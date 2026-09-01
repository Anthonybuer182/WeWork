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
  createQuote,
  usePluginStore,
  usePanelStore,
  useCommandStore,
  getPluginBridge,
} from '@pi/ui';
import { AppShell } from '@pi/ui';
import { ThreeColumnLayout } from '@pi/ui';
import { LeftSidebar } from '@pi/ui';
import { CenterPanel } from '@pi/ui';
import { PanelHost, PanelRail, SelectionService } from '@pi/ui';
import { WorkspaceDropdown } from '@pi/ui';
import { WorkspaceCreateButton } from '@pi/ui';
import { SessionList } from '@pi/ui';
import { ChatTimeline } from '@pi/ui';
import { Composer } from '@pi/ui';
import { UsageBar } from '@pi/ui';
import { ErrorBoundary } from '@pi/ui';
import { FileTree } from '@pi/ui';
import { Separator } from '@pi/ui';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      retry: 1,
    },
  },
});

/**
 * The host is the zeroth panel contributor: preview / settings / plugin-center
 * flow through the same panel registry, rail and lifecycle as plugins.
 * (The browser preview is contributed by the com.pi.browser plugin.)
 */
const HOST_PANELS = [
  { id: 'host:plugins', title: '插件中心', icon: 'puzzle', kind: 'host' as const, source: 'host', keepAlive: 'never' as const },
  { id: 'host:settings', title: '设置', icon: 'settings', kind: 'host' as const, source: 'host', keepAlive: 'never' as const },
  { id: 'host:preview', title: '预览', icon: 'preview', kind: 'host' as const, source: 'host', keepAlive: 'never' as const },
];

function AppContent() {
  useTheme();
  const sdk = useSDK();

  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const rightPanelOpen = useUIStore((s) => s.rightPanelOpen);
  const rightPanelWidth = useUIStore((s) => s.rightPanelWidth);
  const setRightPanelWidth = useUIStore((s) => s.setRightPanelWidth);
  const toggleRightPanel = useUIStore((s) => s.toggleRightPanel);
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
        if (target) openPanel(target, { focus: event.focus });
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

  // Listen for "switch to Browser tab" signals from the main process.
  // The browser preview is now contributed by the com.pi.browser plugin —
  // open its liveview panel so the BrowserView has a slot to render into.
  useEffect(() => {
    const api = (window as unknown as { electronAPI?: { browser?: { onSwitchToBrowserTab?: (cb: () => void) => void } } }).electronAPI?.browser;
    if (api?.onSwitchToBrowserTab) {
      api.onSwitchToBrowserTab(() => {
        openPanel('plugin:com.pi.browser:preview', { focus: true });
        if (!useUIStore.getState().rightPanelOpen) {
          useUIStore.getState().toggleRightPanel();
        }
      });
    }
  }, [openPanel]);

  // Listen for quote events from the injected page script.
  // The injected quote button in the BrowserView page sends {text, url, title}
  // via fetch to http://127.0.0.1:19223/quote, which forwards to the renderer.
  useEffect(() => {
    const api = (window as unknown as { electronAPI?: { browser?: { onQuote?: (cb: (data: { text: string; url: string; title: string }) => void) => void } } }).electronAPI?.browser;
    if (api?.onQuote) {
      api.onQuote((data) => {
        const url = data.url || '';
        const source = url || 'browser';
        useComposerStore.getState().addQuote(createQuote(data.text, source, 'browser'));
      });
    }
  }, []);

  return (
    <TooltipProvider delayDuration={300}>
      <SelectionService />
      <AppShell>
        <ThreeColumnLayout
          sidebarOpen={sidebarOpen}
          rightPanelOpen={rightPanelOpen}
          onToggleRightPanel={toggleRightPanel}
          rightWidth={rightPanelWidth}
          onRightWidthChange={setRightPanelWidth}
          topLeftContent={
            <>
              <WorkspaceDropdown />
              <WorkspaceCreateButton />
            </>
          }
          rightPanel={<PanelHost />}
          rightCollapsedContent={<PanelRail />}
          leftSidebar={
            <LeftSidebar>
              <div className="flex flex-col min-h-0 flex-1 p-2 gap-0">
                <div className="max-h-[45%] overflow-auto flex-shrink-0">
                  <FileTree />
                </div>
                <Separator className="my-1" />
                <SessionList />
              </div>
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
