import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Maximize2, Minimize2, MoreHorizontal, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { showPopupMenu } from '@/lib/native-menu';
import { usePanelStore, type PanelEntry, type PanelRegion } from '@/stores/panel-store';
import { useI18n } from '@/i18n';
import { panelTitle } from './panel-title';
import { RailIcon } from './panel-rail';

/**
 * Width reserved at the strip's right end for the "⋯" overflow button and
 * the paddings/gaps around it, subtracted from the space entries may occupy
 * before one falls into the overflow menu.
 */
const CONTROLS_RESERVE = 44;

/**
 * The header plugin list — a horizontal SWITCHER (2026-10-17 redesign; the
 * vertical icon rail turned sideways, nothing more):
 *
 *  - every installed + enabled panel of the region is an entry, always
 *    visible; unselected entries render muted;
 *  - click an unselected entry → it joins the work area (selected, focused);
 *  - click a selected entry → focus its pane (agent target);
 *  - hover a selected entry → [×] deselects it (its pane leaves the work
 *    area; state is kept warm for a while), [⛶] zooms its pane to the full
 *    column (double-click on the entry does the same — since the tiled panes
 *    draw no header of their own, the tab is the zoom control's home);
 *  - drag an entry onto another to reorder the list — the work-area pane
 *    order follows the list order.
 *
 * The list carries NO split state: which panes sit side by side and how wide
 * they are is the work area's business (see PanelHost). Overflow: when the
 * column is too narrow for every entry, the tail collapses into a "⋯" button
 * whose popup lists exactly what the measurement cut off. Entries that are
 * focused or carrying badge/pending activity mark the button with a dot.
 */
export function PanelTabs({ region = 'right' }: { region?: PanelRegion }) {
  const { t } = useI18n();
  const panels = usePanelStore((s) => s.panels);
  const panelOrder = usePanelStore((s) => s.panelOrder[region]);
  const selectedIds = usePanelStore((s) => s.openPanelIds[region]);
  const focusedId = usePanelStore((s) => s.focusedId[region]);
  const runtime = usePanelStore((s) => s.runtime);
  const openPanel = usePanelStore((s) => s.openPanel);
  const closeTab = usePanelStore((s) => s.closeTab);
  const setFocused = usePanelStore((s) => s.setFocused);
  const setPanelOrder = usePanelStore((s) => s.setPanelOrder);
  const zoomedId = usePanelStore((s) => s.zoomedId[region]);
  const toggleZoom = usePanelStore((s) => s.toggleZoom);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef(new Map<string, HTMLDivElement>());
  const widthCache = useRef(new Map<string, number>());
  // Index into the list where the overflow cut begins (null = all fit).
  const [cut, setCut] = useState<number | null>(null);

  // The list's display order: the user's `panelOrder` first, registry order
  // (with its `order` tiebreak) for entries the user has never arranged.
  // Hidden panels (openable only by the backend) are excluded — unless they
  // are selected: a displayed panel must always be reachable as an entry.
  // EXCEPT a hidden split-companion whose main panel is also selected: the
  // strip reads as one entry per plugin, and the companion is present as the
  // pane beside its main (unsplit lives in the tab / in-panel menus).
  const selectedSet = new Set(selectedIds);
  const sorted = (() => {
    const orderIndex = new Map(panelOrder.map((id, i) => [id, i]));
    return panels
      .filter((p) => p.region === region && (!p.hidden || selectedSet.has(p.id)))
      .filter((p) => {
        if (!p.hidden || !p.panelId) return true;
        const main = panels.find((q) => q.source === p.source && q.companion === p.panelId);
        return !(main && selectedSet.has(main.id));
      })
      .sort((a, b) => {
        const ia = orderIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER;
        const ib = orderIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER;
        return ia === ib ? (a.order ?? 0) - (b.order ?? 0) : ia - ib;
      });
  })();

  const visualRef = useRef(sorted);
  visualRef.current = sorted;
  const overflowIds = cut == null ? [] : sorted.slice(cut).map((p) => p.id);
  const overflowRef = useRef(overflowIds);
  overflowRef.current = overflowIds;

  // Overflow measurement. Rendered items are measured live; once an item is
  // cut (display:none) its cached width stands in, so the computation cannot
  // oscillate. Re-runs on column resizes and list changes.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const compute = () => {
      const available = container.clientWidth - CONTROLS_RESERVE;
      let acc = 0;
      let nextCut: number | null = null;
      visualRef.current.forEach((p, i) => {
        const el = itemRefs.current.get(p.id);
        let w = widthCache.current.get(p.id) ?? 0;
        // offsetWidth 0 = currently cut (Tailwind `hidden` sets a class, not
        // an inline style) — its cached width stands in, keeping the
        // computation stable across the hide/show cycle.
        if (el && el.offsetWidth > 0) {
          w = el.getBoundingClientRect().width;
          if (w > 0) widthCache.current.set(p.id, w);
        }
        if (nextCut == null) {
          acc += w + 2; // the flex gap
          if (acc > available) nextCut = i;
        }
      });
      setCut(nextCut);
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(container);
    return () => ro.disconnect();
  }, [selectedIds, panelOrder, region, panels]);

  const endDrag = () => {
    setDragId(null);
    setDropTargetId(null);
  };

  // ── Split (向右拆分) ──
  // A panel may declare a companion (manifest `companion`): a hidden second
  // panel with independent state that opens BESIDE this one — the multi-tab
  // counterpart of VS Code's split-editor gesture. The companion resolves
  // from either side of the pair: the main panel names it, the companion is
  // found by reverse lookup.
  const splitPairOf = (panel: PanelEntry): { main: PanelEntry; companion: PanelEntry } | null => {
    if (panel.companion) {
      const companion = panels.find((p) => p.source === panel.source && p.panelId === panel.companion);
      if (companion) return { main: panel, companion };
    }
    if (panel.panelId) {
      const main = panels.find((p) => p.source === panel.source && p.companion === panel.panelId);
      if (main) return { main, companion: panel };
    }
    return null;
  };

  const openTabMenu = (panel: PanelEntry, at: { x: number; y: number }) => {
    const pair = splitPairOf(panel);
    if (!pair) return;
    // No unsplit item — closing the pane's tabs (their ×) collapses the split,
    // so a menu while the pane is open would only ever offer nothing.
    if (selectedSet.has(pair.companion.id)) return;
    void showPopupMenu([{ id: 'split-right', label: t('向右拆分') }], at).then((picked) => {
      if (picked === 'split-right') openPanel(pair.companion.id, { focus: true });
    });
  };

  const renderItem = (panel: PanelEntry) => {
    const id = panel.id;
    const title = panelTitle(panel, t);
    const selected = selectedSet.has(id);
    const focused = focusedId === id;
    const zoomed = zoomedId === id;
    const rt = runtime[id];
    const badge = rt?.badge;
    const visualIndex = sorted.findIndex((p) => p.id === id);
    const overflowed = cut != null && visualIndex >= cut;

    return (
      <div
        key={id}
        ref={(el) => {
          if (el) itemRefs.current.set(id, el);
          else itemRefs.current.delete(id);
        }}
        tabIndex={0}
        aria-pressed={selected}
        data-panel-tab={id}
        data-state={focused ? 'focused' : selected ? 'selected' : 'unselected'}
        draggable
        title={title}
        onClick={() => {
          if (selected) setFocused(region, id);
          else openPanel(id, { focus: true });
        }}
        onDoubleClick={() => {
          // The tab is the tiled pane's zoom control (tiled panes draw no
          // header of their own — see PaneView).
          if (selected) toggleZoom(region, id);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          openTabMenu(panel, { x: e.clientX, y: e.clientY });
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (selected) setFocused(region, id);
            else openPanel(id, { focus: true });
          } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            const delta = e.key === 'ArrowLeft' ? -1 : 1;
            const i = sorted.findIndex((p) => p.id === id);
            const next = sorted[i + delta];
            if (next) itemRefs.current.get(next.id)?.focus();
          } else if (e.key === 'Home' || e.key === 'End') {
            const next = e.key === 'Home' ? sorted[0] : sorted[sorted.length - 1];
            if (next) itemRefs.current.get(next.id)?.focus();
          }
        }}
        onDragStart={(e) => {
          setDragId(id);
          e.dataTransfer.effectAllowed = 'move';
          // Firefox refuses drags without payload; the id doubles as the
          // reorder source so the drop never depends on React state.
          e.dataTransfer.setData('text/plain', id);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDropTargetId(id);
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const from = e.dataTransfer.getData('text/plain');
          if (from && from !== id) {
            // Reorder: `from` re-seats before `id` in the user's arrangement.
            const ids = visualRef.current.map((p) => p.id).filter((x) => x !== from);
            const at = ids.indexOf(id);
            if (at === -1) ids.push(from);
            else ids.splice(at, 0, from);
            setPanelOrder(region, ids);
          }
          endDrag();
        }}
        onDragEnd={endDrag}
        className={cn(
          // Pill style: vertically centered in the band, comfortable hit
          // area, 13px label. Selected pills are SOLID (all highlighted at
          // once, per design); the focused one adds a primary ring — it is
          // the pane the agent acts on.
          'group/entry relative flex h-8 shrink-0 cursor-default items-center gap-2 rounded-lg px-2.5 text-[13px] transition-colors',
          'max-w-[176px]',
          selected
            ? cn(
                'bg-accent text-accent-foreground',
                focused && 'ring-1 ring-foreground/25',
              )
            : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground/80',
          dropTargetId === id && dragId !== null && dragId !== id && 'bg-muted-foreground/20 ring-1 ring-muted-foreground/40',
          dragId === id && 'opacity-50',
          overflowed && 'hidden',
        )}
      >
        <RailIcon panel={panel} size={16} className="h-4 w-4 shrink-0" />
        <span className={cn('min-w-0 truncate', focused && 'font-medium')}>{title}</span>
        {/* Badge/pending mirror the work area so the entry carries the same
            signal even when its pane is not the one on display. */}
        {badge !== undefined && badge !== null && badge !== '' && (
          <span
            data-panel-tab-badge={id}
            className="min-w-[16px] shrink-0 rounded-full bg-primary px-1 text-center text-[10px] font-medium leading-4 text-primary-foreground"
          >
            {badge}
          </span>
        )}
        {rt?.pending && !badge && (
          <span
            data-panel-tab-pending={id}
            className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-primary"
          />
        )}
        {/* Session-scoped entries carry a marker — what they display swaps
            with the conversation while global entries never move. */}
        {panel.scope === 'session' && (
          <span
            data-panel-tab-scope={id}
            title={t('跟会话走的面板（切换会话时随会话切换）')}
            className={cn('h-1.5 w-1.5 shrink-0 rounded-full', 'bg-primary/70')}
          />
        )}
        {/* Zoom: lives here because the tiled pane below draws no header
            (its title would duplicate this entry). Hover reveals ⛶; a zoomed
            pane keeps the restore button always visible. */}
        {selected && (
          <button
            type="button"
            aria-label={zoomed ? t('还原窗格') : t('放大窗格')}
            title={
              zoomed
                ? t('还原（其他窗格回到工作区；Esc 同效）')
                : t('放大占满（其他窗格收成侧条）')
            }
            data-panel-tab-zoom={id}
            onClick={(e) => {
              e.stopPropagation();
              toggleZoom(region, id);
            }}
            onDoubleClick={(e) => e.stopPropagation()}
            className={cn(
              'shrink-0 rounded-sm p-0.5 transition-opacity hover:bg-accent-foreground/15',
              zoomed ? 'opacity-80' : 'opacity-0',
              'group-hover/entry:opacity-70',
            )}
          >
            {zoomed ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </button>
        )}
        {/* Deselect: only on selected entries, only on hover — an explicit,
            hard-to-hit-by-accident gesture. */}
        {selected && (
          <button
            type="button"
            aria-label={t('收起 {title}', { title })}
            data-panel-tab-close={id}
            onClick={(e) => {
              e.stopPropagation();
              closeTab(region, id);
            }}
            className={cn(
              'shrink-0 rounded-sm p-0.5 transition-opacity hover:bg-accent-foreground/15',
              focused ? 'opacity-80' : 'opacity-0',
              'group-hover/entry:opacity-70',
            )}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    );
  };

  if (sorted.length === 0) return null;

  const overflowAttention = overflowIds.some((id) => {
    const rt = runtime[id];
    return (
      focusedId === id ||
      rt?.pending === true ||
      (rt?.badge !== undefined && rt?.badge !== null && rt?.badge !== '')
    );
  });

  return (
    <div
      ref={containerRef}
      className="flex h-full w-full min-w-0 select-none items-center gap-1 px-1.5"
      role="toolbar"
      aria-label={t('插件列表')}
      data-testid={`panel-tabs-${region}`}
    >
      {sorted.map((p) => renderItem(p))}
      {cut != null && (
        <button
          type="button"
          aria-label={t('更多面板')}
          title={t('更多面板')}
          data-panel-plus-toggle={region}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            void openOverflowMenu({ x: r.left, y: r.bottom + 4 });
          }}
          className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          <MoreHorizontal className="h-4 w-4" />
          {overflowAttention && (
            <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-primary" />
          )}
        </button>
      )}
    </div>
  );

  /** The "⋯" popup: exactly the entries the width measurement cut off. */
  async function openOverflowMenu(at: { x: number; y: number }) {
    const items = overflowRef.current
      .map((id) => sorted.find((p) => p.id === id))
      .filter((p): p is PanelEntry => Boolean(p))
      .map((p) => ({ id: p.id, label: panelTitle(p, t) }));
    if (items.length === 0) return;
    const picked = await import('@/lib/native-menu').then((m) => m.showPopupMenu(items, at));
    if (picked) openPanel(picked, { focus: true });
  }
}
