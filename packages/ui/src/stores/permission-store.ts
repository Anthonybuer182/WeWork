import { create } from 'zustand';
import type { PermissionDecision, PermissionMode, PermissionRequest } from '@pi/types';

// Shared with main through @pi/types (it is the enforcer; the drift risk of
// two definitions is exactly what moving them there removes). Re-exported so
// the store stays the renderer's import surface for them.
export type { PermissionMode, PermissionDecision, PermissionRequest };

/**
 * Session-scoped permission modes, mirrored from main.
 *
 * Main owns the truth (mode table + pending approvals); this store is the
 * renderer's projection: the composer reads the mode for its badge, and
 * ToolCallDisplay looks up pending approvals by toolCallId to render the
 * inline approval card. In-memory on both sides — a restart resets everything.
 */

function electronApi():
  | { invoke: (channel: string, ...args: unknown[]) => Promise<unknown>; on: (channel: string, cb: (...args: unknown[]) => void) => void }
  | undefined {
  return (window as unknown as { electronAPI?: ReturnType<typeof electronApi> }).electronAPI;
}

interface PermissionState {
  /** Session key → mode. Missing key = 'default' (also main's fallback). */
  modeBySession: Record<string, PermissionMode>;
  /** Pending approval keyed by toolCallId — matches the tool_call block in the timeline. */
  pendingByToolCall: Record<string, PermissionRequest>;

  setMode: (sessionId: string, mode: PermissionMode) => void;
  receiveRequest: (request: PermissionRequest) => void;
  removeRequest: (requestId: string) => void;
  /** Pull current mode + in-flight requests from main (on session switch / reload). */
  sync: (sessionId: string) => Promise<void>;
  /** Answer an approval card: resolves on main, drops the card immediately. */
  resolve: (request: PermissionRequest, decision: PermissionDecision) => void;
}

export const usePermissionStore = create<PermissionState>((set, get) => ({
  modeBySession: {},
  pendingByToolCall: {},

  setMode: (sessionId, mode) => {
    set((s) => ({ modeBySession: { ...s.modeBySession, [sessionId]: mode } }));
    // Main is the enforcer — persist there too, but never roll back the UI if
    // the round-trip fails: the toggle staying responsive matters more.
    electronApi()
      ?.invoke('pi:permission:set-mode', { sessionId, mode })
      .catch(() => {});
  },

  receiveRequest: (request) =>
    set((s) => ({
      pendingByToolCall: { ...s.pendingByToolCall, [request.toolCallId]: request },
    })),

  removeRequest: (requestId) =>
    set((s) => {
      const next = { ...s.pendingByToolCall };
      for (const [key, req] of Object.entries(next)) {
        if (req.requestId === requestId) delete next[key];
      }
      return { pendingByToolCall: next };
    }),

  sync: async (sessionId) => {
    const api = electronApi();
    if (!api) return;
    try {
      const state = (await api.invoke('pi:permission:sync', sessionId)) as {
        mode: PermissionMode;
        pending: PermissionRequest[];
      } | undefined;
      if (!state) return;
      set((s) => ({
        modeBySession: { ...s.modeBySession, [sessionId]: state.mode },
        // Wholesale replace: anything the renderer still held that main no
        // longer tracks is stale (answered elsewhere, or the session died).
        pendingByToolCall: Object.fromEntries(
          state.pending.map((req) => [req.toolCallId, req]),
        ),
      }));
    } catch {
      /* main not up yet — the next session switch or request re-syncs */
    }
  },

  resolve: (request, decision) => {
    // Drop the card first so the UI never shows an already-answered prompt,
    // even if the IPC round-trip is slow.
    get().removeRequest(request.requestId);
    electronApi()
      ?.invoke('pi:permission:resolve', { requestId: request.requestId, decision })
      .catch(() => {
        /* main gone mid-click — the abort path unblocks the agent anyway */
      });
  },
}));

/**
 * Wire the main → renderer channels. Called once from the app shell; a no-op
 * in the web build (no electronAPI → no enforcer → the UI stays hidden).
 */
export function initPermissionBridge(): void {
  const api = electronApi();
  if (!api?.on) return;
  api.on('pi:permission:request', (payload) => {
    usePermissionStore.getState().receiveRequest(payload as PermissionRequest);
  });
  // Resolved without the user (session aborted mid-approval) — retire the card.
  api.on('pi:permission:cancelled', (payload) => {
    const requestId = (payload as { requestId?: string } | undefined)?.requestId;
    if (requestId) usePermissionStore.getState().removeRequest(requestId);
  });
}
