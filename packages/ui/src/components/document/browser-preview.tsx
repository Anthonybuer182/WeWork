import { useState, useRef, useCallback, useEffect } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  ExternalLink,
  Circle,
  Square,
  Globe,
  ZoomIn,
  ZoomOut,
  Maximize,
  Minimize,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { BrowserQuoteButton } from './browser-quote-button';
import { WorkflowDialog, type WorkflowStep } from './workflow-dialog';
import { WorkflowSelector, type Workflow } from './workflow-selector';


/** Minimal webview element interface. */
interface WebviewElement extends HTMLElement {
  executeJavaScript: (code: string) => Promise<unknown>;
  getURL: () => string;
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  loadURL: (url: string) => Promise<void>;
}

/** Minimal electronAPI interface for browser operations. */
interface BrowserAPI {
  connect: () => Promise<{ connected: boolean; error?: string }>;
  navigate: (url: string) => Promise<{ url: string; title: string }>;
  getUrl: () => Promise<{ url: string; title: string }>;
  screenshot: () => Promise<{ base64: string }>;
  startRecording: () => Promise<{ started: boolean }>;
  stopRecording: () => Promise<{ steps: WorkflowStep[] }>;
  saveWorkflow: (name: string, steps: WorkflowStep[]) => Promise<{ name: string; saved: boolean }>;
  listWorkflows: () => Promise<Workflow[]>;
  deleteWorkflow: (name: string) => Promise<{ name: string; deleted: boolean }>;
  replay: (name: string, variables?: Record<string, string>) => Promise<{ name: string; completed: boolean; stepCount: number }>;
  setViewport: (width: number, height: number) => Promise<void>;
  setZoom: (factor: number) => Promise<{ zoom: number }>;
  resetZoom: () => Promise<{ zoom: number }>;
  getZoom: () => Promise<{ zoom: number }>;
  onUrlChanged: (callback: (url: string) => void) => void;
  onRecordingState: (callback: (recording: boolean) => void) => void;
  onReplayProgress: (callback: (progress: { current: number; total: number }) => void) => void;
  onSwitchToBrowserTab: (callback: () => void) => void;
}

function getBrowserAPI(): BrowserAPI | undefined {
  return (window as unknown as { electronAPI?: { browser?: BrowserAPI } }).electronAPI?.browser;
}

/** Detect if running inside Electron (where <webview> is available). */
function isElectron(): boolean {
  return typeof (window as unknown as { electronAPI?: unknown }).electronAPI !== 'undefined';
}

export function BrowserPreview() {
  const webviewRef = useRef<WebviewElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [url, setUrl] = useState('about:blank');
  const [urlInput, setUrlInput] = useState('');
  const [connected, setConnected] = useState(false);
  const [recording, setRecording] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [recordedSteps, setRecordedSteps] = useState<WorkflowStep[]>([]);
  const [replayProgress, setReplayProgress] = useState<{ current: number; total: number } | null>(null);
  const [zoom, setZoomState] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const api = getBrowserAPI();
  const inElectron = isElectron();

  // ── Track container size via ResizeObserver ──
  // We observe the container (not the webview) because the webview element
  // may not be mounted yet when the observer is set up. The container size
  // includes the toolbar, so we subtract it for accurate viewport sync.
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const container = document.querySelector('.browser-preview-container');
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerSize({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // ── Sync viewport to the webview's actual rendered size ──
  useEffect(() => {
    if (!api || !inElectron || !connected) return;

    const debounceMs = 300;
    const timer = setTimeout(() => {
      // Measure the webview element's actual size for precise viewport sync
      const webview = webviewRef.current;
      if (!webview) return;
      const rect = webview.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      if (width > 0 && height > 0) {
        api.setViewport(width, height).catch((err) => {
          console.warn('[BrowserPreview] setViewport failed:', err);
        });
      }
    }, debounceMs);

    return () => clearTimeout(timer);
  }, [api, inElectron, connected, containerSize]);

  // ── Track connected state in a ref to break callback dependency chain ──
  const connectedRef = useRef(false);
  const connectRetryCountRef = useRef(0);
  const MAX_CONNECT_RETRIES = 5;

  // ── Connect to CDP when webview is ready ──
  // Uses connectedRef instead of connected state to keep identity stable
  const connectToCDP = useCallback(async () => {
    if (!api || connectedRef.current) return;
    try {
      const result = await api.connect();
      if (result.connected) {
        connectedRef.current = true;
        setConnected(true);
        connectRetryCountRef.current = 0;
        console.log('[BrowserPreview] CDP connected');
      } else {
        connectRetryCountRef.current++;
        console.error('[BrowserPreview] CDP connect failed:', result.error);
        if (connectRetryCountRef.current < MAX_CONNECT_RETRIES) {
          setTimeout(() => connectToCDPRef.current(), 1000);
        }
      }
    } catch (err) {
      connectRetryCountRef.current++;
      console.error('[BrowserPreview] CDP connect error:', err);
      if (connectRetryCountRef.current < MAX_CONNECT_RETRIES) {
        setTimeout(() => connectToCDPRef.current(), 1000);
      }
    }
  }, [api]);

  // ── Stale closure workaround: keep a ref to connectToCDP ──
  const connectToCDPRef = useRef(connectToCDP);
  useEffect(() => {
    connectToCDPRef.current = connectToCDP;
  }, [connectToCDP]);

  // ── Kick off connection when api becomes available ──
  useEffect(() => {
    if (api && !connectedRef.current) {
      connectToCDPRef.current();
    }
  }, [api]);

  // Refs to hold webview listener references for cleanup
  const navListenerRef = useRef<(() => void) | null>(null);
  const domReadyListenerRef = useRef<(() => void) | null>(null);

  // ── Set up event listeners ──
  useEffect(() => {
    if (!api) return;

    const handleUrlChanged = (newUrl: string) => {
      setUrl(newUrl);
      setUrlInput(newUrl);
    };

    const handleRecordingState = (isRecording: boolean) => {
      setRecording(isRecording);
    };

    const handleReplayProgress = (progress: { current: number; total: number }) => {
      setReplayProgress(progress);
      if (progress.current >= progress.total) {
        setTimeout(() => setReplayProgress(null), 1000);
      }
    };

    api.onUrlChanged(handleUrlChanged);
    api.onRecordingState(handleRecordingState);
    api.onReplayProgress(handleReplayProgress);
  }, [api]);

  // ── Handle webview element when it's mounted (Electron only) ──
  // Stable identity — uses refs to avoid dependency on `connected` or `connectToCDP`
  const setWebviewRef = useCallback((node: WebviewElement | null) => {
    // Clean up old listeners before setting new ref
    const prev = webviewRef.current;
    if (prev && prev !== node) {
      prev.removeEventListener('did-navigate', navListenerRef.current as EventListener);
      prev.removeEventListener('did-navigate-in-page', navListenerRef.current as EventListener);
      prev.removeEventListener('did-finish-load', navListenerRef.current as EventListener);
      prev.removeEventListener('dom-ready', domReadyListenerRef.current as EventListener);
    }

    webviewRef.current = node;
    if (!node) return;

    // Set up navigation listener
    const navListener = () => {
      const currentUrl = node.getURL();
      setUrl(currentUrl);
      setUrlInput(currentUrl);
    };
    navListenerRef.current = navListener;

    node.addEventListener('did-navigate', navListener as EventListener);
    node.addEventListener('did-navigate-in-page', navListener as EventListener);
    node.addEventListener('did-finish-load', navListener as EventListener);

    // Connect to CDP after webview DOM is ready
    const domReadyListener = () => {
      setTimeout(() => connectToCDPRef.current(), 300);
    };
    domReadyListenerRef.current = domReadyListener;
    node.addEventListener('dom-ready', domReadyListener as EventListener);

    // Also try connecting immediately (in case dom-ready already fired)
    setTimeout(() => connectToCDPRef.current(), 500);
  }, []);

  // ── For web mode: mark as "connected" immediately (no CDP needed) ──
  useEffect(() => {
    if (!inElectron && !connected) {
      setConnected(true);
    }
  }, [inElectron, connected]);

  // ── URL bar navigation ──
  const handleNavigate = useCallback(async () => {
    let targetUrl = urlInput.trim();
    if (!targetUrl) return;

    // Add https:// if no protocol specified
    if (!targetUrl.match(/^https?:\/\//)) {
      targetUrl = 'https://' + targetUrl;
      setUrlInput(targetUrl);
    }

    if (api) {
      try {
        const result = await api.navigate(targetUrl);
        setUrl(result.url);
        setUrlInput(result.url);
      } catch (err) {
        console.error('Navigate failed:', err);
      }
    } else if (inElectron) {
      // Fallback: use webview directly
      await webviewRef.current?.loadURL(targetUrl);
    } else {
      // Web mode: navigate iframe
      setUrl(targetUrl);
      if (iframeRef.current) {
        iframeRef.current.src = targetUrl;
      }
    }
  }, [urlInput, api, inElectron]);

  // ── Webview/iframe controls (Electron only for back/forward) ──
  const handleBack = () => {
    webviewRef.current?.goBack();
  };
  const handleForward = () => {
    webviewRef.current?.goForward();
  };
  const handleReload = () => {
    if (inElectron) {
      webviewRef.current?.reload();
    } else {
      if (iframeRef.current) {
        iframeRef.current.src = iframeRef.current.src;
      }
    }
  };
  const handleOpenExternal = () => {
    if (url && url !== 'about:blank') {
      window.open(url, '_blank');
    }
  };

  // ── Zoom ──
  const handleZoomIn = useCallback(async () => {
    if (!api) return;
    const result = await api.setZoom(zoom + 0.1);
    setZoomState(result.zoom);
  }, [api, zoom]);

  const handleZoomOut = useCallback(async () => {
    if (!api) return;
    const result = await api.setZoom(zoom - 0.1);
    setZoomState(result.zoom);
  }, [api, zoom]);

  const handleZoomReset = useCallback(async () => {
    if (!api) return;
    const result = await api.resetZoom();
    setZoomState(result.zoom);
  }, [api]);

  const handleToggleFullscreen = useCallback(() => {
    setFullscreen((f) => !f);
  }, []);

  // Sync zoom state when page navigates (auto-zoom changes)
  useEffect(() => {
    if (!api || !connected) return;
    api.getZoom().then((r) => setZoomState(r.zoom)).catch(() => {});
  }, [api, connected, url]);

  // ── Recording ──
  const handleRecordToggle = useCallback(async () => {
    if (!api) return;
    try {
      if (recording) {
        const result = await api.stopRecording();
        setRecordedSteps(result.steps || []);
        setDialogOpen(true);
      } else {
        await api.startRecording();
      }
    } catch (err) {
      console.error('Recording toggle failed:', err);
    }
  }, [api, recording]);

  // ── Save workflow ──
  const handleSaveWorkflow = useCallback(async (name: string, steps: WorkflowStep[]) => {
    if (!api) return;
    await api.saveWorkflow(name, steps);
  }, [api]);

  // ── Replay workflow ──
  const handleReplay = useCallback(async (name: string, variables: Record<string, string>) => {
    if (!api) return;
    await api.replay(name, variables);
  }, [api]);

  // ── Delete workflow ──
  const handleDeleteWorkflow = useCallback(async (name: string) => {
    if (!api) return;
    await api.deleteWorkflow(name);
  }, [api]);

  // ── List workflows ──
  const handleListWorkflows = useCallback(async (): Promise<Workflow[]> => {
    if (!api) return [];
    return await api.listWorkflows();
  }, [api]);

  return (
    <div className={fullscreen ? 'fixed inset-0 z-[9999] bg-background flex flex-col' : 'flex flex-col h-full'}>
      {/* ── Toolbar ── */}
      <div className="flex items-center gap-1 border-b px-2 py-1.5">
        {inElectron && (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={handleBack}>
                  <ArrowLeft className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Back</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={handleForward}>
                  <ArrowRight className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Forward</TooltipContent>
            </Tooltip>
          </>
        )}

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={handleReload}>
              <RotateCw className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Reload</TooltipContent>
        </Tooltip>

        <Input
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleNavigate()}
          placeholder="Enter URL..."
          className="h-7 flex-1 text-xs"
        />

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={handleOpenExternal}>
              <ExternalLink className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Open in browser</TooltipContent>
        </Tooltip>

        {inElectron && (
          <>
            <div className="w-px h-5 bg-border mx-0.5" />

            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={handleZoomOut}>
                  <ZoomOut className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Zoom out</TooltipContent>
            </Tooltip>

            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-1.5 text-xs min-w-[3rem]"
              onClick={handleZoomReset}
            >
              {Math.round(zoom * 100)}%
            </Button>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={handleZoomIn}>
                  <ZoomIn className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Zoom in</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={handleToggleFullscreen}>
                  {fullscreen ? <Minimize className="h-3.5 w-3.5" /> : <Maximize className="h-3.5 w-3.5" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{fullscreen ? 'Exit fullscreen' : 'Fullscreen'}</TooltipContent>
            </Tooltip>
          </>
        )}

        {inElectron && (
          <>
            <div className="w-px h-5 bg-border mx-0.5" />

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={recording ? 'destructive' : 'ghost'}
                  size="sm"
                  className="h-7 gap-1.5"
                  onClick={handleRecordToggle}
                >
                  {recording ? (
                    <>
                      <Square className="h-3 w-3 fill-current" />
                      Stop
                    </>
                  ) : (
                    <>
                      <Circle className="h-3 w-3 fill-current" />
                      Record
                    </>
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{recording ? 'Stop recording' : 'Start recording'}</TooltipContent>
            </Tooltip>

            <WorkflowSelector
              onReplay={handleReplay}
              onDelete={handleDeleteWorkflow}
              fetchWorkflows={handleListWorkflows}
              replayProgress={replayProgress}
            />
          </>
        )}
      </div>

      {/* ── Status bar ── */}
      {(recording || replayProgress) && (
        <div className="flex items-center gap-2 px-3 py-1 bg-muted/50 text-xs border-b">
          {recording && (
            <span className="flex items-center gap-1.5 text-destructive">
              <Circle className="h-2 w-2 fill-current animate-pulse" />
              Recording...
            </span>
          )}
          {replayProgress && (
            <span className="flex items-center gap-1.5 text-muted-foreground">
              Replaying step {replayProgress.current}/{replayProgress.total}
            </span>
          )}
        </div>
      )}

      {/* ── Webview (Electron) or Iframe (Web) ── */}
      <div className="browser-preview-container relative flex-1 overflow-hidden">
        {inElectron ? (
          <>
            <webview
              ref={setWebviewRef as any}
              src="about:blank"
              className="w-full h-full"
              style={{ display: 'inline-flex', width: '100%', height: '100%', position: 'relative', zIndex: 0 }}
            />
            <BrowserQuoteButton webviewRef={webviewRef} zoom={zoom} />
          </>
        ) : (
          <iframe
            ref={iframeRef}
            src={url}
            className="w-full h-full border-0"
            title="Browser Preview"
            sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
          />
        )}

        {!connected && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/80 pointer-events-none">
            <div className="flex flex-col items-center gap-2 text-muted-foreground">
              <Globe className="h-8 w-8" />
              <p className="text-sm">Connecting to browser...</p>
            </div>
          </div>
        )}
      </div>

      {/* ── Workflow save dialog ── */}
      <WorkflowDialog
        open={dialogOpen}
        steps={recordedSteps}
        onSave={handleSaveWorkflow}
        onClose={() => {
          setDialogOpen(false);
          setRecordedSteps([]);
        }}
      />
    </div>
  );
}
