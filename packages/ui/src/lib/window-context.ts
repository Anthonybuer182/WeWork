import { useUIStore } from '@/stores/ui-store';
import {
  getDesktopBridge,
  getDesktopWindowId,
  hasDesktopWindowApi,
} from './window-identity';

export { getDesktopBridge, getDesktopWindowId, hasDesktopWindowApi };

/**
 * The window's view state, as the MAIN process remembers it.
 *
 * Main is the source of truth: it creates each window with its workspace and
 * conversation, keeps them in sync as the user navigates, and persists them
 * with the window layout. The renderer never decides which conversation a
 * window is on from localStorage — it asks.
 */

export interface InitialWindowContext {
  workspaceId: string;
  sessionId: string | null;
}

export interface WindowContextState {
  windowId: number;
  workspaceId: string | null;
  sessionId: string | null;
}

/** The view state main put on this window's URL at creation time. */
export function readInitialWindowContext(): InitialWindowContext | null {
  if (getDesktopWindowId() == null) return null;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(window.location.search);
  } catch {
    return null;
  }
  const workspaceId = params.get('piWs');
  if (!workspaceId) return null;
  const sessionId = params.get('piSession');
  return { workspaceId, sessionId: sessionId || null };
}

/** Ask main what this window is showing. */
export async function fetchWindowContext(): Promise<WindowContextState | null> {
  const invoke = getDesktopBridge()?.invoke;
  if (!invoke) return null;
  try {
    return (await invoke('pi:window:context')) as WindowContextState | null;
  } catch {
    return null;
  }
}

/**
 * Reconcile the renderer with main's view state.
 *
 * On a fresh load the URL query already matches; on a reload the query is
 * stale (the user may have switched conversation since) while main has the
 * current truth — this is the only way a reloaded window lands back where it
 * was without persisting the ids in shared localStorage.
 */
export async function syncWindowContext(): Promise<void> {
  const ctx = await fetchWindowContext();
  if (!ctx || !ctx.workspaceId) return;
  const state = useUIStore.getState();
  if (state.activeWorkspaceId === ctx.workspaceId && state.activeSessionId === ctx.sessionId) return;
  state.setActiveWorkspaceAndSession(ctx.workspaceId, ctx.sessionId);
}

/**
 * Apply the main-provided workspace/session BEFORE the first React render.
 *
 * The query parameters are the authoritative values for the FIRST load of a
 * window (main built them when creating it). A per-window sessionStorage
 * guard makes reloads skip them; `syncWindowContext()` then corrects the
 * store from main asynchronously.
 */
export function applyInitialWindowContext(): void {
  const windowId = getDesktopWindowId();
  if (windowId == null) return;

  const guardKey = `pi-window-context:${windowId}`;
  let firstLoad = true;
  try {
    firstLoad = !sessionStorage.getItem(guardKey);
    sessionStorage.setItem(guardKey, '1');
  } catch {
    // Storage unavailable: applying twice on reload is harmless.
  }

  const initial = firstLoad ? readInitialWindowContext() : null;
  if (initial) {
    useUIStore.getState().setActiveWorkspaceAndSession(initial.workspaceId, initial.sessionId);
  }

  // Always reconcile with main — cheap, and it is what makes reload correct.
  void syncWindowContext();
}
