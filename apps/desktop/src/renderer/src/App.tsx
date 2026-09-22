import { useMemo, useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createProxySDKClient, IPCTransport } from '@pi/sdk-wrapper';
import {
  SDKProvider,
  useSDK,
  useTheme,
  useUIStore,
  TooltipProvider,
  useComposerStore,
  usePluginStore,
  usePanelStore,
  useCommandStore,
  getPluginBridge,
} from '@pi/ui';
import { AppShell } from '@pi/ui';
import { TitleBar, LayoutToggles } from '@pi/ui';
import { ThreeColumnLayout } from '@pi/ui';
import { LeftSidebar } from '@pi/ui';
import { CenterPanel } from '@pi/ui';
import { PanelHost, SelectionService } from '@pi/ui';
import { WorkspaceDropdown } from '@pi/ui';
import { WorkspaceCreateButton } from '@pi/ui';
import { HOST_LEFT_PANELS } from '@pi/ui';
import type { PanelEntry } from '@pi/ui';
import { ChatTimeline } from '@pi/ui';
import { Composer } from '@pi/ui';
import { UsageBar } from '@pi/ui';
import { ErrorBoundary } from '@pi/ui';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      retry: 1,
    },
  },
});

/**
 * The host is the zeroth panel contributor: settings / plugin-center flow
 * through the same panel registry, rail and lifecycle as plugins. File
 * preview and the browser are plugin-owned — no host fallback panels.
 */
const HOST_PANELS: PanelEntry[] = [
  { id: 'host:plugins', title: '插件中心', icon: 'puzzle', kind: 'host', source: 'host', keepAlive: 'never', region: 'right' },
  // Settings is a left-sidebar view pinned to the rail's bottom — the VS Code
  // gear position. It reads as configuration rather than navigation.
  // keepAlive 'always' so in-progress form edits survive switching views.
  { id: 'host:settings', title: '设置', icon: 'settings', kind: 'host', source: 'host', keepAlive: 'always', region: 'left', anchor: 'bottom', order: 100 },
  ...HOST_LEFT_PANELS,
];

function AppContent() {
  useTheme();
  const sdk = useSDK();

  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const rightPanelOpen = useUIStore((s) => s.rightPanelOpen);
  const rightPanelWidth = useUIStore((s) => s.rightPanelWidth);
  const rightPanelMaximized = useUIStore((s) => s.rightPanelMaximized);
  const setRightPanelWidth = useUIStore((s) => s.setRightPanelWidth);
  const leftPanelWidth = useUIStore((s) => s.leftPanelWidth);
  const setLeftPanelWidth = useUIStore((s) => s.setLeftPanelWidth);
  const setConnectionStatus = useUIStore((s) => s.setConnectionStatus);

  // ── Panel registry: host panels + plugin panels ──
  const setHostPanels = usePanelStore((s) => s.setHostPanels);
  const setPluginPanels = usePanelStore((s) => s.setPluginPanels);
  const openPanel = usePanelStore((s) => s.openPanel);
  const setPanelStatus = usePanelStore((s) => s.setPanelStatus);
  const setPluginCommands = useCommandStore((s) => s.setPluginCommands);

  useEffect(() => {
    setHostPanels(HOST_PANELS);
  }, [setHostPanels]);

  // The right side defaults to the icon rail only. When it becomes visible
  // with no active panel (e.g. toggled open), restore the last-used panel —
  // or the plugin center — instead of an empty placeholder.
  useEffect(() => {
    if (!rightPanelOpen) return;
    const panelState = usePanelStore.getState();
    // Scope to the right region: a left-sidebar view being active says nothing
    // about what the right side should show.
    if (panelState.activePanelIds.right) return;
    const rightPanels = panelState.panels.filter((p) => p.region === 'right');
    const fallback =
      panelState.recency.find((id) => rightPanels.some((p) => p.id === id)) ??
      rightPanels.find((p) => p.id === 'host:plugins')?.id ??
      rightPanels[0]?.id;
    if (fallback) panelState.openPanel(fallback, { focus: true });
  }, [rightPanelOpen]);

  // ── Plugin system: discovery + events + command contributions ──
  const loadPlugins = usePluginStore((s) => s.loadPlugins);
  const plugins = usePluginStore((s) => s.plugins);

  useEffect(() => {
    loadPlugins();
  }, [loadPlugins]);

  useEffect(() => {
    setPluginPanels(plugins);
    for (const plugin of plugins) {
      setPluginCommands(plugin.id, plugin.commands ?? []);
    }
  }, [plugins, setPluginPanels, setPluginCommands]);

  useEffect(() => {
    const bridge = getPluginBridge();
    if (!bridge) return;
    bridge.onEvent((event) => {
      if (event.type === 'status') {
        setPanelStatus(event.status);
      } else if (event.type === 'panel-open') {
        // focus=false → pending badge only (no-focus-steal principle)
        const panelId = event.panelId
          ? `plugin:${event.pluginId}:${event.panelId}`
          : undefined;
        const target = panelId ?? usePanelStore.getState().panels.find((p) => p.source === event.pluginId)?.id;
        if (target) {
          openPanel(target, { focus: event.focus });
          if (event.focus !== false) {
            // Event-triggered open — surface the panel side too.
            useUIStore.getState().setRightPanelOpen(true);
          }
        }
      } else if (event.type === 'plugins-changed') {
        // Install/uninstall/enable/disable — refresh discovery + panels.
        usePluginStore.getState().loadPlugins();
      } else if (event.type === 'install-phase') {
        usePluginStore.getState().setInstallPhase(event.pluginId, event.phase);
      }
    });
  }, [setPanelStatus, openPanel]);

  useEffect(() => {
    sdk.connect().then(() => {
      setConnectionStatus('connected');
    }).catch(() => {
      setConnectionStatus('disconnected');
    });
  }, [sdk, setConnectionStatus]);

  // A plugin can drive the conversation via the `chat.send` capability. The
  // renderer owns the composer, so the message is relayed here and sent
  // through the same path as typing a message — which also makes it work from
  // a fullscreen plugin panel, where the composer is hidden but still mounted.
  // The plugin owns the input UI; the host only provides the ability to reach
  // the agent.
  useEffect(() => {
    const api = (window as unknown as {
      electronAPI?: { on?: (channel: string, cb: (payload: unknown) => void) => void };
    }).electronAPI;
    if (!api?.on) return;
    api.on('pi:chat:send', (payload) => {
      const text = (payload as { text?: string } | undefined)?.text;
      if (text) useComposerStore.getState().setTriggerSend(text);
    });
  }, []);

  // Listen for "switch to Browser tab" signals from the main process.
  // The browser preview is now contributed by the com.pi.browser plugin —
  // open its liveview panel so the BrowserView has a slot to render into.
  useEffect(() => {
    const api = (window as unknown as { electronAPI?: { browser?: { onSwitchToBrowserTab?: (cb: () => void) => void } } }).electronAPI?.browser;
    if (api?.onSwitchToBrowserTab) {
      api.onSwitchToBrowserTab(() => {
        openPanel('plugin:com.pi.browser:preview', { focus: true });
        useUIStore.getState().setRightPanelOpen(true);
      });
    }
  }, [openPanel]);


  return (
    <TooltipProvider delayDuration={300}>
      <SelectionService />
      <AppShell>
        <TitleBar
          leading={<WorkspaceDropdown />}
          leadingAction={<WorkspaceCreateButton />}
          // Match the left column so the "+" lands on the sidebar's edge line.
          leadingWidth={sidebarOpen ? leftPanelWidth : undefined}
          trailing={<LayoutToggles />}
        />
        <ThreeColumnLayout
          sidebarOpen={sidebarOpen}
          rightPanelOpen={rightPanelOpen}
          rightPanelMaximized={rightPanelMaximized}
          rightWidth={rightPanelWidth}
          onRightWidthChange={setRightPanelWidth}
          leftWidth={leftPanelWidth}
          onLeftWidthChange={setLeftPanelWidth}
          rightPanel={<PanelHost />}
          leftSidebar={
            <LeftSidebar>
              <PanelHost region="left" chrome={false} />
            </LeftSidebar>
          }
          centerPanel={
            <CenterPanel>
              <ChatTimeline />
              <UsageBar />
              <Composer />
            </CenterPanel>
          }
        />
      </AppShell>
    </TooltipProvider>
  );
}

export function App() {
  const sdkClient = useMemo(() => {
    const transport = new IPCTransport();
    return createProxySDKClient({ transport });
  }, []);

  return (
    <ErrorBoundary>
      <SDKProvider value={sdkClient}>
        <QueryClientProvider client={queryClient}>
          <AppContent />
        </QueryClientProvider>
      </SDKProvider>
    </ErrorBoundary>
  );
}
