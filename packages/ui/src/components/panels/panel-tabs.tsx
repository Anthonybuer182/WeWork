import { useEffect, useState } from 'react';
import { X, Columns2, X as ColumnsOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import { usePanelStore, type PanelEntry, type PanelRegion, type PanelSlotId } from '@/stores/panel-store';
import { useUIStore } from '@/stores/ui-store';
import { RailIcon } from './panel-rail';
import { useSplitActive } from './use-split';

/**
 * Closing a tab that leaves the strip empty collapses the right column —
 * the same end state the pre-tab UI reached when its selection cleared.
 * Shared by the strip (× / middle-click) and the context menu (关闭).
 */
function useCloseTabAndCollapse(region: PanelRegion) {
  const closeTab = usePanelStore((s) => s.closeTab);
  const setRightPanelOpen = useUIStore((s) => s.setRightPanelOpen);
  return (tabIds: string[], id: string) => {
    closeTab(region, id);
    if (tabIds.length === 1 && region === 'right') setRightPanelOpen(false);
  };
}

/**
 * Tab strip for one sidebar column: the open-panel list, in strip order,
 * split into two segments when the column is split (the segments line up
 * under their slots' bodies).
 *
 * This renders INSIDE the header band, in the right column's segment — the
 * band is partitioned by the same column widths that drive the body, so the
 * strip can never cross into the centre column, and the layout toggles live
 * in their own trailing zone that tabs can never push out. Too many tabs
 * compress (min-width floor) and then scroll inside their segment.
 *
 * The context menu is a SEPARATE component (PanelTabMenu) rendered in the
 * panel column body: a floating menu anchored to the strip would be covered
 * by the native view in the slot below (plugin panels are WebContentsViews
 * floating above all DOM), so it opens as an inline row that pushes the
 * panel down instead. See the omnibox dropdown in the browser plugin for the
 * in-panel version of the same workaround.
 *
 * Drag reorder uses the browser's native DnD: `dataTransfer` handles and
 * `dragover` targets are enough to move an entry in the store's ordered list.
 * Dropping onto the OTHER segment of a split moves the tab between slots.
 */
export function PanelTabs({ region = 'right' }: { region?: PanelRegion }) {
  const panels = usePanelStore((s) => s.panels);
  const tabIds = usePanelStore((s) => s.openPanelIds[region]);
  const activeIds = usePanelStore((s) => s.activePanelIds[region]);
  const slotOf = usePanelStore((s) => s.slotOf);
  const splitActive = useSplitActive(region);
  const runtime = usePanelStore((s) => s.runtime);
  const openPanel = usePanelStore((s) => s.openPanel);
  const reorderTabs = usePanelStore((s) => s.reorderTabs);
  const moveTab = usePanelStore((s) => s.moveTab);
  const setSplit = usePanelStore((s) => s.setSplit);
  const openTabMenu = usePanelStore((s) => s.openTabMenu);
  const closeTabAndCollapse = useCloseTabAndCollapse(region);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [dropSlot, setDropSlot] = useState<PanelSlotId | null>(null);

  if (tabIds.length === 0) return null;
  const isSplit = splitActive;

  const slotTabs = (slot: PanelSlotId): number[] => {
    const out: number[] = [];
    tabIds.forEach((id, i) => {
      if ((slotOf[id] ?? 'A') === slot) out.push(i);
    });
    return out;
  };

  const renderTab = (id: string, i: number, slot: PanelSlotId) => {
    const panel = panels.find((p) => p.id === id);
    if (!panel) return null;
    const active = id === activeIds[slot];
    const dragOver = dropIndex === i && dragIndex !== null && dragIndex !== i && dropSlot === slot;

    return (
      <div
        key={id}
        role="tab"
        aria-selected={active}
        tabIndex={0}
        data-panel-tab={id}
        data-state={active ? 'active' : 'inactive'}
        draggable
        title={panel.title}
        onClick={() => openPanel(id, { focus: true })}
        onContextMenu={(e) => {
          e.preventDefault();
          openTabMenu(region, id);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openPanel(id, { focus: true });
          } else if (e.key === 'ArrowLeft' && i > 0) {
            focusNeighbor(e, i - 1);
          } else if (e.key === 'ArrowRight' && i < tabIds.length - 1) {
            focusNeighbor(e, i + 1);
          } else if (e.key === 'Home' && tabIds.length > 0) {
            focusNeighbor(e, 0);
          } else if (e.key === 'End' && tabIds.length > 0) {
            focusNeighbor(e, tabIds.length - 1);
          }
        }}
        // Middle-click closes, like every other tab strip.
        onAuxClick={(e) => {
          if (e.button === 1) closeTabAndCollapse(tabIds, id);
        }}
        onDragStart={(e) => {
          setDragIndex(i);
          e.dataTransfer.effectAllowed = 'move';
          // Firefox refuses drags without payload. The id doubles as the
          // reorder source: the drop handler reads it back from the
          // transfer, so it never depends on React state having flushed
          // between dragstart and drop.
          e.dataTransfer.setData('text/plain', id);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDropIndex(i);
          setDropSlot(slot);
        }}
        onDrop={(e) => {
          e.preventDefault();
          const from = tabIds.indexOf(e.dataTransfer.getData('text/plain'));
          if (from !== -1) {
            const fromSlot = slotOf[tabIds[from]] ?? 'A';
            if (fromSlot === slot) {
              reorderTabs(region, from, i);
            } else {
              // Dropping onto the other segment = a cross-slot move.
              moveTab(region, tabIds[from], slot);
            }
          }
          setDragIndex(null);
          setDropIndex(null);
          setDropSlot(null);
        }}
        onDragEnd={() => {
          setDragIndex(null);
          setDropIndex(null);
          setDropSlot(null);
        }}
        className={cn(
          // Tabs compress before the strip scrolls — min-width floors the
          // icon+close pair, the title truncates first.
          'group/tab flex min-w-[64px] max-w-[180px] cursor-default items-center gap-1.5 rounded-t-md px-2 py-1 text-xs transition-colors',
          'text-muted-foreground hover:bg-accent/50',
          active && 'bg-accent text-accent-foreground',
          dragOver && 'bg-accent/70',
          dragIndex === i && 'opacity-50',
        )}
      >
        <RailIcon panel={panel} size={14} className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 truncate">{panel.title}</span>
        {/* Badge/pending mirror the rail so the tab — the primary surface
            once panels accumulate — carries the same signal. */}
        {runtime[id]?.badge !== undefined && runtime[id]?.badge !== null && runtime[id]?.badge !== '' && (
          <span
            data-panel-tab-badge={id}
            className="min-w-[16px] shrink-0 rounded-full bg-primary px-1 text-center text-[10px] font-medium leading-4 text-primary-foreground"
          >
            {runtime[id]?.badge}
          </span>
        )}
        {runtime[id]?.pending && !runtime[id]?.badge && (
          <span
            data-panel-tab-pending={id}
            className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-primary"
          />
        )}
        {/* Session-scoped tabs carry a marker — they swap out with the
            conversation while global tabs stay put. */}
        {panel.scope === 'session' && (
          <span
            data-panel-tab-scope={id}
            title="跟会话走的标签（切换会话时随会话切换）"
            className={cn(
              'h-1.5 w-1.5 shrink-0 rounded-full',
              'bg-primary/70',
            )}
          />
        )}
        <button
          type="button"
          aria-label={`关闭 ${panel.title}`}
          data-panel-tab-close={id}
          onClick={(e) => {
            e.stopPropagation();
            closeTabAndCollapse(tabIds, id);
          }}
          className={cn(
            'shrink-0 rounded-sm p-0.5 transition-opacity hover:bg-accent-foreground/15',
            // Hidden until hover, except on the focused tab — the strip
            // reads calmer and the active tab is where the pointer is.
            active ? 'opacity-100' : 'opacity-0 group-hover/tab:opacity-100',
          )}
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    );
  };

  return (
    <div
      className="flex h-full w-full min-w-0 select-none items-end gap-0.5 overflow-x-auto px-1"
      role="tablist"
      data-testid={`panel-tabs-${region}`}
    >
      <div
        className={cn('flex h-full min-w-0 items-end gap-0.5 overflow-x-auto', isSplit && 'flex-1')}
        data-panel-tabs-segment="A"
        onDragOver={(e) => {
          e.preventDefault();
          setDropSlot('A');
        }}
      >
        {slotTabs('A').map((i) => renderTab(tabIds[i], i, 'A'))}
      </div>
      {isSplit && (
        <>
          {/* The divider mirrors the body's splitter position: segment A
              takes `ratio` of the strip, B the rest — the slots' tabs sit
              under their own segment. */}
          <div className="h-full w-1 shrink-0 self-stretch bg-border" data-panel-tabs-divider />
          <div
            className="flex h-full min-w-0 flex-1 items-end gap-0.5 overflow-x-auto"
            data-panel-tabs-segment="B"
            onDragOver={(e) => {
              e.preventDefault();
              setDropSlot('B');
            }}
          >
            {slotTabs('B').map((i) => renderTab(tabIds[i], i, 'B'))}
          </div>
        </>
      )}
      {/* Split toggle: available once there is a second tab to show, and
          always available to collapse a running split. */}
      <button
        type="button"
        aria-label={isSplit ? '取消分屏' : '分屏显示'}
        title={isSplit ? '取消分屏（合并为一栏）' : '分屏显示（左右两栏）'}
        data-panel-split-toggle={region}
        onClick={() => setSplit(region, isSplit ? null : 0.5)}
        disabled={!isSplit && slotTabs('A').length + slotTabs('B').length < 2}
        className="flex h-6 w-6 shrink-0 items-center justify-center self-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-0"
      >
        {isSplit ? <ColumnsOff className="h-3.5 w-3.5" /> : <Columns2 className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

/** VS Code convention: arrows move focus, Enter/Space activate — activating
 *  on arrows would fight panels that re-take input focus on activation. */
function focusNeighbor(e: React.KeyboardEvent, offset: number) {
  const next = e.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[data-panel-tab]')[offset];
  next?.focus();
}

/**
 * The tab context menu, as an inline row at the top of the panel column
 * body. Reads its target from the store (`tabMenu`) because the strip that
 * right-clicked it lives in the header band while this row lives in the
 * body. Dismisses on any click outside the strip/menu — clicks over a
 * plugin panel's native view never reach the document, so such a click
 * leaves the menu open; any strip interaction or Esc closes it.
 */
export function PanelTabMenu({ region = 'right' }: { region?: PanelRegion }) {
  const panels = usePanelStore((s) => s.panels);
  const tabIds = usePanelStore((s) => s.openPanelIds[region]);
  const activeIds = usePanelStore((s) => s.activePanelIds[region]);
  const splitRatio = usePanelStore((s) => s.splitRatio[region]);
  const slotOf = usePanelStore((s) => s.slotOf);
  const menuTarget = usePanelStore((s) => s.tabMenu[region]);
  const openPanel = usePanelStore((s) => s.openPanel);
  const closeTab = usePanelStore((s) => s.closeTab);
  const closeTabMenu = usePanelStore((s) => s.closeTabMenu);
  const moveTab = usePanelStore((s) => s.moveTab);
  const closeTabAndCollapse = useCloseTabAndCollapse(region);

  useEffect(() => {
    if (menuTarget === null) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest(`[data-testid="panel-tabs-${region}"], [data-testid="panel-tab-menu-${region}"]`)) {
        return;
      }
      closeTabMenu(region);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeTabMenu(region);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuTarget, region, closeTabMenu]);

  if (menuTarget === null) return null;
  const index = tabIds.indexOf(menuTarget);
  // The targeted tab was closed while the menu was open — nothing to act on.
  if (index === -1) return null;

  const closeOthers = () => {
    for (const id of tabIds) {
      if (id !== menuTarget) closeTab(region, id);
    }
    // The kept tab may not be the focused one; focus it (it is the only tab
    // left, so this cannot steal focus from anything else).
    if (activeIds.A !== menuTarget && activeIds.B !== menuTarget) {
      openPanel(menuTarget, { focus: true });
    }
    closeTabMenu(region);
  };

  const closeRight = () => {
    for (const id of tabIds.slice(index + 1)) {
      closeTab(region, id);
    }
    // If the focused tab was among the closed, closeTab re-focused leftward.
    closeTabMenu(region);
  };

  // The menu target's slot (for the cross-slot move action).
  const targetSlot = menuTarget ? (slotOf[menuTarget] ?? 'A') : 'A';
  const otherSlot: PanelSlotId = targetSlot === 'A' ? 'B' : 'A';
  const canMoveSlot = splitRatio != null && region === 'right';

  return (
    <div
      className="flex h-7 shrink-0 items-center gap-1 border-b bg-background px-1.5"
      data-testid={`panel-tab-menu-${region}`}
      onContextMenu={(e) => e.preventDefault()}
    >
      <span className="pr-1 text-[10px] text-muted-foreground">
        {panels.find((p) => p.id === menuTarget)?.title}
      </span>
      {canMoveSlot && (
        <button
          type="button"
          data-menu-action="move-slot"
          onClick={() => {
            moveTab(region, menuTarget, otherSlot);
            closeTabMenu(region);
          }}
          className="rounded-sm px-1.5 py-0.5 text-xs hover:bg-accent"
        >
          移到{otherSlot === 'A' ? '左' : '右'}侧
        </button>
      )}
      <button
        type="button"
        data-menu-action="close"
        onClick={() => {
          closeTabAndCollapse(tabIds, menuTarget);
          closeTabMenu(region);
        }}
        className="rounded-sm px-1.5 py-0.5 text-xs hover:bg-accent"
      >
        关闭
      </button>
      {tabIds.length > 1 && (
        <button
          type="button"
          data-menu-action="close-others"
          onClick={closeOthers}
          className="rounded-sm px-1.5 py-0.5 text-xs hover:bg-accent"
        >
          关闭其他
        </button>
      )}
      {index < tabIds.length - 1 && (
        <button
          type="button"
          data-menu-action="close-right"
          onClick={closeRight}
          className="rounded-sm px-1.5 py-0.5 text-xs hover:bg-accent"
        >
          关闭右侧标签
        </button>
      )}
    </div>
  );
}
