/**
 * ImapEngine — one account, one IMAP connection, tool-shaped operations.
 *
 * Design notes:
 * - Lazy connect: nothing touches the network until the first operation (or a
 *   successful configure + operation), so a configured-but-unused mailbox
 *   costs nothing.
 * - Reconnect: desktop reality is sleep, network switches and server-side
 *   drops. The `close` event schedules exponential backoff (1s→60s) — but
 *   only after a connection has ever succeeded. A first connect that fails is
 *   a misconfiguration; background-retrying it would just hide the problem
 *   from the user. Any user-triggered operation cancels the pending backoff
 *   and retries immediately.
 * - Auth failures are terminal (`auth-error`): retrying a rejected password
 *   risks the provider rate-limiting or locking the account.
 * - Stale-connection guard: every listener captures its client and checks
 *   `this.client === client` before acting, so a discarded connection (after
 *   reconfigure) can never schedule a reconnect for a config that's gone.
 * - Search is deliberately a JS filter over a recent window instead of IMAP
 *   text SEARCH: text SEARCH dialects (charset, OR support) vary wildly
 *   across Chinese providers. Date bounds DO go to the server (`SINCE`).
 * - Auto-IDLE: ImapFlow idles on inactivity by default, so new mail arrives
 *   via the `exists` event without a manual idle loop. A count *increase*
 *   means new mail (a decrease is a server-side expunge renumber).
 */
import { AuthenticationFailure, ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import * as iconv from 'iconv-lite';
import type {
  AttachmentRef,
  FolderInfo,
  FolderRole,
  MailDetail,
  MailSummary,
  ResolvedAccount,
  EngineState,
} from './types';

/** Structural subset of ImapFlow's FetchMessageObject we consume. */
interface FetchedMessage {
  uid: number;
  flags?: Set<string>;
  internalDate?: Date | string;
  envelope?: {
    subject?: string;
    from?: Addr[];
    to?: Addr[];
    date?: Date | string;
  } | null;
  bodyStructure?: unknown;
  bodyParts?: Map<string, Buffer>;
}

/** Map a mailbox to its client role: SPECIAL-USE first, name heuristics as
 *  fallback (many servers never set SPECIAL-USE). */
function roleFor(path: string, name: string, specialUse?: string | false): FolderRole {
  if (path.toUpperCase() === 'INBOX') return 'inbox';
  switch (specialUse) {
    case '\\Sent': return 'sent';
    case '\\Drafts': return 'drafts';
    case '\\Trash': return 'trash';
    case '\\Junk': return 'junk';
    case '\\Archive':
    case '\\All': return 'archive';
  }
  const p = path.toLowerCase();
  if (/(^|\/)sent(\/|$)/.test(p) || /已发送|已寄出/.test(name)) return 'sent';
  if (/(^|\/)draft/.test(p) || /草稿/.test(name)) return 'drafts';
  if (/(^|\/)(trash|deleted)(\/|$)/.test(p) || /已删除|废纸/.test(name)) return 'trash';
  if (/(^|\/)(junk|spam)(\/|$)/.test(p) || /垃圾/.test(name)) return 'junk';
  if (/(^|\/)archive(\/|$)/.test(p) || /归档/.test(name)) return 'archive';
  return 'other';
}

/** Walk a BODYSTRUCTURE tree collecting attachment parts (disposition only —
 *  inline images are rendered by the HTML view, not listed). */
function collectAttachmentParts(node: unknown, out: AttachmentRef[]): void {
  const n = node as {
    part?: string;
    type?: string;
    size?: number;
    disposition?: string;
    dispositionParameters?: Record<string, string>;
    parameters?: Record<string, string>;
    childNodes?: unknown[];
  } | undefined;
  if (!n) return;
  if (n.disposition === 'attachment' && n.part) {
    out.push({
      partId: n.part,
      filename: n.dispositionParameters?.filename || n.parameters?.name || '(未命名附件)',
      size: n.size ?? 0,
      contentType: n.type ?? '',
    });
  }
  for (const child of n.childNodes ?? []) collectAttachmentParts(child, out);
}

export const NOT_CONFIGURED = '尚未配置邮箱账号 — 请在右侧「邮件」面板完成账号设置后重试';

/** How far back list/search scan before JS filtering kicks in. */
const WINDOW_SIZE = 300;
const RECONNECT_MAX_MS = 60_000;

export interface EngineHooks {
  onState?(state: EngineState, detail: string): void;
  onNewMail?(info: { items: Array<{ subject: string; from: string }>; count: number }): void;
}

type Addr = { address?: string | null; name?: string | null } | null | undefined;

function fmtAddrs(list: unknown): string {
  // imapflow envelope 给数组;mailparser 的 from/to 给 { value: Addr[], text }。
  let arr: Addr[] = [];
  if (Array.isArray(list)) arr = list as Addr[];
  else if (list && typeof list === 'object') arr = (list as { value?: Addr[] }).value ?? [];
  return arr
    .filter((a): a is NonNullable<Addr> => Boolean(a?.address))
    .map((a) => (a.name ? `${a.name} <${a.address}>` : a.address))
    .join(', ');
}

function toIso(date: unknown): string {
  const d = date instanceof Date ? date : date ? new Date(String(date)) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : '';
}

/** Minimal html→text for html-only mails; plain-text mails never reach it. */
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function hasAttachment(node: unknown): boolean {
  const n = node as { disposition?: unknown; childNodes?: unknown[] } | undefined;
  if (!n) return false;
  if (n.disposition === 'attachment') return true;
  return (n.childNodes ?? []).some(hasAttachment);
}

const LIST_QUERY = {
  uid: true, envelope: true, flags: true, internalDate: true, bodyStructure: true,
  // 摘要 part 顺路在同一轮 FETCH 里取,省掉整个第二轮往返
  bodyParts: ['1.1', '1'],
};
/** 搜索结果的摘要二段取:搜索窗口可能 300 封,只给最终可见行补摘要。 */
const SNIPPET_QUERY = { uid: true, bodyParts: ['1.1', '1'] };

/** 摘要清洗:叶子 part 的原文可能带自己的 MIME 头块,且常是 base64 —
 *  剥头、解 base64、跳过无意义行。仍失败就返回 undefined。 */
function cleanSnippet(raw: Buffer | undefined): string | undefined {
  if (!raw) return undefined;
  const full = raw.toString('latin1'); // 先按字节看,charset 判定后再正确解码
  // 从 part 头里拿 charset。头本身可能是 quoted-printable 转义的
  // (charset=3DUTF-8,3D 即 '='),要剥掉;再过白名单,认不出按 utf-8。
  let charset = (/charset=["']?([\w-]+)/i.exec(full)?.[1] ?? 'utf-8')
    .replace(/^=?(3D)?/i, '')
    .toLowerCase();
  if (!/^(utf-?8|gb(18030|2312|k)?|big5|iso-8859-1|latin1|us-ascii|windows-125\d)$/.test(charset)) {
    charset = 'utf-8';
  }
  let text: string;
  try {
    text = iconv.decode(raw, charset);
  } catch {
    text = raw.toString('utf8');
  }
  // 头部块/空行/boundary 前导,整段剥掉(逐行跳,不依赖空行位置)
  const all = text.split(/\r?\n/);
  const headerish = (l: string) =>
    l.trim() === '' || /^this is a multi-part message/i.test(l.trim()) ||
    /^[A-Za-z][A-Za-z0-9-]*:[ \t]/.test(l.trim()) || /^\s/.test(l) ||
    l.trim().startsWith('--') || /^boundary=/i.test(l.trim());
  let i = 0;
  while (i < all.length && headerish(all[i])) i++;
  text = all.slice(i).join('\n');
  const compact = text.replace(/\s+/g, '');
  if (compact.length > 20) {
    // ≥98% 字符在 base64 字母表内就尝试解码(容掉个别残留字符)
    const stray = compact.replace(/[A-Za-z0-9+/=]/g, '');
    if (stray.length / compact.length < 0.02) {
      try {
        const decoded = iconv.decode(Buffer.from(compact, 'base64'), charset);
        // 解码产物可打印比例高才采用,二进制附件内容会尝出来是乱码
        const printable = decoded.replace(/[^\t\n\r\x20-\x7e一-鿿　-〿＀-￯]/g, '');
        if (printable.length / decoded.length > 0.85) text = decoded;
      } catch {
        /* 保持原文 */
      }
    }
  }
  // text/html part(邮件只有 HTML 正文):全文剥标签再找首行,否则首行常是纯标签
  if (/<[a-z][\s\S]*>/i.test(text)) {
    text = text
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ');
  }
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const junk = (l: string) =>
    !l || l.startsWith('--') || /^this is a multi-part message/i.test(l) || /^\-{3,}/.test(l) ||
    /^[A-Za-z][A-Za-z0-9-]*:[ \t]/.test(l) || /^boundary=/i.test(l) || /^&[a-z]+;/i.test(l);
  const good = lines.find((l) => !junk(l));
  if (!good) return undefined;
  const cleaned = good.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  // 乱码护栏:charset 没猜中时宁可不给摘要,也不显示一串替换符
  if (!cleaned || cleaned.includes('�')) return undefined;
  return cleaned.slice(0, 160);
}

/** 从二段取回的 parts 里挑第一个能出摘要的('1.1' 嵌套优先,容器跳过)。 */
function snippetFrom(parts: Map<string, Buffer> | undefined): string | undefined {
  if (!parts) return undefined;
  for (const key of ['1.1', '1']) {
    const buf = parts.get(key);
    if (!buf) continue;
    if (buf.toString('utf8', 0, 8).startsWith('------')) continue; // 容器子树
    const s = cleanSnippet(buf);
    if (s) return s;
  }
  return undefined;
}

/** 对最终可见页按 uid 补取正文首段,只取 limit 行,不扫全窗口。 */
async function fetchSnippetParts(
  client: ImapFlow,
  uids: number[],
): Promise<Map<number, Map<string, Buffer>>> {
  const map = new Map<number, Map<string, Buffer>>();
  if (uids.length === 0) return map;
  for await (const msg of client.fetch(uids, SNIPPET_QUERY, { uid: true })) {
    if (msg.bodyParts) map.set(msg.uid, msg.bodyParts);
  }
  return map;
}

export class ImapEngine {
  state: EngineState = 'disconnected';
  stateDetail = '';

  private account: ResolvedAccount | null = null;
  private pass = '';
  private client: ImapFlow | null = null;
  private connecting: Promise<ImapFlow> | null = null;
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private everConnected = false;
  /** 新邮件水位线:最后观测到的 uidNext。UID 只增不减,免疫 qiye 的 EXISTS 弹跳。 */
  private uidWatermark = 0;
  private checkingNew = false;
  /** 会话视图对账:每条连接只做一次(改收信范围后首登录会拿到旧视图)。 */
  private viewChecked = false;
  private hooks: EngineHooks = {};

  constructor() {}

  setHooks(hooks: EngineHooks): void {
    this.hooks = hooks;
  }

  get configured(): boolean {
    return this.account !== null;
  }

  /** Swap credentials. Drops any live connection; the next operation reconnects. */
  configure(account: ResolvedAccount | null, pass: string): void {
    this.account = account;
    this.pass = pass;
    this.everConnected = false;
    this.attempts = 0;
    this.uidWatermark = 0;
    this.viewChecked = false;
    this.cancelReconnect();
    if (this.client) {
      const stale = this.client;
      this.client = null;
      try {
        stale.close();
      } catch {
        /* closing a dying socket is best-effort */
      }
    }
    this.setState('disconnected', account ? '' : '未配置');
  }

  async listMailboxes(): Promise<Array<{ path: string; name: string; specialUse?: string }>> {
    const client = await this.ensure();
    const list = await client.list();
    return list
      .filter((box) => !box.flags?.has('\\Noselect'))
      .map((box) => ({ path: box.path, name: box.name, specialUse: box.specialUse || undefined }));
  }

  /**
   * One 50-message page of a mailbox, newest first. Pages are UID windows off
   * `uidNext` — stable across the EXISTS lag (see listMessages comment) and
   * cheap: each page touches only its own 50-uid range. `hasMore` = the window
   * has not reached uid 1 yet (sparse uid space means a page can legitimately
   * come back with few rows and still have older pages behind it).
   */
  async listMessagesPage(
    mailbox: string,
    limit: number,
    page = 0,
  ): Promise<{ messages: MailSummary[]; hasMore: boolean; total: number }> {
    const client = await this.ensure();
    const lock = await client.getMailboxLock(mailbox);
    try {
      // 按 SEQUENCE 序号开窗(而不是 UID):seq 天然稠密,每页恒为
      // limit 封实邮件,没有 UID 空洞带来的空页;SELECT 的 exists 是
      // 权威总数(qiye 的 STATUS/uidNext 反而各有口径问题)。
      let mb = await client.mailboxOpen(mailbox);
      let exists = mb?.exists ?? 0;
      let high = exists - 50 * page;
      let low = Math.max(1, high - (limit - 1));
      if (high < 1 || exists === 0) return { messages: [], hasMore: false, total: 0 };
      let pageMsgs: FetchedMessage[] = [];
      for await (const msg of client.fetch(`${low}:${high}`, LIST_QUERY)) pageMsgs.push(msg);
      // 服务器视图预热怪癖:刚登录/刚改收信范围后的第一次 SELECT 会报旧
      // 视图(满页却说到底)。强制重新 SELECT 复核一次,以新 exists 重取。
      if (pageMsgs.length >= limit && low > 1) {
        await client.mailboxClose();
        mb = await client.mailboxOpen(mailbox);
        const exists2 = mb?.exists ?? exists;
        if (exists2 !== exists) {
          exists = exists2;
          high = exists - 50 * page;
          low = Math.max(1, high - (limit - 1));
          pageMsgs = [];
          for await (const m2 of client.fetch(`${low}:${high}`, LIST_QUERY)) pageMsgs.push(m2);
        }
      }
      pageMsgs.sort((a, b) =>
        toIso(b.envelope?.date ?? b.internalDate).localeCompare(toIso(a.envelope?.date ?? a.internalDate)),
      );
      return {
        messages: pageMsgs.map((m) => toSummary(m, mailbox, snippetFrom(m.bodyParts))),
        hasMore: low > 1,
        total: exists,
      };
    } finally {
      lock.release();
    }
  }

  async listMessages(mailbox: string, limit: number, page = 0): Promise<MailSummary[]> {
    return (await this.listMessagesPage(mailbox, limit, page)).messages;
  }

  /** 未读视图:IMAP SEARCH 未读,按页取(页 0 = 最新 limit 封),计数用全量。 */
  async listUnreadPage(
    limit: number,
    page = 0,
  ): Promise<{ messages: MailSummary[]; total: number; hasMore: boolean }> {
    const client = await this.ensure();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const seqs = await client.search({ seen: false });
      const list = Array.isArray(seqs) ? seqs : [];
      const total = list.length;
      if (total === 0) return { messages: [], total: 0, hasMore: false };
      const end = total - limit * page;
      const start = Math.max(0, end - limit);
      if (end <= 0) return { messages: [], total, hasMore: start > 0 };
      const recent = list.slice(start, end);
      const pageMsgs: FetchedMessage[] = [];
      for await (const msg of client.fetch(recent, LIST_QUERY)) pageMsgs.push(msg);
      pageMsgs.sort((a, b) =>
        toIso(b.envelope?.date ?? b.internalDate).localeCompare(toIso(a.envelope?.date ?? a.internalDate)),
      );
      return {
        messages: pageMsgs.map((m) => toSummary(m, 'INBOX', snippetFrom(m.bodyParts))),
        total,
        hasMore: start > 0,
      };
    } finally {
      lock.release();
    }
  }

  /**
   * Search every user-facing folder (收件箱/已发送/归档/自定义 — 垃圾、已删除、
   * 草稿除外) and merge, newest first. Per-folder budget keeps one dead
   * folder from eating the whole budget.
   */
  async searchAll(query: string, since: Date | null, limit: number): Promise<MailSummary[]> {
    const folders = await this.listFolders();
    const targets = folders.filter((f) => !['trash', 'junk', 'drafts'].includes(f.role));
    const merged: MailSummary[] = [];
    for (const folder of targets) {
      try {
        const found = await this.searchMessages(folder.path, query, since, 25);
        merged.push(...found);
      } catch {
        /* 一个文件夹挂了不拖垮全局搜索 */
      }
    }
    merged.sort((a, b) => b.date.localeCompare(a.date));
    return merged.slice(0, limit);
  }

  async searchMessages(
    mailbox: string,
    query: string,
    since: Date | null,
    limit: number,
  ): Promise<MailSummary[]> {
    const client = await this.ensure();
    const lock = await client.getMailboxLock(mailbox);
    try {
      let range: string | number[];
      if (since) {
        const seqs = await client.search({ since });
        if (!seqs || seqs.length === 0) return [];
        range = seqs.slice(-WINDOW_SIZE);
      } else {
        // 同 listMessagesPage:按 exists 的 seq 窗口,不依赖 uidNext
        const mb = await client.mailboxOpen(mailbox);
        const exists = mb?.exists ?? 0;
        range = `${Math.max(1, exists - WINDOW_SIZE + 1)}:${exists}`;
      }

      const page: FetchedMessage[] = [];
      for await (const msg of client.fetch(range, LIST_QUERY, { uid: true })) page.push(msg);
      const q = query.trim().toLowerCase();
      const filtered = page.filter((msg) => {
        if (!q) return true;
        const hay =
          `${msg.envelope?.subject ?? ''} ${fmtAddrs(msg.envelope?.from)} ${fmtAddrs(msg.envelope?.to)}`.toLowerCase();
        return hay.includes(q);
      });
      filtered.sort((a, b) =>
        toIso(b.envelope?.date ?? b.internalDate).localeCompare(toIso(a.envelope?.date ?? a.internalDate)),
      );
      const top = filtered.slice(0, limit);
      const partsByUid = await fetchSnippetParts(client, top.map((m) => m.uid));
      return top.map((m) => toSummary(m, mailbox, snippetFrom(partsByUid.get(m.uid))));
    } finally {
      lock.release();
    }
  }

  async readMessage(mailbox: string, uid: number, maxChars: number): Promise<MailDetail> {
    const client = await this.ensure();
    const lock = await client.getMailboxLock(mailbox);
    try {
      let source: Buffer | undefined;
      let seen = false;
      let structure: unknown;
      for await (const msg of client.fetch(
        { uid },
        { uid: true, source: true, flags: true, bodyStructure: true },
        { uid: true },
      )) {
        source = msg.source;
        seen = msg.flags?.has('\\Seen') ?? false;
        structure = msg.bodyStructure;
      }
      if (!source) throw new Error(`未找到邮件 uid=${uid}(可能已被删除或移动)`);

      const parsed = await simpleParser(source);
      if (!seen) {
        await client.messageFlagsAdd({ uid }, ['\\Seen'], { uid: true }).catch(() => {});
      }

      const raw = parsed.text?.trim() || htmlToText(typeof parsed.html === 'string' ? parsed.html : '');
      const truncated = raw.length > maxChars;
      const parts: AttachmentRef[] = [];
      collectAttachmentParts(structure, parts);
      return {
        uid,
        mailbox,
        subject: parsed.subject ?? '(无主题)',
        from: fmtAddrs(parsed.from as unknown),
        to: fmtAddrs(parsed.to as unknown),
        cc: fmtAddrs(parsed.cc as unknown),
        date: toIso(parsed.date),
        messageId: parsed.messageId ?? '',
        references: parsed.references ? String(parsed.references) : undefined,
        text: truncated ? raw.slice(0, maxChars) : raw,
        html: typeof parsed.html === 'string' ? parsed.html.slice(0, 300_000) : undefined,
        truncated,
        attachments: parts,
      };
    } finally {
      lock.release();
    }
  }

  /** Folder rail: every listable mailbox with role + unread/total counts. */
  async listFolders(): Promise<FolderInfo[]> {
    const client = await this.ensure();
    const boxes = await client.list();
    const out: FolderInfo[] = [];
    for (const box of boxes) {
      if (box.flags?.has('\\Noselect') || box.flags?.has('\\NonExistent')) continue;
      const role = roleFor(box.path, box.name, box.specialUse || undefined);
      const st = await client.status(box.path, { unseen: true, messages: true }).catch(() => null);
      const ok = st && typeof st === 'object' ? st : null;
      out.push({
        path: box.path,
        name: box.name,
        role,
        unseen: ok?.unseen ?? 0,
        total: ok?.messages ?? 0,
      });
    }
    const order: Record<FolderRole, number> = { inbox: 0, drafts: 1, sent: 2, archive: 3, junk: 4, trash: 5, other: 6 };
    out.sort((a, b) => order[a.role] - order[b.role] || a.path.localeCompare(b.path));
    return out;
  }

  /** Delete = move to the Trash folder when one exists, hard-delete otherwise. */
  async deleteMessages(mailbox: string, uids: number[]): Promise<void> {
    if (uids.length === 0) return;
    const client = await this.ensure();
    const folders = await this.listFolders();
    const trash = folders.find((f) => f.role === 'trash');
    const lock = await client.getMailboxLock(mailbox);
    try {
      if (trash && trash.path !== mailbox) {
        await client.messageMove(uids, trash.path, { uid: true });
      } else {
        await client.messageDelete(uids, { uid: true });
      }
    } finally {
      lock.release();
    }
  }

  async setFlags(
    mailbox: string,
    uids: number[],
    action: 'read' | 'unread' | 'flag' | 'unflag',
  ): Promise<void> {
    if (uids.length === 0) return;
    const flag = action === 'read' || action === 'unread' ? '\\Seen' : '\\Flagged';
    const client = await this.ensure();
    const lock = await client.getMailboxLock(mailbox);
    try {
      if (action === 'read' || action === 'flag') {
        await client.messageFlagsAdd(uids, [flag], { uid: true });
      } else {
        await client.messageFlagsRemove(uids, [flag], { uid: true });
      }
    } finally {
      lock.release();
    }
  }

  /**
   * 发送成功后在「已发送」里定位刚发的那封(qiye 服务器会自动存 SMTP 发件,
   * 无需自己 APPEND)。服务器落盘稍有延迟,重试几次按主题匹配。
   */
  async findSentCopy(subject: string): Promise<{ mailbox: string; uid: number } | null> {
    try {
      const client = await this.ensure();
      const folders = await this.listFolders();
      const sent = folders.find((f) => f.role === 'sent');
      if (!sent) return null;
      for (let attempt = 0; attempt < 8; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 2000));
        const mb = await client.mailboxOpen(sent.path);
        const exists = mb?.exists ?? 0;
        if (exists === 0) continue;
        const last = await client.fetchOne(String(exists), { uid: true, envelope: true });
        const obj = last && typeof last === 'object' ? last : null;
        const lastSubj = obj?.envelope?.subject ?? '';
        if (lastSubj === subject || lastSubj.includes(subject.slice(0, 16))) {
          return obj?.uid ? { mailbox: sent.path, uid: obj.uid } : null;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Stream one attachment part to `destPath` (caller supplies a safe name). */
  async downloadAttachment(
    mailbox: string,
    uid: number,
    partId: string,
    destPath: string,
  ): Promise<{ path: string; size: number }> {
    const client = await this.ensure();
    const lock = await client.getMailboxLock(mailbox);
    try {
      const dl = await client.download(String(uid), partId, { uid: true, maxBytes: 100 * 1024 * 1024 });
      if (!dl || !('content' in dl) || !dl.content) throw new Error('服务器未返回附件内容');
      const chunks: Buffer[] = [];
      for await (const chunk of dl.content) chunks.push(chunk as Buffer);
      const buf = Buffer.concat(chunks);
      const { mkdirSync, writeFileSync } = await import('node:fs');
      const { dirname } = await import('node:path');
      mkdirSync(dirname(destPath), { recursive: true });
      writeFileSync(destPath, buf);
      return { path: destPath, size: buf.length };
    } finally {
      lock.release();
    }
  }

  // ── internals ──

  private setState(state: EngineState, detail = ''): void {
    this.state = state;
    this.stateDetail = detail;
    this.hooks.onState?.(state, detail);
  }

  private cancelReconnect(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleReconnect(): void {
    if (!this.account || !this.everConnected) {
      // First connect never succeeded: a config problem, not a hiccup. Retry
      // would loop in the background forever; the next user action retries.
      if (!this.account) this.setState('disconnected');
      return;
    }
    this.cancelReconnect();
    this.attempts += 1;
    const delay = Math.min(1000 * 2 ** (this.attempts - 1), RECONNECT_MAX_MS);
    this.setState('reconnecting', `${Math.round(delay / 1000)}s 后第 ${this.attempts} 次重连`);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.connect().catch(() => {
        /* state already reported by connect(); backoff continues on next close */
      });
    }, delay);
  }

  private connect(): Promise<ImapFlow> {
    if (this.connecting) return this.connecting;
    const account = this.account;
    if (!account) return Promise.reject(new Error(NOT_CONFIGURED));

    this.setState(this.attempts > 0 ? 'reconnecting' : 'connecting');
    const promise = (async () => {
      const client = new ImapFlow({
        host: account.imap.host,
        port: account.imap.port,
        secure: true,
        auth: { user: account.user, pass: this.pass },
        logger: false,
        connectionTimeout: 15_000,
        greetingTimeout: 15_000,
      });

      client.on('error', () => {
        /* the close event follows an error; reporting twice is noise */
      });
      client.on('close', () => {
        if (this.client !== client) return; // stale: reconfigured away
        this.client = null;
        this.setState('disconnected');
        this.scheduleReconnect();
      });
      client.on('exists', () => {
        if (this.client === client) void this.handleExists(client);
      });

      try {
        await client.connect();
      } catch (err) {
        try {
          client.close();
        } catch {
          /* already dead */
        }
        this.connecting = null;
        if (isAuthFailure(err)) {
          this.attempts = 0;
          this.setState('auth-error', '用户名或客户端密码不正确');
          throw new Error(
            `邮箱登录被拒绝:请确认用户名 (${account.user}) 和客户端专用密码(不是登录密码)。`,
          );
        }
        throw err;
      }

      this.connecting = null;
      this.everConnected = true;
      this.attempts = 0;
      this.client = client;
      this.setState('ready');
      return client;
    })().catch((err) => {
      this.connecting = null;
      if (!isAuthFailure(err)) {
        if (this.everConnected) this.scheduleReconnect();
        else {
          // First connect: a config problem (unreachable host, refused port).
          // Surface it and stop — background-retrying misconfiguration only
          // hides it from the user.
          const message = err instanceof Error ? err.message : String(err);
          this.setState('error', message);
        }
      }
      throw err;
    });

    this.connecting = promise;
    return promise;
  }

  private async ensure(): Promise<ImapFlow> {
    if (!this.account) throw new Error(NOT_CONFIGURED);
    if (this.state === 'auth-error') {
      throw new Error('邮箱登录被拒绝:请在邮件面板更新客户端专用密码后重试。');
    }
    if (this.client?.usable) return this.client;
    // The user asked for something now — a pending backoff is irrelevant.
    this.cancelReconnect();
    const client = await this.connect().catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith('邮箱登录被拒绝') || message === NOT_CONFIGURED) throw err;
      throw new Error(`无法连接邮箱服务器 (${this.account!.imap.host}):${message}`);
    });
    const replaced = await this.reconcileView(client);
    if (replaced) return this.ensure(); // viewChecked 已置位,递归一层拿新连接
    return client;
  }

  /**
   * 会话视图对账(每条连接一次):qiye 在「收取邮件范围」等设置变更后的
   * 首个会话里,SELECT 仍会给出旧视图(比如只有最近 30 天),STATUS 却报
   * 全量 —— 两边对不上就强制换一条新连接,新连接即为全量视图。
   * @returns true = 已丢弃旧连接并换新,调用方应重新 ensure
   */
  private async reconcileView(client: ImapFlow): Promise<boolean> {
    if (this.viewChecked) return false;
    this.viewChecked = true;
    try {
      const lock = await client.getMailboxLock('INBOX');
      let selectExists = 0;
      try {
        const mb = client.mailbox;
        selectExists = mb && typeof mb === 'object' ? mb.exists ?? 0 : 0;
      } finally {
        lock.release();
      }
      const st = await client.status('INBOX', { messages: true });
      const statusCount = st && typeof st === 'object' ? st.messages ?? 0 : 0;
      if (statusCount - selectExists > 5) {
        this.client = null;
        try { client.close(); } catch { /* 已死连接 */ }
        this.setState('connecting', '刷新邮箱视图…');
        return true;
      }
    } catch {
      /* 对账失败不阻断:最坏情况是这轮会话用旧视图 */
    }
    return false;
  }

  /**
   * 新邮件检测(由 EXISTS 事件驱动,Auto-IDLE 唤醒):
   * 以 uidNext 为水位线 —— 计数在 qiye 上会弹跳(EXISTS 报 0 再报回原值),
   * 按「计数变大」判断会产生无休止的假通知;UID 严格递增,只在真正有新信
   * 时越线。首次观测只记水位(重连后不轰炸通知),越线后按 UID 区间拉取
   * 新信信封,真件真内容。
   */
  private async handleExists(client: ImapFlow): Promise<void> {
    if (this.checkingNew) return;
    try {
      const mb = client.mailbox;
      const uidNext = mb && typeof mb === 'object' ? mb.uidNext ?? 0 : 0;
      if (!uidNext) return;
      if (this.uidWatermark === 0) {
        this.uidWatermark = uidNext;
        return;
      }
      if (uidNext <= this.uidWatermark) return;
      const watermark = this.uidWatermark;
      this.uidWatermark = uidNext;
      this.checkingNew = true;
      const items: Array<{ subject: string; from: string }> = [];
      try {
        for await (const msg of client.fetch(`${watermark}:*`, { uid: true, envelope: true }, { uid: true })) {
          if (msg.uid < watermark) continue; // 'n:*' 总会带上最后一封,过滤掉旧件
          items.push({
            subject: msg.envelope?.subject || '(无主题)',
            from: fmtAddrs(msg.envelope?.from),
          });
          if (items.length >= 5) break;
        }
      } finally {
        this.checkingNew = false;
      }
      if (items.length === 0) return;
      this.hooks.onNewMail?.({ items, count: items.length });
    } catch {
      /* best effort — a missed notification is better than a broken connection */
    }
  }
}

function toSummary(msg: FetchedMessage, mailbox: string, snippet?: string): MailSummary {
  return {
    uid: msg.uid,
    mailbox,
    subject: msg.envelope?.subject || '(无主题)',
    from: fmtAddrs(msg.envelope?.from),
    date: toIso(msg.envelope?.date ?? msg.internalDate),
    seen: msg.flags?.has('\\Seen') ?? false,
    flagged: msg.flags?.has('\\Flagged') ?? false,
    hasAttachment: hasAttachment(msg.bodyStructure),
    snippet,
  };
}

function isAuthFailure(err: unknown): boolean {
  if (err instanceof AuthenticationFailure) return true;
  if (err instanceof Error && err.name === 'AuthenticationFailure') return true;
  const message = err instanceof Error ? err.message : String(err);
  return /AUTHENTICATIONFAILED|认证失败|登录失败/i.test(message);
}
