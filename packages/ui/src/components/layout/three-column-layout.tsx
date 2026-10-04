'use client';

import { useEffect, useRef, useState, useCallback, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';

interface ThreeColumnLayoutProps {
  leftSidebar: ReactNode;
  centerPanel: ReactNode;
  rightPanel: ReactNode;
  /** Content for the top bar left section (workspace controls). Shown in sidebar column when sidebar is open. */
  topLeftContent?: ReactNode;
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

export function ThreeColumnLayout({
  leftSidebar,
  centerPanel,
  rightPanel,
  topLeftContent,
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
    <div ref={containerRef} className="flex flex-1 overflow-hidden">
      {/* ============== Left + Center column ============== */}
      <div
        className={cn(
          'flex flex-col min-w-0 overflow-hidden',
          // Centre hidden with the right panel absorbing the space: shrink to
          // just the sidebar. Two `flex-1` siblings would split the free
          // width instead of handing it all over.
          rightTakesCenter ? 'flex-none' : 'flex-1',
        )}
      >
        {/* Top bar */}
        {/* Legacy top bar. Apps that render a full-width <TitleBar/> in the
            AppShell above pass no topLeftContent, and this bar disappears —
            which also removes its overlap with the right resize handle. */}
        {topLeftContent && (
        <div className="flex h-12 shrink-0 items-center border-b bg-background">
          {sidebarOpen ? (
            <>
              <div
                style={{ width: currentLeftWidth }}
                className="flex-shrink-0 overflow-hidden h-full"
              >
                <div className="flex items-center gap-2 px-4 h-full">
                  {topLeftContent}
                </div>
              </div>
              <div className="flex-1 h-full" />
            </>
          ) : (
            <div className="flex-1 flex items-center gap-2 px-4">
              {topLeftContent}
            </div>
          )}
        </div>
        )}

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
            <Separator
              orientation="vertical"
              role="separator"
              tabIndex={0}
              aria-label="Resize sidebar"
              aria-valuenow={currentLeftWidth}
              aria-valuemin={minLeftWidth}
              aria-valuemax={maxLeftWidth}
              aria-orientation="vertical"
              className="w-1 cursor-col-resize hover:bg-primary/50 transition-colors"
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
            className={cn('flex-1 min-w-0 overflow-hidden', !centerPanelOpen && 'hidden')}
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
            className="relative flex-shrink-0 cursor-col-resize group"
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
            <div className="h-full w-full bg-border group-hover:bg-primary/50 group-active:bg-primary/30 transition-colors" />
          </div>
          ) : null}
          <div
            style={rightTakesCenter ? undefined : { width: currentRightWidth }}
            className={cn(
              'overflow-hidden border-l flex flex-col',
              rightTakesCenter ? 'flex-1 min-w-0' : 'flex-shrink-0',
            )}
          >
            <div className="flex-1 overflow-hidden">{rightPanel}</div>
          </div>
        </>
      ) : null}
    </div>
  );
}
