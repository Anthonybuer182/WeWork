import type { ComponentType } from 'react';
import { usePanelStore, type PanelEntry } from '@/stores/panel-store';
import { ProviderSettings } from '@/components/settings';
import { PluginCenter } from '@/components/plugins/plugin-center';
import { PluginPanelHost } from '@/components/plugins/plugin-panel';
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
};

function PanelBody({ panel }: { panel: PanelEntry }) {
  const allPanels = usePanelStore((s) => s.panels);
  if (panel.kind === 'host') {
    const Host = HOST_COMPONENTS[panel.id];
    return Host ? <Host /> : null;
  }
  if (panel.kind === 'iframe' && panel.pluginId && panel.panelId && panel.entry) {
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
export function PanelSlot() {
  const panels = usePanelStore((s) => s.panels);
  const activePanelId = usePanelStore((s) => s.activePanelId);
  const mountedIds = usePanelStore((s) => s.mountedIds);

  return (
    <div className="relative flex-1 min-h-0 overflow-hidden" data-testid="panel-slot">
      {mountedIds.map((id) => {
        const panel = panels.find((p) => p.id === id);
        if (!panel) return null;
        const visible = id === activePanelId;
        return (
          <div
            key={id}
            data-panel-container={id}
            className="absolute inset-0"
            style={{ display: visible ? undefined : 'none' }}
          >
            <PanelBody panel={panel} />
          </div>
        );
      })}
      {mountedIds.length === 0 && (
        <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
          <span className="text-sm">从右侧图标栏选择一个面板</span>
        </div>
      )}
    </div>
  );
}
