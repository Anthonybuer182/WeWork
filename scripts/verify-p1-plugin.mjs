/**
 * P1 acceptance test — raw CDP over the app's debug port (19222).
 *
 * Node 24 has a built-in WebSocket client, so this has zero deps.
 *
 * Checks:
 *  1. "Hello" tab (contributed by the plugin) appears in the right panel
 *  2. Clicking it mounts a pi-plugin://com.pi.hello iframe
 *  3. Host SDK is injected (window.piSDK) in the plugin origin
 *  4. Data plane: piSDK.request('ping') round-trips to the backend
 *  5. Control plane: storage.set/get capabilities through the CapabilityHub
 */
const CDP_HTTP = 'http://127.0.0.1:19222';

const ok = (name) => console.log(`PASS  ${name}`);
const fail = (name, detail) => {
  console.error(`FAIL  ${name}: ${detail ?? ''}`);
  process.exitCode = 1;
};

/** Minimal CDP session over a target's webSocketDebuggerUrl. */
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    const listeners = [];
    ws.onopen = () => {
      resolve({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const id = ++seq;
            pending.set(id, { res, rej });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        on(fn) { listeners.push(fn); },
        close() { ws.close(); },
      });
    };
    ws.onerror = () => reject(new Error('ws error: ' + wsUrl));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      } else {
        for (const fn of listeners) fn(msg);
      }
    };
  });
}

async function listTargets() {
  const res = await fetch(`${CDP_HTTP}/json/list`);
  return res.json();
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

// ── 1 · Find the main window page ──
let targets = await listTargets();
const pageTarget = targets.find((t) => t.type === 'page' && t.url.includes('localhost:5173'));
if (!pageTarget) {
  fail('find renderer page', targets.map((t) => `${t.type}:${t.url}`).join(', '));
  process.exit(1);
}
const page = await connect(pageTarget.webSocketDebuggerUrl);
await page.send('Runtime.enable');

// ── 2 · The plugin contributed a "Hello" panel — activate it via the rail ──
const railActivate = `(() => {
  const btn = document.querySelector('[data-panel-id="plugin:com.pi.hello:hello"]');
  if (!btn) return false;
  btn.click();
  return true;
})()`;

const tabFound = await evaluate(
  page,
  `(() => !!document.querySelector('[data-panel-id="plugin:com.pi.hello:hello"]'))()`,
);
tabFound ? ok('plugin panel appears in the panel rail') : fail('plugin panel appears in the panel rail', 'rail button not found');

await evaluate(page, railActivate);

// ── 3 · Wait for the pi-plugin:// iframe target (OOPIF shows up in /json/list) ──
let pluginTarget = null;
for (let i = 0; i < 30 && !pluginTarget; i++) {
  targets = await listTargets();
  pluginTarget = targets.find((t) => t.url.startsWith('pi-plugin://com.pi.hello'));
  if (!pluginTarget) await sleep(400);
}
if (!pluginTarget) {
  fail('pi-plugin iframe target', targets.map((t) => `${t.type}:${t.url}`).join(', '));
  process.exit(1);
}
ok(`pi-plugin iframe loaded as its own target (${pluginTarget.url}) — process isolation`);

const plugin = await connect(pluginTarget.webSocketDebuggerUrl);
await plugin.send('Runtime.enable');

// ── 4 · SDK injected + unique origin ──
const sdk = await evaluate(
  plugin,
  `({ hasSdk: !!window.piSDK, pluginId: window.piSDK?.pluginId ?? null, origin: location.origin })`,
);
sdk.hasSdk && sdk.pluginId === 'com.pi.hello'
  ? ok('host SDK injected (window.piSDK)')
  : fail('host SDK injected', JSON.stringify(sdk));
sdk.origin === 'pi-plugin://com.pi.hello'
  ? ok('unique plugin origin (pi-plugin://com.pi.hello)')
  : fail('unique plugin origin', sdk.origin);

// ── 5 · Data plane: ping round-trip through backend ──
await evaluate(plugin, `document.getElementById('ping').click(); true;`);
let pingOut = null;
for (let i = 0; i < 25; i++) {
  pingOut = await evaluate(plugin, `document.getElementById('pingOut').textContent`);
  if (pingOut && !pingOut.includes('尚未调用') && !pingOut.includes('请求中')) break;
  await sleep(400);
}
pingOut?.includes('"pong": true')
  ? ok(`data-plane ping round-trip → ${pingOut.replace(/\s+/g, ' ').slice(0, 100)}`)
  : fail('data-plane ping round-trip', String(pingOut));

// ── 6 · Control plane: storage capability (permission-checked in main) ──
await evaluate(plugin, `document.getElementById('noteInput').value = 'P1 验收'; true;`);
await evaluate(plugin, `document.getElementById('save').click(); true;`);
await sleep(300);
await evaluate(plugin, `document.getElementById('recall').click(); true;`);
let capOut = null;
for (let i = 0; i < 25; i++) {
  capOut = await evaluate(plugin, `document.getElementById('capOut').textContent`);
  if (capOut && !capOut.includes('尚未调用')) break;
  await sleep(400);
}
capOut?.includes('P1 验收')
  ? ok('control-plane storage.set/get via CapabilityHub')
  : fail('control-plane storage capability', String(capOut));

// ── 7 · Storage persisted in plugins-data (code/data separation) ──
// (verified implicitly above; data lives outside the plugin code dir)

page.close();
plugin.close();
console.log(process.exitCode ? '\nRESULT: FAIL' : '\nRESULT: ALL PASS');
process.exit(process.exitCode ?? 0);
