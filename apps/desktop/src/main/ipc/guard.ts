import type { IpcMainInvokeEvent } from 'electron';
import { windows } from '@main/windows';
import type { WindowContext } from '@main/windows';

/**
 * Sender validation for privileged IPC.
 *
 * With several windows (and several panel WebContentsViews per window) the
 * main process can no longer assume "the one window" is calling. Every
 * privileged channel resolves the caller instead, and only the window's own
 * shell renderer — its main frame, not a subframe or one of its panel views —
 * may act on window-level state. This is the Electron security checklist's
 * rule, applied per window.
 *
 * Panel views legitimately have their own narrow IPC surface (live slots,
 * plugin ports); those handlers resolve the owning window themselves.
 */
export function hostWindowOf(event: IpcMainInvokeEvent): WindowContext | undefined {
  const ctx = windows.byWebContents(event.sender);
  if (!ctx) return undefined;
  if (ctx.hostWebContentsId !== event.sender.id) return undefined;
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame) return undefined;
  return ctx;
}

/** Throwing variant: rejected invokes surface a clear message in the renderer. */
export function assertHostWindow(event: IpcMainInvokeEvent): WindowContext {
  const ctx = hostWindowOf(event);
  if (!ctx) throw new Error('untrusted IPC sender');
  return ctx;
}
