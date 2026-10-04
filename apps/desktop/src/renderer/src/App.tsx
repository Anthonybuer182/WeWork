import { useMemo, useEffect } from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
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
import { PanelHost } from '@pi/ui';
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
 * The host is the zeroth panel contributor: settings / plugin-center / the
 * browser flow through the same panel registry, rail and lifecycle as plugins.
 * File preview is plugin-owned — no host fallback panel.
 */
const HOST_PANELS: PanelEntry[] = [
  { id: 'host:plugins', title: '插件中心', icon: 'puzzle', source: 'host', keepAlive: 'never', region: 'right' },
  // The browser is a plugin panel now (com.pi.browser): its page embeds the
  // host's engine view via piSDK.liveSlot. The engine and its session stay
  // host-owned — the plugin only positions and drives it.
  // Settings is a left-sidebar view pinned to the rail's bottom — the VS Code
  // gear position. It reads as configuration rather than navigation.
  // keepAlive 'always' so in-progress form edits survive switching views.
  { id: 'host:settings', title: '设置', icon: 'settings', source: 'host', keepAlive: 'always', region: 'left', anchor: 'bottom', order: 100 },
  ...HOST_LEFT_PANELS,
];

function AppContent() {
  useTheme();
  const sdk = useSDK();

  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const rightPanelOpen = useUIStore((s) => s.rightPanelOpen);
  const centerPanelOpen = useUIStore((s) => s.centerPanelOpen);
  const rightPanelWidth = useUIStore((s) => s.rightPanelWidth);
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

  // ── Tell main which workspace is on screen ──
  // Which workspace is active is a view fact that only the renderer holds, and
  // the plugin kernel needs it to resolve the default target of `agent.*`
  // reads (which AGENTS.md chain the context plugin should show). Shares the
  // workspaces query cache with the dropdown rather than re-fetching.
  const activeWorkspaceId = useUIStore((s) => s.activeWorkspaceId);
  const { data: workspaces } = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => sdk.workspace.list(),
  });
  useEffect(() => {
    const api = (
      window as unknown as {
        electronAPI?: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
      }
    ).electronAPI;
    if (!api) return;
    const ws = workspaces?.find((w) => w.id === activeWorkspaceId);
    api
      .invoke('pi:agent:set-active-workspace', ws ? { id: ws.id, path: ws.path } : null)
      .catch(() => {
        /* kernel may not be up yet; the next change re-sends */
      });
  }, [workspaces, activeWorkspaceId]);

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
          // Surface the panel's own side: a backend-opened panel must not land
          // in a collapsed column the user cannot see. focus=false means
          // "badge, don't steal focus" — no reveal in that case, either region.
          const region = usePanelStore.getState().panels.find((p) => p.id === target)?.region;
          if (event.focus !== false) {
            if (region === 'right') useUIStore.getState().setRightPanelOpen(true);
            else if (region === 'left') useUIStore.getState().setSidebarOpen(true);
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


  return (
    <TooltipProvider delayDuration={300}>
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
          centerPanelOpen={centerPanelOpen}
          rightWidth={rightPanelWidth}
          onRightWidthChange={setRightPanelWidth}
          leftWidth={leftPanelWidth}
          onLeftWidthChange={setLeftPanelWidth}
          rightPanel={<PanelHost />}
          leftSidebar={
            <LeftSidebar>
              <PanelHost region="left" />
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
