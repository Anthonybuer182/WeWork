import { useMemo, type CSSProperties, type ReactNode } from 'react';
import { Minus, PanelLeft, PanelRight, Square, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/ui-store';
import { usePanelStore } from '@/stores/panel-store';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * `-webkit-app-region` is not a Tailwind utility and neither tailwind config
 * registers a plugin for it, so a class name would be silently purged from the
 * build (both configs scan source for class NAMES). It must be an inline style.
 */
const DRAG: CSSProperties = { WebkitAppRegion: 'drag' } as CSSProperties;
const NO_DRAG: CSSProperties = { WebkitAppRegion: 'no-drag' } as CSSProperties;

export type HostPlatform = 'darwin' | 'win32' | 'linux' | 'web';

/** Window-chrome facts the renderer needs. Supplied by the host, never sniffed. */
export interface HostChrome {
  platform: HostPlatform;
  /** px reserved on the left for native window controls (macOS traffic lights). */
  insetLeft: number;
  /** px reserved on the right for native window controls (Windows caption buttons). */
  insetRight: number;
  /** Host draws its own minimize/maximize/close (Linux frameless). */
  customControls: boolean;
}

const WEB_CHROME: HostChrome = {
  platform: 'web',
  insetLeft: 0,
  insetRight: 0,
  customControls: false,
};

/**
 * Read the chrome descriptor the Electron preload exposes. The browser build has
 * no preload, so it falls back to a chrome-less descriptor — which is correct
 * for a normal browser tab (no native title bar to avoid, nothing to drag).
 */
export function getHostChrome(): HostChrome {
  const api = (window as unknown as { electronAPI?: { chrome?: Partial<HostChrome> } }).electronAPI;
  if (!api?.chrome) return WEB_CHROME;
  return { ...WEB_CHROME, ...api.chrome };
}

interface TitleBarProps {
  /** Omit to let the component read the host descriptor itself. */
  chrome?: HostChrome;
  /** Left-aligned content (workspace selector). */
  leading?: ReactNode;
  /** Rendered at the end of the leading section (the "+" action). */
  leadingAction?: ReactNode;
  /**
   * Upper bound for the leading section — normally the left column's width.
   * The section sizes to its content (the controls sit next to each other);
   * this only clamps it, so a long workspace name truncates instead of
   * pushing the trailing action past the sidebar's edge.
   */
  leadingWidth?: number;
  /** Right-aligned content (layout toggles). */
  trailing?: ReactNode;
  className?: string;
}

/**
 * Full-width application title bar. Replaces the OS title bar on Electron and
 * acts as a plain header row on web.
 *
 * Interactive children sit in their own no-drag zones: a `drag` region is
 * treated by Chromium as a window-caption hit-test area and receives no mouse
 * events at all, so a bare button inside it would simply not be clickable.
 * The container around them stays draggable, so the gaps still move the window.
 */
export function TitleBar({
  chrome = getHostChrome(),
  leading,
  leadingAction,
  leadingWidth,
  trailing,
  className,
}: TitleBarProps) {
  const draggable = chrome.platform !== 'web';

  return (
    <div
      className={cn(
        'flex h-11 shrink-0 items-center border-b bg-background select-none',
        className,
      )}
      style={{
        ...(draggable ? DRAG : undefined),
        paddingRight: chrome.insetRight,
      }}
      data-testid="title-bar"
    >
      {(leading || leadingAction) && (
        <div
          className="flex shrink-0 items-center gap-0.5 min-w-0"
          style={{
            // max-width, not width: the controls stay tightly packed and this
            // only stops them from crossing the sidebar's right edge.
            maxWidth: leadingWidth,
            paddingLeft: chrome.insetLeft + 12,
            paddingRight: 8,
          }}
        >
          {leading && (
            <div className="min-w-0" style={NO_DRAG}>
              {leading}
            </div>
          )}
          {leadingAction && (
            <div className="shrink-0" style={NO_DRAG}>
              {leadingAction}
            </div>
          )}
        </div>
      )}
      <div className="flex-1" />
      <div className="flex items-center gap-1 px-2" style={NO_DRAG}>
        {trailing}
      </div>
      {chrome.customControls && <WindowControls />}
    </div>
  );
}

function TitleBarButton({
  label,
  active,
  onClick,
  dot,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  /** Small activity dot — used when the toggled region is collapsed. */
  dot?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-pressed={active}
          data-activity-dot={dot ? 'true' : undefined}
          onClick={onClick}
          className={cn(
            'relative flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground',
            active && 'bg-accent text-accent-foreground',
          )}
        >
          {children}
          {dot && <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-primary" />}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Sidebar visibility toggles. These actions already existed on the ui store but
 * nothing in the app ever called them — there was no affordance at all.
 */
export function LayoutToggles() {
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const rightPanelOpen = useUIStore((s) => s.rightPanelOpen);
  const toggleRightPanel = useUIStore((s) => s.toggleRightPanel);
  const panels = usePanelStore((s) => s.panels);
  const runtime = usePanelStore((s) => s.runtime);

  // Only offer the toggle when its region has something to show. Web registers
  // no right-region panels, so a right toggle there would open an empty column.
  const hasRightPanels = panels.some((p) => p.region === 'right' && !p.hidden);

  // The right rail is only rendered while the sidebar is open, so a badge or
  // unread dot on a panel of a collapsed sidebar would otherwise be invisible.
  // Surface it on the toggle itself.
  const rightActivity = useMemo(() => {
    if (rightPanelOpen) return false;
    return panels.some((p) => {
      if (p.region !== 'right' || p.hidden) return false;
      const rt = runtime[p.id];
      if (!rt) return false;
      return (
        rt.pending === true ||
        (rt.badge !== undefined && rt.badge !== null && rt.badge !== '') ||
        rt.activity === 'streaming' ||
        rt.activity === 'working' ||
        rt.activity === 'error'
      );
    });
  }, [panels, runtime, rightPanelOpen]);

  return (
    <>
      <TitleBarButton
        label={sidebarOpen ? '隐藏左侧栏' : '显示左侧栏'}
        active={sidebarOpen}
        onClick={toggleSidebar}
      >
        <PanelLeft className="h-4 w-4" />
      </TitleBarButton>
      {hasRightPanels && (
        <TitleBarButton
          label={rightPanelOpen ? '隐藏右侧栏' : '显示右侧栏'}
          active={rightPanelOpen}
          dot={rightActivity}
          onClick={toggleRightPanel}
        >
          <PanelRight className="h-4 w-4" />
        </TitleBarButton>
      )}
    </>
  );
}

/** Self-drawn caption buttons for frameless platforms (Linux). */
function WindowControls() {
  const invoke = (channel: string) => {
    const api = (window as unknown as {
      electronAPI?: { invoke?: (c: string, ...a: unknown[]) => Promise<unknown> };
    }).electronAPI;
    api?.invoke?.(channel).catch(() => {});
  };

  return (
    <div className="flex h-full items-stretch" style={NO_DRAG}>
      <button
        type="button"
        aria-label="最小化"
        className="flex w-11 items-center justify-center text-muted-foreground hover:bg-accent"
        onClick={() => invoke('pi:window:minimize')}
      >
        <Minus className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        aria-label="最大化"
        className="flex w-11 items-center justify-center text-muted-foreground hover:bg-accent"
        onClick={() => invoke('pi:window:maximize')}
      >
        <Square className="h-3 w-3" />
      </button>
      <button
        type="button"
        aria-label="关闭"
        className="flex w-11 items-center justify-center text-muted-foreground hover:bg-destructive hover:text-destructive-foreground"
        onClick={() => invoke('pi:window:close')}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
