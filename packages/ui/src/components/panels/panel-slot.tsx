import { useEffect, type ComponentType } from 'react';
import { usePanelStore, type PanelEntry, type PanelRegion } from '@/stores/panel-store';
import { ProviderSettings } from '@/components/settings';
import { PluginCenter } from '@/components/plugins/plugin-center';
import { FileTree } from '@/components/file/file-tree';
import { SessionList } from '@/components/session/session-list';
import { ContextPanel } from '@/components/context/context-panel';
import { ensureRelayInstalled } from '@/components/plugins/panel-relay';
import { LiveSlot } from './live-slot';

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
 * It also installs the relay — the theme push and the `onRelay` subscription
 * that carries a panel's selection frames back to the shell.
 */
function PluginWebViewPanel({ pluginId, panelId }: { pluginId: string; panelId: string }) {
  const params = usePanelStore((s) => s.params[`plugin:${pluginId}:${panelId}`]);
  useEffect(() => {
    ensureRelayInstalled();
  }, []);
  return <LiveSlot pluginId={pluginId} panelId={panelId} notifyMounted params={params} />;
}

function PanelBody({ panel }: { panel: PanelEntry }) {
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
          插件面板需要桌面端
        </div>
      );
    }
    return <PluginWebViewPanel pluginId={panel.pluginId} panelId={panel.panelId} />;
  }
  return null;
}

/**
 * Single-panel slot: the active panel is visible; keep-alive panels stay
 * mounted hidden (the view stays alive), everything
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
