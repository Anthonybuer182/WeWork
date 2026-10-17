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
  rightPanelOpen?: boolean;
  sidebarOpen?: boolean;
  /**
   * Hide the centre chat column. CSS-hidden, never unmounted: the centre owns
   * the composer, and a plugin `chat.send` from a fullscreen panel must still
   * reach it.
   */
  centerPanelOpen?: boolean;
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
  rightPanelOpen = true,
  sidebarOpen = true,
  centerPanelOpen = true,
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

  const applyRightWidth = useCallback((next: number) => {
    const clamped = Math.max(minRightWidth, Math.min(maxRightWidth, next));
    rightWidthRef.current = clamped;
    setCurrentRightWidth(clamped);
    return clamped;
  }, [minRightWidth, maxRightWidth]);

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!dragging || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;

      if (dragging === 'left') {
        applyLeftWidth(x);
      } else if (dragging === 'right') {
        applyRightWidth(rect.width - x);
        onRightWidthChangeRef.current?.(rightWidthRef.current);
      }
    },
    [dragging, applyLeftWidth, applyRightWidth],
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
              paddingLeft: sidebarOpen ? 0 : chrome.insetLeft,
              // Right panel closed → this segment reaches the band's right
              // edge, where the toggles zone sits on top of it.
              paddingRight: rightPanelOpen ? 0 : trailingWidth,
            }}
          >
            {centerHeader != null && (
              <div className="flex min-w-0 items-center gap-0.5" style={NO_DRAG}>
                {centerHeader}
              </div>
            )}
          </div>
        )}
        {/* Right divider continuation — the same single 1px line as the body
            handle, flush against the right column (the segment's own border-l
            would double it). */}
        {rightPanelOpen && !rightTakesCenter && (
          <div className="flex w-2 shrink-0 justify-end" aria-hidden>
            <div className="h-full w-px bg-border" />
          </div>
        )}
        {rightPanelOpen && (
          <div
            className={cn(
              'flex h-full min-w-0 items-stretch overflow-hidden',
              rightTakesCenter ? 'flex-1' : 'shrink-0',
            )}
            style={{
              width: rightTakesCenter ? undefined : currentRightWidth,
              paddingLeft: rightTakesCenter && !sidebarOpen ? chrome.insetLeft : 0,
              // The toggles zone sits over this segment's right end.
              paddingRight: trailingWidth,
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
              <div
                className="group relative flex-shrink-0 cursor-col-resize"
                style={{ width: '8px' }}
                onMouseDown={() => setDragging('right')}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowLeft') handleKeyboardResize('right', -10);
                  if (e.key === 'ArrowRight') handleKeyboardResize('right', 10);
                }}
                role="separator"
                tabIndex={0}
                aria-label="Resize preview panel"
                aria-valuenow={currentRightWidth}
                aria-valuemin={minRightWidth}
                aria-valuemax={maxRightWidth}
                aria-orientation="vertical"
              >
                <div className="absolute inset-y-0 -left-2 -right-2 z-10" />
                {/* Single 1px divider, flush against the right column — the
                    column's own border-l would draw a second line 4px over. */}
                <div className="ml-auto h-full w-px bg-border group-hover:bg-muted-foreground/60 group-active:bg-muted-foreground/40 transition-colors" />
              </div>
            ) : null}
            <div
              style={rightTakesCenter ? undefined : { width: currentRightWidth }}
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
