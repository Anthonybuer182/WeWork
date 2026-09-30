/**
 * Recurrence, on top of `rrule` (the standard iCalendar RRULE implementation).
 *
 * Two things in here are easy to get wrong and are therefore stated once, here,
 * instead of at each call site:
 *
 * 1. **The rule is built with an explicit local `dtstart`.** Handing `rrule` a
 *    `DTSTART:...` string makes it parse that stamp as UTC, which moves a 09:00
 *    item to 17:00 in UTC+8 — and shifts a monthly item across a day boundary
 *    while still producing dates that look plausible. See `buildRule`.
 *
 * 2. **Ranges are half-open on the left**: `(from, to]`. The trigger engine
 *    re-evaluates `(lastTickAt, now]` on every tick, so an inclusive-left range
 *    would re-fire the boundary occurrence on every single tick.
 */
import { RRule, type Options } from 'rrule';
import type { Item, Occurrence } from './types.js';
import { toLocalIso } from './time.js';

/** The occurrence key of an item that has no time. One occurrence, forever. */
export const ONCE = 'once';

export function occurrenceKey(at: Date | undefined): string {
  return at ? at.toISOString() : ONCE;
}

/** The parsed rule for an item, or null when it does not repeat. */
function buildRule(item: Pick<Item, 'start' | 'rrule'>): RRule | null {
  if (!item.start || !item.rrule) return null;
  let parsed: Partial<Options>;
  try {
    parsed = RRule.parseString(item.rrule);
  } catch {
    // A malformed rule must not take the whole tick down with it — one bad
    // item would otherwise stop every other item from ever firing.
    return null;
  }
  // `new Date(...)` on the stored local ISO yields the correct instant, and
  // rrule then expands in the machine's timezone rather than in UTC.
  return new RRule({ ...(parsed as Options), dtstart: new Date(item.start) });
}

/** Whether an item repeats. */
export function repeats(item: Pick<Item, 'rrule'>): boolean {
  return Boolean(item.rrule && item.rrule.trim());
}

/**
 * Occurrences of `item` in `(from, to]`, oldest first.
 *
 * Empty for an item with no `start`: with no time there is nothing to place on
 * a timeline, and nothing for a trigger to count back from.
 */
export function expandOccurrences(item: Item, from: Date, to: Date): Occurrence[] {
  if (!item.start) return [];
  if (to.getTime() < from.getTime()) return [];

  const rule = buildRule(item);
  const dates = rule
    ? // Inclusive on both ends, then narrowed by the explicit filter below.
      // Doing it this way keeps the `(from, to]` rule visible at the call site
      // instead of depending on a library flag's default.
      rule.between(from, to, true)
    : [new Date(item.start)];

  return dates
    .filter((d) => d.getTime() > from.getTime() && d.getTime() <= to.getTime())
    .map((d) => ({ itemId: item.id, key: occurrenceKey(d), at: d }));
}

/**
 * The next occurrence strictly after `after`, or null.
 *
 * Uses the library's `after`, which walks the recurrence set lazily rather than
 * expanding an unbounded rule into an array.
 */
export function nextOccurrence(item: Item, after: Date): Occurrence | null {
  if (!item.start) return null;
  const rule = buildRule(item);
  const next = rule ? rule.after(after, false) : new Date(item.start);
  if (!next || next.getTime() <= after.getTime()) return null;
  return { itemId: item.id, key: occurrenceKey(next), at: next };
}

/** The first occurrence at or after `from` — used to show "next up" for a rule with no end. */
export function firstOccurrenceOnOrAfter(item: Item, from: Date): Occurrence | null {
  if (!item.start) return null;
  const rule = buildRule(item);
  if (!rule) {
    const at = new Date(item.start);
    return at.getTime() >= from.getTime() ? { itemId: item.id, key: occurrenceKey(at), at } : null;
  }
  const next = rule.after(new Date(from.getTime() - 1), true);
  if (!next) return null;
  return { itemId: item.id, key: occurrenceKey(next), at: next };
}

/**
 * Move `start` forward to the first occurrence the rule actually produces.
 *
 * RFC 5545 is explicit that DTSTART *bounds* the recurrence set rather than
 * being a member of it, so a Thursday date combined with `BYDAY=TU` yields no
 * Thursday occurrence at all. Left alone that stores a time the agenda happily
 * displays and which can never fire — the item reads "周四 10:00 / 每周二" and
 * the next firing is the following Tuesday. Aligning the two keeps the row
 * honest, and doing it here rather than in the editor means the agent cannot
 * create the same contradiction through a tool call.
 */
export function alignStartToRule(item: Pick<Item, 'start' | 'rrule'>): string | undefined {
  if (!item.start || !item.rrule) return item.start;
  const rule = buildRule(item);
  if (!rule) return item.start;

  const from = new Date(item.start);
  // `after(from - 1ms, true)` is "the first occurrence at or after `from`".
  const first = rule.after(new Date(from.getTime() - 1), true);
  if (!first) return item.start;
  return first.getTime() === from.getTime() ? item.start : toLocalIso(first);
}

// ── repeat editing (the panel's picker) ──

export type RepeatKind = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'custom';

export interface RepeatSpec {
  kind: RepeatKind;
  /** For `weekly`: which days, 0 = Sunday … 6 = Saturday. */
  byDay?: number[];
  /** For `custom`: the RRULE body verbatim. */
  raw?: string;
}

const BYDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;

/** Build an RRULE body from the picker's state. `none` yields no rule at all. */
export function buildRRule(spec: RepeatSpec): string | undefined {
  switch (spec.kind) {
    case 'none':
      return undefined;
    case 'daily':
      return 'FREQ=DAILY';
    case 'weekly': {
      const days = (spec.byDay ?? []).slice().sort((a, b) => a - b);
      return days.length ? `FREQ=WEEKLY;BYDAY=${days.map((d) => BYDAY_CODES[d]).join(',')}` : 'FREQ=WEEKLY';
    }
    case 'monthly':
      return 'FREQ=MONTHLY';
    case 'yearly':
      return 'FREQ=YEARLY';
    case 'custom':
      return spec.raw?.trim() || undefined;
    default:
      return undefined;
  }
}

/** Read a stored RRULE body back into the picker's shape. */
export function parseRepeat(rrule: string | undefined): RepeatSpec {
  if (!rrule || !rrule.trim()) return { kind: 'none' };
  const body = rrule.trim();
  const freq = /FREQ=([A-Z]+)/.exec(body)?.[1];
  if (freq === 'DAILY' && body === 'FREQ=DAILY') return { kind: 'daily' };
  if (freq === 'MONTHLY' && body === 'FREQ=MONTHLY') return { kind: 'monthly' };
  if (freq === 'YEARLY' && body === 'FREQ=YEARLY') return { kind: 'yearly' };
  if (freq === 'WEEKLY') {
    const byday = /BYDAY=([A-Z,]+)/.exec(body)?.[1];
    if (!byday) return { kind: 'weekly', byDay: [] };
    const days = byday
      .split(',')
      .map((code) => BYDAY_CODES.indexOf(code.trim() as (typeof BYDAY_CODES)[number]))
      .filter((i) => i >= 0);
    return { kind: 'weekly', byDay: days };
  }
  return { kind: 'custom', raw: body };
}

/** Short human label for a rule, e.g. `每周一、周三`. Falls back to the raw body. */
export function describeRepeat(rrule: string | undefined): string {
  const spec = parseRepeat(rrule);
  switch (spec.kind) {
    case 'none':
      return '不重复';
    case 'daily':
      return '每天';
    case 'weekly':
      return spec.byDay?.length
        ? `每${spec.byDay.map((d) => ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d]).join('、')}`
        : '每周';
    case 'monthly':
      return '每月';
    case 'yearly':
      return '每年';
    default:
      return spec.raw ?? '自定义';
  }
}
