import { useMemo, useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createProxySDKClient, HTTPTransport } from '@pi/sdk-wrapper';
import {
  SDKProvider,
  useSDK,
  useTheme,
  useUIStore,
  TooltipProvider,
  usePanelStore,
} from '@pi/ui';
import { AppShell } from '@pi/ui';
import { ThreeColumnLayout } from '@pi/ui';
import { LeftSidebar } from '@pi/ui';
import { CenterPanel } from '@pi/ui';
import { PanelHost, PanelRail } from '@pi/ui';
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
 * The web build registers the same host panels as desktop. There is no
 * plugin bridge here, so plugin panels simply never appear — the panel
 * system degrades gracefully. (The browser preview is Electron-only.)
 */
const HOST_PANELS = [
  { id: 'host:preview', title: '预览', icon: 'preview', kind: 'host' as const, source: 'host', keepAlive: 'never' as const },
  { id: 'host:settings', title: '设置', icon: 'settings', kind: 'host' as const, source: 'host', keepAlive: 'never' as const },
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

  const setHostPanels = usePanelStore((s) => s.setHostPanels);
  useEffect(() => {
    setHostPanels(HOST_PANELS);
  }, [setHostPanels]);

  // Try to connect on mount
  useEffect(() => {
    sdk.connect().then(() => {
      setConnectionStatus('connected');
    }).catch(() => {
      setConnectionStatus('disconnected');
    });
  }, [sdk, setConnectionStatus]);

  return (
    <TooltipProvider delayDuration={300}>
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
    const transport = new HTTPTransport('/api');
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
