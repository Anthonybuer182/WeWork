import { create } from 'zustand';
import type { TodoSnapshot } from '@pi/types';
import { electronApi, invokeWhenReady } from '@/lib/electron-ipc';

/**
 * The renderer's projection of the agent's task checklist.
 *
 * Main owns the list (it is what survives a reload and what the model sees on
 * its next call); this store exists so the card can update the moment the tool
 * runs, without waiting for the message to finish streaming. A snapshot is a
 * full replacement — never merged — and `revision` makes an out-of-order push
 * (a sync racing a live update) harmless.
 */

interface TodoState {
  /** sessionId → the latest list, or null when the session never had one. */
  bySession: Record<string, TodoSnapshot | null>;
  setSnapshot: (snapshot: TodoSnapshot) => void;
  /** Pull the persisted list for a session (session switch / reload). */
  sync: (sessionId: string) => Promise<void>;
}

export const useTodoStore = create<TodoState>((set) => ({
  bySession: {},

  setSnapshot: (snapshot) =>
    set((s) => {
      const current = s.bySession[snapshot.sessionId];
      if (current && current.revision > snapshot.revision) return s;
      return { bySession: { ...s.bySession, [snapshot.sessionId]: snapshot } };
    }),

  sync: async (sessionId) => {
    const api = electronApi();
    if (!api) return;
    try {
      const snapshot = (await invokeWhenReady(api, 'pi:todo:sync', sessionId)) as
        | TodoSnapshot
        | null;
      set((s) => {
        if (!snapshot) {
          // A live push may have arrived while this was in flight; it is newer
          // by definition, so never let a "no list" answer erase it.
          if (s.bySession[sessionId]) return s;
          return { bySession: { ...s.bySession, [sessionId]: null } };
        }
        const current = s.bySession[sessionId];
        if (current && current.revision > snapshot.revision) return s;
        return { bySession: { ...s.bySession, [sessionId]: snapshot } };
      });
    } catch {
      /* main not up yet — the next push or switch re-syncs */
    }
  },
}));

/** Wire the main → renderer channel. Called once from the app shell. */
export function initTodoBridge(): void {
  const api = electronApi();
  if (!api?.on) return; // web build: no host, cards render from message data only
  api.on('pi:todo:changed', (payload) => {
    const snapshot = payload as TodoSnapshot | undefined;
    if (snapshot?.sessionId) useTodoStore.getState().setSnapshot(snapshot);
  });
}
