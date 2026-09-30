/**
 * File writes that refuse to clobber a concurrent edit.
 *
 * The mtime guard is the whole point: a caller that read a file, showed it to a
 * user, and now writes back must notice that the file moved underneath it. Both
 * the plugin-facing `filesystem.write` capability and the host's own context
 * editor need this, and they need the *same* rule — a file saved through the
 * panel and a file saved through a plugin should not disagree about when a
 * conflict is a conflict.
 */

import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Filesystem mtimes are not exactly reproducible across a write/stat round
 * trip, so an exact comparison produces false conflicts. One millisecond is
 * well below the resolution anything here operates at, and well above the
 * jitter.
 */
const MTIME_TOLERANCE_MS = 1;

export interface WriteResult {
  path: string;
  size: number;
  mtime: number;
}

function assertUnchanged(path: string, expectedMtime: number | undefined, action: string): void {
  if (expectedMtime === undefined || !existsSync(path)) return;
  const actual = statSync(path).mtimeMs;
  if (Math.abs(actual - expectedMtime) > MTIME_TOLERANCE_MS) {
    throw new Error(
      `conflict: file changed on disk (mtime ${Math.round(actual)}) since read ` +
        `(expected ${Math.round(expectedMtime)}) — re-read before ${action}`,
    );
  }
}

export function writeFileWithMtimeGuard(
  path: string,
  content: Buffer | string,
  expectedMtime?: number,
): WriteResult {
  if (!path) throw new Error('missing path');
  assertUnchanged(path, expectedMtime, 'writing');
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return { path, size: bytes.length, mtime: statSync(path).mtimeMs };
}

export interface DeleteResult {
  path: string;
  deleted: boolean;
  reason?: 'not-found';
}

export function deleteFileWithMtimeGuard(path: string, expectedMtime?: number): DeleteResult {
  if (!path) throw new Error('missing path');
  if (!existsSync(path)) return { path, deleted: false, reason: 'not-found' };
  assertUnchanged(path, expectedMtime, 'deleting');
  rmSync(path);
  return { path, deleted: true };
}
