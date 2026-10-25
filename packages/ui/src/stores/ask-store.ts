import { create } from 'zustand';
import type { AskAnswers, AskRequest } from '@pi/types';
import { electronApi, invokeWhenReady } from '@/lib/electron-ipc';

/**
 * Pending `asktool` questions, plus the in-progress draft behind each one.
 *
 * Drafts live here (keyed by requestId, not by session) for one reason: a
 * question card belongs to a conversation, but switching away from it must not
 * throw away half-typed answers. When the user switches back, the same card
 * comes back answered up to where they left it.
 *
 * Main owns the request lifecycle. This store is the renderer's projection:
 * `byToolCall` is what lets the streaming tool-call block find its card, and
 * `submit` is the only path that resolves the agent's waiting promise.
 */

export interface AskDraft {
  /** Which question the card is showing. */
  index: number;
  /** question index → option labels ticked. */
  selected: Record<number, string[]>;
  /** question index → free-text answer. */
  custom: Record<number, string>;
}

export const EMPTY_DRAFT: AskDraft = { index: 0, selected: {}, custom: {} };

interface AskState {
  requests: Record<string, AskRequest>;
  /** toolCallId → requestId, so a streaming tool block finds its card. */
  byToolCall: Record<string, string>;
  /** requestId → half-finished answers; survives a session switch. */
  drafts: Record<string, AskDraft>;
  submitting: Record<string, boolean>;

  receive: (request: AskRequest) => void;
  remove: (requestId: string) => void;
  /** Pull the on-screen request for a session (session switch / reload). */
  sync: (sessionId: string) => Promise<void>;

  setIndex: (requestId: string, index: number) => void;
  toggleOption: (requestId: string, index: number, label: string, multiSelect: boolean) => void;
  setCustom: (requestId: string, index: number, value: string, multiSelect: boolean) => void;
  clearQuestion: (requestId: string, index: number) => void;
  /** Send the answers to main. Returns false when the request was stale. */
  submit: (request: AskRequest, answers: AskAnswers) => Promise<boolean>;
}

function editDraft(
  drafts: Record<string, AskDraft>,
  requestId: string,
  edit: (draft: AskDraft) => AskDraft,
): Record<string, AskDraft> {
  return { ...drafts, [requestId]: edit(drafts[requestId] ?? EMPTY_DRAFT) };
}

export const useAskStore = create<AskState>((set, get) => ({
  requests: {},
  byToolCall: {},
  drafts: {},
  submitting: {},

  receive: (request) =>
    set((s) => {
      // A sync can re-deliver a request the renderer already holds — keep the
      // draft. Only the first delivery seeds an empty one.
      if (s.requests[request.requestId]) return s;
      return {
        requests: { ...s.requests, [request.requestId]: request },
        byToolCall: { ...s.byToolCall, [request.toolCallId]: request.requestId },
        drafts: s.drafts[request.requestId]
          ? s.drafts
          : { ...s.drafts, [request.requestId]: EMPTY_DRAFT },
      };
    }),

  remove: (requestId) =>
    set((s) => {
      const request = s.requests[requestId];
      if (!request) return s;
      const requests = { ...s.requests };
      delete requests[requestId];
      const byToolCall = { ...s.byToolCall };
      if (byToolCall[request.toolCallId] === requestId) delete byToolCall[request.toolCallId];
      const drafts = { ...s.drafts };
      delete drafts[requestId];
      const submitting = { ...s.submitting };
      delete submitting[requestId];
      return { requests, byToolCall, drafts, submitting };
    }),

  sync: async (sessionId) => {
    const api = electronApi();
    if (!api) return;
    // Same boot race as the todo store: retry until main's handler exists, so
    // a reload mid-question puts the card back instead of losing it.
    try {
      const pending = (await invokeWhenReady(api, 'pi:ask:sync', sessionId)) as
        | AskRequest[]
        | undefined;
      for (const request of pending ?? []) get().receive(request);
    } catch (err) {
      console.warn('[ask] could not sync pending questions:', err);
    }
  },

  setIndex: (requestId, index) =>
    set((s) => ({ drafts: editDraft(s.drafts, requestId, (d) => ({ ...d, index })) })),

  toggleOption: (requestId, index, label, multiSelect) =>
    set((s) => ({
      drafts: editDraft(s.drafts, requestId, (d) => {
        const current = d.selected[index] ?? [];
        const next = multiSelect
          ? current.includes(label)
            ? current.filter((x) => x !== label)
            : [...current, label]
          : // Radio: a click always lands on this option (clicking the
            // selected one again is a no-op, not a deselect).
            [label];
        return {
          ...d,
          selected: { ...d.selected, [index]: next },
          // A single-choice answer is one value: choosing an option retires
          // whatever was typed in the free-text box.
          custom: multiSelect ? d.custom : { ...d.custom, [index]: '' },
        };
      }),
    })),

  setCustom: (requestId, index, value, multiSelect) =>
    set((s) => ({
      drafts: editDraft(s.drafts, requestId, (d) => ({
        ...d,
        custom: { ...d.custom, [index]: value },
        selected: multiSelect
          ? d.selected
          : { ...d.selected, [index]: value.trim() ? [] : (d.selected[index] ?? []) },
      })),
    })),

  clearQuestion: (requestId, index) =>
    set((s) => ({
      drafts: editDraft(s.drafts, requestId, (d) => {
        const selected = { ...d.selected };
        const custom = { ...d.custom };
        delete selected[index];
        delete custom[index];
        return { ...d, selected, custom };
      }),
    })),

  submit: async (request, answers) => {
    const id = request.requestId;
    if (get().submitting[id]) return false;
    set((s) => ({ submitting: { ...s.submitting, [id]: true } }));
    try {
      const api = electronApi();
      const res = api
        ? ((await api.invoke('pi:ask:resolve', {
            requestId: id,
            sessionId: request.sessionId,
            answers,
          })) as { ok?: boolean; error?: string } | undefined)
        : undefined;
      if (res && res.ok === false) throw new Error(res.error ?? 'resolve rejected');
      get().remove(id);
      return true;
    } catch (err) {
      // Keep the card. The request may already be settled (abort, second
      // window); main is idempotent, so a retry is harmless, and a silent
      // failure would leave the turn blocked with no explanation.
      console.warn(`[ask] could not submit ${id}:`, err);
      set((s) => ({ submitting: { ...s.submitting, [id]: false } }));
      return false;
    }
  },
}));

/** Wire the main → renderer channels. Called once from the app shell. */
export function initAskBridge(): void {
  const api = electronApi();
  if (!api?.on) return;
  api.on('pi:ask:request', (payload) => {
    const request = payload as AskRequest | undefined;
    if (request?.requestId) useAskStore.getState().receive(request);
  });
  // The turn aborted: main settled the questions with nulls and the card must
  // not linger, or the next user message would look like it answered it.
  api.on('pi:ask:cancelled', (payload) => {
    const requestId = (payload as { requestId?: string } | undefined)?.requestId;
    if (requestId) useAskStore.getState().remove(requestId);
  });
}
