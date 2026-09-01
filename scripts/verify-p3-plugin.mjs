/**
 * P3 acceptance test — plugin center + marketplace distribution.
 *
 * Raw CDP over the app's debug port (19222), zero deps.
 *
 * Checks:
 *  1. Rail "+" opens the plugin center (host-contributed panel)
 *  2. Installed section lists discovered plugins (dev source)
 *  3. Catalog loads from the local static registry index
 *  4. Install flow: consent dialog → download/verify/install → activated
 *  5. Installed plugin's declarative panel works (notes + storage persist)
 *  6. Disable → gone from rail; re-enable → back
 *  7. engines negotiation: incompatible plugin install refused with reason
 *  8. Uninstall: code dir removed, plugin data retained by default
 */
const CDP_HTTP = 'http://127.0.0.1:19222';
const NOTES_ID = 'com.pi.notes';
const INCOMPAT_ID = 'com.pi.incompat';

const ok = (name) => console.log(`PASS  ${name}`);
const fail = (name, detail) => {
  console.error(`FAIL  ${name}: ${detail ?? ''}`);
  process.exitCode = 1;
};

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    ws.onopen = () =>
      resolve({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const id = ++seq;
            pending.set(id, { res, rej });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        close() { ws.close(); },
      });
    ws.onerror = () => reject(new Error('ws error: ' + wsUrl));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      }
    };
  });
}

async function evaluate(session, expression) {
  const r = await session.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval error');
  return r.result.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(session, expression, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await evaluate(session, expression);
    if (v) return v;
    await sleep(350);
  }
  return null;
}

// ── find the main window ──
const targets = await (await fetch(`${CDP_HTTP}/json/list`)).json();
const pageTarget = targets.find((t) => t.type === 'page' && t.url.includes('localhost:517'));
if (!pageTarget) {
  fail('find renderer page', targets.map((t) => `${t.type}:${t.url}`).join(', '));
  process.exit(1);
}
const page = await connect(pageTarget.webSocketDebuggerUrl);
await page.send('Runtime.enable', {});

// ensure the right panel is open
await evaluate(
  page,
  `(() => {
    if (!document.querySelector('[data-testid="panel-slot"]')) {
      // 右栏默认收起 — 点插件中心图标展开(人为打开语义)
      document.querySelector('[data-panel-id="host:plugins"]')?.click();
    }
    return true;
  })()`,
);
await sleep(400);

// ── 1 · Rail "+" opens the plugin center ──
await evaluate(page, `document.querySelector('[data-panel-id="host:plugins"]')?.click(); true`);
const centerOpen = await waitFor(
  page,
  `document.querySelector('[data-testid="panel-chrome"]')?.getAttribute('data-panel-title') === '插件中心'`,
);
centerOpen ? ok('rail "+" opens the plugin center panel') : fail('plugin center opens', 'chrome title mismatch');

// ── 2 · Installed section lists discovered plugins ──
const helloListed = await waitFor(
  page,
  `!!document.querySelector('[data-installed-plugin="com.pi.hello"]')`,
);
helloListed ? ok('installed section lists com.pi.hello (dev source)') : fail('installed list', 'com.pi.hello not listed');

// ── 3 · Catalog loads from the local static index ──
const catalogLoaded = await waitFor(
  page,
  `!!document.querySelector('[data-catalog-plugin="${NOTES_ID}"]') && !!document.querySelector('[data-catalog-plugin="${INCOMPAT_ID}"]')`,
);
catalogLoaded ? ok('catalog loads from the static registry index (2 entries)') : fail('catalog loads', 'entries not found');

// ── 4 · Install flow with permission consent ──
await evaluate(page, `document.querySelector('[data-install-trigger="${NOTES_ID}"]')?.click(); true`);
const consentShown = await waitFor(
  page,
  `(() => { const d = document.querySelector('[role="dialog"]'); return d && d.textContent.includes('storage') ? true : false; })()`,
);
consentShown ? ok('permission consent dialog lists declared permissions') : fail('consent dialog', 'not shown');

await evaluate(
  page,
  `(() => { const btns = [...document.querySelectorAll('[role="dialog"] button')]; btns.find(b => b.textContent.trim() === '确认安装')?.click(); return true; })()`,
);
const notesInstalled = await waitFor(
  page,
  `(() => {
    const el = document.querySelector('[data-installed-plugin="${NOTES_ID}"]');
    return el && el.textContent.includes('运行中') ? true : false;
  })()`,
  25_000,
);
notesInstalled ? ok('install flow: download → verify → install → activate (状态=运行中)') : fail('install flow', 'com.pi.notes not active');

// ── 5 · Installed plugin's declarative panel works ──
const notesRail = `[data-panel-id="plugin:${NOTES_ID}:notes"]`;
const railBtn = await waitFor(page, `!!document.querySelector('${notesRail}')`);
railBtn ? ok('installed plugin contributes its panel to the rail') : fail('plugin panel in rail', 'button not found');
await evaluate(page, `document.querySelector('${notesRail}')?.click(); true`);

const panelReady = await waitFor(
  page,
  `(() => document.querySelector('[data-panel-kind="declarative"]')?.textContent.includes('便签') ?? false)()`,
);
panelReady ? ok('market-installed declarative panel renders') : fail('notes panel renders', 'panel content missing');

// add a note via the declarative input (event loopback + storage capability)
const NOTE_TEXT = `P3验收便签-${Date.now()}`;
await evaluate(
  page,
  `(() => {
    const input = document.querySelector('[data-panel-kind="declarative"] input');
    if (!input) return 'no-input';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(NOTE_TEXT)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return true;
  })()`,
);
const noteAdded = await waitFor(
  page,
  `(() => document.querySelector('[data-panel-kind="declarative"]')?.textContent.includes(${JSON.stringify(NOTE_TEXT)}) ?? false)()`,
);
noteAdded ? ok('declarative event loopback: note added and persisted via storage capability') : fail('note added', 'note text not found');

// ── 6 · Disable / re-enable ──
await evaluate(page, `document.querySelector('[data-panel-id="host:plugins"]')?.click(); true`);
await sleep(300);
await evaluate(
  page,
  `(() => { document.querySelector('[data-installed-plugin="${NOTES_ID}"] [role="switch"]')?.click(); return true; })()`,
);
const disabledGone = await waitFor(
  page,
  `(() => {
    const rail = !document.querySelector('${notesRail}');
    const item = document.querySelector('[data-installed-plugin="${NOTES_ID}"]');
    return rail && item && item.textContent.includes('已禁用') ? true : false;
  })()`,
);
disabledGone ? ok('disable: panel removed from rail, state=已禁用') : fail('disable', 'notes still enabled');

await evaluate(
  page,
  `(() => { document.querySelector('[data-installed-plugin="${NOTES_ID}"] [role="switch"]')?.click(); return true; })()`,
);
const reEnabled = await waitFor(page, `!!document.querySelector('${notesRail}')`, 20_000);
reEnabled ? ok('re-enable: backend restarts, panel returns to rail') : fail('re-enable', 'rail button not back');

// ── 7 · engines negotiation refusal ──
await evaluate(page, `document.querySelector('[data-install-trigger="${INCOMPAT_ID}"]')?.click(); true`);
await sleep(300);
await evaluate(
  page,
  `(() => { const btns = [...document.querySelectorAll('[role="dialog"] button')]; btns.find(b => b.textContent.trim() === '确认安装')?.click(); return true; })()`,
);
const refusalShown = await waitFor(
  page,
  `(() => {
    const el = document.querySelector('[data-catalog-plugin="${INCOMPAT_ID}"]');
    return el && el.textContent.includes('99.0.0') ? true : false;
  })()`,
  20_000,
);
const incompatNotInstalled = await evaluate(
  page,
  `!document.querySelector('[data-installed-plugin="${INCOMPAT_ID}"]')`,
);
refusalShown && incompatNotInstalled
  ? ok('engines negotiation: incompatible plugin refused with version reason, not installed')
  : fail('engines refusal', `refusal=${refusalShown} installed=${!incompatNotInstalled}`);

// ── 8 · Uninstall with data retention ──
await evaluate(
  page,
  `(() => {
    const item = document.querySelector('[data-installed-plugin="${NOTES_ID}"]');
    const btn = item?.querySelector('button[aria-label^="卸载"]');
    btn?.click();
    return !!btn;
  })()`,
);
await sleep(300);
await evaluate(
  page,
  `(() => { const btns = [...document.querySelectorAll('[role="dialog"] button')]; btns.find(b => b.textContent.trim() === '卸载')?.click(); return true; })()`,
);
const uninstalled = await waitFor(
  page,
  `!document.querySelector('[data-installed-plugin="${NOTES_ID}"]')`,
  20_000,
);
uninstalled ? ok('uninstall: plugin removed from installed list and rail') : fail('uninstall', 'still listed');

page.close();

// ── filesystem assertions (script side) ──
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const pluginsRoot = join(homedir(), '.pi/agent/plugins');
const dataRoot = join(homedir(), '.pi/agent/plugins-data');

!existsSync(join(pluginsRoot, NOTES_ID))
  ? ok('uninstall removed the code dir (plugins/com.pi.notes)')
  : fail('uninstall code dir', 'plugins/com.pi.notes still exists');

existsSync(join(dataRoot, NOTES_ID))
  ? ok('plugin data retained by default (plugins-data/com.pi.notes)')
  : fail('data retention', 'plugins-data/com.pi.notes missing');

try {
  const storage = JSON.parse(readFileSync(join(dataRoot, NOTES_ID, 'storage.json'), 'utf-8'));
  (storage.notes ?? []).some((n) => n.text === NOTE_TEXT)
    ? ok('retained data contains the note created during the test (reinstall would restore it)')
    : fail('retained data content', JSON.stringify(storage));
} catch (err) {
  fail('retained data readable', String(err));
}

console.log(process.exitCode ? '\nRESULT: FAIL' : '\nRESULT: ALL PASS');
process.exit(process.exitCode ?? 0);
