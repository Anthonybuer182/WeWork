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
const events = [];
let panelListener = null;
const pendingResponses = new Map();
const panelPort = {
  postMessage(msg) {
    if (msg.kind === 'event' && msg.event === 'ui.render') renders.push(msg);
    else if (msg.kind === 'event') events.push(msg);
    else if (msg.kind === 'response') {
      const resolve = pendingResponses.get(msg.id);
      if (resolve) {
        pendingResponses.delete(msg.id);
        resolve(msg);
      }
    }
  },
  on(_event, listener) {
    panelListener = listener;
  },
  start() {},
};
const panelSends = (event, data) =>
  panelListener?.({ data: { kind: 'event', event, panelId: 'drafts', data } });

/** onRequest: post a request, wait for the backend's response. */
let reqSeq = 0;
function panelRequest(method, params = {}) {
  return new Promise((resolve) => {
    const id = 'r' + ++reqSeq;
    pendingResponses.set(id, resolve);
    panelListener?.({ data: { kind: 'request', id, panelId: 'drafts', method, params } });
    setTimeout(() => {
      if (pendingResponses.delete(id)) resolve({ ok: false, error: 'request timeout' });
    }, 5000);
  });
}

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

// ── sending through the panel (no account configured yet) ──

panelSends('mail.send', { key: 'd1' });
await new Promise((r) => setTimeout(r, 150));
check(
  'sending without an account fails loudly back to the panel',
  events.some((e) => e.event === 'mail.send-failed' && e.data?.id === 'd1'),
  JSON.stringify(events.map((e) => e.event)),
);
check(
  'a failed send leaves the draft unsent',
  renders.at(-1)?.data?.drafts?.find((d) => d.id === 'd1')?.sent !== true,
);
check('a failed send does not claim success in a notification', notifications.length === 0);

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

// Real send needs an account: without one, the tool must say so.
const noAcc = await callTool('mail_send_draft', { subject: '工具建的' }).catch((e) => ({ error: e.message }));
check(
  'mail_send_draft without an account tells the user to configure one',
  /尚未配置邮箱账号/.test(noAcc.error ?? ''),
  JSON.stringify(noAcc),
);

// Point SMTP at a dead local port: the send must surface the connection
// failure and the draft must stay unsent (no fake success).
await panelRequest('account.save', {
  preset: 'custom',
  email: 'local@test.dev',
  imap: { host: '127.0.0.1', port: 1 },
  smtp: { host: '127.0.0.1', port: 2 },
  pass: 'x',
});
const refusedSend = await callTool('mail_send_draft', { subject: '工具建的' }).catch((e) => ({ error: e.message }));
check(
  'mail_send_draft surfaces an unreachable SMTP server',
  /发送失败/.test(refusedSend.error ?? ''),
  JSON.stringify(refusedSend),
);
const stillDraft = await callTool('mail_list_drafts', {});
check(
  'a failed SMTP send keeps the draft in the box',
  /\[草稿\] 工具建的/.test(stillDraft.content?.[0]?.text ?? ''),
  stillDraft.content?.[0]?.text,
);
await panelRequest('account.clear');

const missing = await callTool('mail_send_draft', { subject: '不存在的草稿' }).catch((e) => ({ error: e.message }));
check('sending an unknown draft errors', /未找到待发送的草稿/.test(missing.error ?? ''), JSON.stringify(missing));

const unknown = await callTool('mail_nope', {}).catch((e) => ({ error: e.message }));
check('an unknown tool errors', /unknown tool/.test(unknown.error ?? ''), JSON.stringify(unknown));

// ── command ──

const cmd = await invoke({ type: 'command', name: '/mail' });
check('the /mail command opens the panel', cmd.result?.opened === 'drafts', JSON.stringify(cmd.result));

const badCmd = await invoke({ type: 'command', name: '/nope' }).catch((e) => ({ error: e.message }));
check('an unknown command errors', /unknown command/.test(badCmd.error ?? ''), JSON.stringify(badCmd));

// ── account config + mailbox requests (no network: refused/refused/unset) ──

const meta = await panelRequest('account.get');
check(
  'account.get lists presets incl. dingtalk & feishu',
  meta.ok === true &&
    meta.result.presets.some((p) => p.id === 'dingtalk') &&
    meta.result.presets.some((p) => p.id === 'feishu'),
  JSON.stringify(meta),
);
check('account.get reports no account yet', meta.result.account === null);

const badAccount = await panelRequest('account.save', {
  preset: 'qq',
  email: 'not-an-email',
  pass: 'x',
});
check('account.save rejects an invalid email', badAccount.ok === false && /邮箱地址/.test(badAccount.error ?? ''));

const saved = await panelRequest('account.save', {
  preset: 'qq',
  email: 'tester@qq.com',
  pass: 'authcode-123',
});
check('account.save accepts a valid preset account', saved.ok === true, JSON.stringify(saved));
check('the account reached storage', store['mail:account']?.email === 'tester@qq.com');
check('the password reached its own storage key', store['mail:pass'] === 'authcode-123');

// Custom account pointed at a dead local port: the tool must surface the
// connection failure, fast (ECONNREFUSED, no retry storm — first connect).
await panelRequest('account.save', {
  preset: 'custom',
  email: 'local@test.dev',
  imap: { host: '127.0.0.1', port: 1 },
  smtp: { host: '127.0.0.1', port: 2 },
  pass: 'x',
});
const refused = await callTool('mail_list_emails', {}).catch((e) => ({ error: e.message }));
check(
  'mail_list_emails surfaces an unreachable server',
  /无法连接邮箱服务器/.test(refused.error ?? refused.content?.[0]?.text ?? ''),
  JSON.stringify(refused),
);
const meta2 = await panelRequest('account.get');
check(
  'the engine state shows the failure',
  meta2.result?.engineState === 'error',
  JSON.stringify(meta2.result?.engineState),
);

await panelRequest('account.clear');
const unconfigured = await callTool('mail_list_emails', {}).catch((e) => ({ error: e.message }));
check(
  'mail_list_emails without an account tells the user to configure one',
  /尚未配置邮箱账号/.test(unconfigured.error ?? unconfigured.content?.[0]?.text ?? ''),
  JSON.stringify(unconfigured),
);
const unsearch = await callTool('mail_search', { query: 'x' }).catch((e) => ({ error: e.message }));
check('mail_search without an account fails the same way', /尚未配置邮箱账号/.test(unsearch.error ?? ''));
const badRead = await callTool('mail_read', {}).catch((e) => ({ error: e.message }));
check('mail_read without an id names the missing parameter', /id 必填/.test(badRead.error ?? ''));

console.log(`\n${failures === 0 ? '✓ all checks passed' : `✗ ${failures} check(s) failed`}`);
process.exit(failures ? 1 : 0);
