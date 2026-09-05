/**
 * com.pi.mail backend — draft panel + agent tools
 * (mail_create_draft / mail_list_drafts / mail_send_draft)
 * + /mail command + mail.quote-draft selection action.
 *
 * Drafts are local (demo mail — no SMTP connector in this revision).
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
  uiPost({ kind: 'event', event: 'ui.render', panelId: 'drafts', data: panelData() });

// ── State ──
let drafts = []; // { id, to, subject, body, sent, createdAt }
let composing = { to: '', subject: '', body: '' };

function panelData() {
  return { composing, drafts };
}

async function load() {
  const [savedDrafts, savedComposing] = await Promise.all([
    call('storage.get', { key: 'drafts' }).catch(() => undefined),
    call('storage.get', { key: 'composing' }).catch(() => undefined),
  ]);
  drafts = Array.isArray(savedDrafts) ? savedDrafts : [];
  composing = savedComposing && typeof savedComposing === 'object' ? savedComposing : { to: '', subject: '', body: '' };
}

async function save() {
  await Promise.all([
    call('storage.set', { key: 'drafts', value: drafts }).catch(() => {}),
    call('storage.set', { key: 'composing', value: composing }).catch(() => {}),
  ]);
  render();
}

function createDraft(to, subject, body) {
  const draft = {
    id: 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    to: String(to ?? '').slice(0, 200),
    subject: String(subject ?? '(无主题)').slice(0, 300),
    body: String(body ?? '').slice(0, 20_000),
    sent: false,
    createdAt: new Date().toISOString(),
  };
  drafts = [...drafts, draft];
  return draft;
}

/** Declarative card for mail_create_draft (messageRenderer, streaming). */
function draftCard(draft) {
  return {
    component: 'Card',
    props: { title: '邮件草稿' },
    children: [
      {
        component: 'KeyValue',
        props: { items: [['收件人', draft.to || '(未填)'], ['主题', draft.subject], ['状态', draft.sent ? '已发送' : '草稿']] },
      },
    ],
  };
}

// ── Agent tools ──
async function onTool(msg) {
  const { id, name, params } = msg;
  const p = params ?? {};
  const text = (t) => post({ type: 'tool-result', id, content: [{ type: 'text', text: t }] });

  switch (name) {
    case 'mail_create_draft': {
      const draft = createDraft(p.to, p.subject, p.body);
      await save();
      post({
        type: 'tool-result',
        id,
        content: [{ type: 'text', text: `已创建草稿「${draft.subject}」→ ${draft.to || '(未填收件人)'}` }],
        card: draftCard(draft),
      });
      return;
    }
    case 'mail_list_drafts': {
      if (drafts.length === 0) return text('草稿箱为空。');
      return text(`草稿(${drafts.length}):\n${drafts.map((d) => `${d.sent ? '[已发送]' : '[草稿]'} ${d.subject} → ${d.to}`).join('\n')}`);
    }
    case 'mail_send_draft': {
      const subject = String(p.subject ?? '').trim();
      const draft = [...drafts].reverse().find((d) => !d.sent && (d.subject === subject || d.subject.startsWith(subject)));
      if (!draft) throw new Error(`未找到待发送的草稿: ${subject}`);
      draft.sent = true;
      await save();
      await call('notify.show', { title: '邮件已发送(演示)', body: `${draft.subject} → ${draft.to}` }).catch(() => {});
      return text(`已发送草稿「${draft.subject}」→ ${draft.to}`);
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// ── /mail command ──
async function onCommand(msg) {
  if (msg.name === '/mail') {
    await call('panel.open', { panelId: 'drafts', focus: true });
    return { opened: 'drafts' };
  }
  throw new Error(`unknown command: ${msg.name}`);
}

// ── Selection action: mail.quote-draft ──
async function onSelection(msg) {
  if (msg.actionId !== 'mail.quote-draft') throw new Error(`unknown action: ${msg.actionId}`);
  const text = String(msg.text ?? '').slice(0, 5000);
  const draft = createDraft('', '引用内容', text);
  await save();
  await call('panel.open', { panelId: 'drafts', focus: false }).catch(() => {});
  return { ok: true, draftId: draft.id, subject: draft.subject };
}

// ── Panel events ──
async function onUiEvent(eventId, data) {
  switch (eventId) {
    case 'draft-to': composing.to = String(data ?? ''); break;
    case 'draft-subject': composing.subject = String(data ?? ''); break;
    case 'draft-body': composing.body = String(data ?? ''); break;
    case 'draft-save': {
      if (composing.subject.trim() || composing.to.trim()) {
        createDraft(composing.to, composing.subject, composing.body);
        composing = { to: '', subject: '', body: '' };
      }
      break;
    }
    case 'draft-send': {
      const draft = drafts.find((d) => String(d.id) === String(data?.key));
      if (draft) {
        draft.sent = true;
        await call('notify.show', { title: '邮件已发送(演示)', body: `${draft.subject} → ${draft.to}` }).catch(() => {});
      }
      break;
    }
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
    case 'command':
      onCommand(msg)
        .then((result) => post({ type: 'command-result', id: msg.id, result }))
        .catch((e) => post({ type: 'command-result', id: msg.id, error: String(e.message ?? e) }));
      break;
    case 'selection-action':
      onSelection(msg)
        .then((result) => post({ type: 'command-result', id: msg.id, result }))
        .catch((e) => post({ type: 'command-result', id: msg.id, error: String(e.message ?? e) }));
      break;
    case 'ui-port': {
      const port = event.ports?.[0];
      if (!port) break;
      state.uiPort = port;
      port.on('message', (ev) => {
        const p = ev.data;
        if (p?.kind !== 'event') return;
        if (p.event === 'panel.mounted' && p.panelId === 'drafts') {
          render();
        } else if (p.event === 'ui.event' && p.panelId === 'drafts') {
          onUiEvent(p.data?.eventId, p.data?.data).catch(() => {});
        }
      });
      if (typeof port.start === 'function') port.start();
      break;
    }
  }
});

post({ type: 'ready' });
