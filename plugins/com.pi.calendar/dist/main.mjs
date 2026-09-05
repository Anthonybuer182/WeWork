/**
 * com.pi.calendar backend — events panel + agent tools
 * (calendar_add_event / calendar_list_upcoming).
 *
 * CalDAV / Google connectors are a future revision; this revision keeps
 * local storage + reminders via notify.
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
const render = () =>
  uiPost({ kind: 'event', event: 'ui.render', panelId: 'events', data: panelData() });

// ── State ──
let events = []; // { id, title, time, note?, createdAt }
let composing = { title: '', time: '' };

function panelData() {
  return { composing, events };
}

async function load() {
  const [savedEvents, savedComposing] = await Promise.all([
    call('storage.get', { key: 'events' }).catch(() => undefined),
    call('storage.get', { key: 'composing' }).catch(() => undefined),
  ]);
  events = Array.isArray(savedEvents) ? savedEvents : [];
  composing = savedComposing && typeof savedComposing === 'object' ? savedComposing : { title: '', time: '' };
}

async function save() {
  await Promise.all([
    call('storage.set', { key: 'events', value: events }).catch(() => {}),
    call('storage.set', { key: 'composing', value: composing }).catch(() => {}),
  ]);
  render();
}

function addEvent(title, time, note) {
  const event = {
    id: 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title: String(title).slice(0, 200),
    time: String(time ?? '').slice(0, 100) || '未定时间',
    note: note ? String(note).slice(0, 500) : undefined,
    createdAt: new Date().toISOString(),
  };
  events = [...events, event];
  return event;
}

// ── Agent tools ──
async function onTool(msg) {
  const { id, name, params } = msg;
  const p = params ?? {};
  const text = (t) => post({ type: 'tool-result', id, content: [{ type: 'text', text: t }] });

  switch (name) {
    case 'calendar_add_event': {
      if (!p.title) throw new Error('missing title');
      const event = addEvent(p.title, p.time, p.note);
      await save();
      return text(`已添加日程「${event.title}」（${event.time}）`);
    }
    case 'calendar_list_upcoming': {
      if (events.length === 0) return text('当前没有日程。');
      return text(`日程(${events.length}):\n${events.map((e) => `· ${e.time} — ${e.title}${e.note ? `（${e.note}）` : ''}`).join('\n')}`);
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// ── Panel events ──
async function onUiEvent(eventId, data) {
  switch (eventId) {
    case 'event-title': composing.title = String(data ?? ''); break;
    case 'event-time': composing.time = String(data ?? ''); break;
    case 'event-add': {
      if (composing.title.trim()) {
        addEvent(composing.title, composing.time);
        composing = { title: '', time: '' };
      }
      break;
    }
    case 'event-delete':
      events = events.filter((e) => String(e.id) !== String(data?.key));
      break;
  }
  await save();
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
    case 'ui-port': {
      const port = event.ports?.[0];
      if (!port) break;
      state.uiPort = port;
      port.on('message', (ev) => {
        const p = ev.data;
        if (p?.kind !== 'event') return;
        if (p.event === 'panel.mounted' && p.panelId === 'events') {
          render();
        } else if (p.event === 'ui.event' && p.panelId === 'events') {
          onUiEvent(p.data?.eventId, p.data?.data).catch(() => {});
        }
      });
      if (typeof port.start === 'function') port.start();
      break;
    }
  }
});

post({ type: 'ready' });
