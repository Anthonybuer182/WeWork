/**
 * com.pi.mail backend — real mailbox + drafts.
 *
 * Two halves share this process:
 * - Mail engine (imapflow): account store, IMAP connection, the three query
 *   tools the agent uses (list / search / read).
 * - Drafts (unchanged): local drafts the agent writes and the user reviews in
 *   the panel; `mail_send_draft` gains real SMTP delivery in the next step.
 *
 * The panel talks to the engine through onRequest (account.get/save/clear,
 * box.list, mail.detail) — request/response, because the panel renders the
 * answer. Agent-facing mail state goes out through tools.
 */
import { plugin, type PluginContext } from '@pi/plugin-sdk';
import { clearAccount, loadAccount, loadPass, saveAccount } from './account';
import { ImapEngine } from './imap-engine';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PRESETS, resolveAccount } from './presets';
import { isAuthError, sendDraft, type OutgoingAttachment, type OutgoingDraft } from './smtp-sender';
import type { MailAccountInput, ResolvedAccount } from './types';

const PANEL = 'drafts';
const NOT_CONFIGURED_SEND = '尚未配置邮箱账号 — 发送前请先在「邮件」面板的「账号」页完成配置';

// ── Draft state ──

interface Draft {
  id: string;
  to: string;
  cc?: string;
  bcc?: string;
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

function createDraft(
  to: unknown,
  subject: unknown,
  body: unknown,
  cc?: unknown,
  bcc?: unknown,
): Draft {
  const draft: Draft = {
    id: 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    to: String(to ?? '').slice(0, 500),
    ...(cc ? { cc: String(cc).slice(0, 500) } : {}),
    ...(bcc ? { bcc: String(bcc).slice(0, 500) } : {}),
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
  const items: Array<[string, string]> = [
    ['收件人', draft.to || '(未填)'],
    ...(draft.cc ? ([['抄送', draft.cc]] as Array<[string, string]>) : []),
    ['主题', draft.subject],
    ['状态', draft.sent ? '已发送' : '草稿'],
  ];
  return {
    component: 'Card',
    props: { title: '邮件草稿' },
    children: [
      {
        component: 'KeyValue',
        props: { items },
      },
    ],
  };
}

// ── Mail engine wiring ──

const engine = new ImapEngine();

/**
 * Mirror of what the engine was configured with, for the SMTP path (which is
 * independent of the IMAP connection). Updated wherever configure() is.
 */
let mailAccount: ResolvedAccount | null = null;
let mailPass = '';

/**
 * The one SMTP path. Best-effort appends the raw MIME to the server's Sent
 * folder so 已发送 stays truthful; a missed sent-copy never fails the send.
 */
async function smtpSend(out: OutgoingDraft): Promise<{ response: string; sentCopy: { mailbox: string; uid: number } | null }> {
  if (!mailAccount) throw new Error(NOT_CONFIGURED_SEND);
  let response: string;
  let sentCopy: { mailbox: string; uid: number } | null = null;
  try {
    const result = await sendDraft(mailAccount, mailPass, out);
    // qiye 自动存发件 → 去「已发送」定位刚发的那封,供面板跳转
    sentCopy = await engine.findSentCopy(out.subject);
    response = result.response;
    if (result.rejected.length > 0) {
      throw new Error(`部分收件地址被服务器拒绝:${result.rejected.join(', ')}`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('部分收件地址被服务器拒绝')) throw err;
    if (isAuthError(err)) {
      throw new Error('SMTP 登录被拒绝:请检查「账号」页的客户端专用密码(不是登录密码)。');
    }
    throw new Error(`发送失败(${mailAccount.smtp.host}):${err instanceof Error ? err.message : String(err)}`);
  }
  return { response, sentCopy };
}

/**
 * The one real-send path for local drafts: SMTP deliver → mark → persist →
 * notify. The agent's `mail_send_draft` and the panel's draft click both land
 * here, so their semantics can never drift.
 */
async function sendAndMark(ctx: PluginContext, draft: Draft): Promise<string> {
  const { response, sentCopy } = await smtpSend({
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    body: draft.body,
  });
  draft.sent = true;
  await save(ctx);
  if (sentCopy) {
    ctx.send(PANEL, 'mail.sent', { mailbox: sentCopy.mailbox, uid: sentCopy.uid, subject: draft.subject });
  }
  await ctx
    .call('notify.show', { title: '邮件已发送', body: `${draft.subject} → ${draft.to}` })
    .catch(() => {});
  return response;
}

function fmtDate(iso: string): string {
  if (!iso) return '未知时间';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

function summarizeList(title: string, msgs: Awaited<ReturnType<ImapEngine['listMessages']>>): string {
  if (msgs.length === 0) return `${title}:没有邮件。`;
  const lines = msgs.map(
    (m, i) =>
      `${i + 1}. ${m.seen ? '' : '[未读] '}${m.subject} — ${m.from || '(未知发件人)'} (${fmtDate(m.date)})${
        m.hasAttachment ? ' [附件]' : ''
      }`,
  );
  return `${title}(共 ${msgs.length} 封):\n${lines.join('\n')}`;
}

let restorePromise: Promise<void> | null = null;

/**
 * The panel's first request can beat onInit's storage round-trip — every
 * mailbox operation must wait for the account restore, exactly once.
 */
function ensureRestored(ctx: PluginContext): Promise<void> {
  restorePromise ??= restoreEngine(ctx);
  return restorePromise;
}

async function restoreEngine(ctx: PluginContext): Promise<void> {
  const [account, pass] = await Promise.all([loadAccount(ctx), loadPass(ctx)]);
  if (!account || !pass) return; // configured-without-password never connects
  try {
    mailAccount = resolveAccount(account);
    mailPass = pass;
    engine.configure(mailAccount, pass);
  } catch (err) {
    ctx.log.warn(`保存的邮箱账号无效:${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── The plugin ──

plugin({
  async onInit(ctx) {
    await ensureLoaded(ctx);
    await ensureRestored(ctx);
    // 未读角标已由面板内「未读邮件」条目取代
    void ctx.setBadge(PANEL, null).catch(() => {});
    engine.setHooks({
      onState: (state, detail) => {
        if (state === 'ready') ctx.log.info(`邮箱已连接${detail ? `(${detail})` : ''}`);
        else if (state === 'reconnecting' || state === 'error' || state === 'auth-error') {
          ctx.log.warn(`邮箱连接:${state}${detail ? ` — ${detail}` : ''}`);
        }
      },
      onNewMail: ({ items, count }) => {
        const first = items[0];
        ctx.send(PANEL, 'mail.new', { subject: first.subject, from: first.from, count });
        const body =
          count === 1
            ? `${first.from || '(未知发件人)'}:${first.subject}`
            : `${count} 封新邮件:${items.slice(0, 3).map((i) => i.subject).join('、')}`;
        void ctx
          .call('notify.show', { title: count === 1 ? '新邮件' : `新邮件(${count})`, body })
          .catch(() => {});
      },
    });
    await ensureRestored(ctx);
  },

  async onPanelMounted(_panelId, _params, ctx) {
    await ensureLoaded(ctx);
    ctx.send(PANEL, 'ui.render', { composing, drafts });
  },

  /** Request/response for the panel: account config and mailbox reads. */
  async onRequest(_panelId, method, params, ctx) {
    // Mailbox reads need the account restored first; account.* manage it.
    if (!['account.get', 'account.save', 'account.clear', 'draft.save', 'draft.delete'].includes(method)) {
      await ensureRestored(ctx);
    }
    switch (method) {
      case 'account.get': {
        const [account, pass] = await Promise.all([loadAccount(ctx), loadPass(ctx)]);
        return {
          presets: Object.entries(PRESETS).map(([id, p]) => ({
            id,
            label: p.label,
            hint: p.hint,
            imap: p.imap,
            smtp: p.smtp,
          })),
          account: account ?? null,
          hasPass: Boolean(pass),
          engineState: engine.state,
          engineDetail: engine.stateDetail,
        };
      }

      case 'account.save': {
        const input = params as unknown as MailAccountInput;
        const pass = String((params as { pass?: unknown }).pass ?? '');
        const resolved = await saveAccount(ctx, input, pass);
        mailPass = pass.trim() || (await loadPass(ctx));
        mailAccount = resolved;
        engine.configure(resolved, mailPass);
        ctx.log.info(`邮箱账号已保存:${resolved.email} (${resolved.preset})`);
        return { ok: true, email: resolved.email };
      }

      case 'account.clear': {
        await clearAccount(ctx);
        mailAccount = null;
        mailPass = '';
        engine.configure(null, '');
        return { ok: true };
      }

      case 'box.list': {
        const mailbox = String(params.mailbox ?? 'INBOX');
        const limit = Math.min(Math.max(Number(params.limit) || 50, 1), 100);
        const page = Math.max(Number(params.page) || 0, 0);
        // '__unread__' 是面板的虚拟文件夹:IMAP SEARCH 未读
        if (mailbox === '__unread__') {
          const { messages, total, hasMore } = await engine.listUnreadPage(limit, page);
          return { mailbox, messages, page: 0, unreadCount: total, hasMore, engineState: engine.state };
        }
        const { messages, hasMore } = await engine.listMessagesPage(mailbox, limit, page);
        return { mailbox, messages, page, hasMore, engineState: engine.state };
      }

      case 'mail.searchAll': {
        const query = String(params.query ?? '').trim();
        if (!query) throw new Error('query 必填');
        const sinceParam = String(params.since ?? '').trim();
        let since: Date | null = null;
        if (sinceParam) {
          since = new Date(sinceParam);
          if (Number.isNaN(since.getTime())) throw new Error(`since 不是有效日期:${sinceParam}`);
        }
        const messages = await engine.searchAll(query, since, 60);
        return { query, messages, engineState: engine.state };
      }

      case 'link.open': {
        const url = String(params.url ?? '').trim();
        if (!/^https?:\/\//i.test(url)) throw new Error('只允许打开 http(s) 链接');
        const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
        execFile(cmd, [url], (err) => {
          if (err) ctx.log.warn(`打开链接失败:${err.message}`);
        });
        return { ok: true };
      }

      case 'folder.list':
        return { folders: await engine.listFolders(), engineState: engine.state };

      case 'msg.flags': {
        const mailbox = String(params.mailbox ?? 'INBOX');
        const uids = (Array.isArray(params.uids) ? params.uids : []).map(Number).filter(Number.isFinite);
        const action = String(params.action ?? '');
        if (!['read', 'unread', 'flag', 'unflag'].includes(action)) throw new Error(`未知标记操作: ${action}`);
        await engine.setFlags(mailbox, uids, action as 'read' | 'unread' | 'flag' | 'unflag');
        return { ok: true };
      }

      case 'msg.delete': {
        const mailbox = String(params.mailbox ?? 'INBOX');
        const uids = (Array.isArray(params.uids) ? params.uids : []).map(Number).filter(Number.isFinite);
        if (uids.length === 0) throw new Error('没有选中要删除的邮件');
        await engine.deleteMessages(mailbox, uids);
        return { ok: true };
      }

      case 'att.download': {
        const mailbox = String(params.mailbox ?? 'INBOX');
        const uid = Number(params.uid);
        const partId = String(params.partId ?? '');
        if (!Number.isFinite(uid) || !partId) throw new Error('附件参数无效(uid/partId)');
        const safeName =
          String(params.filename ?? 'attachment')
            .replace(/[\/\\:]+/g, '-')
            .trim()
            .slice(0, 120) || 'attachment';
        const dest = join(homedir(), 'Downloads', 'pi-mail', safeName);
        const saved = await engine.downloadAttachment(mailbox, uid, partId, dest);
        await ctx
          .call('notify.show', { title: '附件已下载', body: saved.path })
          .catch(() => {});
        return saved;
      }

      case 'compose.send': {
        const out: OutgoingDraft = {
          to: String(params.to ?? ''),
          cc: params.cc ? String(params.cc) : undefined,
          bcc: params.bcc ? String(params.bcc) : undefined,
          subject: String(params.subject ?? ''),
          body: String(params.body ?? ''),
          attachments: Array.isArray(params.attachments)
            ? (params.attachments as OutgoingAttachment[]).slice(0, 20)
            : undefined,
          inReplyTo: params.inReplyTo ? String(params.inReplyTo) : undefined,
          references: params.references ? String(params.references) : undefined,
        };
        const { response, sentCopy } = await smtpSend(out);
        if (sentCopy) {
          ctx.send(PANEL, 'mail.sent', { mailbox: sentCopy.mailbox, uid: sentCopy.uid, subject: out.subject });
        }
        await ctx
          .call('notify.show', { title: '邮件已发送', body: `${out.subject || '(无主题)'} → ${out.to}` })
          .catch(() => {});
        return { ok: true, response };
      }

      case 'draft.save': {
        const fields = {
          to: String(params.to ?? '').slice(0, 500),
          cc: params.cc ? String(params.cc).slice(0, 500) : undefined,
          bcc: params.bcc ? String(params.bcc).slice(0, 500) : undefined,
          subject: String(params.subject ?? '(无主题)').slice(0, 300),
          body: String(params.body ?? '').slice(0, 20_000),
        };
        const id = params.id ? String(params.id) : null;
        let draft = id ? drafts.find((d) => d.id === id) : undefined;
        if (draft) {
          if (draft.sent) throw new Error('已发送的草稿不能再修改');
          Object.assign(draft, { ...fields, cc: fields.cc || undefined, bcc: fields.bcc || undefined });
        } else {
          draft = createDraft(fields.to, fields.subject, fields.body, fields.cc, fields.bcc);
        }
        await save(ctx);
        return { ok: true, id: draft.id };
      }

      case 'draft.delete': {
        const id = String(params.id ?? '');
        drafts = drafts.filter((d) => d.id !== id);
        await save(ctx);
        return { ok: true };
      }

      case 'mail.detail': {
        const uid = Number(params.uid);
        if (!Number.isFinite(uid)) throw new Error('uid 无效');
        const mailbox = String(params.mailbox ?? 'INBOX');
        return await engine.readMessage(mailbox, uid, 50_000);
      }

      default:
        throw new Error(`unknown request method: ${method}`);
    }
  },

  async onTool(name, params, ctx) {
    switch (name) {
      // ── query tools (real mailbox) ──

      case 'mail_list_emails': {
        const mailbox = String(params.mailbox ?? 'INBOX');
        const limit = Math.min(Math.max(Number(params.limit) || 20, 1), 50);
        const { messages, total } = await engine.listMessagesPage(mailbox, limit);
        // 首行给权威总数:「收件箱有多少邮件」这类问题直接可答
        const lines = messages.map(
          (m, i) =>
            `${i + 1}. ${m.seen ? '' : '[未读] '}${m.subject} — ${m.from || '(未知发件人)'} (${fmtDate(m.date)})${
              m.hasAttachment ? ' [附件]' : ''
            }`,
        );
        const text = messages.length === 0
          ? `${mailbox} 共 ${total} 封,当前没有可显示的邮件。`
          : `${mailbox} 共 ${total} 封,最近 ${messages.length} 封:\n${lines.join('\n')}`;
        return {
          content: [{ type: 'text', text }],
          details: { mailbox, total, messages },
        };
      }

      case 'mail_search': {
        const query = String(params.query ?? '').trim();
        if (!query) throw new Error('query 必填:要搜索的主题或发件人关键词');
        const mailbox = String(params.mailbox ?? 'INBOX');
        const limit = Math.min(Math.max(Number(params.limit) || 20, 1), 50);
        const sinceParam = String(params.since ?? '').trim();
        let since: Date | null = null;
        if (sinceParam) {
          since = new Date(sinceParam);
          if (Number.isNaN(since.getTime())) throw new Error(`since 不是有效日期:${sinceParam}`);
        }
        const msgs = await engine.searchMessages(mailbox, query, since, limit);
        return {
          content: [
            {
              type: 'text',
              text: summarizeList(
                `「${query}」的搜索结果${since ? `(自 ${sinceParam} 起)` : ''}`,
                msgs,
              ),
            },
          ],
          details: { query, mailbox, messages: msgs },
        };
      }

      case 'mail_read': {
        const uid = Number(params.id);
        if (!Number.isFinite(uid)) throw new Error('id 必填:邮件的 uid(来自 mail_list_emails / mail_search)');
        const mailbox = String(params.mailbox ?? 'INBOX');
        const detail = await engine.readMessage(mailbox, uid, 8_000);
        const header = [
          `主题:${detail.subject}`,
          `发件人:${detail.from || '(未知)'}`,
          detail.cc ? `抄送:${detail.cc}` : '',
          `时间:${fmtDate(detail.date)}`,
        ]
          .filter(Boolean)
          .join('\n');
        const att =
          detail.attachments.length > 0
            ? `\n\n附件(${detail.attachments.length}):${detail.attachments
                .map((a) => `${a.filename}(${fmtSize(a.size)})`)
                .join('、')}`
            : '';
        const body = detail.truncated ? `${detail.text}\n…(正文过长已截断)` : detail.text;
        return {
          content: [{ type: 'text', text: `${header}\n\n${body}${att}` }],
          details: detail,
        };
      }

      // ── draft tools ──

      case 'mail_create_draft': {
        const draft = createDraft(params.to, params.subject, params.body, params.cc, params.bcc);
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
        const response = await sendAndMark(ctx, draft);
        return {
          content: [
            {
              type: 'text',
              text: `已真实发送「${draft.subject}」→ ${draft.to}${response ? `(服务器响应:${response})` : ''}`,
            },
          ],
          card: draftCard(draft),
        };
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
          try {
            await sendAndMark(ctx, draft);
          } catch (err) {
            // The click must get feedback even though events are
            // fire-and-forget: push the failure back to the panel.
            ctx.send(PANEL, 'mail.send-failed', {
              id: draft.id,
              message: err instanceof Error ? err.message : String(err),
            });
            return; // draft stays unsent; no save
          }
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
