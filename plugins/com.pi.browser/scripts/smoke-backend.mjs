#!/usr/bin/env node
/**
 * Drive the built backend with a fake host — no Electron, no app.
 *
 * This plugin has no panel, so this is the only way to check it short of
 * asking the agent to drive a real browser: it runs `dist/main.mjs`, the
 * artifact that actually ships, against a stub that answers the same `call`
 * messages the host does, and asserts each tool's result and the capability it
 * reached for.
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

function sendToBackend(msg) {
  hostListener?.({ data: msg });
}

/** What the fake browser reports back. */
let currentUrl = 'about:blank';
let currentTitle = '';
let snapshotText = '[button] "登录" ref=[1]\n[input] "搜索" ref=[2]';

function handleFromBackend(msg) {
  switch (msg.type) {
    case 'ready':
      sendToBackend({ type: 'init', pluginId: 'com.pi.browser', apiVersion: 2, dataDir: '/tmp/x' });
      break;
    case 'tool-result':
      current?.resolve(msg);
      break;
    case 'call':
      calls.push(msg);
      switch (msg.method) {
        case 'browser.navigate':
          currentUrl = msg.params.url;
          currentTitle = 'Example Domain';
          sendToBackend({ type: 'call-result', id: msg.id, result: { url: currentUrl, title: currentTitle } });
          break;
        case 'browser.getUrl':
          sendToBackend({ type: 'call-result', id: msg.id, result: { url: currentUrl, title: currentTitle } });
          break;
        case 'browser.getState':
          sendToBackend({ type: 'call-result', id: msg.id, result: { url: currentUrl, title: currentTitle, snapshot: snapshotText } });
          break;
        case 'browser.find':
          sendToBackend({
            type: 'call-result',
            id: msg.id,
            result: /没有这个/.test(msg.params.query)
              ? []
              : [{ score: 92, role: 'button', text: '登录', section: 'header' }],
          });
          break;
        case 'browser.click':
          sendToBackend({
            type: 'call-result',
            id: msg.id,
            result: msg.params.selector === '[99]'
              ? { selector: '[99]', clicked: false, error: 'Element not found: "[99]". Did you mean one of these?\n[1] 登录' }
              : { selector: msg.params.selector, clicked: true },
          });
          break;
        case 'browser.fill':
          sendToBackend({ type: 'call-result', id: msg.id, result: { selector: msg.params.selector, value: msg.params.value } });
          break;
        case 'browser.hover':
          sendToBackend({ type: 'call-result', id: msg.id, result: { hovered: true } });
          break;
        case 'browser.select':
          sendToBackend({ type: 'call-result', id: msg.id, result: { selected: true } });
          break;
        case 'browser.scroll':
          sendToBackend({
            type: 'call-result',
            id: msg.id,
            result: { direction: msg.params.direction === 'up' ? 'up' : 'down', amount: msg.params.amount ?? 500 },
          });
          break;
        case 'browser.evaluate':
          sendToBackend({ type: 'call-result', id: msg.id, result: { result: { h1: 'Example Domain' } } });
          break;
        case 'browser.walk':
          sendToBackend({
            type: 'call-result',
            id: msg.id,
            result: {
              goal: msg.params.goal,
              url: currentUrl,
              title: currentTitle,
              reached: true,
              steps: [{ text: '设置' }, { text: '个人资料' }],
            },
          });
          break;
        case 'browser.screenshot':
          sendToBackend({ type: 'call-result', id: msg.id, result: { base64: 'aGVsbG8=' } });
          break;
        default:
          sendToBackend({ type: 'call-result', id: msg.id, error: `no such capability: ${msg.method}` });
      }
      break;
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

// The SDK takes the host port at import time, so the fake must exist first.
process.parentPort = port;

// ── run ──

console.log('━━━ smoke: com.pi.browser dist/main.mjs against a fake host\n');

const seen = [];
const originalPost = port.postMessage.bind(port);
port.postMessage = (msg) => {
  seen.push(msg);
  return originalPost(msg);
};

await import(pathToFileURL(join(ROOT, 'dist/main.mjs')).href);
await new Promise((r) => setTimeout(r, 120));

check('the backend announced readiness on load', seen.some((m) => m.type === 'ready'));

// ── tools ──

const nav = await callTool('browser_navigate', { url: 'example.com' });
check(
  'browser_navigate normalizes a bare host to https',
  /已打开 https:\/\/example\.com/.test(nav.content?.[0]?.text ?? ''),
  nav.content?.[0]?.text,
);
check('browser_navigate reached for browser.navigate', calls.some((c) => c.method === 'browser.navigate'));

const state = await callTool('browser_get_state', {});
check(
  'browser_get_state reports the current page',
  /example\.com/.test(state.content?.[0]?.text ?? '') && /Example Domain/.test(state.content?.[0]?.text ?? ''),
  state.content?.[0]?.text,
);
check(
  'browser_get_state carries the interactive snapshot with a ref hint',
  /可交互元素/.test(state.content?.[0]?.text ?? '') && /browser_click/.test(state.content?.[0]?.text ?? ''),
  state.content?.[0]?.text,
);

const found = await callTool('browser_find', { query: '登录' });
check(
  'browser_find formats matches with role, text and score',
  /\[button\] "登录" \(header, 匹配度 92\)/.test(found.content?.[0]?.text ?? ''),
  found.content?.[0]?.text,
);
const notFound = await callTool('browser_find', { query: '页面上没有这个' });
check(
  'browser_find reports an empty result instead of nothing',
  /没有匹配/.test(notFound.content?.[0]?.text ?? ''),
  notFound.content?.[0]?.text,
);

const click = await callTool('browser_click', { selector: '[1]' });
check('browser_click succeeds on a live selector', /点击 "\[1\]"成功/.test(click.content?.[0]?.text ?? ''), click.content?.[0]?.text);
const clickMiss = await callTool('browser_click', { selector: '[99]' });
check(
  'browser_click surfaces the engine error and its suggestions',
  /点击 "\[99\]"失败/.test(clickMiss.content?.[0]?.text ?? '') && /Did you mean/.test(clickMiss.content?.[0]?.text ?? ''),
  clickMiss.content?.[0]?.text,
);

const fill = await callTool('browser_fill', { selector: '[2]', value: 'hello' });
check('browser_fill forwards selector and value', /填写 "\[2\]"成功/.test(fill.content?.[0]?.text ?? ''), fill.content?.[0]?.text);

const hover = await callTool('browser_hover', { selector: '[1]' });
check('browser_hover succeeds', /悬停 "\[1\]"成功/.test(hover.content?.[0]?.text ?? ''), hover.content?.[0]?.text);

const select = await callTool('browser_select', { selector: '[2]', value: 'option-a' });
check('browser_select forwards the option value', /选中 "option-a"/.test(select.content?.[0]?.text ?? ''), select.content?.[0]?.text);

const scroll = await callTool('browser_scroll', { direction: 'up', amount: 300 });
check('browser_scroll reports direction and amount', /向上滚动 300px/.test(scroll.content?.[0]?.text ?? ''), scroll.content?.[0]?.text);

const evaluated = await callTool('browser_evaluate', { expression: '({h1: document.title})' });
check(
  'browser_evaluate returns the JSON value',
  /"h1":\s*"Example Domain"/.test(evaluated.content?.[0]?.text ?? ''),
  evaluated.content?.[0]?.text,
);

const walk = await callTool('browser_walk', { goal: '进入个人设置页' });
check(
  'browser_walk reports the path and final page',
  /已到达目标 "进入个人设置页"/.test(walk.content?.[0]?.text ?? '') && /2\. 点击 "个人资料"/.test(walk.content?.[0]?.text ?? ''),
  walk.content?.[0]?.text,
);

// Truncation: a huge snapshot must be cut with a pointer at browser_find.
snapshotText = 'x'.repeat(9001);
const truncated = await callTool('browser_get_state', {});
snapshotText = '[button] "登录" ref=[1]\n[input] "搜索" ref=[2]';
check(
  'an oversized snapshot is truncated with a browser_find pointer',
  /快照已截断/.test(truncated.content?.[0]?.text ?? '') && /browser_find/.test(truncated.content?.[0]?.text ?? ''),
  truncated.content?.[0]?.text?.slice(-80),
);

const shot = await callTool('browser_screenshot', {});
check('browser_screenshot returns an image block', shot.content?.[1]?.type === 'image');
check('browser_screenshot carries a png mime type', shot.content?.[1]?.mimeType === 'image/png');
check(
  'browser_screenshot sizes the image in its text',
  /KB PNG/.test(shot.content?.[0]?.text ?? ''),
  shot.content?.[0]?.text,
);

const missing = await callTool('browser_something_else', {}).catch((e) => ({ error: e.message }));
check(
  'an unknown tool errors instead of returning nothing',
  /unknown tool/.test(missing.error ?? ''),
  JSON.stringify(missing),
);

// ── panel (data plane): the address-bar page ──
// The real flow: ui-port lands → page frames flow over it. The fake port
// records what the backend pushes and lets us play page frames back in.

const panelSent = [];
let panelListener = null;
const panelPort = {
  postMessage(msg) { panelSent.push(msg); },
  on(event, listener) { if (event === 'message') panelListener = listener; },
  start() {},
};
// The `ui-port` message carries the port in event.ports, not data.
hostListener?.({ data: { type: 'ui-port' }, ports: [panelPort] });

function panelRequest(id, method, params) {
  panelListener?.({ data: { kind: 'request', id, panelId: 'browser', method, params } });
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      const hit = panelSent.find((m) => m.kind === 'response' && m.id === id);
      if (hit) { clearInterval(timer); resolve(hit); }
    }, 5);
    setTimeout(() => { clearInterval(timer); resolve(null); }, 2000);
  });
}

// panel.mounted is a lifecycle frame the host raises; the backend should
// register the panel and push the current URL.
panelListener?.({ data: { kind: 'event', panelId: 'browser', event: 'panel.mounted', data: { params: {} } } });
await new Promise((r) => setTimeout(r, 60));
check(
  'panel.mounted pushes the current URL to the panel',
  panelSent.some((m) => m.kind === 'event' && m.event === 'ui.urlChanged' && /example\.com/.test(m.data?.url ?? '')),
  JSON.stringify(panelSent),
);

const navReq = await panelRequest('q1', 'nav.open', { url: 'example.org' });
check(
  'panel nav.open reaches browser.navigate and answers ok',
  calls.some((c) => c.method === 'browser.navigate' && c.params.url === 'https://example.org') &&
    navReq?.ok === true && navReq?.result?.url === 'https://example.org',
  JSON.stringify(navReq),
);

await panelRequest('q2', 'nav.back');
await panelRequest('q3', 'nav.forward');
await panelRequest('q4', 'nav.reload');
check(
  'panel back/forward/reload reach their capabilities',
  ['browser.back', 'browser.forward', 'browser.reload'].every((m) => calls.some((c) => c.method === m)),
  calls.map((c) => c.method).join(','),
);

const stateReq = await panelRequest('q5', 'state.get');
check(
  'panel state.get uses the lightweight browser.getUrl (no full snapshot)',
  calls.some((c) => c.method === 'browser.getUrl') && stateReq?.ok === true && 'url' in (stateReq?.result ?? {}),
  JSON.stringify(stateReq),
);

const unknownReq = await panelRequest('q6', 'does.not.exist', {});
check(
  'an unknown panel method is rejected with the known list',
  unknownReq?.ok === false && /unknown panel method/.test(unknownReq?.error ?? ''),
  JSON.stringify(unknownReq),
);

// host-event: agent navigated somewhere → the address bar must hear about it.
panelSent.length = 0;
sendToBackend({ type: 'host-event', event: 'browser.urlChanged', data: { url: 'https://agent-opened.example' } });
await new Promise((r) => setTimeout(r, 60));
check(
  'browser.urlChanged host event is relayed to the mounted panel',
  panelSent.some((m) => m.kind === 'event' && m.event === 'ui.urlChanged' && m.data?.url === 'https://agent-opened.example'),
  JSON.stringify(panelSent),
);

check('every capability call carried a method and params', calls.every((c) => typeof c.method === 'string'));

console.log(`\n${failures === 0 ? '✓ all checks passed' : `✗ ${failures} check(s) failed`}`);
process.exit(failures ? 1 : 0);
