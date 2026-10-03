/**
 * SMTP sending via nodemailer.
 *
 * A fresh transport per send: a draft send is a user-rare, user-explicit
 * action — there is no throughput to gain from a pooled connection, and a
 * per-send connect means a wrong password or dead server surfaces exactly
 * once, on the action that caused it.
 */
import { createTransport } from 'nodemailer';
import type { ResolvedAccount } from './types';

/** How the panel hands files over: base64 over the port (no fs in the webview). */
export interface OutgoingAttachment {
  filename: string;
  base64: string;
}

export interface OutgoingDraft {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  attachments?: OutgoingAttachment[];
  /** Threading headers, set when the compose was opened as a reply. */
  inReplyTo?: string;
  references?: string;
}

export interface SendResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
  response: string;
  /** The raw MIME message — for appending to the server's Sent folder. */
  raw?: Buffer;
}

const MAX_TOTAL_BYTES = 25 * 1024 * 1024; // mainstream providers' sweet spot
const MAX_ATTACHMENTS = 20;

/** Split a recipient field on the separators humans actually type. */
function recipients(field: string | undefined): string[] {
  return String(field ?? '')
    .split(/[,;，；\s]+/)
    .map((s) => s.trim())
    .filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
}

export function isAuthError(err: unknown): boolean {
  const e = err as { code?: string; responseCode?: number } | null;
  if (e?.code === 'EAUTH') return true;
  const message = err instanceof Error ? err.message : String(err);
  return /AUTH|535|530| authentication/i.test(message);
}

export async function sendDraft(
  account: ResolvedAccount,
  pass: string,
  draft: OutgoingDraft,
): Promise<SendResult> {
  const to = recipients(draft.to);
  if (to.length === 0) throw new Error('请填写有效的收件人邮箱地址');

  const attachments = (draft.attachments ?? []).slice(0, MAX_ATTACHMENTS);
  const totalBytes = attachments.reduce((sum, a) => sum + (a.base64.length * 3) / 4, 0);
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new Error(
      `附件总计 ${(totalBytes / 1024 / 1024).toFixed(1)}MB,超过 25MB 上限 — 请拆成多封或压缩后再发`,
    );
  }

  const transport = createTransport({
    host: account.smtp.host,
    port: account.smtp.port,
    // 465 is implicit-TLS; everything else (587/25) is STARTTLS.
    secure: account.smtp.port === 465,
    auth: { user: account.user, pass },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });

  const info = await transport.sendMail({
    from: account.email,
    to,
    ...(recipients(draft.cc).length ? { cc: recipients(draft.cc) } : {}),
    ...(recipients(draft.bcc).length ? { bcc: recipients(draft.bcc) } : {}),
    subject: draft.subject,
    text: draft.body,
    ...(attachments.length
      ? {
          attachments: attachments.map((a) => ({
            filename: a.filename,
            content: Buffer.from(a.base64, 'base64'),
          })),
        }
      : {}),
    ...(draft.inReplyTo ? { inReplyTo: draft.inReplyTo } : {}),
    ...(draft.references ? { references: draft.references } : {}),
  });

  return {
    messageId: info.messageId ?? '',
    accepted: (info.accepted ?? []).map(String),
    rejected: (info.rejected ?? []).map(String),
    response: info.response ?? '',
    // The compiled MIME node — nodemailer hands it back for exactly this
    // "append a copy to Sent" flow. Not in the type defs for every transport,
    // hence the cast; a missing raw simply means no sent-copy.
    raw: (info as unknown as { message?: Buffer }).message,
  };
}
