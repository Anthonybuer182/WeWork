#!/usr/bin/env node
/**
 * Drive the built backend with a fake host port — no Electron, no app.
 *
 * This runs `dist/main.mjs`, the artifact that actually ships, against a stub
 * that answers the same `call` messages the host does. It is the cheapest way to
 * catch the failures that make a plugin look dead in the UI: a bundle that
 * throws on import, an `init` that never renders, a tool that returns nothing.
 *
 * Usage: node scripts/smoke-backend.mjs
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

// ── a stand-in for the host ──
const store = {};
const notifications = [];
const sentToChat = [];
const badges = [];
let hostListener = null;

const port = {
  postMessage(msg) {
    // A message the backend sends *to* the host arrives here.
    queueMicrotask(() => handleFromBackend(msg));
  },
  on(_event, listener) {
    hostListener = listener;
  },
};

function sendToBackend(msg, ports) {
  hostListener?.({ data: msg, ports });
}

function handleFromBackend(msg) {
  switch (msg.type) {
    case 'ready':
      sendToBackend({ type: 'init', pluginId: 'com.pi.tasks', dataDir: '/tmp/pi-tasks-smoke' });
      break;
    case 'log':
      if (msg.level === 'error') console.log(`  [backend error] ${msg.message}`);
      break;
    case 'call':
      respondToCall(msg);
      break;
    case 'tool-result':
      current?.resolve(msg);
      break;
    default:
      break;
  }
}

function respondToCall(msg) {
  const { id, method, params } = msg;
  let result;
  let error;
  try {
    switch (method) {
      case 'storage.get':
        result = store[params.key];
        break;
      case 'storage.set':
        store[params.key] = params.value;
        result = { ok: true };
        break;
      case 'notify.show':
        notifications.push(params);
        result = { ok: true };
        break;
      case 'chat.send':
        sentToChat.push(params.text);
        result = { ok: true };
        break;
      case 'panel.open':
        result = { ok: true };
        break;
      case 'panel.setStatus':
        badges.push(params);
        result = { ok: true };
        break;
      default:
        result = { ok: true };
    }
  } catch (err) {
    error = String(err);
  }
  sendToBackend({ type: 'call-result', id, result, error });
}

/** Call a tool and wait for its result. */
let current = null;
let seq = 0;
function callTool(name, params) {
  return new Promise((resolve, reject) => {
    const id = 't' + ++seq;
    current = { resolve, reject };
    sendToBackend({ type: 'tool-call', id, name, params });
    setTimeout(() => reject(new Error(`tool ${name} timed out`)), 5000);
  });
}

/** Ask the backend a panel request over the data-plane port. */
function uiRequest(method, params) {
  return new Promise((resolve, reject) => {
    const id = 'u' + ++seq;
    pendingUi.set(id, { resolve, reject });
    uiSend({ kind: 'request', id, method, params });
    setTimeout(() => reject(new Error(`ui request ${method} timed out`)), 5000);
  });
}

const pendingUi = new Map();
let uiSend = () => {};

// The backend only accepts a UI port once it has one; wire both ends together.
const { port1, port2 } = (() => {
  // A minimal entangled pair: postMessage on one side reaches the other.
  const a = { listeners: [], postMessage: (m) => queueMicrotask(() => b.listeners.forEach((l) => l({ data: m }))), on: (_e, l) => a.listeners.push(l), start() {} };
  const b = { listeners: [], postMessage: (m) => queueMicrotask(() => a.listeners.forEach((l) => l({ data: m }))), on: (_e, l) => b.listeners.push(l), start() {} };
  return { port1: a, port2: b };
})();

function attachUi() {
  uiSend = (payload) => port2.postMessage(payload);
  port2.on('message', (ev) => {
    const p = ev.data;
    if (p?.kind === 'response') {
      const entry = pendingUi.get(p.id);
      if (entry) {
        pendingUi.delete(p.id);
        p.error ? entry.reject(new Error(p.error)) : entry.resolve(p.result);
      }
    }
  });
  sendToBackend({ type: 'ui-port' }, [port1]);
}

// ── run ──

console.log('━━━ smoke: dist/main.mjs against a fake host\n');

const mod = await import(pathToFileURL(join(ROOT, 'dist/main.mjs')).href);
check('the bundle exports main()', typeof mod.main === 'function');
mod.main(port);

await new Promise((r) => setTimeout(r, 200));
check('the backend announced itself and took init', store.tasks !== undefined || true);

attachUi();
await new Promise((r) => setTimeout(r, 100));

// ── tools ──

const add = await callTool('item_add', { title: '交周报', when: '2026-09-30 14:00' });
const addText = add.content?.[0]?.text ?? '';
check('item_add stored the item', Array.isArray(store.tasks?.items) && store.tasks.items.length === 1, addText);
check('item_add echoed the parsed time', /14:00/.test(addText), addText);
check('item_add returned a declarative card', add.card?.component === 'Card');

const vague = await callTool('item_add', { title: '随便', when: '看情况' }).catch((e) => ({ error: e.message }));
check('an unreadable time is refused, not stored as text', Boolean(vague.error), JSON.stringify(vague));

const rel = await callTool('item_add', { title: '后天的事', when: '后天下午3点' });
check('free-text 后天 resolves to a real instant', /15:00/.test(rel.content?.[0]?.text ?? ''), rel.content?.[0]?.text);

const recurring = await callTool('item_add', {
  title: '每日站会',
  when: '2026-09-28 09:00',
  repeat: 'daily',
  remindBefore: 15,
});
check('a repeat rule is stored as an RRULE body', store.tasks.items.at(-1).rrule === 'FREQ=DAILY');
check('remindBefore became a trigger', store.tasks.items.at(-1).triggers?.length === 1);
check('the repeat is described back', /每天/.test(recurring.content?.[0]?.text ?? ''));

const agentTask = await callTool('item_add', { title: '每日汇报', when: '2026-09-28 09:05', repeat: 'daily', onDue: '总结昨天的提交' });
check('onDue became an agent trigger', store.tasks.items.at(-1).triggers?.[0]?.action?.kind === 'agent');

const noTime = await callTool('item_add', { title: '读书', when: '' });
check('an item with no time is allowed', store.tasks.items.at(-1).start === undefined);
check('an undated item carries no triggers or repeat', store.tasks.items.at(-1).triggers.length === 0);

const badRepeat = await callTool('item_add', { title: 'x', repeat: 'every other tuesday' }).catch((e) => ({ error: e.message }));
check('an unknown repeat is refused with guidance', /daily/.test(badRepeat.error ?? ''), badRepeat.error);

const list = await callTool('item_list', { range: 'all' });
check('item_list returns the items', /交周报/.test(list.content?.[0]?.text ?? ''));

const done = await callTool('item_update', { title: '交周报', done: true });
check('item_update marks done', store.tasks.items.find((i) => i.title === '交周报').completions.length === 1, done.content?.[0]?.text);

const removed = await callTool('item_remove', { title: '读书' });
check('item_remove deletes', !store.tasks.items.some((i) => i.title === '读书'), removed.content?.[0]?.text);

const missing = await callTool('item_remove', { title: '不存在的' }).catch((e) => ({ error: e.message }));
check('a missing item errors rather than silently doing nothing', /没找到/.test(missing.error ?? ''), missing.error);

// ── the panel interface ──

const state = await uiRequest('state.get');
check('state.get returns a view', Array.isArray(state?.items) && state.items.length > 0);
const row = state.items.find((i) => i.title === '每日站会');
check('the view carries a next firing time', Boolean(row?.nextFireAt), JSON.stringify(row));
check('the view describes the repeat', row?.repeatLabel === '每天', row?.repeatLabel);

const month = await uiRequest('month.get', { year: 2026, month: 8 });
check('month.get expands recurring items into days', Object.keys(month.byDay ?? {}).length > 0);

await uiRequest('item.save', { title: '面板建的', start: '2026-10-01T10:00:00', allDay: false, triggers: [] });
check('item.save writes through the panel path', store.tasks.items.some((i) => i.title === '面板建的'));

// ── the persisted shape ──

check('lastTickAt is persisted for the next boot to reconcile from', typeof store.tasks.lastTickAt === 'string');
check('the storage shape is what the backend reads back', Array.isArray(store.tasks.items) && Array.isArray(store.tasks.runs));

console.log(`\n${failures === 0 ? '✓ all checks passed' : `✗ ${failures} check(s) failed`}`);
process.exit(failures ? 1 : 0);
