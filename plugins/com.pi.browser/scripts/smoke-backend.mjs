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
        case 'browser.getState':
          sendToBackend({ type: 'call-result', id: msg.id, result: { url: currentUrl, title: currentTitle } });
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

check('every capability call carried a method and params', calls.every((c) => typeof c.method === 'string'));

console.log(`\n${failures === 0 ? '✓ all checks passed' : `✗ ${failures} check(s) failed`}`);
process.exit(failures ? 1 : 0);
