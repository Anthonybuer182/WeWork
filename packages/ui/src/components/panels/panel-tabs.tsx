import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { usePanelStore, type PanelRegion } from '@/stores/panel-store';
import { useUIStore } from '@/stores/ui-store';
import { RailIcon } from './panel-rail';

/**
 * Tab strip for one sidebar column: the open-panel list, in strip order.
 *
 * Rendered above the panel slot, which means OUTSIDE the native-view area —
 * plugin panels are WebContentsViews floating above all DOM, so anything the
 * shell draws over the slot is swallowed. The strip never overlaps the slot,
 * which is why its drag ghost and hover states work without the workarounds
 * in-panel overlays need (those must occupy document flow).
 *
 * The context menu follows the same rule: it opens as an INLINE row between
 * strip and slot (pushing the panel down while open), because a floating
 * menu anchored to the strip would be covered by the native view in the slot
 * below. See the omnibox dropdown in the browser plugin for the in-panel
 * version of the same workaround.
 *
 * Drag reorder uses the browser's native DnD: `dataTransfer` handles and
 * `dragover` targets are enough to move an entry in the store's ordered list.
 */
export function PanelTabs({ region = 'right' }: { region?: PanelRegion }) {
  const panels = usePanelStore((s) => s.panels);
  const tabIds = usePanelStore((s) => s.openPanelIds[region]);
  const activePanelId = usePanelStore((s) => s.activePanelIds[region]);
  const runtime = usePanelStore((s) => s.runtime);
  const openPanel = usePanelStore((s) => s.openPanel);
  const closeTab = usePanelStore((s) => s.closeTab);
  const reorderTabs = usePanelStore((s) => s.reorderTabs);
  const setRightPanelOpen = useUIStore((s) => s.setRightPanelOpen);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [menuIndex, setMenuIndex] = useState<number | null>(null);

  // Dismiss the context menu on click elsewhere. Clicks over a plugin panel's
  // native view never reach this document (the view swallows input), so such a
  // click leaves the menu open — acceptable: it also stays when focus moves
  // into that panel, and any strip interaction or Esc closes it.
  useEffect(() => {
    if (menuIndex === null) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest(`[data-testid="panel-tabs-${region}"]`)) return;
      setMenuIndex(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuIndex(null);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuIndex, region]);

  if (tabIds.length === 0) return null;

  const closeTabAndMaybeCollapse = (id: string) => {
    closeTab(region, id);
    // Closing the last tab leaves the column with nothing to show — collapse
    // it to the rail, the same end state the pre-tab UI reached when its
    // selection cleared.
    if (tabIds.length === 1 && region === 'right') setRightPanelOpen(false);
  };

  const closeOthers = (i: number) => {
    const keep = tabIds[i];
    for (const id of tabIds) {
      if (id !== keep) closeTab(region, id);
    }
    // The kept tab may not be the focused one; focus it without stealing more
    // than a switch would (it is the only tab left).
    if (activePanelId !== keep) openPanel(keep, { focus: true });
    setMenuIndex(null);
  };

  const closeRight = (i: number) => {
    for (const id of tabIds.slice(i + 1)) {
      closeTab(region, id);
    }
    // If the focused tab was among the closed, closeTab re-focused leftward.
    setMenuIndex(null);
  };

  /** Move DOM focus along the strip (VS Code convention: arrows move focus,
   * Enter/Space activate — activating on arrows would fight panels that
   * re-take input focus on activation). */
  const focusNeighbor = (e: React.KeyboardEvent, offset: number) => {
    const next = e.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[data-panel-tab]')[offset];
    next?.focus();
  };

  return (
    <>
      <div
        className="flex h-9 shrink-0 select-none items-stretch gap-0.5 overflow-x-auto border-b bg-background px-1 pt-1"
        role="tablist"
        data-testid={`panel-tabs-${region}`}
      >
        {tabIds.map((id, i) => {
          const panel = panels.find((p) => p.id === id);
          if (!panel) return null;
          const active = id === activePanelId;
          const dragOver = dropIndex === i && dragIndex !== null && dragIndex !== i;
          const badge = runtime[id]?.badge;
          const pending = runtime[id]?.pending;

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
                setMenuIndex(i);
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
                if (e.button === 1) closeTabAndMaybeCollapse(id);
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
              }}
              onDrop={(e) => {
                e.preventDefault();
                const from = tabIds.indexOf(e.dataTransfer.getData('text/plain'));
                if (from !== -1) reorderTabs(region, from, i);
                setDragIndex(null);
                setDropIndex(null);
              }}
              onDragEnd={() => {
                setDragIndex(null);
                setDropIndex(null);
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
              {badge !== undefined && badge !== null && badge !== '' && (
                <span
                  data-panel-tab-badge={id}
                  className="min-w-[16px] shrink-0 rounded-full bg-primary px-1 text-center text-[10px] font-medium leading-4 text-primary-foreground"
                >
                  {badge}
                </span>
              )}
              {pending && !badge && (
                <span
                  data-panel-tab-pending={id}
                  className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-primary"
                />
              )}
              <button
                type="button"
                aria-label={`关闭 ${panel.title}`}
                data-panel-tab-close={id}
                onClick={(e) => {
                  e.stopPropagation();
                  closeTabAndMaybeCollapse(id);
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
        })}
      </div>
      {menuIndex !== null && (
        <div
          className="flex h-7 shrink-0 items-center gap-1 border-b bg-background px-1.5"
          data-testid={`panel-tabs-menu-${region}`}
          onContextMenu={(e) => e.preventDefault()}
        >
          <span className="pr-1 text-[10px] text-muted-foreground">
            {panels.find((p) => p.id === tabIds[menuIndex])?.title}
          </span>
          <button
            type="button"
            data-menu-action="close"
            onClick={() => {
              closeTabAndMaybeCollapse(tabIds[menuIndex]);
              setMenuIndex(null);
            }}
            className="rounded-sm px-1.5 py-0.5 text-xs hover:bg-accent"
          >
            关闭
          </button>
          {tabIds.length > 1 && (
            <button
              type="button"
              data-menu-action="close-others"
              onClick={() => closeOthers(menuIndex)}
              className="rounded-sm px-1.5 py-0.5 text-xs hover:bg-accent"
            >
              关闭其他
            </button>
          )}
          {menuIndex < tabIds.length - 1 && (
            <button
              type="button"
              data-menu-action="close-right"
              onClick={() => closeRight(menuIndex)}
              className="rounded-sm px-1.5 py-0.5 text-xs hover:bg-accent"
            >
              关闭右侧标签
            </button>
          )}
        </div>
      )}
    </>
  );
}
