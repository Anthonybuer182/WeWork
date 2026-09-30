import { useEffect, type ComponentType } from 'react';
import { usePanelStore, type PanelEntry, type PanelRegion } from '@/stores/panel-store';
import { ProviderSettings } from '@/components/settings';
import { PluginCenter } from '@/components/plugins/plugin-center';
import { FileTree } from '@/components/file/file-tree';
import { SessionList } from '@/components/session/session-list';
import { SearchView } from '@/components/search/search-view';
import { ContextPanel } from '@/components/context/context-panel';
import { PluginPanelHost, ensureRelayInstalled } from '@/components/plugins/plugin-panel';
import { DeclarativePanelHost } from '@/components/plugins/declarative/declarative-panel';
import { LiveViewSlot } from './live-view-slot';

/**
 * Host panels ("the host is the zeroth contributor") — rendered through the
 * same panel registry/lifecycle/rail as plugin panels. File preview is
 * plugin-owned: no host preview panel.
 */
const HOST_COMPONENTS: Record<string, ComponentType> = {
  'host:settings': ProviderSettings,
  'host:plugins': PluginCenter,
  'host:files': FileTree,
  'host:sessions': SessionList,
  'host:search': SearchView,
  'host:context': ContextPanel,
};

/**
 * Whether this host can put a panel in a native WebContentsView.
 *
 * Plugin web panels are hosted natively on desktop. A native view is a real
 * top-level frame, which is what gives a panel correct IME and working
 * print / alert / download — an iframe sandbox blocks all three. The web build
 * has no such host, and does not show plugin panels at all.
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
 * It also installs the relay. That used to happen inside `PluginPanelHost`, so
 * when panels moved to native views nothing ran it any more — which silently
 * broke both the theme push and the `onRelay` subscription that carries a
 * panel's selection frames back to the shell.
 */
function PluginWebViewPanel({ pluginId, panelId }: { pluginId: string; panelId: string }) {
  const params = usePanelStore((s) => s.params[`plugin:${pluginId}:${panelId}`]);
  useEffect(() => {
    ensureRelayInstalled();
  }, []);
  return <LiveViewSlot pluginId={pluginId} panelId={panelId} notifyMounted params={params} />;
}

function PanelBody({ panel }: { panel: PanelEntry }) {
  const allPanels = usePanelStore((s) => s.panels);
  if (panel.kind === 'host') {
    const Host = HOST_COMPONENTS[panel.id];
    return Host ? <Host /> : null;
  }
  if (panel.kind === 'iframe' && panel.pluginId && panel.panelId && panel.entry) {
    if (hasNativeViewHost()) {
      return <PluginWebViewPanel pluginId={panel.pluginId} panelId={panel.panelId} />;
    }
    return <PluginPanelHost pluginId={panel.pluginId} panelId={panel.panelId} entry={panel.entry} autoHeight={panel.autoHeight} />;
  }
  if (panel.kind === 'declarative' && panel.pluginId && panel.panelId) {
    return <DeclarativePanelHost pluginId={panel.pluginId} panelId={panel.panelId} />;
  }
  if (panel.kind === 'liveview' && panel.pluginId && panel.panelId) {
    // Companion card (e.g. a control bar) renders above the live view —
    // one rail button, controls and live feed on the same screen. The
    // companion itself may be an iframe or declarative panel.
    const companion = allPanels.find(
      (p) => p.companionOf === panel.panelId && p.source === panel.source,
    );
    if (companion) {
      const companionBody =
        companion.kind === 'iframe' && companion.pluginId && companion.panelId && companion.entry ? (
          <PluginPanelHost pluginId={companion.pluginId} panelId={companion.panelId} entry={companion.entry} />
        ) : companion.kind === 'declarative' && companion.pluginId && companion.panelId ? (
          <DeclarativePanelHost pluginId={companion.pluginId} panelId={companion.panelId} />
        ) : null;
      return (
        <div className="flex h-full w-full flex-col">
          <div
            className="shrink-0 border-b bg-background"
            // iframe companions are fixed-height toolbars (their HTML is
            // written to fit); declarative companions size to content.
            style={companion.kind === 'iframe' ? { height: 44 } : undefined}
          >
            {companionBody}
          </div>
          <div className="min-h-0 flex-1">
            <LiveViewSlot pluginId={panel.pluginId} panelId={panel.panelId} />
          </div>
        </div>
      );
    }
    return <LiveViewSlot pluginId={panel.pluginId} panelId={panel.panelId} />;
  }
  return null;
}

/**
 * Single-panel slot: the active panel is visible; keep-alive panels stay
 * mounted hidden (iframe state preserved, BrowserView alive), everything
 * else unmounts.
 */
export function PanelSlot({ region = 'right' }: { region?: PanelRegion }) {
  const panels = usePanelStore((s) => s.panels);
  const activePanelId = usePanelStore((s) => s.activePanelIds[region]);
  const mountedIds = usePanelStore((s) => s.mountedIds);

  // `mountedIds` is flat across regions; each slot renders only its own.
  const regionMountedIds = mountedIds.filter(
    (id) => panels.find((p) => p.id === id)?.region === region,
  );

  return (
    <div
      className="relative flex-1 min-h-0 overflow-hidden"
      data-testid={`panel-slot-${region}`}
      data-panel-slot-region={region}
    >
      {regionMountedIds.map((id) => {
        const panel = panels.find((p) => p.id === id);
        if (!panel) return null;
        const visible = id === activePanelId;
        return (
          <div
            key={id}
            data-panel-container={id}
            // `flex flex-col` is load-bearing: panel components size themselves
            // with `flex-1`, which only has meaning against a flex parent.
            // Without it their height collapses to 0 and virtualized lists
            // (the session list) render nothing.
            className="absolute inset-0 flex flex-col"
            style={{ display: visible ? undefined : 'none' }}
          >
            <PanelBody panel={panel} />
          </div>
        );
      })}
      {regionMountedIds.length === 0 && (
        <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
          <span className="text-sm">
            {region === 'left' ? '从左侧图标栏选择一个视图' : '从右侧图标栏选择一个面板'}
          </span>
        </div>
      )}
    </div>
  );
}
