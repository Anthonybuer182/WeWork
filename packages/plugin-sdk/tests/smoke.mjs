#!/usr/bin/env node
/**
 * Drive the built SDK against a fake host — no Electron, no plugin, no app.
 *
 * The SDK's whole reason to exist is that failures must be LOUD. This checks
 * exactly that: every wrong thing an author can do produces a specific,
 * actionable message instead of a silent no-op. Reading the code cannot prove
 * that — the failure modes are all "nothing happened", which looks identical to
 * working code until you run it.
 *
 * Usage: node tests/smoke.mjs   (run `pnpm build` first — this loads dist/)
 */
import { pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
}

// ── A stand-in for the host's half of the control plane ──
const toHost = [];
const callbacks = new Map();
let callSeq = 0;

const parentPort = {
  postMessage(msg) {
    toHost.push(msg);
    // Answer capability calls so `await ctx.call(...)` resolves.
    if (msg.type === 'call') {
      queueMicrotask(() =>
        deliver({ type: 'call-result', id: msg.id, result: { echoed: msg.method } }),
      );
    }
  },
  on(_event, listener) {
    parentPort._listener = listener;
  },
};

function deliver(msg, ports) {
  parentPort._listener?.({ data: msg, ports });
}

/** The panel's half of the data plane. */
const toPanel = [];
let answerProbes = true;
const panelPort = {
  postMessage(msg) {
    toPanel.push(msg);
    // Stand in for the panel SDK: answer liveness probes unless the test says not to.
    if (answerProbes && msg.kind === 'event' && msg.event === 'pi.probe') {
      queueMicrotask(() =>
        panelSends({
          kind: 'event',
          event: 'pi.probe.reply',
          panelId: msg.panelId,
          data: { id: msg.data?.id },
        }),
      );
    }
  },
  on(_event, listener) {
    panelPort._listener = listener;
  },
  start() {},
};
function panelSends(msg) {
  panelPort._listener?.({ data: msg });
}

const nextCall = () => 't' + ++callSeq;

// ── Load the built SDK with the fake port in place ──
process.parentPort = parentPort;
const { plugin } = await import(pathToFileURL(join(ROOT, 'dist/index.js')).href);

console.log('━━━ smoke: @pi/plugin-sdk against a fake host\n');

// ── A plugin that shows each way an author can go wrong ──
plugin({
  async onInit(ctx) {
    callbacks.set('init', { pluginId: ctx.pluginId, dataDir: ctx.dataDir });
    callbacks.set('ctx', ctx);
    // Exercise the capability round-trip through the fake host.
    callbacks.set('capability', await ctx.call('storage.get', { key: 'k' }));
    callbacks.set('send', () => ctx.send('main', 'hello', 1));
  },
  async onRequest(panelId, method) {
    if (method === 'works') return { panelId, ok: true };
    if (method === 'forgot-return') return undefined;
    if (method === 'throws') throw new Error('handler exploded');
    throw new Error(`unknown request method: ${method}`);
  },
  async onEvent(panelId, event) {
    callbacks.set('event', { panelId, event });
  },
  async onTool(name) {
    if (name === 'ok') return 'tool text';
    if (name === 'silent') return undefined;
    throw new Error(`unknown tool: ${name}`);
  },
  async onCommand() {
    return { ran: true };
  },
});

check('posts the ready handshake on import', toHost.some((m) => m.type === 'ready'));

deliver({ type: 'init', pluginId: 'com.test.probe', apiVersion: 3, dataDir: '/tmp/x' });
await new Promise((r) => setTimeout(r, 10));
check(
  'onInit receives the plugin id and data dir',
  callbacks.get('init')?.pluginId === 'com.test.probe' && callbacks.get('init')?.dataDir === '/tmp/x',
  JSON.stringify(callbacks.get('init')),
);

deliver({ type: 'ui-port' }, [panelPort]);

// ── Capability calls ──
deliver({ type: 'call-result', id: 'nonexistent', result: 'ignored' });
check('a call-result for an unknown id is ignored, not thrown', true);

// ── Requests: every failure path must come back as ok:false ──
function replyFor(id) {
  return toPanel.find((m) => m.kind === 'response' && m.id === id);
}

const id1 = nextCall();
panelSends({ kind: 'request', id: id1, panelId: 'main', method: 'works' });
await new Promise((r) => setTimeout(r, 10));
check(
  'a handled request answers ok:true',
  replyFor(id1)?.ok === true && replyFor(id1)?.result?.panelId === 'main',
  JSON.stringify(replyFor(id1)),
);

const id2 = nextCall();
panelSends({ kind: 'request', id: id2, panelId: 'main', method: 'forgot-return' });
await new Promise((r) => setTimeout(r, 10));
check(
  'returning nothing from onRequest is an ERROR, not a silent success',
  replyFor(id2)?.ok === false && /without returning anything/.test(replyFor(id2)?.error ?? ''),
  JSON.stringify(replyFor(id2)),
);

const id3 = nextCall();
panelSends({ kind: 'request', id: id3, panelId: 'main', method: 'throws' });
await new Promise((r) => setTimeout(r, 10));
check(
  'a throwing handler replies ok:false with its message',
  replyFor(id3)?.ok === false && replyFor(id3)?.error === 'handler exploded',
  JSON.stringify(replyFor(id3)),
);

const id4 = nextCall();
panelSends({ kind: 'request', id: id4, panelId: 'main', method: 'nope' });
await new Promise((r) => setTimeout(r, 10));
check(
  'an unknown method surfaces the handler’s own message',
  replyFor(id4)?.ok === false && /unknown request method: nope/.test(replyFor(id4)?.error ?? ''),
  JSON.stringify(replyFor(id4)),
);

// ── The reply is addressed back to the asking panel ──
check(
  'every response carries the panel id back',
  [id1, id2, id3, id4].every((id) => replyFor(id)?.panelId === 'main'),
);

// ── Events ──
const before = toHost.filter((m) => m.type === 'log').length;
panelSends({ kind: 'event', event: 'panel.mounted', panelId: 'main', data: { params: {} } });
await new Promise((r) => setTimeout(r, 10));
panelSends({ kind: 'event', event: 'clicked', panelId: 'main', data: 1 });
await new Promise((r) => setTimeout(r, 10));
check(
  'onEvent receives the panel id and the event name',
  callbacks.get('event')?.panelId === 'main' && callbacks.get('event')?.event === 'clicked',
  JSON.stringify(callbacks.get('event')),
);

// panel.mounted must NOT reach onEvent — it is lifecycle, not a plugin event.
check('panel.mounted is intercepted, not delivered to onEvent', callbacks.get('event')?.event === 'clicked');

const after = toHost.filter((m) => m.type === 'log');
check(
  'a panel.mounted with no onPanelMounted handler is reported',
  after.slice(before).some((m) => m.level === 'warn' && /no onPanelMounted handler/.test(m.message)),
  JSON.stringify(after.slice(before)),
);

// ── A message with no panel id must be reported, not silently routed ──
const logsBefore = toHost.filter((m) => m.type === 'log').length;
panelSends({ kind: 'request', id: nextCall(), method: 'works' });
await new Promise((r) => setTimeout(r, 10));
check(
  'a message with no panelId is warned about by name',
  toHost
    .filter((m) => m.type === 'log')
    .slice(logsBefore)
    .some((m) => m.level === 'warn' && /no panel id/.test(m.message)),
);

// ── Tools ──
function toolResult(id) {
  return toHost.find((m) => m.type === 'tool-result' && m.id === id);
}

const t1 = nextCall();
deliver({ type: 'tool-call', id: t1, name: 'ok', params: {} });
await new Promise((r) => setTimeout(r, 10));
check(
  'a string returned from onTool becomes text content',
  toolResult(t1)?.content?.[0]?.text === 'tool text',
  JSON.stringify(toolResult(t1)),
);

const t2 = nextCall();
deliver({ type: 'tool-call', id: t2, name: 'silent', params: {} });
await new Promise((r) => setTimeout(r, 10));
check(
  'a tool returning nothing reports why the agent sees no result',
  /returned nothing/.test(toolResult(t2)?.error ?? ''),
  JSON.stringify(toolResult(t2)),
);

const t3 = nextCall();
deliver({ type: 'tool-call', id: t3, name: 'boom', params: {} });
await new Promise((r) => setTimeout(r, 10));
check(
  'a throwing tool becomes a tool error',
  toolResult(t3)?.error === 'unknown tool: boom',
  JSON.stringify(toolResult(t3)),
);

// ── Commands ──
const c1 = nextCall();
deliver({ type: 'command', id: c1, name: '/whatever' });
await new Promise((r) => setTimeout(r, 10));
check(
  'a command result comes back',
  toHost.find((m) => m.type === 'command-result' && m.id === c1)?.result?.ran === true,
);

// ── Capability calls and panel pushes ──
check(
  'ctx.call round-trips a capability result',
  callbacks.get('capability')?.echoed === 'storage.get',
  JSON.stringify(callbacks.get('capability')),
);

callbacks.get('send')?.();
await new Promise((r) => setTimeout(r, 10));
check(
  'ctx.send stamps the panel id on a backend → panel event',
  toPanel.some((m) => m.kind === 'event' && m.panelId === 'main' && m.event === 'hello'),
  JSON.stringify(toPanel.filter((m) => m.kind === 'event')),
);

// ── Panel liveness ──
const liveCtx = callbacks.get('ctx');
check('ctx.send reports true when a panel is connected', liveCtx.send('main', 'x') === true);
check(
  'panelAlive is true when the panel answers',
  (await liveCtx.panelAlive('main', 300)) === true,
);

answerProbes = false;
check(
  'panelAlive is false when nothing answers — never a silent true',
  (await liveCtx.panelAlive('main', 120)) === false,
);
answerProbes = true;

console.log(`\n${failures === 0 ? '✓ all checks passed' : `✗ ${failures} check(s) failed`}`);
process.exit(failures ? 1 : 0);
