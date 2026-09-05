/**
 * com.pi.hello backend — P1/P2 kernel acceptance plugin.
 *
 * Panels: hello (iframe, request/response via piSDK) + demo (iframe, ui.render).
 * Command: /hello — opens the hello panel.
 */

const state = { uiPort: null, dataDir: '', pluginId: 'com.pi.hello' };
let seq = 0;
const pending = new Map();

const post = (msg) => process.parentPort.postMessage(msg);
const log = (level, message) => post({ type: 'log', level, message });

/** Control-plane capability call (host.* — permission-gated in main). */
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = 'c' + (++seq);
    pending.set(id, { resolve, reject });
    post({ type: 'call', id, method, params });
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`capability timeout: ${method}`));
    }, 30_000);
  });
}

/** Data-plane helpers (MessagePort ↔ panel iframes). */
const uiPost = (payload) => {
  try { state.uiPort?.postMessage(payload); } catch { /* port closed */ }
};
const render = (panelId, data) => uiPost({ kind: 'event', event: 'ui.render', panelId, data });
const reply = (id, result, error) => uiPost({ kind: 'response', id, result, error });

// ── Plugin state ──
let demoCount = 0;

async function loadCount() {
  const saved = await call('storage.get', { key: 'demo.count' }).catch(() => undefined);
  demoCount = typeof saved === 'number' ? saved : 0;
}

async function saveCount() {
  await call('storage.set', { key: 'demo.count', value: demoCount }).catch(() => {});
}

// ── piSDK requests (hello panel) ──
async function onRequest(msg) {
  const { id, method, params } = msg;
  try {
    switch (method) {
      case 'ping':
        reply(id, { pong: true, at: new Date().toISOString(), plugin: state.pluginId });
        break;
      case 'remember':
        await call('storage.set', { key: 'hello.note', value: String(params.value ?? '') });
        reply(id, { ok: true, saved: params.value });
        break;
      case 'recall': {
        const value = await call('storage.get', { key: 'hello.note' });
        reply(id, { note: value ?? null });
        break;
      }
      case 'notify':
        await call('notify.show', { title: 'Hello 插件', body: String(params.body ?? '') });
        reply(id, { ok: true });
        break;
      default:
        reply(id, undefined, `unknown method: ${method}`);
    }
  } catch (err) {
    reply(id, undefined, err instanceof Error ? err.message : String(err));
  }
}

// ── Panel lifecycle / events ──
async function onPanelMounted(panelId) {
  if (panelId === 'demo') render('demo', { count: demoCount });
  if (panelId === 'hello') {
    // Backend → UI push channel demo (piSDK.onMessage in the panel).
    uiPost({ kind: 'event', event: 'backend-event', data: { hello: 'from backend', at: new Date().toISOString() } });
  }
}

async function onUiEvent(panelId, eventId, data) {
  if (panelId !== 'demo') return;
  switch (eventId) {
    case 'demo-increment': demoCount += 1; break;
    case 'demo-decrement': demoCount -= 1; break;
    case 'demo-reset': demoCount = 0; break;
    case 'demo-quiet-open':
      // No-focus-steal open: the rail shows a pending badge, panel not switched.
      await call('panel.open', { panelId: 'demo', focus: false });
      return;
    default: return;
  }
  await saveCount();
  render('demo', { count: demoCount });
}

// ── Commands ──
async function onCommand(msg) {
  if (msg.name === '/hello') {
    await call('panel.open', { panelId: 'hello', focus: true });
    return { opened: 'hello' };
  }
  throw new Error(`unknown command: ${msg.name}`);
}

// ── Message pump ──
process.parentPort.on('message', (event) => {
  const msg = event.data || {};
  switch (msg.type) {
    case 'init':
      state.dataDir = msg.dataDir ?? '';
      loadCount().catch((e) => log('error', `load failed: ${e.message}`));
      break;
    case 'call-result': {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result);
      }
      break;
    }
    case 'tool-call':
      post({ type: 'tool-result', id: msg.id, error: 'no tools contributed' });
      break;
    case 'command':
      onCommand(msg)
        .then((result) => post({ type: 'command-result', id: msg.id, result }))
        .catch((e) => post({ type: 'command-result', id: msg.id, error: String(e.message ?? e) }));
      break;
    case 'ui-port': {
      const port = event.ports?.[0];
      if (!port) break;
      state.uiPort = port;
      port.on('message', (ev) => {
        const p = ev.data;
        if (!p || typeof p !== 'object') return;
        if (p.kind === 'request') {
          onRequest(p).catch(() => reply(p.id, undefined, 'request handler failed'));
        } else if (p.kind === 'event') {
          if (p.event === 'panel.mounted') {
            onPanelMounted(p.data?.panelId).catch(() => {});
          } else if (p.event === 'ui.event') {
            onUiEvent(p.data?.panelId, p.data?.eventId, p.data?.data).catch(() => {});
          }
        }
      });
      if (typeof port.start === 'function') port.start();
      break;
    }
  }
});

post({ type: 'ready' });
