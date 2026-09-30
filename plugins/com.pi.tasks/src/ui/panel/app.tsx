/**
 * The panel shell: loads state, keeps it fresh, and routes the three views.
 *
 * Data flow is pull-first with push on change. The panel asks for the state
 * when it mounts — so a panel remounted by the keep-alive budget or a window
 * reload comes back correct — and the backend pushes a fresh view after every
 * mutation and tick. Push alone would leave a remounted panel blank until the
 * next tick, which can be thirty seconds of looking broken.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MonthOccurrence, MonthView, ViewItem, Views } from '../../core/view.js';
import { dayKey } from '../../core/time.js';
import type { PiSDK } from './sdk.js';
import { Editor, Confirm } from './editor.js';
import { AgendaView, LogView, MonthViewPanel } from './views.js';

type Tab = 'agenda' | 'month' | 'log';

export function App({ sdk }: { sdk: PiSDK }) {
  const [view, setView] = useState<Views | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('agenda');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<ViewItem | 'new' | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  // Month cursor + its occurrences. The panel cannot expand RRULEs itself, so
  // the grid's dots are fetched from the backend per month.
  const [cursor, setCursor] = useState(() => new Date());
  const [monthView, setMonthView] = useState<MonthView | null>(null);
  const [selectedDay, setSelectedDay] = useState(() => dayKey(new Date()));

  const refresh = useCallback(async () => {
    try {
      setView(await sdk.request<Views>('state.get'));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [sdk]);

  const loadMonth = useCallback(
    async (d: Date) => {
      try {
        setMonthView(await sdk.request<MonthView>('month.get', { year: d.getFullYear(), month: d.getMonth() }));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [sdk],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (tab === 'month') void loadMonth(cursor);
  }, [tab, cursor, loadMonth]);

  // Backend pushes. The ref keeps the latest handler without re-subscribing.
  const onMessage = useRef<(payload: unknown) => void>(() => {});
  onMessage.current = (payload: unknown) => {
    const p = payload as { kind?: string; event?: string; data?: Views } | undefined;
    if (p?.kind === 'event' && p.event === 'ui.render' && p.data) setView(p.data);
  };
  useEffect(() => {
    sdk.onMessage((payload) => onMessage.current(payload));
  }, [sdk]);

  const act = useCallback(
    async (method: string, params: Record<string, unknown>) => {
      setError(null);
      try {
        await sdk.request(method, params);
        await refresh();
        if (tab === 'month') await loadMonth(cursor);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [sdk, refresh, loadMonth, tab, cursor],
  );

  const now = view ? new Date(view.now) : new Date();
  const items = useMemo(() => {
    const all = view?.items ?? [];
    const needle = query.trim();
    if (!needle) return all;
    return all.filter(
      (i) => i.title.includes(needle) || (i.note ?? '').includes(needle) || i.repeatLabel.includes(needle),
    );
  }, [view, query]);

  const openCount = items.filter((i) => !i.done && i.group !== 'later').length;
  const missedCount = view?.missed.length ?? 0;

  const onSubmit = async (params: Record<string, unknown>): Promise<void> => {
    await act('item.save', params);
  };

  return (
    <div className="app">
      <div className="hd">
        <div className="hd-row">
          <div className="tabs">
            <button className="tab" data-on={tab === 'agenda'} onClick={() => setTab('agenda')}>
              议程
              {openCount > 0 && <span className="n">{openCount}</span>}
            </button>
            <button className="tab" data-on={tab === 'month'} onClick={() => setTab('month')}>
              月
            </button>
            <button className="tab" data-on={tab === 'log'} onClick={() => setTab('log')}>
              记录
              {missedCount > 0 && <span className="n">{missedCount}</span>}
            </button>
          </div>
          <span className="grow" />
          <button className="btn primary" onClick={() => setEditing('new')}>
            ＋ 新建
          </button>
        </div>

        {tab === 'agenda' && (
          <input placeholder="搜索事项…" value={query} onChange={(e) => setQuery(e.target.value)} />
        )}

        <div className="caveat">
          <b>定时任务需要应用在运行。</b>
          <span>应用没开时错过的，会在下次打开时列在「记录」里，等你决定要不要补跑。</span>
        </div>
      </div>

      <div className="body">
        {error && <div className="err">{error}</div>}

        {view?.truncated.length ? (
          <div className="warn">
            有 {view.truncated.length} 条事项的重复规则展开次数过多，本次只计算了前一部分。
            检查一下重复规则是不是设得太密（比如每秒一次）。
          </div>
        ) : null}

        {!view ? (
          <div className="empty">读取中…</div>
        ) : tab === 'agenda' ? (
          <AgendaView
            items={items}
            now={now}
            selectedId={editing && editing !== 'new' ? editing.id : undefined}
            onSelect={(item) => setEditing(item)}
            onToggle={(item) => void act('item.toggle', { id: item.id, occurrenceKey: item.occurrenceKey })}
          />
        ) : tab === 'month' ? (
          <MonthViewPanel
            view={monthView}
            cursor={cursor}
            selectedDay={selectedDay}
            onPrev={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}
            onNext={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}
            onToday={() => {
              const d = new Date();
              setCursor(d);
              setSelectedDay(dayKey(d));
            }}
            onSelectDay={setSelectedDay}
            onToggle={(occ: MonthOccurrence) =>
              void act('item.toggle', { id: occ.itemId, occurrenceKey: occ.key })
            }
          />
        ) : (
          <LogView
            view={view}
            onRerun={(key) => void act('run.rerun', { key })}
            onClear={() => setConfirmClear(true)}
          />
        )}
      </div>

      {editing && (
        <Editor
          item={editing === 'new' ? undefined : editing}
          onSave={onSubmit}
          onClose={() => setEditing(null)}
          onDelete={
            editing === 'new'
              ? undefined
              : async () => {
                  await act('item.remove', { id: editing.id });
                  setEditing(null);
                }
          }
        />
      )}

      {confirmClear && (
        <Confirm
          title="清空触发记录？"
          body="记录只是历史，清掉不影响任何事项本身。"
          confirmLabel="清空"
          onCancel={() => setConfirmClear(false)}
          onConfirm={() => {
            setConfirmClear(false);
            void act('run.clear', {});
          }}
        />
      )}
    </div>
  );
}
