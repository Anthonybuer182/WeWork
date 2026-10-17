import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PanelRail, RailIcon } from './panel-rail';
import { PanelBody, PaneView } from './panel-slot';
import { usePanelStore, type PanelEntry, type PanelRegion } from '@/stores/panel-store';
import { cn } from '@/lib/utils';

export { PanelRail };

/** A pane narrower than this cannot show web pages or documents. */
const MIN_PANE = 270;
/** The sash's hit width — subtracted once per boundary from the column. */
const SASH_W = 12;
/** Hard floor for any pane during a sash drag. */
const MIN_FRAC = 0.12;

/**
 * The work area (2026-10-17 redesign): one pane for every SELECTED panel of
 * the region, laid out left-to-right in the plugin list's order, sized by
 * per-pane width shares, separated by sashes.
 *
 * Selection lives in the header plugin list (multi-select): selected =
 * visible-or-minimized. There is no explicit split action — selecting panels
 * IS the layout. Two levels of arrangement:
 *
 *  - **Tiled**: as many panes as fit at MIN_PANE, shares draggable via the
 *    sashes (per pane, persisted); equal by default;
 *  - **Zoomed**: one pane takes the full column (double-click its header
 *    tab, or the tab's ⛶ button); every other selected pane collapses into
 *    a right-edge rail of icons. Clicking a rail icon promotes it into the
 *    tiled area — the focused tiled pane yields.
 *
 * Selected panes beyond the tile capacity are minimized into the rail
 * automatically; the focused pane always keeps a tile. Esc clears the zoom.
 * Non-tiled selected panes stay MOUNTED hidden (keepAlive) — the rail is a
 * control, not an unmount.
 *
 * The LEFT region keeps its single-view rail + pane: zooming and multi-pane
 * tiling are meaningless inside the sidebar.
 */
export function PanelHost({
  region = 'right',
  rail = region === 'left',
}: {
  region?: PanelRegion;
  rail?: boolean;
}) {
  const panels = usePanelStore((s) => s.panels);
  const selectedIds = usePanelStore((s) => s.openPanelIds[region]);
  const panelOrder = usePanelStore((s) => s.panelOrder[region]);
  const focusedId = usePanelStore((s) => s.focusedId[region]);
  const zoomedId = usePanelStore((s) => s.zoomedId[region]);
  const paneFracs = usePanelStore((s) => s.paneFracs);
  const setFocused = usePanelStore((s) => s.setFocused);
  const toggleZoom = usePanelStore((s) => s.toggleZoom);
  const setPaneFracs = usePanelStore((s) => s.setPaneFracs);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerW, setContainerW] = useState(0);
  /** Sash drag state: which pair, pointer start x, their px widths at start. */
  const dragRef = useRef<{ leftId: string; rightId: string; startX: number; leftPx: number; rightPx: number } | null>(null);
  /** Which sash is being dragged (for its highlight + the share pill). */
  const [dragPair, setDragPair] = useState<string | null>(null);
  const [liveShare, setLiveShare] = useState(0.5);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = (): void => setContainerW(el.getBoundingClientRect().width);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const byId = useMemo(() => new Map(panels.map((p) => [p.id, p])), [panels]);

  // Panes in list order: the selection sorted by the user's plugin order.
  const ordered = useMemo(() => {
    const orderIndex = new Map(panelOrder.map((id, i) => [id, i]));
    return selectedIds
      .map((id) => byId.get(id))
      .filter((p): p is PanelEntry => Boolean(p))
      .sort((a, b) => {
        const ia = orderIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER;
        const ib = orderIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER;
        return ia === ib ? (a.order ?? 0) - (b.order ?? 0) : ia - ib;
      });
  }, [selectedIds, panelOrder, byId]);

  // ── Layout: which panes are tiled, which minimized ──
  const zoomedPane =
    zoomedId && ordered.some((p) => p.id === zoomedId)
      ? ordered.find((p) => p.id === zoomedId)!
      : null;

  const tileCapacity = Math.max(1, Math.floor((containerW + SASH_W) / (MIN_PANE + SASH_W)));
  let tiled = ordered.slice(0, Math.min(ordered.length, tileCapacity));
  let minimized = ordered.filter((p) => !tiled.includes(p));
  if (!zoomedPane && focusedId) {
    // The focused pane always keeps a tile: if it fell beyond the capacity,
    // swap it with the last tiled pane. Rail clicks promote through the same
    // rule (rail click → setFocused → the focused pane is promoted here).
    const focusedEntry = ordered.find((p) => p.id === focusedId);
    if (focusedEntry && !tiled.includes(focusedEntry) && tiled.length > 0) {
      const yielding = tiled[tiled.length - 1];
      tiled = [...tiled.slice(0, -1), focusedEntry];
      minimized = minimized.map((p) => (p.id === focusedEntry.id ? yielding : p));
    }
  }

  // ── Widths: per-pane fracs normalized across the tiled panes ──
  const tiledIds = tiled.map((p) => p.id);
  const fracsOf = (id: string): number => {
    const count = tiledIds.length || 1;
    return paneFracs[id] ?? 1 / count;
  };
  const rawSum = tiledIds.reduce((acc, id) => acc + fracsOf(id), 0) || 1;

  const startSashDrag = useCallback(
    (e: React.PointerEvent, leftId: string, rightId: string) => {
      e.preventDefault();
      const startLeftPx = fracsOf(leftId) / rawSum * containerW;
      const startRightPx = fracsOf(rightId) / rawSum * containerW;
      dragRef.current = { leftId, rightId, startX: e.clientX, leftPx: startLeftPx, rightPx: startRightPx };
      setDragPair(`${leftId}|${rightId}`);
      setLiveShare(startLeftPx / Math.max(1, startLeftPx + startRightPx));
      const move = (ev: PointerEvent): void => {
        const drag = dragRef.current;
        if (!drag) return;
        const pairPx = drag.leftPx + drag.rightPx;
        const delta = ev.clientX - drag.startX;
        let leftPx = drag.leftPx + delta;
        leftPx = Math.max(120, Math.min(pairPx - 120, leftPx));
        const rightPx = pairPx - leftPx;
        const w = containerRef.current?.getBoundingClientRect().width ?? 1;
        setPaneFracs(region, {
          [drag.leftId]: leftPx / w,
          [drag.rightId]: rightPx / w,
        });
        setLiveShare(leftPx / Math.max(1, pairPx));
      };
      const up = (): void => {
        dragRef.current = null;
        setDragPair(null);
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [fracsOf, rawSum, containerW, setPaneFracs, region],
  );

  // Esc clears the zoom.
  useEffect(() => {
    if (!zoomedPane) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') toggleZoom(region, zoomedPane.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoomedPane, region, toggleZoom]);

  const paneEl = (panel: PanelEntry, widthPx: number | undefined, hidden = false): ReturnType<typeof PaneView> => (
    <PaneView
      key={panel.id}
      panel={panel}
      focused={focusedId === panel.id}
      zoomed={zoomedPane?.id === panel.id}
      zoomable={region === 'right'}
      hidden={hidden}
      width={widthPx}
    />
  );

  // ── LEFT region: single-view rail + focused pane (legacy shape) ──
  if (region === 'left') {
    const focusedEntry = focusedId ? byId.get(focusedId) : undefined;
    return (
      <div className="flex h-full w-full">
        {rail && <PanelRail region={region} />}
        <div className="flex min-w-0 flex-1 flex-col">
          {focusedEntry && (
            <div data-panel-container={focusedEntry.id} className="flex min-h-0 flex-1 flex-col">
              <PanelBody panel={focusedEntry} />
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── RIGHT region: the pane work area ──
  return (
    <div className="flex h-full w-full">
      <div ref={containerRef} className="flex min-h-0 min-w-0 flex-1 items-stretch" data-panel-slots={region}>
        {zoomedPane ? (
          <>
            {paneEl(zoomedPane, undefined)}
            {/* Zoomed: the other selected panes stay mounted but off-layout. */}
            {ordered
              .filter((p) => p.id !== zoomedPane.id)
              .map((p) => paneEl(p, undefined, true))}
            <Rail
              items={ordered.filter((p) => p.id !== zoomedPane.id)}
              onPromote={(id) => {
                // Promoting from the rail while zoomed: the zoom yields — the
                // promoted pane joins (or re-joins) the tiled area.
                if (zoomedPane) toggleZoom(region, zoomedPane.id);
                setFocused(region, id);
              }}
              zoomedId={zoomedPane.id}
            />
          </>
        ) : (
          <>
            {tiled.map((p, i) => (
              <div key={p.id} className="contents">
                {i > 0 && (
                  <div
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="拖动调整窗格宽度（双击复位均分）"
                    data-pane-sash={p.id}
                    onPointerDown={(e) => startSashDrag(e, tiledIds[i - 1], tiledIds[i])}
                    onDoubleClick={() => {
                      // Reset this pair to equal shares.
                      const reset: Record<string, number> = {};
                      for (const id of tiledIds) reset[id] = 1 / tiledIds.length;
                      setPaneFracs(region, reset);
                    }}
                    className={cn(
                      'group/sash relative flex shrink-0 cursor-col-resize touch-none items-stretch justify-center focus-visible:outline-none',
                      dragPair === `${tiledIds[i - 1]}|${tiledIds[i]}` ? 'w-3' : 'w-3',
                    )}
                    style={{ width: SASH_W }}
                  >
                    <div
                      className={cn(
                        'pointer-events-none my-1.5 w-px rounded-full transition-all duration-150',
                        'bg-border group-hover/sash:w-[3px] group-hover/sash:bg-primary/40',
                        dragPair === `${tiledIds[i - 1]}|${tiledIds[i]}` && 'w-[3px] bg-primary/70',
                      )}
                    />
                    <div
                      className={cn(
                        'pointer-events-none absolute top-1/2 h-9 w-1 -translate-y-1/2 rounded-full bg-primary/45 opacity-0 transition-opacity duration-150 group-hover/sash:opacity-100',
                        dragPair === `${tiledIds[i - 1]}|${tiledIds[i]}` && 'opacity-100 bg-primary/60',
                      )}
                    />
                    {dragPair === `${tiledIds[i - 1]}|${tiledIds[i]}` && (
                      <div className="pointer-events-none absolute left-1/2 top-3 z-20 -translate-x-1/2 whitespace-nowrap rounded-md bg-foreground px-1.5 py-0.5 text-[10px] font-medium leading-4 text-background shadow-md">
                        {Math.round(liveShare * 100)} · {Math.round((1 - liveShare) * 100)}
                      </div>
                    )}
                  </div>
                )}
                {paneEl(p, (fracsOf(p.id) / rawSum) * (containerW - (tiled.length - 1) * SASH_W))}
              </div>
            ))}
            {minimized.length > 0 && (
              <Rail items={minimized} onPromote={(id) => setFocused(region, id)} zoomedId={null} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The right-edge rail of minimized panes: icon + title, one per pane that
 * could not be tiled (or yielded to the zoomed pane). Clicking promotes the
 * pane into the tiled area.
 */
function Rail({
  items,
  onPromote,
  zoomedId,
}: {
  items: PanelEntry[];
  onPromote: (id: string) => void;
  zoomedId: string | null;
}) {
  if (items.length === 0) return null;
  return (
    <div
      className="flex w-11 shrink-0 flex-col items-center gap-1 border-l bg-muted/30 py-2"
      data-pane-rail
    >
      {items.map((p) => (
        <button
          key={p.id}
          type="button"
          title={`${p.title}${p.id === zoomedId ? '（正在放大显示）' : '（点击升格为窗格）'}`}
          data-pane-rail-item={p.id}
          onClick={() => onPromote(p.id)}
          className={cn(
            'flex w-10 flex-col items-center gap-0.5 rounded-md px-1 py-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground',
            p.id === zoomedId && 'bg-accent/70 text-accent-foreground',
          )}
        >
          <RailIcon panel={p} size={20} className="h-5 w-5" />
          <span className="w-full truncate text-center text-[9px] leading-3">{p.title}</span>
        </button>
      ))}
    </div>
  );
}
