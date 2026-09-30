#!/usr/bin/env node
/**
 * Drive the built backend with a fake host — no Electron, no app.
 *
 * Runs `dist/main.mjs`, the artifact that actually ships, against a stub that
 * answers the same messages the host does. Covers the parts a human clicking
 * the panel would exercise: the tools, the panel events, and the render push
 * the panel draws from.
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

// ── A stand-in for the host ──
const store = {};
const calls = [];
let hostListener = null;

const port = {
  postMessage(msg) {
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
      sendToBackend({ type: 'init', pluginId: 'com.pi.knowledge', apiVersion: 2, dataDir: '/tmp/x' });
      break;
    case 'tool-result':
      current?.resolve(msg);
      break;
    case 'call': {
      calls.push(msg);
      let result;
      let error;
      if (msg.method === 'storage.get') result = store[msg.params.key];
      else if (msg.method === 'storage.set') {
        store[msg.params.key] = msg.params.value;
        result = { ok: true };
      } else result = { ok: true };
      sendToBackend({ type: 'call-result', id: msg.id, result, error });
      break;
    }
    case 'log':
      if (msg.level === 'error' || msg.level === 'warn') console.log(`  [${msg.level}] ${msg.message}`);
      break;
    default:
      break;
  }
}

let seq = 0;
let current = null;
function callTool(name, params) {
  return new Promise((resolve, reject) => {
    const id = 't' + ++seq;
    current = { resolve, reject };
    sendToBackend({ type: 'tool-call', id, name, params });
    setTimeout(() => reject(new Error(`tool ${name} timed out`)), 5000);
  });
}

// ── The panel's half of the data plane ──
const renders = [];
let panelListener = null;
const panelPort = {
  postMessage(msg) {
    if (msg.kind === 'event' && msg.event === 'ui.render') renders.push(msg);
  },
  on(_event, listener) {
    panelListener = listener;
  },
  start() {},
};
const panelSends = (msg) => {
  msg.panelId = 'kb';
  panelListener?.({ data: msg });
};

// The SDK takes the host port at import time, so the fake must exist first.
process.parentPort = port;

// Seed storage BEFORE the import: the backend reads it in onInit, and a seed
// added afterwards would simply never be seen.
store.entries = [{ id: 'k1', title: '已有知识', content: '正文', createdAt: '2026-01-01T00:00:00.000Z' }];

// ── run ──

console.log('━━━ smoke: com.pi.knowledge dist/main.mjs against a fake host\n');

const seen = [];
const originalPost = port.postMessage.bind(port);
port.postMessage = (msg) => {
  seen.push(msg);
  return originalPost(msg);
};

await import(pathToFileURL(join(ROOT, 'dist/main.mjs')).href);
await new Promise((r) => setTimeout(r, 120));

check('the backend announced readiness on load', seen.some((m) => m.type === 'ready'));

sendToBackend({ type: 'ui-port' }, [panelPort]);
await new Promise((r) => setTimeout(r, 60));

check(
  'a render before any panel is connected reaches nobody (and is not an error)',
  renders.length === 0,
  JSON.stringify(renders.length),
);

panelSends({ kind: 'event', event: 'panel.mounted', data: { params: {} } });
await new Promise((r) => setTimeout(r, 60));
check('panel.mounted produces the first render', renders.length === 1, JSON.stringify(renders.length));
check(
  'the first render carries what storage held',
  renders.at(-1)?.data?.total === 1,
  JSON.stringify(renders.at(-1)?.data),
);

// ── panel events ──

const before = renders.length;
panelSends({ kind: 'event', event: 'kb.add', data: '面板加的' });
await new Promise((r) => setTimeout(r, 60));
check('kb.add adds an entry', renders.at(-1)?.data?.total === 2, JSON.stringify(renders.at(-1)?.data?.total));

panelSends({ kind: 'event', event: 'kb.search', data: '面板' });
await new Promise((r) => setTimeout(r, 60));
check(
  'kb.search filters the list',
  renders.at(-1)?.data?.shown?.length === 1,
  JSON.stringify(renders.at(-1)?.data),
);

panelSends({ kind: 'event', event: 'kb.delete', data: { key: renders.at(-1).data.shown[0].id } });
await new Promise((r) => setTimeout(r, 60));
check('kb.delete removes it', renders.at(-1)?.data?.total === 1, JSON.stringify(renders.at(-1)?.data?.total));

panelSends({ kind: 'event', event: 'kb.nonsense', data: 1 });
await new Promise((r) => setTimeout(r, 60));
check(
  'an event the plugin does not handle is reported, not swallowed',
  seen.some((m) => m.type === 'log' && m.level === 'warn' && /kb\.nonsense/.test(m.message)),
);

// ── tools ──

const saved = await callTool('kb_save', { title: '工具存的', content: '工具正文' });
check('kb_save stores the entry', /已保存知识/.test(saved.content?.[0]?.text ?? ''), saved.content?.[0]?.text);
check('kb_save persisted to storage', Array.isArray(store.entries) && store.entries.some((e) => e.title === '工具存的'));

const listed = await callTool('kb_list', {});
check('kb_list lists what is there', /工具存的/.test(listed.content?.[0]?.text ?? ''), listed.content?.[0]?.text);

const found = await callTool('kb_search', { query: '工具正文' });
check('kb_search finds it by content', /工具存的/.test(found.content?.[0]?.text ?? ''), found.content?.[0]?.text);

const miss = await callTool('kb_search', { query: '完全不存在的东西' });
check(
  'a search with no hits says so instead of returning nothing',
  /没有匹配/.test(miss.content?.[0]?.text ?? ''),
  miss.content?.[0]?.text,
);

const bad = await callTool('kb_save', {}).catch((e) => ({ error: e.message }));
check('kb_save without a title errors', /missing title/.test(bad.error ?? ''), JSON.stringify(bad));

const unknown = await callTool('kb_nonexistent', {}).catch((e) => ({ error: e.message }));
check('an unknown tool errors', /unknown tool/.test(unknown.error ?? ''), JSON.stringify(unknown));

check(
  'every capability call went through the host',
  calls.every((c) => typeof c.method === 'string' && c.id),
);

console.log(`\n${failures === 0 ? '✓ all checks passed' : `✗ ${failures} check(s) failed`}`);
process.exit(failures ? 1 : 0);
