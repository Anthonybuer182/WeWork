/**
 * P2 acceptance test — panel host + Tier 0 + command registry.
 *
 * Checks (raw CDP over the app's debug port 19222, zero deps):
 *  1. Rail lists host panels + plugin panels through one registry
 *  2. Declarative (Tier 0) panel renders backend-owned state
 *  3. Event loopback: clicking a button updates the tree via the backend
 *  4. No-focus-steal: panel.open(focus=false) badges without switching
 *  5. Host panels run through the same API (settings = zeroth contributor)
 *  6. keepAlive "always": hidden iframe panel stays alive
 *  7. Plugin command "/hello" executes end-to-end and focuses its panel
 *  8. P1 regression: iframe data-plane ping still works
 */
const CDP_HTTP = 'http://127.0.0.1:19222';
const PLUGIN_ID = 'com.pi.hello';
const HELLO_ID = `plugin:${PLUGIN_ID}:hello`;
const DEMO_ID = `plugin:${PLUGIN_ID}:demo`;

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

async function listTargets() {
  return (await fetch(`${CDP_HTTP}/json/list`)).json();
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

async function waitFor(session, expression, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await evaluate(session, expression);
    if (v) return v;
    await sleep(300);
  }
  return null;
}

// ── find the main window ──
let targets = await listTargets();
const pageTarget = targets.find((t) => t.type === 'page' && t.url.includes('localhost:517'));
if (!pageTarget) {
  fail('find renderer page', targets.map((t) => `${t.type}:${t.url}`).join(', '));
  process.exit(1);
}
const page = await connect(pageTarget.webSocketDebuggerUrl);
await page.send('Runtime.enable', {});

// ensure the right panel is expanded
const expanded = await evaluate(
  page,
  `(() => {
    if (document.querySelector('[data-testid="panel-slot"]')) return true;
    // 右栏默认收起(rail-only)— 点插件中心图标展开(人为打开语义)
    const btn = document.querySelector('[data-panel-id="host:plugins"]');
    if (btn) { btn.click(); return 'clicked'; }
    return false;
  })()`,
);
if (!expanded) {
  fail('right panel expandable', 'no panel-slot and no rail plugins button');
  process.exit(1);
}
if (expanded === 'clicked') await sleep(800);

// ── 1 · Rail: unified registry ──
const railPanels = await waitFor(
  page,
  `(() => {
    const btns = [...document.querySelectorAll('[data-panel-id]')].map(b => b.getAttribute('data-panel-id'));
    const expected = ['host:preview', 'host:settings', 'host:plugins', '${HELLO_ID}', '${DEMO_ID}'];
    return expected.every(id => btns.includes(id)) ? btns : null;
  })()`,
);
railPanels
  ? ok(`rail lists host + plugin panels (${railPanels.length} entries: ${railPanels.join(', ')})`)
  : fail('rail lists host + plugin panels', 'missing expected panel ids');

const railActivate = (id) =>
  evaluate(
    page,
    `(() => {
      const btn = document.querySelector('[data-panel-id="${id}"]');
      if (!btn) return false;
      btn.click();
      return true;
    })()`,
  );

const chromeTitle = () => evaluate(page, `document.querySelector('[data-testid="panel-chrome"]')?.getAttribute('data-panel-title') ?? null`);

async function findPluginTarget() {
  for (let i = 0; i < 20; i++) {
    const t = (await listTargets()).find((x) => x.url.startsWith('pi-plugin://com.pi.hello'));
    if (t) return t;
    await sleep(400);
  }
  return null;
}

// ── 2 · Hello iframe panel mounts first (keepAlive "always" baseline) ──
await railActivate(HELLO_ID);
const helloTitle = await waitFor(page, `document.querySelector('[data-testid="panel-chrome"]')?.getAttribute('data-panel-title') === 'Hello'`);
helloTitle ? ok('Hello iframe panel activates') : fail('Hello iframe panel activates', `title=${await chromeTitle()}`);
const pluginTarget = await findPluginTarget();
pluginTarget
  ? ok('pi-plugin iframe target mounted (unique origin)')
  : fail('pi-plugin iframe target mounted', 'target not found');

// ── 3 · Tier 0 declarative panel ──
await railActivate(DEMO_ID);
const demoMounted = await waitFor(
  page,
  `(() => (document.querySelector('[data-panel-kind="declarative"]')?.textContent.match(/当前计数:(\\d+)/) ?? [])[1] ?? null)()`,
);
if (!demoMounted) {
  fail('Tier 0 declarative panel renders', '当前计数 not found');
} else {
  ok(`Tier 0 declarative panel renders backend-owned tree (计数=${demoMounted}, backend state survives panel remounts)`);

  // ── 4 · Event loopback (stateless: expect current+1) ──
  await evaluate(
    page,
    `(() => {
      const btns = [...document.querySelectorAll('[data-panel-kind="declarative"] button')];
      btns.find(b => b.textContent.trim() === '+1')?.click();
      return true;
    })()`,
  );
  const expected = String(Number(demoMounted) + 1);
  const countUpdated = await waitFor(
    page,
    `(() => (document.querySelector('[data-panel-kind="declarative"]')?.textContent.match(/当前计数:(\\d+)/) ?? [])[1] === '${expected}')()`,
  );
  countUpdated
    ? ok(`event loopback: +1 click → backend state update → re-render (计数=${expected})`)
    : fail('event loopback', `计数 did not update to ${expected}`);
}

// ── 5 · No-focus-steal ──
await evaluate(
  page,
  `(() => {
    const btns = [...document.querySelectorAll('[data-panel-kind="declarative"] button')];
    btns.find(b => b.textContent.includes('静默打开'))?.click();
    return true;
  })()`,
);
await sleep(800);
const afterQuiet = await evaluate(
  page,
  `(() => ({
    activeTitle: document.querySelector('[data-testid="panel-chrome"]')?.getAttribute('data-panel-title') ?? null,
    helloPending: document.querySelector('[data-panel-id="${HELLO_ID}"]')?.getAttribute('data-pending') ?? null,
  }))()`,
);
afterQuiet.activeTitle === 'Demo' && afterQuiet.helloPending === 'true'
  ? ok('no-focus-steal: panel.open(focus=false) → pending badge, active panel unchanged')
  : fail('no-focus-steal', JSON.stringify(afterQuiet));

// ── 6 · Host panel via the same API (zeroth contributor) ──
await railActivate('host:settings');
const settingsTitle = await waitFor(page, `document.querySelector('[data-testid="panel-chrome"]')?.getAttribute('data-panel-title') === '设置'`);
const settingsRendered = await waitFor(
  page,
  `(() => !!document.querySelector('[data-panel-container="host:settings"] input, [data-panel-container="host:settings"] button'))()`,
);
settingsTitle && settingsRendered
  ? ok('host settings panel runs through the same panel registry (zeroth contributor)')
  : fail('host settings panel', `title=${settingsTitle} rendered=${settingsRendered}`);

// ── 7 · keepAlive "always": hidden hello iframe stays alive ──
await sleep(500);
targets = await listTargets();
const hiddenIframeAlive = targets.some((t) => t.url.startsWith('pi-plugin://com.pi.hello'));
hiddenIframeAlive
  ? ok('keepAlive=always: hidden plugin iframe stays mounted while settings is active')
  : fail('keepAlive=always', 'pi-plugin target disappeared');

// ── 8 · Plugin command "/hello" end-to-end ──
await evaluate(
  page,
  `(() => {
    const el = document.querySelector('div[contenteditable="true"][data-placeholder]');
    if (!el) return 'no-input';
    el.focus();
    el.textContent = '/hello';
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    return true;
  })()`,
);
// The slash menu should list the plugin-contributed command.
const menuHasCommand = await waitFor(
  page,
  `(() => [...document.querySelectorAll('[data-index]')].some(el => el.textContent.includes('/hello')))()`,
);
menuHasCommand
  ? ok('plugin command /hello appears in the composer slash menu (registry-driven)')
  : fail('plugin command in slash menu', 'menu item /hello not found');

// Enter #1 selects the highlighted menu item (chip insert), Enter #2 submits.
await evaluate(
  page,
  `(() => {
    const el = document.querySelector('div[contenteditable="true"][data-placeholder]');
    el?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return true;
  })()`,
);
await sleep(400);
await evaluate(
  page,
  `(() => {
    const el = document.querySelector('div[contenteditable="true"][data-placeholder]');
    el?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return true;
  })()`,
);
const helloFocused = await waitFor(
  page,
  `document.querySelector('[data-testid="panel-chrome"]')?.getAttribute('data-panel-title') === 'Hello'`,
  12_000,
);
helloFocused
  ? ok('plugin command /hello → backend command → panel.open(focus) switches to Hello panel')
  : fail('plugin command /hello', `chrome title = ${await chromeTitle()}`);

// ── 9 · P1 regression: data plane ping ──
const pingTarget = await findPluginTarget();
if (pingTarget) {
  const plugin = await connect(pingTarget.webSocketDebuggerUrl);
  await plugin.send('Runtime.enable', {});
  const ping = await evaluate(
    plugin,
    `new Promise(res => { const t = setTimeout(() => res('TIMEOUT'), 5000); window.piSDK.request('ping').then(r => { clearTimeout(t); res(r); }).catch(e => { clearTimeout(t); res('ERR:' + e.message); }); })`,
  );
  typeof ping === 'object' && ping.pong
    ? ok('P1 regression: iframe data-plane ping still works')
    : fail('P1 regression ping', JSON.stringify(ping));
  plugin.close();
} else {
  fail('P1 regression ping', 'plugin iframe target not found');
}

page.close();
console.log(process.exitCode ? '\nRESULT: FAIL' : '\nRESULT: ALL PASS');
process.exit(process.exitCode ?? 0);
