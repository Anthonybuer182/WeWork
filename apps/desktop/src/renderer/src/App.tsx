import { useMemo, useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createProxySDKClient, IPCTransport } from '@pi/sdk-wrapper';
import {
  SDKProvider,
  useSDK,
  useTheme,
  useUIStore,
  TooltipProvider,
} from '@pi/ui';
import { AppShell } from '@pi/ui';
import { ThreeColumnLayout } from '@pi/ui';
import { LeftSidebar } from '@pi/ui';
import { CenterPanel } from '@pi/ui';
import { RightPanel } from '@pi/ui';
import { RightPanelTabs } from '@pi/ui';
import { WorkspaceDropdown } from '@pi/ui';
import { WorkspaceCreateButton } from '@pi/ui';
import { SessionList } from '@pi/ui';
import { ChatTimeline } from '@pi/ui';
import { Composer } from '@pi/ui';
import { UsageBar } from '@pi/ui';
import { DocumentPreview } from '@pi/ui';
import { BrowserPreview } from '@pi/ui';
import { ErrorBoundary } from '@pi/ui';
import { FileTree } from '@pi/ui';
import { Separator } from '@pi/ui';
import { Button } from '@pi/ui';
import { ProviderSettings } from '@pi/ui';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      retry: 1,
    },
  },
});

function AppContent() {
  useTheme();
  const sdk = useSDK();

  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const rightPanelOpen = useUIStore((s) => s.rightPanelOpen);
  const rightPanelWidth = useUIStore((s) => s.rightPanelWidth);
  const setRightPanelWidth = useUIStore((s) => s.setRightPanelWidth);
  const rightPanelActiveTab = useUIStore((s) => s.rightPanelActiveTab);
  const setRightPanelTab = useUIStore((s) => s.setRightPanelTab);
  const toggleRightPanel = useUIStore((s) => s.toggleRightPanel);
  const connectionStatus = useUIStore((s) => s.connectionStatus);
  const setConnectionStatus = useUIStore((s) => s.setConnectionStatus);

  useEffect(() => {
    sdk.connect().then(() => {
      setConnectionStatus('connected');
    }).catch(() => {
      setConnectionStatus('disconnected');
    });
  }, [sdk, setConnectionStatus]);

  // Listen for "switch to Browser tab" signals from the main process.
  // This fires when the AI agent uses pi-browser CLI while the Browser
  // tab isn't open — auto-switches so the webview mounts and connects.
  useEffect(() => {
    const api = (window as unknown as { electronAPI?: { browser?: { onSwitchToBrowserTab?: (cb: () => void) => void } } }).electronAPI?.browser;
    if (api?.onSwitchToBrowserTab) {
      api.onSwitchToBrowserTab(() => {
        const state = useUIStore.getState();
        state.setRightPanelTab('browser');
        if (!state.rightPanelOpen) {
          state.toggleRightPanel();
        }
      });
    }
  }, []);

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
          rightPanelHeader={
            <RightPanelTabs
              activeTab={rightPanelActiveTab}
              onTabChange={setRightPanelTab}
            />
          }
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
          rightPanel={
            <RightPanel>
              {rightPanelActiveTab === 'preview' && <DocumentPreview />}
              <div style={{ height: '100%', display: rightPanelActiveTab === 'browser' ? undefined : 'none' }}>
                <BrowserPreview />
              </div>
              {rightPanelActiveTab === 'settings' && <ProviderSettings />}
            </RightPanel>
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
