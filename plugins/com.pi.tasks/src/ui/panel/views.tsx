/**
 * The three views: agenda (default), month, and the run log.
 *
 * The agenda is the default on purpose. A calendar grid answers "what does this
 * month look like", which is rarely the question standing in front of the app —
 * "what is coming up and what did I forget" is, and that is what a grouped list
 * answers without any decoding.
 */
import { useMemo } from 'react';
import type { DayNote, RunRecord } from '../../core/types.js';
import { GROUP_LABEL, GROUP_ORDER, type AgendaGroup, type MonthOccurrence, type MonthView, type ViewItem, type Views } from '../../core/view.js';
import { dayKey, dayStart, formatDay, formatTime, formatWhen, weekdayLabel } from '../../core/time.js';

const emptyGroup = (): Record<AgendaGroup, ViewItem[]> => ({
  overdue: [], today: [], tomorrow: [], week: [], later: [], undated: [],
});

export function AgendaView({
  items,
  selectedId,
  onSelect,
  onToggle,
  now,
}: {
  items: ViewItem[];
  selectedId?: string;
  onSelect: (item: ViewItem) => void;
  onToggle: (item: ViewItem) => void;
  now: Date;
}) {
  const groups = useMemo(() => {
    const g = emptyGroup();
    for (const item of items) g[item.group]?.push(item);
    // Done items sink within their group so the open ones stay at the top.
    for (const key of GROUP_ORDER) {
      g[key].sort((a, b) => {
        if (a.done !== b.done) return a.done ? 1 : -1;
        return (a.start ?? '9999') < (b.start ?? '9999') ? -1 : 1;
      });
    }
    return g;
  }, [items]);

  const total = GROUP_ORDER.reduce((n, k) => n + groups[k].length, 0);
  if (total === 0) {
    return (
      <div className="empty">
        还没有任何事项
        <br />
        点上面「新建」，或者直接对 agent 说「记一下…」
      </div>
    );
  }

  let first = true;
  return (
    <>
      {GROUP_ORDER.map((key) => {
        const list = groups[key];
        if (list.length === 0) return null;
        const isFirst = first;
        first = false;
        return (
          <div key={key}>
            <div className={`group-hd ${key === 'overdue' ? 'overdue' : ''}`} data-first={isFirst}>
              {GROUP_LABEL[key]}
              <span style={{ opacity: 0.6 }}>{list.length}</span>
            </div>
            {list.map((item) => (
              <Row
                key={item.id}
                item={item}
                selected={item.id === selectedId}
                onSelect={() => onSelect(item)}
                onToggle={() => onToggle(item)}
                now={now}
              />
            ))}
          </div>
        );
      })}
    </>
  );
}

function Row({
  item,
  selected,
  onSelect,
  onToggle,
  now,
}: {
  item: ViewItem;
  selected: boolean;
  onSelect: () => void;
  onToggle: () => void;
  now: Date;
}) {
  return (
    <div className="row" data-done={item.done} data-open={selected} onClick={onSelect}>
      <button
        className="tick"
        data-done={item.done}
        title={item.done ? '标记为未完成' : '标记完成'}
        aria-label={item.done ? `把「${item.title}」标记为未完成` : `把「${item.title}」标记完成`}
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
      >
        ✓
      </button>
      <div className="main">
        <div className="title">{item.title}</div>
        <div className={`when ${item.group === 'overdue' && !item.done ? 'overdue' : ''}`}>
          {item.whenLabel}
          {item.nextFireAt && ` · 下次 ${formatWhen(new Date(item.nextFireAt), now)}`}
        </div>
        {(item.rrule || item.triggerLabels.length > 0 || item.note) && (
          <div className="meta">
            {item.rrule && <span className="badge">↻ {item.repeatLabel}</span>}
            {item.triggerLabels.map((label, i) => (
              <span key={i} className="badge">
                {label}
              </span>
            ))}
            {item.note && <span>{item.note}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

// ── month ──

export function MonthViewPanel({
  view,
  cursor,
  selectedDay,
  notes,
  onPrev,
  onNext,
  onToday,
  onSelectDay,
  onOpenDay,
  onToggle,
}: {
  view: MonthView | null;
  cursor: Date;
  selectedDay: string;
  notes: Record<string, DayNote>;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  onSelectDay: (day: string) => void;
  onOpenDay: (day: string) => void;
  onToggle: (occ: MonthOccurrence) => void;
}) {
  const todayKey = dayKey(new Date());

  const cells = useMemo(() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const start = new Date(first);
    // Start the grid on Sunday, the way the weekday labels are ordered.
    start.setDate(1 - first.getDay());
    const out: Date[] = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      out.push(d);
    }
    return out;
  }, [cursor]);

  const dayItems = view?.byDay[selectedDay] ?? [];

  return (
    <>
      <div className="month-hd">
        <span className="label">{view?.label ?? ''}</span>
        <span className="grow" />
        <button className="btn tiny" onClick={onPrev}>
          ‹
        </button>
        <button className="btn tiny" onClick={onToday}>
          今天
        </button>
        <button className="btn tiny" onClick={onNext}>
          ›
        </button>
      </div>

      <div className="grid">
        {['日', '一', '二', '三', '四', '五', '六'].map((d) => (
          <div key={d} className="dow">
            {d}
          </div>
        ))}
        {cells.map((d) => {
          const key = dayKey(d);
          const list = view?.byDay[key] ?? [];
          const wrote = Boolean(notes[key]?.text?.trim());
          return (
            <button
              key={key}
              className="cell"
              data-out={d.getMonth() !== cursor.getMonth()}
              data-today={key === todayKey}
              data-sel={key === selectedDay}
              data-note={wrote}
              onClick={() => onSelectDay(key)}
            >
              <span>{d.getDate()}</span>
              <span className="dots">
                {list.slice(0, 3).map((o) => (
                  <span key={o.key} className={`dot ${o.done ? 'done' : ''}`} />
                ))}
              </span>
            </button>
          );
        })}
      </div>

      <div className="group-hd" style={{ paddingTop: 14 }}>
        {formatDay(dayStart(selectedDay))} {weekdayLabel(dayStart(selectedDay))}
        <span className="grow" />
        <button className="btn tiny" onClick={() => onOpenDay(selectedDay)}>
          {notes[selectedDay]?.text?.trim() ? '看这一天的记录' : '写这一天的记录'}
        </button>
      </div>
      {dayItems.length === 0 ? (
        <div className="empty" style={{ padding: '18px 0' }}>
          这一天没有事项
        </div>
      ) : (
        dayItems.map((o) => (
          <div key={o.key} className="row" data-done={o.done}>
            <button
              className="tick"
              data-done={o.done}
              onClick={() => onToggle(o)}
              title={o.done ? '标记为未完成' : '标记完成'}
            >
              ✓
            </button>
            <div className="main">
              <div className="title">{o.title}</div>
              <div className="when">{formatTime(new Date(o.at))}</div>
            </div>
          </div>
        ))
      )}
    </>
  );
}

// ── the run log ──

const STATUS_LABEL: Record<RunRecord['status'], string> = {
  ok: '已完成',
  missed: '错过',
  undelivered: '没送到',
  failed: '出错',
};

export function LogView({
  view,
  onRerun,
  onClear,
}: {
  view: Views;
  onRerun: (key: string) => void;
  onClear: () => void;
}) {
  const { runs, missed } = view;

  if (runs.length === 0) {
    return (
      <div className="empty">
        还没有触发记录
        <br />
        给事项加一个触发，到点后这里会记下发生了什么
      </div>
    );
  }

  return (
    <>
      {missed.length > 0 && (
        <>
          <div className="group-hd overdue" data-first="true">
            需要你决定 · {missed.length}
          </div>
          <div className="warn" style={{ marginBottom: 10 }}>
            这些到点的时候应用没有在运行（或者窗口没开）。它们不会自己补跑 ——
            点右边的「补跑」才会执行。
          </div>
          {missed.map((r) => (
            <div key={r.key} className="log-row">
              <span className={`st ${r.status}`} />
              <div className="log-main">
                <div className="log-title">
                  <span className="t">{r.itemTitle}</span>
                  <span className="badge">{r.action === 'notify' ? '通知' : 'agent'}</span>
                </div>
                <div className="log-sub">
                  本该 {formatWhen(new Date(r.dueAt), new Date(view.now))}
                  {r.detail ? ` · ${r.detail}` : ''}
                </div>
              </div>
              <button className="btn tiny" onClick={() => onRerun(r.key)}>
                补跑
              </button>
            </div>
          ))}
        </>
      )}

      <div className="group-hd" data-first={missed.length === 0 ? 'true' : 'false'}>
        全部记录
        <span className="grow" />
        <button className="btn tiny" onClick={onClear}>
          清空
        </button>
      </div>
      {runs.map((r) => (
        <div key={`${r.key}-${r.firedAt ?? r.dueAt}`} className="log-row">
          <span className={`st ${r.status}`} />
          <div className="log-main">
            <div className="log-title">
              <span className="t">{r.itemTitle}</span>
              <span className="badge">{STATUS_LABEL[r.status]}</span>
            </div>
            <div className="log-sub">
              {r.firedAt
                ? `${formatWhen(new Date(r.firedAt), new Date(view.now))} 执行`
                : `本该 ${formatWhen(new Date(r.dueAt), new Date(view.now))}`}
              {r.detail ? ` · ${r.detail}` : ''}
            </div>
          </div>
        </div>
      ))}
    </>
  );
}
