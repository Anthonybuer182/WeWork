/**
 * Turning what a person (or the agent) says into a real instant.
 *
 * The rule this file exists to enforce: **never store a time we did not
 * understand.** The calendar plugin this replaces stored `time` as a free
 * string and documented that it "would not compute dates, sort, or remind" —
 * which is how a product ends up with a schedule full of entries that can
 * never fire. If the text cannot be resolved, this returns an error.
 *
 * `chrono-node` does most of the work, but its Chinese support has real holes
 * that were measured rather than assumed: `后天` and `大后天` — among the most
 * ordinary things a Chinese speaker writes — do not parse at all, nor do
 * `下个月1号` or `9/30`. So the gaps that matter are normalised away first
 * (`normalizeRelative`) and chrono handles the rest.
 *
 * Its second quirk is that a date with no time comes back as 12:00, and that
 * implied noon is indistinguishable from an explicit one by certainty alone —
 * `明天` and `明天早上` both report "hour not certain". The rule below resolves
 * that the only way that is safe: an uncertain *12:00* is treated as no time at
 * all (an all-day item), which is right for `明天` and for `10月1号交报告`.
 * The cost is that a bare `中午` also reads as all-day; that is the error we
 * can live with, because the alternative invents a noon meeting for every
 * undated reminder.
 */
import * as chrono from 'chrono-node';
import { addDays, dayKey, formatDay, formatTime, weekdayLabel } from './time.js';

export interface ParsedWhen {
  at: Date;
  /** True when no time of day was given — the item covers the whole day. */
  allDay: boolean;
  /** How it was understood, to be echoed back so a wrong reading is visible. */
  note: string;
}

export type ParseWhenResult = { ok: true; value: ParsedWhen } | { ok: false; error: string };

/**
 * Rewrite the relative date words chrono drops into an explicit `YYYY-MM-DD`,
 * leaving any time-of-day text intact for chrono to read.
 *
 * `后天下午 3 点` becomes `2026-10-01 下午 3 点`, which chrono parses correctly.
 * The trailing space is load-bearing: chrono reads `2026-10-01下午3点` as
 * date-only (noon) and only picks up the time when the two are separated.
 */
export function normalizeRelative(input: string, now: Date): string {
  let text = input;

  // Longest first: `大后天` contains `后天`, so it has to be replaced before it.
  text = text.replace(/大后天/g, `${dayKey(addDays(now, 3))} `);
  text = text.replace(/后天/g, `${dayKey(addDays(now, 2))} `);

  // `下个月 1 号` / `下月 1 日` → an explicit date in the following month.
  text = text.replace(/下个?月\s*(\d{1,2})\s*[号日]/g, (_m, day: string) => {
    const d = new Date(now.getFullYear(), now.getMonth() + 1, Number(day));
    return `${dayKey(d)} `;
  });

  // Trim the separator added above when nothing followed it.
  return text.trim();
}

/** Explicit date/time shapes, which are read directly rather than guessed at. */
function parseExplicit(input: string): ParsedWhen | null {
  // Full ISO with a time: keep exactly the instant given.
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(input);
  if (iso) {
    const [, y, mo, d, h, mi, s] = iso;
    const at = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0));
    if (!Number.isNaN(at.getTime())) return { at, allDay: false, note: '' };
  }

  // Date only — the whole day.
  const dateOnly = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(input);
  if (dateOnly) {
    const [, y, mo, d] = dateOnly;
    const at = new Date(Number(y), Number(mo) - 1, Number(d));
    if (!Number.isNaN(at.getTime())) return { at, allDay: true, note: '' };
  }

  // `2026/9/30` and `9/30` — the slash form chrono also rejects.
  const slash = /^(\d{4}\/)?(\d{1,2})\/(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/.exec(input);
  if (slash) {
    const [, yearPart, mo, d, h, mi] = slash;
    const now = new Date();
    let year = yearPart ? Number(yearPart.slice(0, -1)) : now.getFullYear();
    const at = h
      ? new Date(year, Number(mo) - 1, Number(d), Number(h), Number(mi))
      : new Date(year, Number(mo) - 1, Number(d));
    // A bare `9/30` that has already passed means next year, not the past.
    if (!yearPart && at.getTime() < now.getTime() - 86_400_000) {
      at.setFullYear(year + 1);
    }
    if (!Number.isNaN(at.getTime())) return { at, allDay: !h, note: '' };
  }

  return null;
}

/** `2026年9月30日 周三 15:00` — what the parser understood, for the echo. */
export function describeParsed(value: ParsedWhen, now = new Date()): string {
  const day = `${formatDay(value.at, now)} ${weekdayLabel(value.at)}`;
  return value.allDay ? `${day} 全天` : `${day} ${formatTime(value.at)}`;
}

export function parseWhen(input: string, now: Date = new Date()): ParseWhenResult {
  const raw = String(input ?? '').trim();
  if (!raw) return { ok: false, error: '没有给时间' };

  const explicit = parseExplicit(raw);
  if (explicit) {
    return { ok: true, value: { ...explicit, note: describeParsed(explicit, now) } };
  }

  const normalized = normalizeRelative(raw, now);
  const results = chrono.zh.parse(normalized, now, { forwardDate: true });
  const first = results[0];
  if (!first) {
    return {
      ok: false,
      error:
        `读不出「${raw}」是什么时候。可以用这些写法：` +
        `2026-09-30 14:00、2026-09-30、明天下午3点、下周五、后天、下个月1号。`,
    };
  }

  const at = first.start.date();
  // See the header: an uncertain 12:00 is chrono's "no time given", not noon.
  const certain = first.start.isCertain('hour');
  const allDay = !certain && at.getHours() === 12 && at.getMinutes() === 0;

  const value: ParsedWhen = { at, allDay, note: '' };
  value.note = describeParsed(value, now);
  return { ok: true, value };
}

/**
 * Appended to the echo whenever a time came from free text rather than an
 * explicit date.
 *
 * Free-text parsing has blind spots (see the header), so the agent is told to
 * repeat its reading back rather than let a misread time be stored silently.
 */
export const FREE_TEXT_HINT = '这是按自由文本读出来的。如果不是你要的时间，请改用 2026-09-30 14:00 这样的写法。';
