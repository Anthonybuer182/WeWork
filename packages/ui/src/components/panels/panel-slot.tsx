import { useEffect, type ComponentType } from 'react';
import { Minimize2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { usePanelStore, type PanelEntry } from '@/stores/panel-store';
import { useI18n } from '@/i18n';
import { PluginCenter } from '@/components/plugins/plugin-center';
import { FileTree } from '@/components/file/file-tree';
import { SessionList } from '@/components/session/session-list';
import { ContextPanel } from '@/components/context/context-panel';
import { ensureRelayInstalled } from '@/components/plugins/panel-relay';
import { LiveSlot } from './live-slot';
import { panelTitle } from './panel-title';
import { RailIcon } from './panel-rail';

/**
 * Host panels ("the host is the zeroth contributor") — rendered through the
 * same panel registry/lifecycle as plugin panels. File preview is
 * plugin-owned: no host preview panel.
 */
const HOST_COMPONENTS: Record<string, ComponentType> = {
  'host:plugins': PluginCenter,
  'host:files': FileTree,
  'host:sessions': SessionList,
  'host:context': ContextPanel,
};

/**
 * Whether this host can put a panel in a native WebContentsView.
 *
 * Every shipped build can: desktop always exposes `electronAPI`, and the web
 * build never registers plugin panels at all (`setPluginPanels` is called only
 * by the desktop renderer). A native view is a real top-level frame, which is
 * what gives a panel correct IME and working print / alert / download.
 *
 * Kept as a guard rather than assumed, because the failure it prevents — a
 * blank rectangle with no explanation — is the one this whole area is prone to.
 */
function hasNativeViewHost(): boolean {
  if (typeof window === 'undefined') return false;
  const api = (window as unknown as { electronAPI?: { invoke?: unknown } }).electronAPI;
  return typeof api?.invoke === 'function';
}

/**
 * A plugin web panel hosted natively. Reads the panel's open params (e.g.
 * `{ file }` for the viewer) and hands them to the slot, which forwards them to
 * the backend as the `panel.mounted` event the backend renders from.
 *
 * It also installs the relay — the theme push that keeps a panel's colors in
 * sync with the shell.
 */
function PluginWebViewPanel({ pluginId, panelId }: { pluginId: string; panelId: string }) {
  const params = usePanelStore((s) => s.params[`plugin:${pluginId}:${panelId}`]);
  useEffect(() => {
    ensureRelayInstalled();
  }, []);
  return <LiveSlot pluginId={pluginId} panelId={panelId} notifyMounted params={params} />;
}

export function PanelBody({ panel }: { panel: PanelEntry }) {
  const { t } = useI18n();
  // Host panel: a React component the shell owns.
  if (panel.source === 'host') {
    const Host = HOST_COMPONENTS[panel.id];
    return Host ? <Host /> : null;
  }
  // Plugin panel: a web page the host hosts, in a WebContentsView.
  if (panel.pluginId && panel.panelId && panel.entry) {
    if (!hasNativeViewHost()) {
      // No shipped build reaches this. Saying so beats the alternative — an
      // empty rectangle that looks like a plugin that failed to load.
      return (
        <div className="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground">
          {t('插件面板需要桌面端')}
        </div>
      );
    }
    return <PluginWebViewPanel pluginId={panel.pluginId} panelId={panel.panelId} />;
  }
  return null;
}

/**
 * One work-area pane: the panel's body, plus — only while the pane is ZOOMED —
 * a slim host-drawn header carrying identity and the restore control.
 *
 * The tiled panes draw no header: the header tab strip directly above already
 * shows every open panel's icon and title, and a second copy right under it
 * read as duplication. Zoom must live outside the panel body either way
 * (plugin pages are native views that would cover any DOM floating inside
 * them), so in tiled mode it lives on the tab (hover button + double-click);
 * zoomed, the header returns as the pane's own title bar with 还原.
 *
 * `zoomable` is false for regions where a pane already spans its whole
 * container (the left sidebar) — zooming there is meaningless.
 */
export function PaneView({
  panel,
  focused,
  zoomed,
  zoomable = true,
  hidden = false,
  width,
}: {
  panel: PanelEntry;
  focused: boolean;
  zoomed: boolean;
  zoomable?: boolean;
  /** Rendered but kept off the layout (kept-alive while minimized). */
  hidden?: boolean;
  /** Flex-basis width when laid out (px). Undefined → flex:1. */
  width?: number;
}) {
  const { t } = useI18n();
  const setFocused = usePanelStore((s) => s.setFocused);
  const toggleZoom = usePanelStore((s) => s.toggleZoom);
  const region = panel.region;
  const title = panelTitle(panel, t);

  return (
    <div
      data-panel-container={panel.id}
      data-pane-focused={focused ? 'true' : undefined}
      className={cn(
        'group/pane flex min-w-0 flex-col overflow-hidden',
        focused ? 'bg-background' : 'bg-background/95',
        hidden && 'hidden',
      )}
      style={hidden ? undefined : { flex: width != null ? `0 0 ${width}px` : '1 1 0%' }}
      onMouseDown={() => {
        if (!focused) setFocused(region, panel.id);
      }}
    >
      {/* Header only while zoomed — see the doc comment above. */}
      {zoomed && (
        <div
          data-pane-header={panel.id}
          onDoubleClick={(e) => {
            if (!zoomable) return;
            e.preventDefault();
            toggleZoom(region, panel.id);
          }}
          className={cn(
            'flex h-7 shrink-0 select-none items-center gap-1.5 border-b px-2 text-xs',
            focused ? 'border-border bg-accent/60 text-accent-foreground' : 'bg-muted/40 text-muted-foreground',
          )}
        >
          <RailIcon panel={panel} size={14} className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{title}</span>
          {zoomable && (
            <button
              type="button"
              aria-label={t('还原窗格')}
              title={t('还原（其他窗格回到工作区；Esc 同效）')}
              data-pane-zoom={panel.id}
              onClick={(e) => {
                e.stopPropagation();
                toggleZoom(region, panel.id);
              }}
              className="shrink-0 rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <Minimize2 className="h-3 w-3" />
            </button>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1">
        <PanelBody panel={panel} />
      </div>
    </div>
  );
}
