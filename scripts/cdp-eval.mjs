#!/usr/bin/env node
/**
 * Evaluate JS in an Electron CDP target.
 *
 * The app runs with `--remote-debugging-port=19222`. Because plugins are
 * site-isolated under `pi-plugin://` with `Origin-Agent-Cluster: 1`, each
 * plugin panel is its OWN target with its own console — so assertions about a
 * panel must run in that target's context, not the shell's. Hence the matcher.
 *
 * Usage:
 *   node scripts/cdp-eval.mjs [--match <substring>] [--frame <substring>] [--list] [--timeout <ms>] <expression>
 *
 *   --match <s>   pick the target whose url OR title contains <s>
 *                 (default: the first target of type "page")
 *   --frame <s>   evaluate inside the child frame whose url contains <s>.
 *                 Needed for plugin panels: they are cross-origin
 *                 (pi-plugin://<id>) so `contentDocument` is blocked, and with
 *                 site-per-process off they share the shell's process so they
 *                 do not appear as their own CDP target.
 *   --list        print targets and exit
 *   --timeout n   evaluate timeout, default 15000
 *
 * The expression is evaluated as an async function body, so `await` works and
 * the last expression is returned. Result is printed as JSON.
 *
 * NOTE: do not add an Origin header — the CDP endpoint rejects the upgrade.
 */
import { argv, exit } from 'node:process';

const CDP_HOST = process.env.PI_CDP_HOST ?? '127.0.0.1:19222';

// ── args ────────────────────────────────────────────────────────────────
const args = argv.slice(2);
let match = null;
let frameMatch = null;
let list = false;
let timeout = 15_000;
const exprParts = [];

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--match') match = args[++i];
  else if (a === '--frame') frameMatch = args[++i];
  else if (a === '--list') list = true;
  else if (a === '--timeout') timeout = Number(args[++i]);
  else exprParts.push(a);
}
const expression = exprParts.join(' ');

// ── targets ─────────────────────────────────────────────────────────────
const targets = await (await fetch(`http://${CDP_HOST}/json/list`)).json();
// Plugin panels are cross-origin (`pi-plugin://<id>`) so Chromium makes them
// out-of-process iframes — they show up as their own target with type
// "iframe", NOT as child frames of the shell. Include them.
const pages = targets.filter((t) => t.type === 'page' || t.type === 'iframe');

if (list) {
  for (const t of pages) {
    console.log(`[${t.type}] ${t.title || '(no title)'}\n    url: ${t.url}\n    id:  ${t.id}`);
  }
  exit(0);
}

let target;
if (match) {
  target = pages.find((t) => (t.url ?? '').includes(match) || (t.title ?? '').includes(match));
  if (!target) {
    console.error(`no target matching "${match}". Available:`);
    for (const t of pages) console.error(`  ${t.title || '(no title)'} — ${t.url}`);
    exit(2);
  }
} else {
  target = pages[0];
}
if (!target) {
  console.error('no page targets');
  exit(2);
}

if (!expression) {
  console.error('no expression given');
  exit(2);
}

// ── evaluate ────────────────────────────────────────────────────────────
const ws = new WebSocket(target.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
/** frameId → executionContextId, filled from Runtime.executionContextCreated. */
const contextsByFrame = new Map();

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
    }, timeout);
  });
}

ws.addEventListener('message', (ev) => {
  let msg;
  try {
    msg = JSON.parse(ev.data);
  } catch {
    return;
  }
  // Runtime.enable replays every live context; that is how we learn the
  // context id of a child frame without racing its creation.
  if (msg.method === 'Runtime.executionContextCreated') {
    const { id, auxData } = msg.params.context;
    if (auxData?.frameId && !contextsByFrame.has(auxData.frameId)) {
      contextsByFrame.set(auxData.frameId, id);
    }
    return;
  }
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
});

const done = new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', () => reject(new Error('websocket error')), { once: true });
});

/** Walk the frame tree depth-first, returning the first frame whose url matches. */
function findFrame(node, needle) {
  if ((node.frame?.url ?? '').includes(needle)) return node.frame;
  for (const child of node.childFrames ?? []) {
    const hit = findFrame(child, needle);
    if (hit) return hit;
  }
  return null;
}

try {
  await done;
  await send('Runtime.enable');
  await send('Page.enable');

  let contextId;
  if (frameMatch) {
    const { frameTree } = await send('Page.getFrameTree');
    const frame = findFrame(frameTree, frameMatch);
    if (!frame) {
      const urls = [];
      (function collect(n) {
        if (n.frame?.url) urls.push(n.frame.url);
        for (const c of n.childFrames ?? []) collect(c);
      })(frameTree);
      console.error(`no frame matching "${frameMatch}". Frames:\n  ${urls.join('\n  ')}`);
      exit(2);
    }
    // The context map is populated by the events Runtime.enable replayed; if
    // the frame navigated after that, fall back to an isolated world (which
    // can read the DOM but not the page's JS globals).
    contextId = contextsByFrame.get(frame.id);
    if (contextId === undefined) {
      const { executionContextId } = await send('Page.createIsolatedWorld', {
        frameId: frame.id,
        worldName: 'pi-cdp-eval',
        grantUniveralAccess: true,
      });
      contextId = executionContextId;
    }
  }

  const res = await send('Runtime.evaluate', {
    expression: `(async () => { ${expression} })()`,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
    ...(contextId === undefined ? {} : { contextId }),
  });

  if (res.exceptionDetails) {
    const d = res.exceptionDetails;
    console.error('EXCEPTION:', d.exception?.description ?? d.text);
    console.log(JSON.stringify({ ok: false, error: d.exception?.description ?? d.text }, null, 2));
    exit(1);
  }
  const v = res.result?.value;
  console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
} catch (err) {
  console.error('ERROR:', err.message);
  exit(1);
} finally {
  ws.close();
}
