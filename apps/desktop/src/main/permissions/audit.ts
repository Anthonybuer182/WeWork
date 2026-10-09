import { app } from 'electron';
import { appendFile, mkdir } from 'fs/promises';
import { dirname, join } from 'path';

/**
 * Audit trail for high-risk tool calls let through by 完全访问 mode.
 *
 * One JSON object per line in `<userData>/permission-audit.jsonl`. Appends are
 * fire-and-forget by design: the audit trail is evidence, not a gate — a failed
 * write must never block (or even delay) the tool call it is recording.
 */
export interface AuditEntry {
  ts: string;
  sessionId: string;
  toolName: string;
  /** One-line human summary of what the call would do (command / path / …). */
  summary: string;
  mode: 'full';
  reason: string;
}

let auditFile: string | null = null;

function resolveAuditFile(): string {
  // Lazily resolved after app is ready — the gate only fires from a live
  // session, which cannot exist before ready.
  if (!auditFile) {
    auditFile = join(app.getPath('userData'), 'permission-audit.jsonl');
  }
  return auditFile;
}

export function appendAuditRecord(entry: Omit<AuditEntry, 'ts'>): void {
  const record: AuditEntry = { ts: new Date().toISOString(), ...entry };
  const file = resolveAuditFile();
  mkdir(dirname(file), { recursive: true })
    .catch(() => { /* exists or unrecoverable — the append below reports it */ })
    .then(() => appendFile(file, JSON.stringify(record) + '\n', 'utf-8'))
    .catch((err: unknown) => {
      console.warn(
        '[permissions] audit write failed:',
        err instanceof Error ? err.message : err,
      );
    });
}
