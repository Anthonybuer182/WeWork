/**
 * Shared shapes for the mail engine.
 *
 * Pure Node types — no plugin-SDK imports here, so `smoke-imap.mjs` can drive
 * the engine directly (bundled by esbuild) without a host process.
 */

/** What the panel's account form submits (and what storage round-trips). */
export interface MailAccountInput {
  /** A key of `PRESETS`, or `'custom'` when imap/smtp are filled by hand. */
  preset: string;
  email: string;
  /** IMAP/SMTP login name. Defaults to `email` when empty. */
  user?: string;
  /** Required when preset is `'custom'`, otherwise resolved from the preset. */
  imap?: { host: string; port: number };
  smtp?: { host: string; port: number };
}

/** An account with every field the engine needs already resolved. */
export interface ResolvedAccount {
  preset: string;
  email: string;
  user: string;
  imap: { host: string; port: number };
  smtp: { host: string; port: number };
}

/** One row of an inbox listing (envelope only — no bodies fetched). */
export interface MailSummary {
  uid: number;
  mailbox: string;
  subject: string;
  from: string;
  date: string;
  seen: boolean;
  flagged: boolean;
  hasAttachment: boolean;
  /** First ~160 chars of the text body, for the list preview line. */
  snippet?: string;
}

/** A server attachment: downloadable by (mailbox, uid, partId). */
export interface AttachmentRef {
  partId: string;
  filename: string;
  size: number;
  contentType: string;
}

/** A full message: `mail_read` / the panel's detail view. */
export interface MailDetail {
  uid: number;
  mailbox: string;
  subject: string;
  from: string;
  to: string;
  cc: string;
  date: string;
  /** Threading headers — the compose fills these in when replying. */
  messageId: string;
  references?: string;
  text: string;
  /** Sanitised-by-the-renderer raw HTML when the mail is HTML-formatted. */
  html?: string;
  truncated: boolean;
  attachments: AttachmentRef[];
}

export type FolderRole = 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive' | 'other';

/** One row of the panel's folder rail. */
export interface FolderInfo {
  path: string;
  name: string;
  role: FolderRole;
  unseen: number;
  total: number;
}

/**
 * Connection lifecycle. `auth-error` is deliberately its own state: a rejected
 * password must surface to the user, not disappear into a retry loop.
 */
export type EngineState =
  | 'disconnected'
  | 'connecting'
  | 'ready'
  | 'reconnecting'
  | 'auth-error'
  | 'error';
