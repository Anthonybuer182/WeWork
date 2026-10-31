/**
 * The blocked-question service behind `asktool`.
 *
 * This is the same shape as the permission gate's pending-approval table — a
 * promise stored under an id, resolved from the renderer, settled by the run's
 * abort signal — because both are "hold the agent turn open until a human
 * answers". The differences are the payload (a list of questions) and the
 * queue: only one card per conversation is on screen at a time, so two tool
 * calls in the same batch cannot interleave their answers.
 *
 * Nothing here times out. A question with no answer is the user's decision to
 * make; the only automatic settlement is the turn aborting, and even then the
 * tool resolves (with nulls) so the loop can finish its bookkeeping.
 */

import { ipcMain } from 'electron';
import type { AskAnswers, AskQuestion, AskRequest } from '@pi/types';

export interface AskOutcome {
  requestId: string;
  answers: AskAnswers;
  /** True when the run was aborted instead of the user answering. */
  cancelled: boolean;
}

interface PendingAsk {
  payload: AskRequest;
  resolve: (outcome: AskOutcome) => void;
  signal?: AbortSignal;
  abortListener?: () => void;
  settled: boolean;
}

export interface AskServiceOptions {
  /** Delivers a request to the renderer (webContents.send). */
  sendRequest: (payload: AskRequest) => void;
  /** Notifies the owning renderer that a pending card died without an answer. */
  sendCancelled: (payload: { requestId: string; sessionId?: string }) => void;
}

export class AskService {
  private pending = new Map<string, PendingAsk>();
  /** sessionId → the one request currently on screen. */
  private active = new Map<string, string>();
  /** sessionId → requests waiting for their turn. */
  private queue = new Map<string, string[]>();
  private counter = 0;

  constructor(private options: AskServiceOptions) {}

  /**
   * Ask and wait. Always resolves — on a user answer, on abort, or (if the
   * signal was already aborted) immediately with nulls.
   */
  ask(input: {
    sessionId: string;
    toolCallId: string;
    questions: AskQuestion[];
    signal?: AbortSignal;
  }): Promise<AskOutcome> {
    const nulls: AskAnswers = input.questions.map(() => null);

    // The run can abort between the loop's own check and this call; an
    // addEventListener on an already-aborted signal never fires, so registering
    // would leave the answer pending forever. Settle now instead.
    if (input.signal?.aborted) {
      return Promise.resolve({ requestId: '', answers: nulls, cancelled: true });
    }

    const requestId = `ask-${Date.now()}-${++this.counter}`;
    const payload: AskRequest = {
      requestId,
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      questions: input.questions,
      createdAt: new Date().toISOString(),
    };

    return new Promise<AskOutcome>((resolve) => {
      const entry: PendingAsk = {
        payload,
        resolve,
        signal: input.signal,
        settled: false,
      };
      this.pending.set(requestId, entry);

      if (input.signal) {
        entry.abortListener = () => this.settle(requestId, nulls, true);
        input.signal.addEventListener('abort', entry.abortListener, { once: true });
      }

      // One card per conversation. A second ask from the same batch waits for
      // the first to be answered rather than painting two cards at once.
      if (this.active.has(input.sessionId)) {
        const q = this.queue.get(input.sessionId) ?? [];
        q.push(requestId);
        this.queue.set(input.sessionId, q);
      } else {
        this.active.set(input.sessionId, requestId);
        this.options.sendRequest(payload);
      }
    });
  }

  /**
   * The renderer finished a card. Idempotent: a double click, a stale card in
   * a second window, or an answer arriving after an abort all no-op.
   */
  resolve(input: { requestId: string; sessionId?: string; answers: unknown }): boolean {
    const entry = this.pending.get(input.requestId);
    if (!entry) return false;
    if (input.sessionId && input.sessionId !== entry.payload.sessionId) {
      console.warn(
        `[asks] resolve(${input.requestId}) came from session ${input.sessionId}, expected ${entry.payload.sessionId} — ignored`,
      );
      return false;
    }
    const answers = normalizeAnswers(input.answers, entry.payload.questions.length);
    this.settle(input.requestId, answers, false);
    return true;
  }

  /**
   * The one request currently on screen for a session.
   *
   * Queued requests are deliberately absent: they have never painted a card,
   * and they must not paint one until the first is answered. A reloaded
   * renderer rebuilds exactly what was visible before.
   */
  sync(sessionId: string): AskRequest[] {
    const activeId = this.active.get(sessionId);
    const payload = activeId ? this.pending.get(activeId)?.payload : undefined;
    return payload ? [payload] : [];
  }

  /** Settle every request in a session with nulls (session teardown). */
  cancelSession(sessionId: string): void {
    const activeId = this.active.get(sessionId);
    const ids = [activeId, ...(this.queue.get(sessionId) ?? [])].filter(
      (id): id is string => !!id,
    );
    // Clear the routing maps first: settling an active request otherwise
    // activates the next one, which would flash a card that is about to die.
    this.queue.delete(sessionId);
    this.active.delete(sessionId);
    for (const id of ids) {
      const entry = this.pending.get(id);
      if (!entry || entry.settled) continue;
      entry.settled = true;
      if (entry.signal && entry.abortListener) {
        entry.signal.removeEventListener('abort', entry.abortListener);
      }
      this.pending.delete(id);
      if (id === activeId) this.options.sendCancelled({ requestId: id, sessionId });
      entry.resolve({
        requestId: id,
        answers: entry.payload.questions.map(() => null),
        cancelled: true,
      });
    }
  }

  private settle(requestId: string, answers: AskAnswers, cancelled: boolean): void {
    const entry = this.pending.get(requestId);
    if (!entry || entry.settled) return;
    entry.settled = true;
    if (entry.signal && entry.abortListener) {
      entry.signal.removeEventListener('abort', entry.abortListener);
    }
    this.pending.delete(requestId);

    const sessionId = entry.payload.sessionId;
    const queued = this.queue.get(sessionId);
    if (queued) {
      const idx = queued.indexOf(requestId);
      if (idx >= 0) queued.splice(idx, 1);
      if (queued.length === 0) this.queue.delete(sessionId);
    }
    if (this.active.get(sessionId) === requestId) {
      this.active.delete(sessionId);
      // Only a request that was actually shown needs to be retired in the UI;
      // a queued one never painted a card.
      if (cancelled) this.options.sendCancelled({ requestId, sessionId });
      this.activateNext(sessionId);
    }

    entry.resolve({ requestId, answers, cancelled });
  }

  private activateNext(sessionId: string): void {
    const queued = this.queue.get(sessionId);
    if (!queued || queued.length === 0) {
      this.queue.delete(sessionId);
      this.active.delete(sessionId);
      return;
    }
    const nextId = queued.shift()!;
    if (queued.length === 0) this.queue.delete(sessionId);
    const next = this.pending.get(nextId);
    if (!next || next.settled) {
      // Skip dead entries without leaving the queue stalled.
      this.activateNext(sessionId);
      return;
    }
    this.active.set(sessionId, nextId);
    this.options.sendRequest(next.payload);
  }
}

/**
 * Coerce whatever crossed IPC into one answer per question.
 *
 * Out-of-range entries are dropped, missing ones become null, and strings are
 * trimmed. Unknown labels are NOT filtered: "输入其他答案" is a first-class
 * answer, not a value from a fixed list.
 */
function normalizeAnswers(raw: unknown, count: number): AskAnswers {
  const out: AskAnswers = new Array(count).fill(null);
  if (!Array.isArray(raw)) return out;
  for (let i = 0; i < count; i += 1) {
    const value = raw[i];
    if (value == null) continue;
    if (typeof value === 'string') {
      const s = value.trim();
      if (s) out[i] = [s];
      continue;
    }
    if (Array.isArray(value)) {
      const seen = new Set<string>();
      const answers: string[] = [];
      for (const item of value) {
        if (typeof item !== 'string') continue;
        const s = item.trim();
        if (!s || seen.has(s)) continue;
        seen.add(s);
        answers.push(s);
      }
      if (answers.length > 0) out[i] = answers;
    }
  }
  return out;
}

interface AskWindowHost {
  byWebContents(wc: Electron.WebContents): { windowId: number } | undefined;
  activeOwnerOf(sessionId: string): { windowId: number } | undefined;
}

/**
 * IPC surface consumed by the renderer's ask store. A card lives in exactly
 * one window; answers and syncs from any other window are ignored.
 */
export function registerAskIpc(service: AskService, windows?: AskWindowHost): void {
  ipcMain.handle(
    'pi:ask:resolve',
    (event, payload: { requestId?: string; sessionId?: string; answers?: unknown }) => {
      const requestId = typeof payload?.requestId === 'string' ? payload.requestId : '';
      if (!requestId) return { ok: false, error: 'missing requestId' };
      const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : undefined;
      if (sessionId && windows) {
        const owner = windows.activeOwnerOf(sessionId);
        const caller = windows.byWebContents(event.sender);
        if (owner && caller && owner.windowId !== caller.windowId) {
          return { ok: false, error: 'session owned by another window' };
        }
      }
      const ok = service.resolve({ requestId, sessionId, answers: payload.answers });
      return ok ? { ok: true } : { ok: false, error: 'request already settled' };
    },
  );

  ipcMain.handle('pi:ask:sync', (event, sessionId?: string) => {
    const key = sessionId || 'default';
    if (windows) {
      const owner = windows.activeOwnerOf(key);
      const caller = windows.byWebContents(event.sender);
      if (owner && caller && owner.windowId !== caller.windowId) return [];
    }
    return service.sync(key);
  });
}
