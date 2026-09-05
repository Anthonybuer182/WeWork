/**
 * com.pi.browser backend — the P4 benchmark plugin.
 *
 * Panels: preview (liveview — the host BrowserView mounts there) +
 * control (Tier 0 iframe toolbar, companion of preview).
 * Tools: browser_navigate / browser_get_state / browser_screenshot.
 * Host events: browser.urlChanged keeps the toolbar in sync.
 */

const state = { uiPort: null, dataDir: '' };
let seq = 0;
const pending = new Map();

const post = (msg) => process.parentPort.postMessage(msg);
const log = (level, message) => post({ type: 'log', level, message });

function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = 'c' + (++seq);
    pending.set(id, { resolve, reject });
    post({ type: 'call', id, method, params });
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`capability timeout: ${method}`));
    }, 60_000);
  });
}

const uiPost = (payload) => {
  try { state.uiPort?.postMessage(payload); } catch { /* port closed */ }
};
const renderToolbar = (url) =>
  uiPost({ kind: 'event', event: 'ui.render', panelId: 'control', data: { url: url ?? '' } });

let currentUrl = '';

async function refreshToolbar() {
  try {
    const st = await call('browser.getState');
    currentUrl = st?.url ?? '';
  } catch { /* browser not ready yet */ }
  renderToolbar(currentUrl);
}

function normalizeUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('missing url');
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}

// ── Agent tools ──
async function onTool(msg) {
  const { id, name, params } = msg;
  const p = params ?? {};

  switch (name) {
    case 'browser_navigate': {
      const url = normalizeUrl(p.url);
      const result = await call('browser.navigate', { url });
      currentUrl = result?.url ?? url;
      renderToolbar(currentUrl);
      post({
        type: 'tool-result',
        id,
        content: [{ type: 'text', text: `已打开 ${currentUrl}${result?.title ? ` — ${result.title}` : ''}` }],
      });
      return;
    }
    case 'browser_get_state': {
      const st = await call('browser.getState');
      currentUrl = st?.url ?? currentUrl;
      renderToolbar(currentUrl);
      post({
        type: 'tool-result',
        id,
        content: [{ type: 'text', text: `当前页面: ${st?.url ?? '(about:blank)'}${st?.title ? ` — ${st.title}` : ''}` }],
      });
      return;
    }
    case 'browser_screenshot': {
      const shot = await call('browser.screenshot', { fullPage: p.fullPage === true });
      if (!shot?.base64) throw new Error('screenshot failed');
      post({
        type: 'tool-result',
        id,
        content: [
          { type: 'text', text: `截图完成 (${Math.round((shot.base64.length * 3) / 4 / 1024)} KB PNG)` },
          { type: 'image', data: shot.base64, mimeType: 'image/png' },
        ],
      });
      return;
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// ── Host events ──
function onHostEvent(event, data) {
  if (event === 'browser.urlChanged') {
    currentUrl = data?.url ?? currentUrl;
    renderToolbar(currentUrl);
  }
}

// ── Panel events (control toolbar) ──
async function onUiEvent(eventId, data) {
  switch (eventId) {
    case 'browser-open': {
      const url = normalizeUrl(data);
      const result = await call('browser.navigate', { url });
      currentUrl = result?.url ?? url;
      break;
    }
    case 'browser-back': await call('browser.back'); break;
    case 'browser-forward': await call('browser.forward'); break;
    case 'browser-reload': await call('browser.reload'); break;
  }
  renderToolbar(currentUrl);
}

// ── Message pump ──
process.parentPort.on('message', (event) => {
  const msg = event.data || {};
  switch (msg.type) {
    case 'init':
      refreshToolbar().catch(() => renderToolbar(''));
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
      onTool(msg).catch((e) =>
        post({ type: 'tool-result', id: msg.id, error: e instanceof Error ? e.message : String(e) }));
      break;
    case 'host-event':
      onHostEvent(msg.event, msg.data);
      break;
    case 'ui-port': {
      const port = event.ports?.[0];
      if (!port) break;
      state.uiPort = port;
      port.on('message', (ev) => {
        const p = ev.data;
        if (p?.kind !== 'event') return;
        if (p.event === 'panel.mounted') {
          refreshToolbar().catch(() => {});
        } else if (p.event === 'ui.event' && p.panelId === 'control') {
          onUiEvent(p.data?.eventId, p.data?.data).catch(() => {});
        }
      });
      if (typeof port.start === 'function') port.start();
      break;
    }
  }
});

post({ type: 'ready' });
