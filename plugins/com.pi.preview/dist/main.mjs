/**
 * com.pi.preview backend — text-class file preview (txt/md/json/log).
 *
 * Panel: preview (declarative — the backend streams UiNode trees, no UI files).
 * filePreview: txt | md | json | log → this panel opens with params {file}.
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
const renderTree = (tree) => uiPost({ kind: 'event', event: 'ui.render', panelId: 'preview', data: { tree } });

const MAX_CHARS = 100_000;

function buildTree({ fileName, ext, text, size, error }) {
  const children = [];
  if (error) {
    children.push({ component: 'Text', props: { text: fileName ?? '文件', variant: 'title', weight: 'bold' } });
    children.push({ component: 'Separator' });
    children.push({ component: 'EmptyState', props: { title: '无法预览', description: String(error) } });
    return { component: 'Column', props: { size: 'md' }, children };
  }
  let content = text ?? '';
  let truncated = false;
  if (content.length > MAX_CHARS) {
    content = content.slice(0, MAX_CHARS);
    truncated = true;
  }
  if (ext === 'json') {
    try { content = JSON.stringify(JSON.parse(content), null, 2); } catch { /* keep raw */ }
  }
  children.push({ component: 'Text', props: { text: fileName, variant: 'title', weight: 'bold' } });
  children.push({
    component: 'Text',
    props: { text: `${ext.toUpperCase()} · ${(size / 1024).toFixed(1)} KB${truncated ? ' · 已截断' : ''}`, variant: 'small' },
  });
  children.push({ component: 'Separator' });
  children.push({ component: 'Text', props: { text: content || '(空文件)' } });
  return { component: 'Column', props: { size: 'md' }, children };
}

function emptyTree() {
  return {
    component: 'Column',
    props: { size: 'md' },
    children: [
      { component: 'EmptyState', props: { title: '未选择文件', description: '在左侧文件树点击 txt / md / json / log 文件' } },
    ],
  };
}

async function previewFile(path) {
  const fileName = String(path).split('/').pop() ?? path;
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  try {
    const result = await call('filesystem.read', { path });
    renderTree(buildTree({ fileName, ext, text: result?.content ?? '', size: result?.size ?? 0 }));
  } catch (err) {
    log('error', `read failed: ${err instanceof Error ? err.message : String(err)}`);
    renderTree(buildTree({ fileName, ext, error: err instanceof Error ? err.message : String(err) }));
  }
}

function onPanelMounted(params) {
  const file = params?.file;
  if (typeof file === 'string' && file) previewFile(file);
  else renderTree(emptyTree());
}

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
      post({ type: 'tool-result', id: msg.id, error: 'no tools contributed' });
      break;
    case 'ui-port': {
      const port = event.ports?.[0];
      log('info', `ui-port received: ${port ? 'yes' : 'NO'}`);
      if (!port) break;
      state.uiPort = port;
      port.on('message', (ev) => {
        const p = ev.data;
        if (p?.kind === 'event' && p.event === 'panel.mounted' && p.panelId === 'preview') {
          try { onPanelMounted(p.data?.params); } catch (e) { log('error', String(e)); }
        }
      });
      if (typeof port.start === 'function') port.start();
      break;
    }
  }
});

post({ type: 'ready' });
