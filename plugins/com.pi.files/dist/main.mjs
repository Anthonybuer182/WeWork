/**
 * com.pi.files backend — hi-fi office viewer (docx/pptx/xlsx/pdf/xls/csv).
 *
 * Panel: viewer (hidden iframe, ui-dist). The viewer fetches file bytes
 * itself via pi-plugin://com.pi.files/ws-file?path=…; the backend only
 * pushes the current path on panel.mounted({file}) and handles the
 * file-save write-back (with mtime conflict detection).
 * Tools: files_probe_write / files_probe_read / files_probe_open (P9a).
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
    }, 30_000);
  });
}

const uiPost = (payload) => {
  try { state.uiPort?.postMessage(payload); } catch { /* port closed */ }
};
const renderViewer = (data) =>
  uiPost({ kind: 'event', event: 'ui.render', panelId: 'viewer', data });

let currentFile = '';

function openFile(path) {
  currentFile = String(path ?? '');
  if (!currentFile) {
    renderViewer({}); // empty state
    return;
  }
  // The viewer loads content itself over ws-file; mtime rides along so the
  // first save's conflict detection has a baseline.
  renderViewer({ path: currentFile });
}

// ── Agent tools ──
async function onTool(msg) {
  const { id, name, params } = msg;
  const p = params ?? {};
  const text = (t, details) => post({ type: 'tool-result', id, content: [{ type: 'text', text: t }], details });

  switch (name) {
    case 'files_probe_write': {
      if (!p.path) throw new Error('missing path');
      const result = await call('filesystem.write', {
        path: String(p.path),
        content: String(p.content ?? ''),
        expectedMtime: typeof p.expectedMtime === 'number' ? p.expectedMtime : undefined,
      });
      return text(`已写入 ${result?.path} (${result?.size} bytes, mtime ${Math.round(Number(result?.mtime ?? 0))})`, result);
    }
    case 'files_probe_read': {
      if (!p.path) throw new Error('missing path');
      const result = await call('filesystem.read', { path: String(p.path) });
      const content = String(result?.content ?? '');
      return text(`读取 ${result?.path} (${result?.size} bytes):\n${content.slice(0, 4000)}`, result);
    }
    case 'files_probe_open': {
      const target = typeof p.path === 'string' && p.path ? String(p.path) : currentFile;
      if (!target) throw new Error('no file to open (pass path or click a file first)');
      await call('panel.open', { panelId: 'viewer', focus: true });
      openFile(target);
      return text(`已在查看器中打开 ${target}`);
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// ── Panel events ──
async function onUiEvent(eventId, data) {
  if (eventId !== 'file-save') return;
  // Viewer write-back: docx edits are saved back with mtime conflict detection.
  const { path, contentB64, expectedMtime } = data ?? {};
  if (!path || typeof contentB64 !== 'string') return;
  try {
    const result = await call('filesystem.write', {
      path: String(path),
      contentB64,
      expectedMtime: typeof expectedMtime === 'number' ? expectedMtime : undefined,
    });
    renderViewer({ saved: true, mtime: result?.mtime });
  } catch (err) {
    log('error', `file-save failed: ${err instanceof Error ? err.message : String(err)}`);
    renderViewer({ error: `保存失败: ${err instanceof Error ? err.message : String(err)}` });
  }
}

// ── Message pump ──
process.parentPort.on('message', (event) => {
  const msg = event.data || {};
  switch (msg.type) {
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
    case 'ui-port': {
      const port = event.ports?.[0];
      if (!port) break;
      state.uiPort = port;
      port.on('message', (ev) => {
        const p = ev.data;
        if (p?.kind !== 'event') return;
        if (p.event === 'panel.mounted') {
          openFile(p.data?.params?.file ?? currentFile);
        } else if (p.event === 'ui.event' && p.panelId === 'viewer') {
          onUiEvent(p.data?.eventId, p.data?.data).catch(() => {});
        }
      });
      if (typeof port.start === 'function') port.start();
      break;
    }
  }
});

post({ type: 'ready' });
