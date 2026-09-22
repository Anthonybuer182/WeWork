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
 * The web build registers the same host panels as desktop. There is no
 * plugin bridge here, so plugin panels simply never appear — the panel
 * system degrades gracefully. (The browser preview is Electron-only.)
 * File preview is plugin-owned — no host fallback panel.
 */
const HOST_PANELS: PanelEntry[] = [
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
