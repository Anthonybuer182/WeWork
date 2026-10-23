'use client';

import { useEffect, useRef, useState, useCallback, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { getHostChrome, DRAG, NO_DRAG, WindowControls } from './title-bar';

interface ThreeColumnLayoutProps {
  leftSidebar: ReactNode;
  centerPanel: ReactNode;
  rightPanel: ReactNode;
  /**
   * Header band segment over the left column (workspace controls). Rendered
   * only while the sidebar is open — when it is closed the app is expected
   * to pass the same content as `centerHeader`, which then carries the
   * traffic-light inset.
   */
  leftHeader?: ReactNode;
  /** Header band segment over the centre column (future: session title). */
  centerHeader?: ReactNode;
  /** Header band segment over the right column (the panel tab strip). */
  rightHeader?: ReactNode;
  /**
   * Pinned at the far right of the header band, IN FLOW — the tab strip is
   * confined to the right column's segment, so no number of tabs can push
   * this out. It is also the only affordance that re-opens a collapsed
   * column, which is why it must never disappear.
   */
  headerTrailing?: ReactNode;
  /** Callback when right panel width changes (after drag/arrow-key resize finishes). */
  onRightWidthChange?: (width: number) => void;
  /** Callback when left sidebar width changes (after drag/arrow-key resize finishes). */
  onLeftWidthChange?: (width: number) => void;
  leftWidth?: number;
  rightWidth?: number;
  minLeftWidth?: number;
  minRightWidth?: number;
  maxLeftWidth?: number;
  maxRightWidth?: number;
  /**
   * Minimum width the centre column keeps while the right panel is widened.
   * The right panel's own `maxRightWidth` is a static cap; this is the dynamic
   * one — it also reserves the sidebar and both dividers, so dragging the
   * right divider can never squeeze the left column out of view.
   */
  minCenterWidth?: number;
  rightPanelOpen?: boolean;
  sidebarOpen?: boolean;
  /**
   * Hide the centre chat column. CSS-hidden, never unmounted: the centre owns
   * the composer, and a plugin `chat.send` from a fullscreen panel must still
   * reach it.
   */
  centerPanelOpen?: boolean;
  /**
   * Mirror the two visible columns: the panel keeps the left edge and the
   * chat takes the right. Applied only while the sidebar is closed — the chat
   * cannot cross the sidebar (they share one flex wrapper), and the sidebar
   * stays the platform's left rail.
   */
  chatRight?: boolean;
}

/** Width of each resize divider (matches the `w-1` handles below). */
const DIVIDER_WIDTH = 4;

/**
 * The right divider handle — used by BOTH the header band and the body so the
 * line is one continuous grab target from the very top of the window. Grabbing
 * it in the title bar must feel identical to grabbing it below (same cursor,
 * same hover highlight, same keyboard behaviour); the two copies are driven by
 * one `currentRightWidth`, so they can never drift apart.
 */
function RightDividerHandle({
  width,
  minWidth,
  maxWidth,
  order,
  onDragStart,
  onKeyboardResize,
}: {
  width: number;
  minWidth: number;
  maxWidth: number;
  /** Flex order — the handle travels with its column when the sides swap. */
  order?: number;
  onDragStart: () => void;
  onKeyboardResize: (side: 'left' | 'right', delta: number) => void;
}) {
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label="Resize preview panel"
      aria-valuenow={width}
      aria-valuemin={minWidth}
      aria-valuemax={maxWidth}
      aria-orientation="vertical"
      className="group relative w-1 shrink-0 cursor-col-resize"
      // The header band is a window drag region; the handle must opt out or
      // the OS swallows the mousedown and resizing from the title bar never
      // starts.
      style={{ ...NO_DRAG, order }}
      onMouseDown={onDragStart}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') onKeyboardResize('right', -10);
        if (e.key === 'ArrowRight') onKeyboardResize('right', 10);
      }}
    >
      <div className="absolute inset-y-0 -left-2 -right-2 z-10" />
      <div className="ml-auto h-full w-px bg-border transition-colors group-hover:bg-muted-foreground/60 group-active:bg-muted-foreground/40" />
    </div>
  );
}

/**
 * Three-column workbench layout with a partitioned header band.
 *
 * The band is NOT a separate title bar floating above the columns: each
 * column owns a header segment sized by the SAME width state that drives its
 * body. That is what lets the column dividers run unbroken from the very top
 * — the band's divider continuations sit at the same x positions as the body
 * handles, because both come from one `currentLeftWidth`/`currentRightWidth`.
 *
 * On desktop the band is the window drag region (`-webkit-app-region` is not
 * a Tailwind utility and would be purged from the build — it must be inline
 * styles, see title-bar.tsx). Interactive segments opt out with NO_DRAG.
 */
export function ThreeColumnLayout({
  leftSidebar,
  centerPanel,
  rightPanel,
  leftHeader,
  centerHeader,
  rightHeader,
  headerTrailing,
  onRightWidthChange,
  onLeftWidthChange,
  leftWidth = 260,
  rightWidth = 600,
  minLeftWidth = 200,
  minRightWidth = 300,
  maxLeftWidth = 400,
  maxRightWidth = 1200,
  minCenterWidth = 360,
  rightPanelOpen = true,
  sidebarOpen = true,
  centerPanelOpen = true,
  chatRight = false,
}: ThreeColumnLayoutProps) {
  const [currentLeftWidth, setCurrentLeftWidth] = useState(leftWidth);
  const [currentRightWidth, setCurrentRightWidth] = useState(rightWidth);
  const [dragging, setDragging] = useState<'left' | 'right' | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const leftWidthRef = useRef(currentLeftWidth);
  const rightWidthRef = useRef(currentRightWidth);
  const onLeftWidthChangeRef = useRef(onLeftWidthChange);
  const onRightWidthChangeRef = useRef(onRightWidthChange);

  const chrome = getHostChrome();
  const draggable = chrome.platform !== 'web';

  // Two visible columns, chat on the right of the panel. Only that state has a
  // defined other side: with the sidebar open the chat cannot cross it (they
  // are one flex wrapper), so the preference lies dormant rather than
  // reordering three columns behind the user's back.
  //
  // The columns are moved with CSS `order`, never by changing DOM order: the
  // centre owns the composer and the right column owns the native views, and
  // a reorder in the tree would remount both.
  const swapped = chatRight && !sidebarOpen && rightPanelOpen && centerPanelOpen;

  // The trailing zone (layout toggles) is pinned absolutely at the band's
  // top-right — in flow it would eat its 100-odd px out of the flex-1 centre
  // segment and break the divider alignment with the body. Segments that sit
  // at the band's right edge reserve its measured width instead.
  const trailingRef = useRef<HTMLDivElement>(null);
  const [trailingWidth, setTrailingWidth] = useState(0);
  useEffect(() => {
    const el = trailingRef.current;
    if (!el) return;
    const measure = () => setTrailingWidth(el.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Keep refs in sync. During a drag the refs are also written directly by the
  // handlers below so that rapid events accumulate correctly even when React
  // has not re-rendered yet.
  leftWidthRef.current = currentLeftWidth;
  rightWidthRef.current = currentRightWidth;
  onLeftWidthChangeRef.current = onLeftWidthChange;
  onRightWidthChangeRef.current = onRightWidthChange;

  const applyLeftWidth = useCallback((next: number) => {
    const clamped = Math.max(minLeftWidth, Math.min(maxLeftWidth, next));
    leftWidthRef.current = clamped;
    setCurrentLeftWidth(clamped);
    return clamped;
  }, [minLeftWidth, maxLeftWidth]);

  /**
   * The right panel's real ceiling right now. `maxRightWidth` is a static
   * preference (a 1200px panel on a 1400px window is legal by that number),
   * so it also has to leave room for the sidebar, both dividers and a usable
   * centre — otherwise the left column is clipped out of view and the panel
   * appears to cover it.
   */
  const maxRightWidthNow = useCallback(() => {
    const width = containerRef.current?.getBoundingClientRect().width;
    if (width === undefined) return maxRightWidth;
    const leftColumn = sidebarOpen ? currentLeftWidth + DIVIDER_WIDTH : 0;
    const centre = centerPanelOpen ? minCenterWidth : 0;
    const cap = width - leftColumn - DIVIDER_WIDTH - centre;
    return Math.max(minRightWidth, Math.min(maxRightWidth, cap));
  }, [maxRightWidth, minRightWidth, minCenterWidth, sidebarOpen, centerPanelOpen, currentLeftWidth]);

  const applyRightWidth = useCallback((next: number) => {
    const clamped = Math.max(minRightWidth, Math.min(maxRightWidthNow(), next));
    rightWidthRef.current = clamped;
    setCurrentRightWidth(clamped);
    return clamped;
  }, [minRightWidth, maxRightWidthNow]);

  // A panel that was already wide must not survive a window shrink or a wider
  // sidebar: re-clamp whenever the container or the left column changes, so
  // the left column is never left clipped.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const clamp = () => {
      const cap = maxRightWidthNow();
      if (rightWidthRef.current > cap) {
        applyRightWidth(cap);
        onRightWidthChangeRef.current?.(rightWidthRef.current);
      }
    };
    clamp();
    const observer = new ResizeObserver(clamp);
    observer.observe(el);
    return () => observer.disconnect();
  }, [maxRightWidthNow, applyRightWidth]);

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!dragging || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;

      if (dragging === 'left') {
        applyLeftWidth(x);
      } else if (dragging === 'right') {
        // Mirrored while swapped: the panel is then the LEFT column (the
        // sidebar is closed, so it starts at the container's own edge) and
        // grows with x instead of shrinking from the right.
        applyRightWidth(swapped ? x : rect.width - x);
        onRightWidthChangeRef.current?.(rightWidthRef.current);
      }
    },
    [dragging, applyLeftWidth, applyRightWidth, swapped],
  );

  const handleMouseUp = useCallback(() => {
    // Persist only the side that was actually dragged. This used to call
    // onRightWidthChange unconditionally, so releasing a left-handle drag
    // wrote the right panel's width.
    if (dragging === 'left') {
      onLeftWidthChangeRef.current?.(leftWidthRef.current);
    } else if (dragging === 'right') {
      onRightWidthChangeRef.current?.(rightWidthRef.current);
    }
    setDragging(null);
  }, [dragging]);

  const handleKeyboardResize = useCallback(
    (side: 'left' | 'right', delta: number) => {
      if (side === 'left') {
        onLeftWidthChangeRef.current?.(applyLeftWidth(leftWidthRef.current + delta));
      } else {
        onRightWidthChangeRef.current?.(applyRightWidth(rightWidthRef.current + delta));
      }
    },
    [applyLeftWidth, applyRightWidth],
  );

  // Centre hidden + right panel open → the right column absorbs the freed
  // space instead of leaving a dead gap between the columns: it becomes the
  // working surface (viewer, browser, plugin panels all want the room).
  // Two flex-1 siblings would split the space 50/50, so the left column must
  // collapse to just the sidebar.
  const rightTakesCenter = !centerPanelOpen && rightPanelOpen;

  useEffect(() => {
    if (dragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    }
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [dragging, handleMouseMove, handleMouseUp]);

  return (
    <div ref={containerRef} className="flex flex-1 flex-col overflow-hidden">
      {/* ============ Header band ============ */}
      {/* No bottom border: the band merges into the body (Codex-style); the
          column separators themselves carry the structure. */}
      <div
        className="relative flex h-11 shrink-0 select-none items-stretch bg-background"
        data-testid="header-band"
        style={draggable ? DRAG : undefined}
      >
        {sidebarOpen && (
          <>
            <div
              className="flex h-full min-w-0 shrink-0 items-center overflow-hidden border-r bg-sidebar"
              style={{ width: currentLeftWidth, paddingLeft: chrome.insetLeft }}
            >
              {leftHeader != null && (
                <div className="flex min-w-0 items-center gap-0.5" style={NO_DRAG}>
                  {leftHeader}
                </div>
              )}
            </div>
            {/* Left divider continuation — same x as the body separator. */}
            <div className="w-1 shrink-0" aria-hidden />
          </>
        )}
        {!rightTakesCenter && (
          <div
            className="flex h-full min-w-0 flex-1 items-center overflow-hidden"
            style={{
              order: swapped ? 2 : 0,
              // Leftmost segment carries the traffic-light inset, rightmost
              // reserves the toggles zone — both follow the swap.
              paddingLeft: sidebarOpen || swapped ? 0 : chrome.insetLeft,
              paddingRight: swapped || !rightPanelOpen ? trailingWidth : 0,
            }}
          >
            {centerHeader != null && (
              <div className="flex min-w-0 items-center gap-0.5" style={NO_DRAG}>
                {centerHeader}
              </div>
            )}
          </div>
        )}
        {/* Right divider continuation — the same interactive handle as the
            body, flush against the right column (the segment's own border-l
            would double the line). */}
        {rightPanelOpen && !rightTakesCenter && (
          <RightDividerHandle
            width={currentRightWidth}
            minWidth={minRightWidth}
            maxWidth={maxRightWidthNow()}
            order={swapped ? 1 : 0}
            onDragStart={() => setDragging('right')}
            onKeyboardResize={handleKeyboardResize}
          />
        )}
        {rightPanelOpen && (
          <div
            className={cn(
              'flex h-full min-w-0 items-stretch overflow-hidden',
              rightTakesCenter ? 'flex-1' : 'shrink-0',
            )}
            style={{
              order: swapped ? 0 : undefined,
              width: rightTakesCenter ? undefined : currentRightWidth,
              // Swapped → this segment is the leftmost column and takes the
              // traffic-light inset; otherwise the chat's segment keeps it.
              paddingLeft:
                (rightTakesCenter || swapped) && !sidebarOpen ? chrome.insetLeft : 0,
              // The toggles zone sits over this segment's right end — unless
              // the chat has taken that edge.
              paddingRight: swapped ? 0 : trailingWidth,
            }}
          >
            {rightHeader != null && (
              <div className="flex h-full min-w-0 flex-1 items-stretch" style={NO_DRAG}>
                {rightHeader}
              </div>
            )}
          </div>
        )}
        <div
          ref={trailingRef}
          className="absolute inset-y-0 right-0 z-10 flex shrink-0 items-center gap-1 px-2"
          style={NO_DRAG}
          data-testid="header-trailing"
        >
          {headerTrailing}
          {chrome.customControls && <WindowControls />}
        </div>
      </div>

      {/* ============ Body band ============ */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* ============== Left + Center column ============== */}
        <div
          style={{ order: swapped ? 2 : 0 }}
          className={cn(
            'flex min-w-0 flex-col overflow-hidden',
            // Centre hidden with the right panel absorbing the space: shrink to
            // just the sidebar. Two `flex-1` siblings would split the free
            // width instead of handing it all over.
            rightTakesCenter ? 'flex-none' : 'flex-1',
          )}
        >
          {/* Sidebar + Center */}
          <div className="flex flex-1 overflow-hidden">
            {/* Hidden, not unmounted, when collapsed — same reasoning as the
                centre column below. The sidebar hosts the left PanelHost, whose
                keepAlive:'always' panels (session list, file tree, settings
                forms) must survive a collapse/expand cycle with their state.
                Unmounting here silently defeated that policy. The resize handle
                is chrome, not state, so it still goes away. */}
            <div
              style={sidebarOpen ? { width: currentLeftWidth } : undefined}
              className={cn(
                'flex-shrink-0 overflow-hidden border-r',
                !sidebarOpen && 'hidden',
              )}
            >
              {leftSidebar}
            </div>
            {sidebarOpen && (
              <div
                role="separator"
                tabIndex={0}
                aria-label="Resize sidebar"
                aria-valuenow={currentLeftWidth}
                aria-valuemin={minLeftWidth}
                aria-valuemax={maxLeftWidth}
                aria-orientation="vertical"
                className="w-1 cursor-col-resize hover:bg-muted-foreground/40 transition-colors"
                onMouseDown={() => setDragging('left')}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowLeft') handleKeyboardResize('left', -10);
                  if (e.key === 'ArrowRight') handleKeyboardResize('left', 10);
                }}
              />
            )}
            {/* Hidden, not unmounted: the centre column owns the composer, and a
                plugin panel can trigger a send from fullscreen (`chat.send`).
                Unmounting would take that path with it. */}
            <div
              className={cn('min-w-0 flex-1 overflow-hidden', !centerPanelOpen && 'hidden')}
            >
              {centerPanel}
            </div>
          </div>
        </div>

        {/* ============== Right column ============== */}
        {rightPanelOpen ? (
          <>
            {!rightTakesCenter ? (
              <RightDividerHandle
                width={currentRightWidth}
                minWidth={minRightWidth}
                maxWidth={maxRightWidthNow()}
                order={swapped ? 1 : 0}
                onDragStart={() => setDragging('right')}
                onKeyboardResize={handleKeyboardResize}
              />
            ) : null}
            <div
              style={{
                order: swapped ? 0 : undefined,
                ...(rightTakesCenter ? undefined : { width: currentRightWidth }),
              }}
              className={cn(
                'overflow-hidden flex flex-col',
                rightTakesCenter ? 'min-w-0 flex-1' : 'flex-shrink-0',
              )}
            >
              <div className="flex-1 overflow-hidden">{rightPanel}</div>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
