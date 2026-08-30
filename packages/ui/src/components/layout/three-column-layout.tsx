'use client';

import { useEffect, useRef, useState, useCallback, type ReactNode } from 'react';
import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';

interface ThreeColumnLayoutProps {
  leftSidebar: ReactNode;
  centerPanel: ReactNode;
  rightPanel: ReactNode;
  /** Content for the top bar left section (workspace controls). Shown in sidebar column when sidebar is open. */
  topLeftContent?: ReactNode;
  /** Header content for the right panel (tabs). Only rendered when rightPanelOpen. */
  rightPanelHeader?: ReactNode;
  /** Shown in place of the collapsed right panel (e.g. the panel rail), so badges stay visible. */
  rightCollapsedContent?: ReactNode;
  /** Callback when the right panel toggle button is clicked. */
  onToggleRightPanel?: () => void;
  /** Callback when right panel width changes (after drag/arrow-key resize finishes). */
  onRightWidthChange?: (width: number) => void;
  leftWidth?: number;
  rightWidth?: number;
  minLeftWidth?: number;
  minRightWidth?: number;
  maxLeftWidth?: number;
  maxRightWidth?: number;
  rightPanelOpen?: boolean;
  sidebarOpen?: boolean;
}

export function ThreeColumnLayout({
  leftSidebar,
  centerPanel,
  rightPanel,
  topLeftContent,
  rightPanelHeader,
  rightCollapsedContent,
  onToggleRightPanel,
  onRightWidthChange,
  leftWidth = 260,
  rightWidth = 600,
  minLeftWidth = 200,
  minRightWidth = 300,
  maxLeftWidth = 400,
  maxRightWidth = 1200,
  rightPanelOpen = true,
  sidebarOpen = true,
}: ThreeColumnLayoutProps) {
  const [currentLeftWidth, setCurrentLeftWidth] = useState(leftWidth);
  const [currentRightWidth, setCurrentRightWidth] = useState(rightWidth);
  const [dragging, setDragging] = useState<'left' | 'right' | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rightWidthRef = useRef(currentRightWidth);
  const onRightWidthChangeRef = useRef(onRightWidthChange);

  // Keep refs in sync
  rightWidthRef.current = currentRightWidth;
  onRightWidthChangeRef.current = onRightWidthChange;

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!dragging || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;

      if (dragging === 'left') {
        const newWidth = Math.max(minLeftWidth, Math.min(maxLeftWidth, x));
        setCurrentLeftWidth(newWidth);
      } else if (dragging === 'right') {
        const newWidth = Math.max(
          minRightWidth,
          Math.min(maxRightWidth, rect.width - x),
        );
        setCurrentRightWidth(newWidth);
        onRightWidthChangeRef.current?.(newWidth);
      }
    },
    [dragging, minLeftWidth, maxLeftWidth, minRightWidth, maxRightWidth],
  );

  const handleMouseUp = useCallback(() => {
    setDragging(null);
    onRightWidthChangeRef.current?.(rightWidthRef.current);
  }, []);

  const handleKeyboardResize = useCallback((delta: number) => {
    setCurrentRightWidth((prev) => {
      const next = Math.max(minRightWidth, Math.min(maxRightWidth, prev + delta));
      return next;
    });
    // Need to read the new value after state update, so schedule a microtask
    queueMicrotask(() => {
      onRightWidthChangeRef.current?.(rightWidthRef.current + delta);
    });
  }, [minRightWidth, maxRightWidth]);

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
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        {/* Top bar */}
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
          {onToggleRightPanel && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0 mr-1 text-muted-foreground hover:text-foreground"
              onClick={onToggleRightPanel}
              title={rightPanelOpen ? 'Collapse right panel' : 'Expand right panel'}
            >
              {rightPanelOpen ? (
                <PanelRightClose className="h-4 w-4" />
              ) : (
                <PanelRightOpen className="h-4 w-4" />
              )}
            </Button>
          )}
        </div>

        {/* Sidebar + Center */}
        <div className="flex flex-1 overflow-hidden">
          {sidebarOpen && (
            <>
              <div
                style={{ width: currentLeftWidth }}
                className="flex-shrink-0 overflow-hidden border-r"
              >
                {leftSidebar}
              </div>
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
                  if (e.key === 'ArrowLeft')
                    setCurrentLeftWidth(
                      Math.max(minLeftWidth, currentLeftWidth - 10),
                    );
                  if (e.key === 'ArrowRight')
                    setCurrentLeftWidth(
                      Math.min(maxLeftWidth, currentLeftWidth + 10),
                    );
                }}
              />
            </>
          )}
          <div className="flex-1 min-w-0 overflow-hidden">{centerPanel}</div>
        </div>
      </div>

      {/* ============== Right column ============== */}
      {rightPanelOpen ? (
        <>
          <div
            className="relative flex-shrink-0 cursor-col-resize group"
            style={{ width: '8px' }}
            onMouseDown={() => setDragging('right')}
            onKeyDown={(e) => {
              if (e.key === 'ArrowLeft') handleKeyboardResize(-10);
              if (e.key === 'ArrowRight') handleKeyboardResize(10);
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
          <div
            style={{ width: currentRightWidth }}
            className="flex-shrink-0 overflow-hidden border-l flex flex-col"
          >
            {rightPanelHeader && (
              <div className="shrink-0">{rightPanelHeader}</div>
            )}
            <div className="flex-1 overflow-hidden">{rightPanel}</div>
          </div>
        </>
      ) : (
        rightCollapsedContent && (
          <div className="flex-shrink-0 border-l">{rightCollapsedContent}</div>
        )
      )}
    </div>
  );
}
