/**
 * com.pi.tasks backend — the planner's state, its agent tools, and the timer
 * that makes a scheduled item actually happen.
 *
 * Why the timer lives here and not in the panel: the host starts the backend of
 * every enabled plugin at app boot and never idles it (`PluginSystem.doInit`),
 * so a UtilityProcess long-lived process is the one place in a plugin that
 * outlives the panel being closed. A timer in the panel UI would stop the
 * moment the user switched tabs, which is exactly when a reminder is needed.
 *
 * What it cannot do is run while the app is closed, and it cannot reach a
 * conversation when the window is gone. Rather than paper over either, every
 * firing that cannot happen is *written down* — see `runMissed` and
 * `probeUi` — so the 记录 view can show what was skipped and offer to do it.
 */
import type { Item, RunRecord, RunStatus, TasksState, Trigger } from '../core/types.js';
import { parseWhen, FREE_TEXT_HINT } from '../core/parse-when.js';
import { buildRRule, describeRepeat, expandOccurrences, alignStartToRule } from '../core/recur.js';
import {
  dueRuns,
  nextTriggerAt,
  nextFireAcrossItems,
  currentOccurrenceKey,
  describeTrigger,
  type DueRun,
} from '../core/triggers.js';
import { addDays, dayKey, dayStart, formatWhen, formatMonth, toLocalIso, weekdayLabel } from '../core/time.js';

// ── host plumbing (control plane = process.parentPort) ──

/**
 * Electron's `parentPort` is not on the stock `Process` type, so the host port
 * is taken as a parameter with one cast at the bottom of this file — the same
 * shape `com.pi.files` uses. It also means the backend can be imported and
 * driven in a test without an Electron runtime.
 */
export interface HostPort {
  postMessage(msg: unknown): void;
  on(event: 'message', listener: (event: { data: any; ports?: any[] }) => void): void;
}

/** Assigned by `main`; a no-op before that so importing this file cannot throw. */
let hostPost: (msg: unknown) => void = () => {};
const post = (msg: unknown): void => hostPost(msg);
const log = (level: string, message: string): void => post({ type: 'log', level, message });

let seq = 0;
const pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();

function call(method: string, params: Record<string, unknown> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = 'c' + ++seq;
    pending.set(id, { resolve, reject });
    post({ type: 'call', id, method, params });
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`capability timeout: ${method}`));
    }, 30_000);
  });
}

// ── state ──

const STORAGE_KEY = 'tasks';
/** Older entries are dropped: the history is a convenience, not a record of account. */
const MAX_RUNS = 500;
/**
 * Ceiling on how long the engine may sleep between passes.
 *
 * The engine normally wakes exactly when the next firing is due. This cap is
 * the safety net for the cases where "the next firing" is not the whole story:
 * a clock jump, a laptop waking from sleep, or a rule that starts matching
 * because the date rolled over. Without it, a long sleep would mean the engine
 * never notices.
 */
const MAX_TICK_MS = 30_000;
/** Floor, so a firing due "now" cannot spin the loop. */
const MIN_TICK_MS = 250;

let state: TasksState = { items: [], runs: [], notes: {}, completedAt: {} };
let uiPort: any = null;
/** Set when the host's port closes — i.e. the window that owned it is gone. */
let uiPortClosed = false;

const uiPost = (payload: unknown): void => {
  try {
    uiPort?.postMessage(payload);
  } catch {
    /* The port is gone. Not proof of anything — see probeUi. */
  }
};

async function load(): Promise<void> {
  const saved = await call('storage.get', { key: STORAGE_KEY }).catch(() => undefined);
  const s = (saved && typeof saved === 'object' ? saved : {}) as Partial<TasksState>;
  state = {
    items: Array.isArray(s.items) ? s.items : [],
    runs: Array.isArray(s.runs) ? s.runs : [],
    // Both are newer than the first release, so older stored state simply has
    // them absent — defaulted here rather than migrated.
    notes: s.notes && typeof s.notes === 'object' ? s.notes : {},
    completedAt: s.completedAt && typeof s.completedAt === 'object' ? s.completedAt : {},
    lastTickAt: s.lastTickAt,
  };
}

async function save(): Promise<void> {
  if (state.runs.length > MAX_RUNS) {
    state.runs = state.runs.slice(-MAX_RUNS);
  }
  await call('storage.set', { key: STORAGE_KEY, value: state }).catch((err) => {
    log('error', `storage.set failed: ${err.message}`);
  });
}

// ── the view the panel renders ──

import type { AgendaGroup, Views, ViewItem } from '../core/view.js';
import { buildDayPage, type DayPage } from '../core/day.js';

function groupOf(start: Date | undefined, now: Date): AgendaGroup {
  if (!start) return 'undated';
  const days = Math.floor(
    (new Date(start).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000,
  );
  if (days < 0) return 'overdue';
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days < 7) return 'week';
  return 'later';
}

function toViewItem(item: Item, now: Date): ViewItem {
  const occKey = currentOccurrenceKey(item, now);
  const start = item.start ? new Date(item.start) : undefined;
  const next = nextTriggerAt(item, now);
  const done = item.completions.includes(occKey);
  return {
    id: item.id,
    title: item.title,
    note: item.note,
    start: item.start,
    end: item.end,
    allDay: Boolean(item.allDay),
    rrule: item.rrule,
    repeatLabel: describeRepeat(item.rrule),
    triggers: item.triggers,
    triggerLabels: item.triggers.map(describeTrigger),
    done,
    occurrenceKey: occKey,
    nextFireAt: next ? next.toISOString() : undefined,
    whenLabel: item.start
      ? item.allDay
        ? `${formatWhen(start!, now, true)} 全天`
        : formatWhen(start!, now)
      : '无日期',
    group: groupOf(start, now),
  };
}

function buildView(now: Date, truncated: string[] = []): Views {
  const runs = [...state.runs].reverse();
  return {
    items: state.items.map((i) => toViewItem(i, now)),
    runs,
    missed: runs.filter((r) => r.status === 'missed' || r.status === 'undelivered'),
    notes: state.notes,
    now: now.toISOString(),
    truncated,
  };
}

/** Assemble one day's page — the auto half plus whatever the user wrote. */
function dayPage(day: string): DayPage {
  return buildDayPage(state.items, state.runs, state.notes, state.completedAt, day);
}

function render(truncated: string[] = []): void {
  uiPost({ kind: 'event', event: 'ui.render', panelId: 'items', data: buildView(new Date(), truncated) });
  // A newly saved item can be due seconds from now; re-arming here means it is
  // picked up then rather than at the next poll.
  scheduleNextTick();
}

// ── delivery probing ──
//
// The host offers no signal that the renderer died: it drops its own bookkeeping
// when a webContents is destroyed but never closes the port or tells the
// backend. Posting into a dead port is a silent no-op, so `uiPost` returning
// without throwing proves nothing.
//
// So delivery is established the only way that is actually evidence: ask, and
// wait for an answer. This runs at fire time rather than as a steady heartbeat
// — nothing is sent when nothing is due.

const PROBE_TIMEOUT_MS = 1500;
const pendingProbes = new Map<string, () => void>();

function probeUi(): Promise<boolean> {
  if (!uiPort || uiPortClosed) return Promise.resolve(false);
  return new Promise((resolve) => {
    const id = 'probe' + ++seq;
    const timer = setTimeout(() => {
      pendingProbes.delete(id);
      resolve(false);
    }, PROBE_TIMEOUT_MS);
    pendingProbes.set(id, () => {
      clearTimeout(timer);
      resolve(true);
    });
    try {
      uiPort.postMessage({ kind: 'event', event: 'pi.probe', data: { id } });
    } catch {
      clearTimeout(timer);
      pendingProbes.delete(id);
      resolve(false);
    }
  });
}

// ── the tick ──

let ticking = false;
let tickTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Arm the timer for the next moment something is due.
 *
 * Not a fixed interval: that would make a reminder up to a full tick late, and
 * the next fire time is already known, so there is no reason to be. Bounded
 * above by `MAX_TICK_MS` and below by `MIN_TICK_MS` — see both.
 */
function scheduleNextTick(): void {
  if (tickTimer) clearTimeout(tickTimer);
  const now = new Date();
  const next = nextFireAcrossItems(state.items, now);
  const delay =
    next === null
      ? MAX_TICK_MS
      : Math.min(Math.max(next.getTime() - now.getTime(), MIN_TICK_MS), MAX_TICK_MS);
  tickTimer = setTimeout(() => void tick(), delay);
}

async function tick(): Promise<void> {
  // A slow tick must not overlap the next one: two concurrent passes would both
  // compute the same due set and, before either had written its run records,
  // both fire it.
  if (ticking) return;
  ticking = true;
  const now = new Date();
  try {
    const from = state.lastTickAt ? new Date(state.lastTickAt) : now;
    const alreadyRun = new Set(state.runs.map((r) => r.key));
    const { toFire, missed, truncated } = dueRuns(state.items, alreadyRun, from, now, now);

    for (const run of missed) {
      state.runs.push(record(run, 'missed', undefined, '当时应用没有在运行'));
    }

    for (const run of toFire) {
      await perform(run);
    }

    state.lastTickAt = now.toISOString();
    await save();
    render(truncated);
  } catch (err) {
    log('error', `tick failed: ${err instanceof Error ? err.message : String(err)}`);
    // Re-arm even on failure: a throwing pass must not stop the clock, or one
    // bad item would silence every reminder after it.
    scheduleNextTick();
  } finally {
    ticking = false;
  }
}

function record(
  run: DueRun,
  status: RunStatus,
  firedAt: Date | undefined,
  detail: string | undefined,
): RunRecord {
  return {
    key: run.key,
    itemId: run.item.id,
    itemTitle: run.item.title,
    occurrenceKey: run.occurrence.key,
    triggerId: run.trigger.id,
    dueAt: toLocalIso(run.fireAt),
    firedAt: firedAt ? toLocalIso(firedAt) : undefined,
    action: run.trigger.action.kind,
    status,
    detail,
  };
}

/** Carry out one firing and record what actually happened. */
async function perform(run: DueRun): Promise<void> {
  const { trigger, item, fireAt } = run;
  const now = new Date();

  // Raise a badge without stealing focus, so a firing is visible even when the
  // panel is closed. Done for both action kinds — a notification the user
  // missed entirely would otherwise leave no trace in the UI.
  void call('panel.open', { panelId: 'items', focus: false }).catch(() => undefined);

  if (trigger.action.kind === 'notify') {
    const title = trigger.action.title || item.title;
    const body = item.note || formatWhen(fireAt, now, Boolean(item.allDay));
    try {
      await call('notify.show', { title, body });
      state.runs.push(record(run, 'ok', now, '已发送系统通知'));
    } catch (err) {
      state.runs.push(record(run, 'failed', now, err instanceof Error ? err.message : String(err)));
    }
    return;
  }

  // A live panel is necessary but not sufficient. The composer lives in the
  // shell window, and on macOS closing that window leaves the panel's view —
  // and therefore this port — alive, so the probe can answer "yes" while there
  // is nowhere for a message to land. That was measured, not assumed: with the
  // window closed the probe passed and the send threw `Object has been
  // destroyed`. So the probe stays as a cheap pre-check, and the authoritative
  // answer is whether the send itself succeeded.
  if (!(await probeUi())) {
    state.runs.push(record(run, 'undelivered', undefined, '当时没有打开任何窗口'));
    return;
  }

  try {
    await call('chat.send', { text: trigger.action.prompt });
    state.runs.push(record(run, 'ok', now, '已送进对话'));
  } catch (err) {
    // Recorded as "not delivered" rather than "failed". From the user's side
    // there is one fact and one action — the message never reached the
    // conversation, and they can re-run it — and `failed` would read as a
    // plugin bug instead. The raw error is kept in the detail because it is a
    // real Electron message, and swallowing it would make an actual defect
    // harder to find than a closed window.
    state.runs.push(
      record(run, 'undelivered', undefined, `没能送进对话（${errMessage(err)}）—— 通常是应用窗口已经关闭`),
    );
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Re-run a firing the user asked for, ignoring the grace window. */
async function rerun(key: string): Promise<void> {
  const existing = state.runs.find((r) => r.key === key);
  if (!existing) return;
  // Drop the old record so the idempotency check in `dueRuns` does not block
  // the re-run, then rebuild the firing from the item as it stands now.
  state.runs = state.runs.filter((r) => r.key !== key);
  const item = state.items.find((i) => i.id === existing.itemId);
  const trigger = item?.triggers.find((t) => t.id === existing.triggerId);
  if (!item || !trigger || !item.start) {
    // The item or trigger was deleted since — nothing to re-run.
    await save();
    render();
    return;
  }
  await perform({
    item,
    occurrence: { itemId: item.id, key: existing.occurrenceKey, at: new Date(existing.occurrenceKey) },
    trigger,
    fireAt: new Date(existing.dueAt),
    key: existing.key,
  });
  await save();
  render();
}

// ── writing items ──

function newId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function newTrigger(action: Trigger['action'], offsetMinutes: number): Trigger {
  return { id: newId('g'), offsetMinutes, action, enabled: true };
}

interface SaveInput {
  id?: string;
  title?: string;
  note?: string;
  start?: string | null;
  end?: string | null;
  allDay?: boolean;
  rrule?: string | null;
  triggers?: Trigger[];
}

/** Create or update an item. Returns the stored item. */
function saveItem(input: SaveInput): Item {
  const existing = input.id ? state.items.find((i) => i.id === input.id) : undefined;
  const item: Item = existing ?? {
    id: newId('i'),
    title: '',
    createdAt: toLocalIso(new Date()),
    completions: [],
    triggers: [],
  };

  if (input.title !== undefined) item.title = String(input.title).slice(0, 200);
  if (input.note !== undefined) item.note = String(input.note).slice(0, 2000) || undefined;
  if (input.start !== undefined) item.start = input.start || undefined;
  if (input.end !== undefined) item.end = input.end || undefined;
  if (input.allDay !== undefined) item.allDay = input.allDay;
  if (input.rrule !== undefined) item.rrule = input.rrule || undefined;
  if (input.triggers !== undefined) item.triggers = input.triggers;

  // Triggers are anchored to an occurrence, so an item with no time can have
  // none — and nothing to repeat either. Dropping them here rather than letting
  // them sit inert means the UI never shows a reminder that could not possibly
  // fire. Callers that set either without a time report it as an error first.
  if (!item.start) {
    item.triggers = [];
    item.rrule = undefined;
  }

  if (existing) {
    state.items = state.items.map((i) => (i.id === item.id ? item : i));
  } else {
    state.items = [...state.items, item];
  }

  // Keep the stored time and the rule consistent — see `alignStartToRule`.
  // Applied after insertion so the corrected value is what every reader sees,
  // and to items created either by the editor or by an agent tool call.
  if (item.rrule && item.start) {
    const aligned = alignStartToRule(item);
    if (aligned && aligned !== item.start) item.start = aligned;
  }

  return item;
}

// ── agent tools ──

/**
 * Mark an occurrence done or not done, and record *when*.
 *
 * The timestamp is the whole reason `completedAt` exists: it is what lets an
 * item with no time appear on the day it was actually finished, since its
 * occurrence key is the dateless constant `'once'`.
 */
function setCompletion(item: Item, key: string, done: boolean, now = new Date()): void {
  if (done) {
    item.completions = Array.from(new Set([...item.completions, key]));
    state.completedAt[key] = toLocalIso(now);
  } else {
    item.completions = item.completions.filter((k) => k !== key);
    delete state.completedAt[key];
  }
}

/** Find an item by title substring, most recently created first. */
function findByTitle(title: string, preferOpen = true): Item | undefined {
  const needle = String(title ?? '').trim();
  if (!needle) return undefined;
  const matches = state.items
    .filter((i) => i.title.includes(needle))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return (preferOpen && matches.find((i) => i.completions.length === 0)) || matches[0];
}

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

/** Run statuses as the agent should read them out. */
const STATUS_CN: Record<RunStatus, string> = {
  ok: '已完成',
  missed: '错过',
  undelivered: '没送到',
  failed: '出错',
};

/**
 * Accepts either a picker word or a raw RRULE body.
 *
 * Both are allowed because the picker cannot express everything — `每月最后一个
 * 工作日` has no picker entry — and refusing a valid RRULE just because the UI
 * has no button for it would be a strange limit to impose on the agent.
 */
function repeatSpec(value: unknown): string | undefined {
  const spec = String(value ?? '').trim();
  if (!spec) return undefined;
  if (spec.toUpperCase().includes('FREQ=')) return spec;
  const kind = spec.toLowerCase();
  if (kind === 'daily' || kind === 'weekly' || kind === 'monthly' || kind === 'yearly') {
    return buildRRule({ kind });
  }
  throw new Error(
    `看不懂的重复方式：${spec}。可用 daily / weekly / monthly / yearly，` +
      `或直接给 RRULE，例如 FREQ=WEEKLY;BYDAY=MO。`,
  );
}

async function onTool(msg: any): Promise<unknown> {
  const { name, params } = msg;
  const p = params ?? {};

  switch (name) {
    case 'item_add': {
      if (!p.title) throw new Error('missing title');
      let start: string | undefined;
      let allDay = false;
      let echo = '';

      if (p.when) {
        const parsed = parseWhen(String(p.when));
        if (!parsed.ok) throw new Error(parsed.error);
        start = toLocalIso(parsed.value.at);
        allDay = parsed.value.allDay;
        echo = parsed.value.note;
      }

      let rrule: string | undefined;
      if (p.repeat !== undefined && p.repeat !== null && String(p.repeat).trim() !== '') {
        rrule = repeatSpec(p.repeat);
        if (rrule && !start) throw new Error('要重复就得先有时间。请同时给 when。');
      }

      const triggers: Trigger[] = [];
      if (p.remindBefore !== undefined) {
        const minutes = Number(p.remindBefore);
        if (!Number.isFinite(minutes)) throw new Error('remindBefore 要是一个分钟数');
        triggers.push(newTrigger({ kind: 'notify' }, -Math.abs(minutes)));
      }
      if (p.onDue) {
        triggers.push(newTrigger({ kind: 'agent', prompt: String(p.onDue) }, 0));
      }
      if (triggers.length > 0 && !start) {
        throw new Error('要设提醒就得先有时间。请同时给 when。');
      }

      const item = saveItem({ title: p.title, note: p.note, start, allDay, rrule, triggers });
      await save();
      render();

      const lines = [`已记下：${item.title}`];
      if (echo) lines.push(`时间：${echo}${p.when && !String(p.when).match(/^\d{4}-/) ? `（${FREE_TEXT_HINT}）` : ''}`);
      else lines.push('时间：无（纯待办）');
      if (item.rrule) lines.push(`重复：${describeRepeat(item.rrule)}`);
      for (const t of item.triggers) lines.push(`触发：${describeTrigger(t)}`);
      return {
        ...text(lines.join('\n')),
        card: {
          component: 'Card',
          props: { title: '已记下' },
          children: [
            {
              component: 'KeyValue',
              props: {
                items: [
                  ['事项', item.title],
                  ...(echo ? [['时间', echo]] : []),
                  ...(item.rrule ? [['重复', describeRepeat(item.rrule)]] : []),
                  ...item.triggers.map((t) => ['触发', describeTrigger(t)]),
                ],
              },
            },
          ],
        },
      };
    }

    case 'day_read': {
      // A range so that "整理一下这周" is one call rather than seven.
      const today = dayKey(new Date());
      const to = String(p.to ?? today);
      const from = String(p.from ?? (p.day ? p.day : dayKey(addDays(new Date(), -6))));
      const fromD = dayStart(from);
      const toD = dayStart(to);
      if (Number.isNaN(fromD.getTime()) || Number.isNaN(toD.getTime())) {
        throw new Error('日期要写成 2026-09-30 这样');
      }
      const span = Math.round((toD.getTime() - fromD.getTime()) / 86_400_000);
      if (span < 0) throw new Error('from 比 to 还晚');
      if (span > 90) throw new Error('一次最多读 90 天，请缩短范围');

      const lines: string[] = [];
      let wrote = 0;
      for (let i = 0; i <= span; i++) {
        const day = dayKey(addDays(fromD, i));
        const page = dayPage(day);
        const note = page.note?.text?.trim();
        const empty = page.planned.length === 0 && page.done.length === 0 && page.missed.length === 0 && !note;
        if (empty) continue;
        wrote++;

        lines.push(`【${day} ${weekdayLabel(dayStart(day))}】`);
        if (page.done.length) lines.push(`  完成：${page.done.map((e) => e.title).join('、')}`);
        if (page.planned.length) lines.push(`  没完成：${page.planned.map((e) => e.title).join('、')}`);
        if (page.missed.length) {
          lines.push(`  错过的触发：${page.missed.map((r) => `${r.itemTitle}（${STATUS_CN[r.status]}）`).join('、')}`);
        }
        if (note) lines.push(`  用户写的：${note.replace(/\n/g, '\n    ')}`);
        lines.push('');
      }

      if (wrote === 0) return text(`${from} 到 ${to} 之间没有任何记录。`);
      return text(`从 ${from} 到 ${to} 的记录：\n\n${lines.join('\n')}`);
    }

    case 'day_write': {
      const day = String(p.day ?? dayKey(new Date()));
      if (Number.isNaN(dayStart(day).getTime())) throw new Error('日期要写成 2026-09-30 这样');
      const body = String(p.text ?? '').trim();
      if (!body) throw new Error('没给要写的内容');

      const mode = p.mode === 'replace' ? 'replace' : 'append';
      const existing = state.notes[day]?.text ?? '';
      const next = mode === 'replace' || !existing.trim() ? body : `${existing}\n\n${body}`;
      state.notes[day] = { text: next, updatedAt: toLocalIso(new Date()) };
      await save();
      render();

      return text(
        `已写入 ${day} 的记录${mode === 'replace' && existing.trim() ? '（覆盖了原来的内容）' : ''}。\n` +
          `现在这一天是：\n${next}`,
      );
    }

    case 'item_list': {
      const now = new Date();
      const range = String(p.range ?? 'week');
      let items = state.items;
      if (range === 'today') {
        const today = dayKey(now);
        items = items.filter((i) => i.start && dayKey(new Date(i.start)) === today);
      } else if (range === 'week') {
        const end = new Date(now.getTime() + 7 * 86_400_000);
        items = items.filter((i) => i.start && new Date(i.start) <= end);
      }
      if (items.length === 0) return text('没有符合条件的事项。');

      const lines = items
        .sort((a, b) => (a.start ?? '9999') < (b.start ?? '9999') ? -1 : 1)
        .map((i) => {
          const v = toViewItem(i, now);
          const mark = v.done ? '✓' : '○';
          const rep = i.rrule ? ` ↻${describeRepeat(i.rrule)}` : '';
          const fire = v.nextFireAt ? ` · 下次触发 ${formatWhen(new Date(v.nextFireAt), now)}` : '';
          return `${mark} ${v.whenLabel} — ${i.title}${rep}${fire}${i.note ? `（${i.note}）` : ''}`;
        });
      const open = items.filter((i) => !toViewItem(i, now).done).length;
      return text(`事项（范围：${range}，${open} 项未完成）：\n${lines.join('\n')}`);
    }

    case 'item_update': {
      const item = findByTitle(p.title, true);
      if (!item) throw new Error(`没找到事项：${p.title}`);
      const input: SaveInput = { id: item.id };

      if (p.when !== undefined) {
        if (p.when === null || p.when === '') {
          input.start = null;
        } else {
          const parsed = parseWhen(String(p.when));
          if (!parsed.ok) throw new Error(parsed.error);
          input.start = toLocalIso(parsed.value.at);
          input.allDay = parsed.value.allDay;
        }
      }
      if (p.note !== undefined) input.note = String(p.note);
      if (p.repeat !== undefined) {
        const next = repeatSpec(p.repeat);
        // A repeat with no time has nothing to anchor to — refuse it here so the
        // reason reaches the agent, rather than being dropped silently in saveItem.
        if (next && !(input.start !== undefined ? input.start : item.start)) {
          throw new Error('要重复就得先有时间。请同时给 when。');
        }
        input.rrule = next ?? null;
      }
      const updated = saveItem(input);

      if (p.done !== undefined) {
        setCompletion(updated, currentOccurrenceKey(updated, new Date()), Boolean(p.done));
      }
      await save();
      render();
      const v = toViewItem(updated, new Date());
      return text(`已更新：${updated.title}\n时间：${v.whenLabel}\n状态：${v.done ? '已完成' : '未完成'}`);
    }

    case 'item_remove': {
      const item = findByTitle(p.title, false);
      if (!item) throw new Error(`没找到事项：${p.title}`);
      state.items = state.items.filter((i) => i.id !== item.id);
      await save();
      render();
      return text(`已删除：${item.title}`);
    }

    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// ── panel requests ──

async function onUiRequest(method: string, params: any): Promise<unknown> {
  switch (method) {
    case 'state.get':
      return buildView(new Date());

    case 'day.get':
      return dayPage(String(params?.day ?? dayKey(new Date())));

    /**
     * Write the day's free text.
     *
     * The note is the user's own words, so the destructive shape is opt-in:
     * callers pass `mode: 'replace'` explicitly, and anything else appends.
     * Reaching for a text field and wiping what someone wrote about their day
     * is not a failure mode worth leaving to a default.
     */
    case 'day.note.set': {
      const day = String(params?.day ?? dayKey(new Date()));
      const text = String(params?.text ?? '');
      const mode = params?.mode === 'replace' ? 'replace' : 'append';
      const existing = state.notes[day]?.text ?? '';
      const next = mode === 'replace' || !existing.trim() ? text : `${existing}\n\n${text}`;
      if (next.trim()) {
        state.notes[day] = { text: next, updatedAt: toLocalIso(new Date()) };
      } else {
        delete state.notes[day];
      }
      await save();
      render();
      return { ok: true, day, text: next };
    }

    /** Occurrences for the month grid. The panel cannot expand RRULEs itself. */
    case 'month.get': {
      const year = Number(params?.year ?? new Date().getFullYear());
      const month = Number(params?.month ?? new Date().getMonth());
      const from = new Date(year, month, 1, 0, 0, 0, 0);
      const to = new Date(year, month + 1, 0, 23, 59, 59, 999);
      const byDay: Record<string, Array<{ itemId: string; title: string; key: string; at: string; done: boolean }>> = {};
      for (const item of state.items) {
        for (const occ of expandOccurrences(item, from, to)) {
          const key = dayKey(occ.at!);
          (byDay[key] ??= []).push({
            itemId: item.id,
            title: item.title,
            key: occ.key,
            at: toLocalIso(occ.at!),
            done: item.completions.includes(occ.key),
          });
        }
      }
      return { year, month, label: formatMonth(from), byDay };
    }

    case 'item.save': {
      const item = saveItem(params as SaveInput);
      await save();
      render();
      return { ok: true, id: item.id };
    }

    case 'item.remove': {
      state.items = state.items.filter((i) => i.id !== String(params?.id));
      await save();
      render();
      return { ok: true };
    }

    case 'item.toggle': {
      const item = state.items.find((i) => i.id === String(params?.id));
      if (!item) throw new Error('没有这条事项');
      const key = String(params?.occurrenceKey ?? currentOccurrenceKey(item, new Date()));
      setCompletion(item, key, !item.completions.includes(key));
      await save();
      render();
      return { ok: true };
    }

    case 'run.rerun':
      await rerun(String(params?.key));
      return { ok: true };

    case 'run.clear':
      state.runs = [];
      await save();
      render();
      return { ok: true };

    default:
      throw new Error(`unknown ui request: ${method}`);
  }
}

// ── message pump ──

function onHostMessage(event: { data: any; ports?: any[] }): void {
  const msg = event.data || {};
  switch (msg.type) {
    case 'init':
      load()
        .then(async () => {
          render();
          // The first tick reconciles anything that came due while the app was
          // closed: `lastTickAt` is from the previous session, so the window
          // covers the gap. That is the whole catch-up mechanism.
          await tick();
        })
        .catch((e) => log('error', `init failed: ${e.message}`));
      break;

    case 'call-result': {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result);
      }
      break;
    }

    case 'tool-call':
      onTool(msg)
        .then((result) => post({ type: 'tool-result', id: msg.id, ...(result as object) }))
        .catch((e) =>
          post({ type: 'tool-result', id: msg.id, error: e instanceof Error ? e.message : String(e) }),
        );
      break;

    case 'ui-port': {
      const port = event.ports?.[0];
      if (!port) break;
      uiPort = port;
      uiPortClosed = false;
      // The host closes a replaced port when a fresh webContents takes over, so
      // this is the closest thing to "the old window is gone" that exists.
      try {
        port.on('close', () => {
          uiPortClosed = true;
          log('info', 'ui port closed — window gone');
        });
      } catch {
        /* older Electron: no close event. Probing still covers delivery. */
      }
      port.on('message', (ev: any) => {
        const payload = ev.data;
        if (payload?.kind === 'event' && payload.event === 'pi.probe.reply') {
          const resolve = pendingProbes.get(payload.data?.id);
          if (resolve) {
            pendingProbes.delete(payload.data.id);
            resolve();
          }
          return;
        }
        if (payload?.kind === 'event' && payload.event === 'panel.mounted') {
          render();
          // A badge set while no window existed is lost — it is renderer state
          // and does not survive a reload — so it is re-asserted on every mount.
          const due = buildView(new Date()).missed.length;
          if (due > 0) void call('panel.setStatus', { panelId: 'items', badge: due }).catch(() => undefined);
          return;
        }
        if (payload?.kind === 'request') {
          onUiRequest(payload.method, payload.params)
            .then((result) => uiPost({ kind: 'response', id: payload.id, result }))
            .catch((err) =>
              uiPost({
                kind: 'response',
                id: payload.id,
                error: err instanceof Error ? err.message : String(err),
              }),
            );
        }
      });
      if (typeof port.start === 'function') port.start();
      break;
    }
  }
}

/** Wire the backend to its host port and announce readiness. */
export function main(parentPort: HostPort): void {
  hostPost = (msg) => parentPort.postMessage(msg);
  parentPort.on('message', onHostMessage);
  post({ type: 'ready' });
}

const injected = (process as unknown as { parentPort?: HostPort }).parentPort;
if (injected) main(injected);
