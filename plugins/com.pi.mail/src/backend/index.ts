/**
 * com.pi.mail backend — draft panel + agent tools
 * (mail_create_draft / mail_list_drafts / mail_send_draft)
 * + /mail command + mail.quote-draft selection action.
 *
 * Drafts are local (demo mail — no SMTP connector in this revision).
 */
import { plugin, type PluginContext } from '@pi/plugin-sdk';

const PANEL = 'drafts';

interface Draft {
  id: string;
  to: string;
  subject: string;
  body: string;
  sent: boolean;
  createdAt: string;
}

interface Composing {
  to: string;
  subject: string;
  body: string;
}

const EMPTY_COMPOSING: Composing = { to: '', subject: '', body: '' };

let drafts: Draft[] = [];
let composing: Composing = { ...EMPTY_COMPOSING };
let loaded = false;

// ── State ──

async function load(ctx: PluginContext): Promise<void> {
  const [savedDrafts, savedComposing] = await Promise.all([
    ctx.call('storage.get', { key: 'drafts' }).catch(() => undefined),
    ctx.call('storage.get', { key: 'composing' }).catch(() => undefined),
  ]);
  drafts = Array.isArray(savedDrafts) ? (savedDrafts as Draft[]) : [];
  composing =
    savedComposing && typeof savedComposing === 'object'
      ? (savedComposing as Composing)
      : { ...EMPTY_COMPOSING };
  loaded = true;
}

/** Load once, whoever asks first — the panel can mount before storage is read. */
async function ensureLoaded(ctx: PluginContext): Promise<void> {
  if (!loaded) await load(ctx);
}

async function save(ctx: PluginContext): Promise<void> {
  await Promise.all([
    ctx.call('storage.set', { key: 'drafts', value: drafts }).catch(() => {}),
    ctx.call('storage.set', { key: 'composing', value: composing }).catch(() => {}),
  ]);
  ctx.send(PANEL, 'ui.render', { composing, drafts });
}

function createDraft(to: unknown, subject: unknown, body: unknown): Draft {
  const draft: Draft = {
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
function draftCard(draft: Draft): unknown {
  return {
    component: 'Card',
    props: { title: '邮件草稿' },
    children: [
      {
        component: 'KeyValue',
        props: {
          items: [
            ['收件人', draft.to || '(未填)'],
            ['主题', draft.subject],
            ['状态', draft.sent ? '已发送' : '草稿'],
          ],
        },
      },
    ],
  };
}

// ── The plugin ──

plugin({
  async onInit(ctx) {
    await ensureLoaded(ctx);
  },

  async onPanelMounted(_panelId, _params, ctx) {
    await ensureLoaded(ctx);
    ctx.send(PANEL, 'ui.render', { composing, drafts });
  },

  async onTool(name, params, ctx) {
    switch (name) {
      case 'mail_create_draft': {
        const draft = createDraft(params.to, params.subject, params.body);
        await save(ctx);
        return {
          content: [
            { type: 'text', text: `已创建草稿「${draft.subject}」→ ${draft.to || '(未填收件人)'}` },
          ],
          card: draftCard(draft),
        };
      }

      case 'mail_list_drafts': {
        if (drafts.length === 0) return '草稿箱为空。';
        const lines = drafts.map(
          (d) => `${d.sent ? '[已发送]' : '[草稿]'} ${d.subject} → ${d.to}`,
        );
        return `草稿(${drafts.length}):\n${lines.join('\n')}`;
      }

      case 'mail_send_draft': {
        const subject = String(params.subject ?? '').trim();
        const draft = [...drafts]
          .reverse()
          .find((d) => !d.sent && (d.subject === subject || d.subject.startsWith(subject)));
        if (!draft) throw new Error(`未找到待发送的草稿: ${subject}`);
        draft.sent = true;
        await save(ctx);
        await ctx
          .call('notify.show', { title: '邮件已发送(演示)', body: `${draft.subject} → ${draft.to}` })
          .catch(() => {});
        return `已发送草稿「${draft.subject}」→ ${draft.to}`;
      }

      default:
        throw new Error(`unknown tool: ${name}`);
    }
  },

  async onCommand(name, _args, ctx) {
    if (name === '/mail') {
      await ctx.openPanel(PANEL);
      return { opened: PANEL };
    }
    throw new Error(`unknown command: ${name}`);
  },

  async onSelectionAction(actionId, text, ctx) {
    if (actionId !== 'mail.quote-draft') throw new Error(`unknown action: ${actionId}`);
    const draft = createDraft('', '引用内容', text.slice(0, 5000));
    await save(ctx);
    await ctx.openPanel(PANEL, { focus: false }).catch(() => {});
    return { ok: true, draftId: draft.id, subject: draft.subject };
  },

  /** One panel, so the events are named for what happened. */
  async onEvent(_panelId, event, data, ctx) {
    switch (event) {
      case 'mail.to':
        composing.to = String(data ?? '');
        break;
      case 'mail.subject':
        composing.subject = String(data ?? '');
        break;
      case 'mail.body':
        composing.body = String(data ?? '');
        break;
      case 'mail.save': {
        if (composing.subject.trim() || composing.to.trim()) {
          createDraft(composing.to, composing.subject, composing.body);
          composing = { ...EMPTY_COMPOSING };
        }
        break;
      }
      case 'mail.send': {
        const draft = drafts.find((d) => d.id === String((data as { key?: string })?.key));
        if (draft) {
          draft.sent = true;
          await ctx
            .call('notify.show', { title: '邮件已发送(演示)', body: `${draft.subject} → ${draft.to}` })
            .catch(() => {});
        }
        break;
      }
      default:
        ctx.log.warn(`ignoring unknown panel event "${String(event)}"`);
        return;
    }
    await save(ctx);
  },
});
