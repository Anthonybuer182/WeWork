/**
 * com.pi.todo backend — task panel + agent tools (todo_add/todo_list/todo_done).
 *
 * State lives here (storage capability); the panel is a pure projection.
 * todo_add returns a declarative card (messageRenderer: todo_add).
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
  uiPost({ kind: 'event', event: 'ui.render', panelId: 'tasks', data: panelData() });

// ── State (backend-owned; storage-persisted) ──
let tasks = []; // { id, title, note?, done, createdAt }

function panelData() {
  return { tasks, open: tasks.filter((t) => !t.done).length };
}

async function load() {
  const saved = await call('storage.get', { key: 'tasks' }).catch(() => undefined);
  tasks = Array.isArray(saved) ? saved : [];
}

async function save() {
  await call('storage.set', { key: 'tasks', value: tasks }).catch(() => {});
  render();
}

function addTask(title, note) {
  const task = {
    id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title: String(title).slice(0, 200),
    note: note ? String(note).slice(0, 1000) : undefined,
    done: false,
    createdAt: new Date().toISOString(),
  };
  tasks = [...tasks, task];
  return task;
}

/** Declarative card attached to todo_add results (messageRenderer: todo_add). */
function taskCard(task) {
  return {
    component: 'Card',
    props: { title: '已添加待办' },
    children: [
      { component: 'KeyValue', props: { items: [['任务', task.title], ...(task.note ? [['备注', task.note]] : [])] } },
    ],
  };
}

// ── Agent tools ──
async function onTool(msg) {
  const { id, name, params } = msg;
  const p = params ?? {};
  const text = (t) => post({ type: 'tool-result', id, content: [{ type: 'text', text: t }] });

  switch (name) {
    case 'todo_add': {
      if (!p.title) throw new Error('missing title');
      const task = addTask(p.title, p.note);
      await save();
      post({ type: 'tool-result', id, content: [{ type: 'text', text: `已添加待办: ${task.title}` }], card: taskCard(task) });
      return;
    }
    case 'todo_list': {
      if (tasks.length === 0) return text('当前没有待办任务。');
      const lines = tasks.map((t) => `${t.done ? '✓' : '○'} ${t.title}${t.note ? ` — ${t.note}` : ''}`);
      return text(`待办(${tasks.filter((t) => !t.done).length} 项进行中):\n${lines.join('\n')}`);
    }
    case 'todo_done': {
      const title = String(p.title ?? '').trim();
      const task = [...tasks].reverse().find((t) => !t.done && t.title.includes(title));
      if (!task) throw new Error(`未找到未完成的待办: ${title}`);
      task.done = true;
      await save();
      return text(`已完成待办: ${task.title}`);
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// ── Panel events ──
async function onUiEvent(eventId, data) {
  switch (eventId) {
    case 'task-add': {
      const title = String(data ?? '').trim();
      if (title) { addTask(title); await save(); }
      break;
    }
    case 'task-toggle': {
      const task = tasks.find((t) => String(t.id) === String(data?.key));
      if (task) { task.done = !task.done; await save(); }
      break;
    }
    case 'task-delete': {
      tasks = tasks.filter((t) => String(t.id) !== String(data?.key));
      await save();
      break;
    }
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
    case 'ui-port': {
      const port = event.ports?.[0];
      if (!port) break;
      state.uiPort = port;
      port.on('message', (ev) => {
        const p = ev.data;
        if (p?.kind !== 'event') return;
        if (p.event === 'panel.mounted' && p.panelId === 'tasks') {
          render();
        } else if (p.event === 'ui.event' && p.panelId === 'tasks') {
          onUiEvent(p.data?.eventId, p.data?.data).catch(() => {});
        }
      });
      if (typeof port.start === 'function') port.start();
      break;
    }
  }
});

post({ type: 'ready' });
