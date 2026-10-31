import { useUIStore } from '@/stores/ui-store';
import { toast } from '@/stores/toast-store';
import { t } from '@/i18n';
import { getDesktopBridge, hasDesktopWindowApi } from './window-context';

/**
 * Window-scoped actions for the shared UI.
 *
 * Opening a conversation is a CLAIM in the desktop shell: a session belongs to
 * one window at a time. The claim is checked in main before the store changes,
 * so a refusal never leaves the UI briefly showing the wrong conversation.
 * Every helper degrades to the old single-window behaviour on the web build.
 */

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T | null> {
  const call = getDesktopBridge()?.invoke;
  if (!call) return null;
  try {
    return (await call(channel, ...args)) as T;
  } catch (err) {
    console.warn(`[window-actions] ${channel} failed:`, err);
    return null;
  }
}

/**
 * Make `sessionId` this window's active conversation.
 *
 * Returns false when another window already shows it — that window has been
 * focused and this one keeps its current session.
 */
export async function activateSession(sessionId: string | null): Promise<boolean> {
  if (!hasDesktopWindowApi()) {
    useUIStore.getState().setActiveSession(sessionId);
    return true;
  }

  const result = await invoke<{ ok: boolean; ownerWindowId?: number }>('pi:window:activate-session', {
    sessionId,
  });

  // No answer (older shell, bridge failure): behave like the single-window app
  // rather than leaving the user unable to switch conversations.
  if (!result) {
    useUIStore.getState().setActiveSession(sessionId);
    return true;
  }
  if (!result.ok) {
    console.info(
      `[window-actions] session ${sessionId ?? '(none)'} is open in window ${result.ownerWindowId ?? '?'} — focused it instead`,
    );
    toast(t('该会话已在另一个窗口打开'));
    return false;
  }
  useUIStore.getState().setActiveSession(sessionId);
  return true;
}

/**
 * Open `workspaceId` in a new window. The new window starts on a fresh
 * session of that workspace (created by its composer, exactly like a fresh
 * window in the single-window app). Explicit action: always a new window,
 * even when the workspace is already open elsewhere.
 */
export function openWorkspaceInNewWindow(workspaceId: string): void {
  void invoke('pi:window:open-workspace', { workspaceId, forceNew: true });
}

/**
 * VS Code's "open folder" semantics: if ANOTHER window already shows this
 * workspace, focus that window instead of opening it twice. Returns true when
 * the caller should stop (the user is now looking at the other window).
 */
export async function focusWorkspaceElsewhere(workspaceId: string): Promise<boolean> {
  if (!hasDesktopWindowApi()) return false;
  const result = await invoke<{ focused: boolean }>('pi:window:focus-workspace', { workspaceId });
  return result?.focused === true;
}

/**
 * Open a conversation in a new window. If another window already owns it,
 * that window is focused instead and the promise resolves false.
 */
export async function openSessionInNewWindow(
  sessionId: string,
  workspaceId: string,
): Promise<boolean> {
  const result = await invoke<{ ok: boolean; ownerWindowId?: number }>('pi:window:open-session', {
    sessionId,
    workspaceId,
  });
  if (result && !result.ok) {
    toast(t('该会话已在另一个窗口打开，已切换到那个窗口'));
  }
  return result?.ok ?? false;
}

/** Cmd+N from the renderer's own menus / buttons (the app menu does this natively). */
export function openNewWindow(): void {
  void invoke('pi:window:new');
}
