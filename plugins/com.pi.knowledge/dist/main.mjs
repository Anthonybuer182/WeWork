/**
 * com.pi.knowledge backend — knowledge base panel + agent tools
 * (kb_save / kb_search / kb_list) + kb.save-selection selection action
 * + kb.auto context provider (auto-inject before each message send,
 * gated by the autoContext setting).
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

// ── State ──
let entries = []; // { id, title, content, createdAt }
let search = '';

function matches(entry, query) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    entry.title.toLowerCase().includes(q) ||
    (entry.content ?? '').toLowerCase().includes(q)
  );
}

function panelData() {
  const shown = entries.filter((e) => matches(e, search));
  return { total: entries.length, search, shown };
}

const render = () =>
  uiPost({ kind: 'event', event: 'ui.render', panelId: 'kb', data: panelData() });

async function load() {
  const saved = await call('storage.get', { key: 'entries' }).catch(() => undefined);
  entries = Array.isArray(saved) ? saved : [];
}

async function save() {
  await call('storage.set', { key: 'entries', value: entries }).catch(() => {});
  render();
}

function addEntry(title, content) {
  const entry = {
    id: 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title: String(title).slice(0, 200),
    content: String(content ?? '').slice(0, 50_000),
    createdAt: new Date().toISOString(),
  };
  entries = [...entries, entry];
  return entry;
}

/** Keyword retrieval for the context provider: score by query-term overlap. */
function retrieve(message, limit = 5) {
  const terms = String(message)
    .toLowerCase()
    .split(/[\s,，。.;；:：?？!！()（）"'「」\[\]]+/)
    .filter((t) => t.length >= 2)
    .slice(0, 30);
  if (terms.length === 0) return [];
  return entries
    .map((e) => {
      const haystack = `${e.title}\n${e.content ?? ''}`.toLowerCase();
      const score = terms.reduce((acc, t) => acc + (haystack.includes(t) ? 1 : 0), 0);
      return { entry: e, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.entry);
}

// ── Agent tools ──
async function onTool(msg) {
  const { id, name, params } = msg;
  const p = params ?? {};
  const text = (t) => post({ type: 'tool-result', id, content: [{ type: 'text', text: t }] });

  switch (name) {
    case 'kb_save': {
      if (!p.title) throw new Error('missing title');
      const entry = addEntry(p.title, p.content);
      await save();
      return text(`已保存知识「${entry.title}」(${entry.content.length} 字符)`);
    }
    case 'kb_search': {
      const hits = entries.filter((e) => matches(e, String(p.query ?? '')));
      if (hits.length === 0) return text(`没有匹配「${p.query}」的知识条目。`);
      return text(hits.map((e) => `【${e.title}】\n${String(e.content).slice(0, 500)}`).join('\n\n'));
    }
    case 'kb_list': {
      if (entries.length === 0) return text('知识库为空。');
      return text(`知识库(${entries.length} 条):\n${entries.map((e) => `· ${e.title}`).join('\n')}`);
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// ── Selection action: kb.save-selection ──
async function onSelection(msg) {
  if (msg.actionId !== 'kb.save-selection') throw new Error(`unknown action: ${msg.actionId}`);
  const text = String(msg.text ?? '').slice(0, 50_000);
  const source = msg.source?.label ? `（来源: ${msg.source.label}）` : '';
  const entry = addEntry(text.split('\n')[0].slice(0, 60) || '选中内容', text + source);
  await save();
  return { ok: true, entryId: entry.id, title: entry.title };
}

// ── Context provider: kb.auto ──
async function onContextRequest(msg) {
  if (msg.providerId !== 'kb.auto') throw new Error(`unknown provider: ${msg.providerId}`);
  const setting = await call('storage.get', { key: 'settings.autoContext' }).catch(() => undefined);
  const enabled = typeof setting === 'boolean' ? setting : true; // manifest default: true
  if (!enabled) return undefined;
  const hits = retrieve(String(msg.message ?? ''));
  if (hits.length === 0) return undefined;
  return hits.map((e) => `【${e.title}】\n${String(e.content).slice(0, 800)}`).join('\n\n');
}

// ── Panel events ──
async function onUiEvent(eventId, data) {
  switch (eventId) {
    case 'kb-add': {
      const title = String(data ?? '').trim();
      if (title) { addEntry(title, ''); await save(); }
      break;
    }
    case 'kb-search':
      search = String(data ?? '');
      render();
      break;
    case 'kb-delete':
      entries = entries.filter((e) => String(e.id) !== String(data?.key));
      await save();
      break;
  }
}

// ── Message pump ──
process.parentPort.on('message', (event) => {
  const msg = event.data || {};
  switch (msg.type) {
    case 'init':
      load()
        .then(render)
        .catch((e) => log('error', `load failed: ${e.message}`));
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
    case 'selection-action':
      onSelection(msg)
        .then((result) => post({ type: 'command-result', id: msg.id, result }))
        .catch((e) => post({ type: 'command-result', id: msg.id, error: String(e.message ?? e) }));
      break;
    case 'context-request':
      onContextRequest(msg)
        .then((text) => post({ type: 'context-result', id: msg.id, text: text ?? undefined }))
        .catch((e) => post({ type: 'context-result', id: msg.id, error: String(e.message ?? e) }));
      break;
    case 'ui-port': {
      const port = event.ports?.[0];
      if (!port) break;
      state.uiPort = port;
      port.on('message', (ev) => {
        const p = ev.data;
        if (p?.kind !== 'event') return;
        if (p.event === 'panel.mounted' && p.panelId === 'kb') {
          render();
        } else if (p.event === 'ui.event' && p.panelId === 'kb') {
          onUiEvent(p.data?.eventId, p.data?.data).catch(() => {});
        }
      });
      if (typeof port.start === 'function') port.start();
      break;
    }
  }
});

post({ type: 'ready' });
