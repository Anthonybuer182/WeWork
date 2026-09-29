#!/usr/bin/env node
/**
 * Live check of the panel → host-agent path, for every format that has a
 * selection popover.
 *
 * ## Why this exists
 *
 * The bugs this catches are invisible to every other kind of test here. The
 * backend's own suite (`run-tests.mjs`) exercises pure functions; nothing else
 * can see that
 *
 *   - sheets' chat entries are `{ text }`, not `{ content }` — a watcher that
 *     forwards on the wrong field name looks exactly like a working one;
 *   - an `AgentLoop.run()` that throws instead of reporting left `aiBusy` stuck
 *     true, so sheets answered the FIRST submission and silently dropped every
 *     one after it;
 *   - the pdf popover's trigger is `visibility: hidden` until a layout effect
 *     runs, and Univer's canvas is wider than the panel, so a drag has to be
 *     aimed in VIEWPORT coordinates or the trigger lands off-screen.
 *
 * All three were found by driving the real app. None was visible in the source.
 *
 * ## Requirements
 *
 * The app must be running with `--remote-debugging-port=19222` (the dev script
 * does this) and a document of the matching kind must be openable from disk.
 *
 *   node scripts/smoke-panel-live.mjs <docx|xlsx|pdf> <file-path>
 *
 * The check drives a REAL mouse drag: synthetic DOM events do not move
 * ProseMirror's selection state, which is what the docs popover reads, and
 * Univer's selection is built from pointer events the same way. Then it submits
 * through the popover and reads back what the host conversation actually
 * received.
 *
 * NOTE: this sends a real message into the running conversation, and the agent
 * will answer it. That is the point — it is the only way to prove the wiring —
 * but it does mean the session gets a few test turns.
 */
import { argv, exit } from 'node:process';

const CDP_HOST = process.env.PI_CDP_HOST ?? '127.0.0.1:19222';
const SHELL_MATCH = 'localhost:5174';
const PANEL_MATCH = 'com.pi.files';

const KIND = argv[2];
const DOC = argv[3];
if (!KIND || !DOC) {
  console.error('usage: node scripts/smoke-panel-live.mjs <docx|xlsx|pdf> <file-path>');
  exit(2);
}

const MARK = `SMOKE-${KIND}-${Date.now()}`;

// ── tiny CDP client ─────────────────────────────────────────────────────

async function connect(match) {
  const targets = await (await fetch(`http://${CDP_HOST}/json/list`)).json();
  const target = targets.find((t) => (t.url ?? '').includes(match));
  if (!target) {
    console.error(`no CDP target matching "${match}". Is the app running with --remote-debugging-port?`);
    exit(2);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
      }, 25_000);
    });
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
  });
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
  await send('Runtime.enable');
  await send('Page.enable');
  return { ws, send };
}

function evaluator(session) {
  return async (body) => {
    const res = await session.send('Runtime.evaluate', {
      expression: `(async () => { ${body} })()`,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
    }
    return res.result?.value;
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── per-format selection drivers ────────────────────────────────────────
//
// Each returns the viewport point of a CLICKABLE ask entry, or null. "Clickable"
// is the strict test: elementFromPoint must be the entry itself, because a
// hidden or off-screen trigger still has a bounding rect.

/** docs: a real drag across the first text node in the ProseMirror document. */
async function selectDocs(session, ev, mouse) {
  const spot = await ev(`
    const pm = document.querySelector('.ProseMirror');
    if (!pm) return null;
    const walker = document.createTreeWalker(pm, NodeFilter.SHOW_TEXT);
    let n, target = null;
    while ((n = walker.nextNode())) { if ((n.textContent||'').trim().length >= 4) { target = n; break; } }
    if (!target) return null;
    const r = document.createRange();
    r.setStart(target, 0);
    r.setEnd(target, Math.min(4, target.textContent.length));
    const b = r.getBoundingClientRect();
    return { x1: b.left + 1, x2: b.right - 1, y: b.top + b.height / 2 };
  `);
  if (!spot) return null;
  await drag(mouse, spot.x1, spot.y, spot.x2, spot.y);
  return askEntry(ev);
}

/**
 * pdf: the markup bar's Ask-AI entry, which only appears after a drag over the
 * text layer.
 *
 * The spans are tiny — a 10px line for the heading, 6px for the body — so the
 * drag follows the span's own rect and tries a pixel either side of its centre.
 * Aiming at a guessed offset from the page rect missed entirely: it landed in
 * the margin between lines, and no selection was made.
 */
async function selectPdf(session, ev, mouse) {
  // The text layer arrives AFTER `.pdf-page-content` does — it is built once
  // pdf.js has parsed the page. Querying it too early returns an empty layer,
  // and dragging over an empty layer selects nothing.
  let spans = [];
  for (let i = 0; i < 40 && spans.length === 0; i++) {
    spans = await ev(`
      const tl = document.querySelector('.textLayer, [class*=text-layer], [class*=textLayer]');
      if (!tl) return [];
      return [...tl.children]
        .map(s => { const r = s.getBoundingClientRect();
                    return { text: (s.textContent||'').trim(), x: r.left, y: r.top, w: r.width, h: r.height }; })
        .filter(s => s.text && s.w > 2 && s.h > 2);
    `);
    if (spans.length === 0) await sleep(400);
  }
  for (const span of spans) {
    for (const nudge of [0, 1, -1]) {
      const y = span.y + span.h / 2 + nudge;
      await drag(mouse, span.x + 2, y, span.x + span.w - 2, y);
      const entry = await ev(`
        const b = document.querySelector('.pdf-sel-ask');
        if (!b) return null;
        const r = b.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        return document.elementFromPoint(cx, cy) === b ? { x: cx, y: cy } : null;
      `);
      if (entry) return entry;
    }
  }
  return null;
}

/**
 * sheets: drag across Univer cells. Coordinates must stay INSIDE the panel
 * viewport — the canvas is wider than the panel, and a drag that ends off-screen
 * puts the trigger past the right edge where elementFromPoint cannot reach it.
 */
async function selectSheets(session, ev, mouse) {
  const vp = await ev(`return { w: window.innerWidth, h: window.innerHeight };`);
  const canvasTop = await ev(`
    const c = document.querySelector('#univer-container canvas') || document.querySelector('.spreadsheet');
    return c ? c.getBoundingClientRect().top : null;
  `);
  if (canvasTop === null) return null;

  // The drag that follows an ask often does not re-arm the anchor (the ask
  // dismissed it, and finishSelectionPointer bails when the range is unchanged),
  // so retry — with a different range each time — rather than assuming one drag.
  for (let attempt = 0; attempt < 6; attempt++) {
    const y0 = canvasTop + 140 + attempt * 30;
    const x0 = 110;
    const x1 = Math.min(x0 + 200, vp.w - 60);
    await drag(mouse, x0, y0, x1, y0 + 70);
    const entry = await askEntry(ev);
    if (entry) return entry;
  }
  return null;
}

/** A real mouse drag: pressed → several moves → released. */
async function drag(mouse, x0, y0, x1, y1) {
  await mouse('mouseMoved', x0, y0, 0);
  await mouse('mousePressed', x0, y0, 1);
  for (let i = 1; i <= 14; i++) {
    await mouse('mouseMoved', x0 + ((x1 - x0) * i) / 14, y0 + ((y1 - y0) * i) / 14, 1);
    await sleep(20);
  }
  await mouse('mouseReleased', x1, y1, 0);
  await sleep(1400);
}

/** The floating ask entry, once it is actually clickable. */
async function askEntry(ev) {
  for (let i = 0; i < 10; i++) {
    const found = await ev(`
      const b = document.querySelector('.ai-ask-trigger');
      if (!b) return null;
      const cs = getComputedStyle(b);
      if (cs.visibility !== 'visible' || cs.display === 'none') return null;
      const r = b.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      return document.elementFromPoint(cx, cy) === b ? { x: cx, y: cy } : null;
    `);
    if (found) return found;
    await sleep(300);
  }
  return null;
}

// ── run ─────────────────────────────────────────────────────────────────

const panel = await connect(PANEL_MATCH);
const ev = evaluator(panel);
const mouse = (type, x, y, buttons) =>
  panel.send('Input.dispatchMouseEvent', {
    type, x, y, button: 'left', buttons, clickCount: 1, pointerType: 'mouse',
  });

// Pin the target file. The agent opens files of its own accord while answering,
// which would otherwise leave the panel on some other document mid-run.
await ev(`sessionStorage.setItem('pi.files.openPath', ${JSON.stringify(DOC)}); return 1;`);
await panel.send('Page.reload', { ignoreCache: true });

// Each app has its own root: docs renders into `.ProseMirror`, pdf into
// `.pdf-page-content`, sheets into `.app-shell`. Waiting on the wrong one just
// burns the timeout while the panel is already usable.
const READY = { docx: '.ProseMirror', pdf: '.pdf-page-content', xlsx: '.app-shell' }[KIND];
let ready = false;
for (let i = 0; i < 80; i++) {
  await sleep(500);
  try {
    if (await ev(`return !!document.querySelector(${JSON.stringify(READY)});`)) { ready = true; break; }
  } catch { /* navigating */ }
}
if (!ready) {
  console.log(`✗ the panel never loaded; it shows: ${await ev(`return document.body.innerText.slice(0, 160);`)}`);
  exit(1);
}
await sleep(4000); // editors and their layout effects settle

const driver = { docx: selectDocs, pdf: selectPdf, xlsx: selectSheets }[KIND];
if (!driver) {
  console.error(`unknown kind "${KIND}" — expected docx, xlsx or pdf`);
  exit(2);
}

const entry = await driver(panel, ev, mouse);
if (!entry) {
  console.log(`✗ no clickable ask entry appeared in the ${KIND} panel`);
  exit(1);
}
console.log(`✓ ask entry is on screen and clickable`);

await mouse('mousePressed', entry.x, entry.y, 1);
await mouse('mouseReleased', entry.x, entry.y, 0);
await sleep(600);

// The input is React-controlled: setting .value does not reach React. Go
// through the native setter so the change event carries.
const typed = await ev(`
  const input = document.querySelector('.ai-ask-pop-input');
  if (!input) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, ${JSON.stringify('把这句改得更正式 ')} + ${JSON.stringify(MARK)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
`);
if (!typed) {
  console.log('✗ the popover did not open (no .ai-ask-pop-input)');
  exit(1);
}
console.log(`✓ popover opened; its excerpt reads: ${await ev(`return document.querySelector('.ai-ask-pop-sub')?.textContent ?? '(none)';`)}`);
await sleep(250);

// Which button submits differs per app: sheets confirms with .ai-ask-confirm,
// docs and pdf use .ai-ask-cancel for "send now".
const SEL = KIND === 'xlsx' ? '.ai-ask-confirm' : '.ai-ask-cancel';
const button = await ev(`
  const b = document.querySelector(${JSON.stringify(SEL)});
  if (!b || b.disabled) return null;
  const r = b.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, label: b.textContent };
`);
if (!button) {
  console.log(`✗ no enabled submit button (${SEL})`);
  exit(1);
}
console.log(`✓ submitting via ${JSON.stringify(button.label)}`);
await mouse('mousePressed', button.x, button.y, 1);
await mouse('mouseReleased', button.x, button.y, 0);
await sleep(2500);

console.log(`  panel after submit: ${JSON.stringify(await ev(`
  return { queueAnchorsLeft: document.querySelectorAll('.ai-queue-anchor').length,
           popoverStillOpen: !!document.querySelector('.ai-ask-pop') };
`))}`);
panel.ws.close();

// What the conversation actually got. This is the assertion that matters: the
// popover rendering proves nothing about whether the message arrived, or what
// it said.
const shell = await connect(SHELL_MATCH);
const sv = evaluator(shell);
for (let i = 0; i < 15; i++) {
  const hit = await sv(`
    const t = document.body.innerText || '';
    const i = t.indexOf(${JSON.stringify(MARK)});
    return i < 0 ? null : t.slice(Math.max(0, i - 260), i + ${MARK.length + 12});
  `);
  if (hit) {
    console.log(`\n=== what the agent received ===\n${hit}\n`);
    console.log('✓ the selection reached the host conversation');
    shell.ws.close();
    exit(0);
  }
  await sleep(1000);
}
console.log('\n✗ the message never reached the host conversation');
shell.ws.close();
exit(1);
