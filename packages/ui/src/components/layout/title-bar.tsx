import { useMemo, type CSSProperties, type ReactNode } from 'react';
import { Columns2, Minus, PanelLeft, PanelRight, Square, X, ArrowLeftRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/ui-store';
import { usePanelStore } from '@/stores/panel-store';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * `-webkit-app-region` is not a Tailwind utility and neither tailwind config
 * registers a plugin for it, so a class name would be silently purged from the
 * build (both configs scan source for class NAMES). It must be an inline style.
 *
 * Exported for the three-column layout, whose header band is the window drag
 * region; interactive segments opt out with NO_DRAG.
 */
export const DRAG: CSSProperties = { WebkitAppRegion: 'drag' } as CSSProperties;
export const NO_DRAG: CSSProperties = { WebkitAppRegion: 'no-drag' } as CSSProperties;

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
  const centerPanelOpen = useUIStore((s) => s.centerPanelOpen);
  const toggleCenterPanel = useUIStore((s) => s.toggleCenterPanel);
  const chatRightOfPanels = useUIStore((s) => s.chatRightOfPanels);
  const toggleChatSide = useUIStore((s) => s.toggleChatSide);
  const panels = usePanelStore((s) => s.panels);
  const runtime = usePanelStore((s) => s.runtime);

  // Only offer the toggle when its region has something to show. Web registers
  // no right-region panels, so a right toggle there would open an empty column.
  const hasRightPanels = panels.some((p) => p.region === 'right' && !p.hidden);

  // Swapping sides is defined for the two-column workbench only: with the
  // sidebar open the chat cannot cross it, so the control would be a no-op.
  const canSwapSides = !sidebarOpen && rightPanelOpen && centerPanelOpen;

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
      <TitleBarButton
        label={centerPanelOpen ? '隐藏中间栏' : '显示中间栏'}
        active={centerPanelOpen}
        onClick={toggleCenterPanel}
      >
        <Columns2 className="h-4 w-4" />
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
      {hasRightPanels && canSwapSides && (
        <TitleBarButton
          label={chatRightOfPanels ? '对话放回左侧' : '对话换到右侧'}
          active={chatRightOfPanels}
          onClick={toggleChatSide}
        >
          <ArrowLeftRight className="h-4 w-4" />
        </TitleBarButton>
      )}
    </>
  );
}

/** Self-drawn caption buttons for frameless platforms (Linux). Rendered by
 *  the layout's header-trailing zone. */
export function WindowControls() {
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
