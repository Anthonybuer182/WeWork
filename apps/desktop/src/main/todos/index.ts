/**
 * The task checklist behind `todotool`.
 *
 * The checklist is the agent's own working plan for the current task — not the
 * user's planner (that is the 事项 plugin, with its own storage and its own
 * vocabulary). It is small, per-session, and fully replaced on every call, so
 * the renderer can treat each snapshot as "the truth" and never merge.
 *
 * Persisted to a single JSON file under userData rather than into the session
 * transcript: the snapshot is UI state that must survive a renderer reload,
 * but it must not become part of the model's context a second time (the tool
 * call and its result are already in the transcript).
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { ipcMain } from 'electron';
import {
  MAX_TODO_CONTENT,
  MAX_TODO_ITEMS,
  TODO_PRIORITIES,
  TODO_STATUSES,
  type TodoItem,
  type TodoPriority,
  type TodoSnapshot,
  type TodoStatus,
} from '@pi/types';

const STORAGE_VERSION = 1;

interface StoredFile {
  version: number;
  sessions: Record<string, Omit<TodoSnapshot, 'sessionId'>>;
}

export interface TodoApplyResult {
  snapshot: TodoSnapshot;
  /** Everything the host had to change to make the list valid. */
  warnings: string[];
}

export class TodoService {
  private bySession = new Map<string, TodoSnapshot>();
  private persistTimer: NodeJS.Timeout | null = null;
  /** Serializes writes; a shared `.tmp` would otherwise race with itself. */
  private writeChain: Promise<void> = Promise.resolve();
  private writeSeq = 0;
  /** Distinguishes temp names across service instances (dev reload, tests). */
  private readonly instanceId = Math.random().toString(36).slice(2, 10);

  constructor(
    private filePath: string,
    /** Delivers a fresh snapshot to the renderer (webContents.send). */
    private sendSnapshot: (snapshot: TodoSnapshot) => void,
  ) {
    this.load();
  }

  /** Current snapshot for a session, or null when it never had a list. */
  get(sessionId: string): TodoSnapshot | null {
    return this.bySession.get(sessionId) ?? null;
  }

  /**
   * Replace a session's list with the agent's input.
   *
   * Validation is deliberately forgiving: a malformed item is repaired (or
   * dropped) and reported back to the model in the tool result, rather than
   * failing the whole call. The model can only fix what it is told about.
   */
  apply(sessionId: string, rawTodos: unknown, toolCallId?: string): TodoApplyResult {
    const warnings: string[] = [];
    const todos = normalizeTodos(rawTodos, warnings);
    const previous = this.bySession.get(sessionId);
    const snapshot: TodoSnapshot = {
      sessionId,
      todos,
      revision: (previous?.revision ?? 0) + 1,
      updatedAt: new Date().toISOString(),
      ...(toolCallId ? { toolCallId } : {}),
    };
    this.bySession.set(sessionId, snapshot);
    this.schedulePersist();
    this.sendSnapshot(snapshot);
    return { snapshot, warnings };
  }

  // ── persistence ──

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as StoredFile;
      if (!parsed || parsed.version !== STORAGE_VERSION || !parsed.sessions) return;
      for (const [sessionId, stored] of Object.entries(parsed.sessions)) {
        if (!stored || !Array.isArray(stored.todos)) continue;
        // Stored data was normalized on the way in; re-run the repair anyway so
        // a hand-edited file cannot put an invalid status in front of the UI.
        const warnings: string[] = [];
        this.bySession.set(sessionId, {
          sessionId,
          todos: normalizeTodos(stored.todos, warnings),
          revision: Number.isFinite(stored.revision) ? Number(stored.revision) : 0,
          updatedAt: typeof stored.updatedAt === 'string' ? stored.updatedAt : new Date().toISOString(),
          // The card renders only on the tool call that produced the snapshot.
          // Dropping this on load persisted the list but made it invisible
          // forever after a restart.
          ...(typeof stored.toolCallId === 'string' ? { toolCallId: stored.toolCallId } : {}),
        });
      }
    } catch (err) {
      console.warn(`[todos] could not read ${this.filePath}:`, err);
    }
  }

  private schedulePersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    // Coalesce bursts (the agent may update the list several times in a row);
    // the last snapshot is the only one worth writing.
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persist();
    }, 150);
  }

  /** Drop a session's list (its transcript is being deleted). */
  remove(sessionId: string): void {
    if (!this.bySession.delete(sessionId)) return;
    this.schedulePersist();
  }

  /** Last-chance synchronous flush for the app's `will-quit`. */
  flushSync(): void {
    try {
      const tmp = this.tempPath();
      writeFileSync(tmp, JSON.stringify(this.buildBody()), 'utf8');
      renameSync(tmp, this.filePath);
    } catch (err) {
      console.warn('[todos] could not flush task list:', err);
    }
  }

  private persist(): Promise<void> {
    const run = this.writeChain.then(() => this.writeNow());
    // Keep the chain alive after a failure; the error is logged in writeNow.
    this.writeChain = run.catch(() => undefined);
    return run;
  }

  private async writeNow(): Promise<void> {
    const tmp = this.tempPath();
    try {
      await writeFile(tmp, JSON.stringify(this.buildBody()), 'utf8');
      await rename(tmp, this.filePath);
    } catch (err) {
      console.warn('[todos] could not persist task list:', err);
    }
  }

  /** Unique per write: two writes must never share one temp file. */
  private tempPath(): string {
    this.writeSeq += 1;
    return `${this.filePath}.${process.pid}.${this.instanceId}.${this.writeSeq}.tmp`;
  }

  private buildBody(): StoredFile {
    const sessions: StoredFile['sessions'] = {};
    for (const [sessionId, snapshot] of this.bySession) {
      const { sessionId: _sessionId, ...rest } = snapshot;
      sessions[sessionId] = rest;
    }
    return { version: STORAGE_VERSION, sessions };
  }
}

/** Repairs one raw list into the shape the UI and the next prompt expect. */
function normalizeTodos(raw: unknown, warnings: string[]): TodoItem[] {
  if (!Array.isArray(raw)) {
    warnings.push('todos 必须是数组，已按空清单处理');
    return [];
  }
  if (raw.length > MAX_TODO_ITEMS) {
    warnings.push(`清单最多 ${MAX_TODO_ITEMS} 项，多出的 ${raw.length - MAX_TODO_ITEMS} 项已丢弃`);
  }

  const out: TodoItem[] = [];
  for (const entry of raw.slice(0, MAX_TODO_ITEMS)) {
    if (!entry || typeof entry !== 'object') {
      warnings.push('有一项不是对象，已丢弃');
      continue;
    }
    const item = entry as Record<string, unknown>;
    let content = typeof item.content === 'string' ? item.content.trim() : '';
    if (!content) {
      warnings.push('有一项缺少 content，已丢弃');
      continue;
    }
    if (content.length > MAX_TODO_CONTENT) {
      content = content.slice(0, MAX_TODO_CONTENT);
      warnings.push(`有一项超过 ${MAX_TODO_CONTENT} 字，已截断`);
    }

    let status = item.status as TodoStatus;
    if (!TODO_STATUSES.includes(status)) {
      warnings.push(`状态 ${String(item.status)} 无效，已按 pending 处理`);
      status = 'pending';
    }

    let priority: TodoPriority | undefined;
    if (item.priority != null) {
      if (TODO_PRIORITIES.includes(item.priority as TodoPriority)) {
        priority = item.priority as TodoPriority;
      } else {
        warnings.push(`优先级 ${String(item.priority)} 无效，已忽略`);
      }
    }

    out.push({ content, status, ...(priority ? { priority } : {}) });
  }

  // At most one item is in progress. Keep the first; the rest go back to
  // pending rather than being dropped — the work still exists.
  let seenInProgress = false;
  for (const todo of out) {
    if (todo.status !== 'in_progress') continue;
    if (!seenInProgress) {
      seenInProgress = true;
    } else {
      todo.status = 'pending';
      warnings.push(`同时只能有一项 in_progress：「${truncate(todo.content, 40)}」已改回 pending`);
    }
  }

  return out;
}

export function countTodos(todos: TodoItem[]): Record<TodoStatus, number> {
  const counts: Record<TodoStatus, number> = {
    pending: 0,
    in_progress: 0,
    completed: 0,
    cancelled: 0,
  };
  for (const todo of todos) counts[todo.status] += 1;
  return counts;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** IPC surface consumed by the renderer's todo store. */
export function registerTodoIpc(service: TodoService): void {
  ipcMain.handle('pi:todo:sync', (_event, sessionId?: string) => {
    return service.get(sessionId || 'default');
  });
}
