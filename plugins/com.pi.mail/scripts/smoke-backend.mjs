#!/usr/bin/env node
/**
 * Drive the built backend with a fake host — no Electron, no app.
 *
 * Runs `dist/main.mjs`, the artifact that actually ships. Covers the paths a
 * human clicking the panel would take (compose, save, send) plus the tools and
 * the /mail command.
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
const notifications = [];
const logs = [];
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
      sendToBackend({ type: 'init', pluginId: 'com.pi.mail', apiVersion: 2, dataDir: '/tmp/x' });
      break;
    case 'tool-result':
      current?.resolve(msg);
      break;
    case 'command-result':
      current?.resolve(msg);
      break;
    case 'call': {
      let result;
      if (msg.method === 'storage.get') result = store[msg.params.key];
      else if (msg.method === 'storage.set') {
        store[msg.params.key] = msg.params.value;
        result = { ok: true };
      } else if (msg.method === 'notify.show') {
        notifications.push(msg.params);
        result = { ok: true };
      } else result = { ok: true };
      sendToBackend({ type: 'call-result', id: msg.id, result });
      break;
    }
    case 'log':
      logs.push(msg);
      if (msg.level === 'error' || msg.level === 'warn') console.log(`  [${msg.level}] ${msg.message}`);
      break;
    default:
      break;
  }
}

let seq = 0;
let current = null;
function invoke(message) {
  return new Promise((resolve, reject) => {
    const id = 't' + ++seq;
    current = { resolve, reject };
    sendToBackend({ ...message, id });
    setTimeout(() => reject(new Error(`${message.type} ${message.name} timed out`)), 5000);
  });
}
const callTool = (name, params) => invoke({ type: 'tool-call', name, params });

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
const panelSends = (event, data) =>
  panelListener?.({ data: { kind: 'event', event, panelId: 'drafts', data } });

// The SDK takes the host port at import time, so the fake must exist first —
// and so must the seed, since the backend reads storage in onInit.
process.parentPort = port;
store.drafts = [
  { id: 'd1', to: 'a@example.com', subject: '已有的草稿', body: '正文', sent: false, createdAt: '2026-01-01T00:00:00.000Z' },
  { id: 'd2', to: 'b@example.com', subject: '已发出的', body: '正文', sent: true, createdAt: '2026-01-02T00:00:00.000Z' },
];
store.composing = { to: '', subject: '', body: '' };

// ── run ──

console.log('━━━ smoke: com.pi.mail dist/main.mjs against a fake host\n');

await import(pathToFileURL(join(ROOT, 'dist/main.mjs')).href);
await new Promise((r) => setTimeout(r, 120));

sendToBackend({ type: 'ui-port' }, [panelPort]);
await new Promise((r) => setTimeout(r, 60));
panelSends('panel.mounted');
await new Promise((r) => setTimeout(r, 60));

check('panel.mounted produces the first render', renders.length === 1, JSON.stringify(renders.length));
check(
  'the first render carries the stored drafts',
  renders.at(-1)?.data?.drafts?.length === 2,
  JSON.stringify(renders.at(-1)?.data?.drafts?.length),
);

// ── composing through panel events ──

panelSends('mail.subject', '面板写的草稿');
await new Promise((r) => setTimeout(r, 40));
panelSends('mail.to', 'panel@example.com');
await new Promise((r) => setTimeout(r, 40));
check(
  'typing into the form is mirrored into the render',
  renders.at(-1)?.data?.composing?.subject === '面板写的草稿',
  JSON.stringify(renders.at(-1)?.data?.composing),
);

panelSends('mail.save');
await new Promise((r) => setTimeout(r, 80));
check('saving a draft adds it', renders.at(-1)?.data?.drafts?.length === 3, renders.at(-1)?.data?.drafts?.length);
check(
  'saving clears the form',
  renders.at(-1)?.data?.composing?.subject === '',
  JSON.stringify(renders.at(-1)?.data?.composing),
);
check('the draft reached storage', Array.isArray(store.drafts) && store.drafts.length === 3);

// An empty form must not create a blank draft.
panelSends('mail.save');
await new Promise((r) => setTimeout(r, 80));
check('saving with an empty form creates nothing', renders.at(-1)?.data?.drafts?.length === 3);

// ── sending through the panel ──

panelSends('mail.send', { key: 'd1' });
await new Promise((r) => setTimeout(r, 80));
check(
  'clicking a draft marks it sent',
  renders.at(-1)?.data?.drafts?.find((d) => d.id === 'd1')?.sent === true,
);
check('sending notifies', notifications.length === 1, JSON.stringify(notifications.length));

panelSends('mail.nonsense', 1);
await new Promise((r) => setTimeout(r, 60));
check(
  'an event the plugin does not handle is reported, not swallowed',
  logs.some((m) => m.level === 'warn' && /mail\.nonsense/.test(m.message)),
  JSON.stringify(logs.map((m) => m.message)),
);

// ── tools ──

const created = await callTool('mail_create_draft', { to: 'tool@example.com', subject: '工具建的', body: '正文' });
check('mail_create_draft reports the new draft', /已创建草稿/.test(created.content?.[0]?.text ?? ''), created.content?.[0]?.text);
check('mail_create_draft returns a card', created.card?.component === 'Card');

const listed = await callTool('mail_list_drafts', {});
check('mail_list_drafts lists them', /工具建的/.test(listed.content?.[0]?.text ?? ''), listed.content?.[0]?.text);

const sent = await callTool('mail_send_draft', { subject: '工具建的' });
check('mail_send_draft sends it', /已发送草稿/.test(sent.content?.[0]?.text ?? ''), sent.content?.[0]?.text);

const missing = await callTool('mail_send_draft', { subject: '不存在的草稿' }).catch((e) => ({ error: e.message }));
check('sending an unknown draft errors', /未找到待发送的草稿/.test(missing.error ?? ''), JSON.stringify(missing));

const unknown = await callTool('mail_nope', {}).catch((e) => ({ error: e.message }));
check('an unknown tool errors', /unknown tool/.test(unknown.error ?? ''), JSON.stringify(unknown));

// ── command ──

const cmd = await invoke({ type: 'command', name: '/mail' });
check('the /mail command opens the panel', cmd.result?.opened === 'drafts', JSON.stringify(cmd.result));

const badCmd = await invoke({ type: 'command', name: '/nope' }).catch((e) => ({ error: e.message }));
check('an unknown command errors', /unknown command/.test(badCmd.error ?? ''), JSON.stringify(badCmd));

console.log(`\n${failures === 0 ? '✓ all checks passed' : `✗ ${failures} check(s) failed`}`);
process.exit(failures ? 1 : 0);
