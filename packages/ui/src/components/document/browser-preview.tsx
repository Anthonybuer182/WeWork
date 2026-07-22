import { useState, useRef, useCallback, useEffect } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  ExternalLink,
  Globe,
  ZoomIn,
  ZoomOut,
  Maximize,
  Minimize,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/** Minimal electronAPI interface for browser operations. */
interface BrowserAPI {
  connect: () => Promise<{ connected: boolean; error?: string }>;
  navigate: (url: string) => Promise<{ url: string; title: string }>;
  getUrl: () => Promise<{ url: string; title: string }>;
  screenshot: () => Promise<{ base64: string }>;
  setViewport: (width: number, height: number) => Promise<void>;
  setZoom: (factor: number) => Promise<{ zoom: number }>;
  resetZoom: () => Promise<{ zoom: number }>;
  getZoom: () => Promise<{ zoom: number }>;
  setBounds: (x: number, y: number, width: number, height: number) => Promise<void>;
  getBounds: () => Promise<{ x: number; y: number; width: number; height: number }>;
  executeJavaScript: (code: string) => Promise<{ result: unknown }>;
  goBack: () => Promise<void>;
  goForward: () => Promise<void>;
  reload: () => Promise<void>;
  loadURL: (url: string) => Promise<void>;
  hide: () => Promise<void>;
  onUrlChanged: (callback: (url: string) => void) => void;
  onSwitchToBrowserTab: (callback: () => void) => void;
}

function getBrowserAPI(): BrowserAPI | undefined {
  return (window as unknown as { electronAPI?: { browser?: BrowserAPI } }).electronAPI?.browser;
}

/** Detect if running inside Electron. */
function isElectron(): boolean {
  return typeof (window as unknown as { electronAPI?: unknown }).electronAPI !== 'undefined';
}

export function BrowserPreview() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [url, setUrl] = useState('about:blank');
  const [urlInput, setUrlInput] = useState('');
  const [connected, setConnected] = useState(false);
  const [zoom, setZoomState] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const api = getBrowserAPI();
  const inElectron = isElectron();

  // ── Report placeholder bounds to main process for BrowserView positioning ──
  // The ResizeObserver reports the placeholder div's viewport-relative rect to
  // the main process, which calls BrowserView.setBounds() to overlay the native
  // BrowserView window on top. When the tab is hidden (display:none), the rect
  // becomes 0x0 and the BrowserView effectively disappears.
  const boundsRef = useRef({ x: 0, y: 0, width: 0, height: 0 });
  const sendBoundsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reportBounds = useCallback(() => {
    // Re-read API each call to handle preload race — api may be undefined
    // at mount time but become available later.
    const currentApi = getBrowserAPI();
    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const x = Math.round(rect.x + window.scrollX);
    const y = Math.round(rect.y + window.scrollY);
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);

    // Skip if no change
    const b = boundsRef.current;
    if (b.x === x && b.y === y && b.width === w && b.height === h) return;
    boundsRef.current = { x, y, width: w, height: h };

    console.log('[BrowserPreview] Reporting bounds:', { x, y, w, h });

    if (!currentApi) return;

    // Also sync viewport for auto-zoom
    if (w > 0 && h > 0) {
      currentApi.setViewport(w, h).catch(() => {});
    }

    currentApi.setBounds(x, y, w, h).catch((err) => {
      console.warn('[BrowserPreview] setBounds failed:', err);
    });
  }, []);

  useEffect(() => {
    if (!inElectron) return;
    console.log('[BrowserPreview] Setting up ResizeObserver');

    // Use requestAnimationFrame to ensure DOM is laid out before observing
    const rafId = requestAnimationFrame(() => {
      const container = containerRef.current;
      if (!container) {
        console.warn('[BrowserPreview] containerRef not available');
        return;
      }

      const resizeObserver = new ResizeObserver(() => {
        if (sendBoundsTimer.current) clearTimeout(sendBoundsTimer.current);
        sendBoundsTimer.current = setTimeout(reportBounds, 50);
      });
      resizeObserver.observe(container);

      // Also observe the parent container for when the tab container resizes
      const parentContainer = document.querySelector('.browser-preview-container');
      const parentObserver = new ResizeObserver(() => {
        if (sendBoundsTimer.current) clearTimeout(sendBoundsTimer.current);
        sendBoundsTimer.current = setTimeout(reportBounds, 50);
      });
      if (parentContainer) parentObserver.observe(parentContainer);
      else console.warn('[BrowserPreview] parentContainer not found');

      // Initial bounds report
      setTimeout(reportBounds, 100);

      // Store on ref for cleanup
      cleanupRef.current = () => {
        resizeObserver.disconnect();
        parentObserver.disconnect();
      };
    });

    return () => {
      cancelAnimationFrame(rafId);
      if (sendBoundsTimer.current) clearTimeout(sendBoundsTimer.current);
      cleanupRef.current?.();
      // Hide BrowserView when component unmounts
      getBrowserAPI()?.hide().catch(() => {});
    };
  }, [inElectron, reportBounds]);

  // Store cleanup fn since ResizeObserver can't be captured in closure
  const cleanupRef = useRef<(() => void) | null>(null);

  // Also report bounds when fullscreen toggles
  useEffect(() => {
    if (!inElectron) return;
    // Wait for CSS transition / layout reflow
    const timer = setTimeout(reportBounds, 200);
    return () => clearTimeout(timer);
  }, [fullscreen, inElectron, reportBounds]);

  // ── Track connected state in a ref to break callback dependency chain ──
  const connectedRef = useRef(false);
  const connectRetryCountRef = useRef(0);
  const MAX_CONNECT_RETRIES = 5;

  // ── Connect to CDP (simplified: just calls api.connect() once) ──
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

  // ── Listen for URL changes from BrowserManager ──
  useEffect(() => {
    if (!api) return;

    const handleUrlChanged = (newUrl: string) => {
      setUrl(newUrl);
      setUrlInput(newUrl);
    };

    api.onUrlChanged(handleUrlChanged);
  }, [api]);

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
    } else {
      // Web mode: navigate iframe
      setUrl(targetUrl);
      if (iframeRef.current) {
        iframeRef.current.src = targetUrl;
      }
    }
  }, [urlInput, api]);

  // ── Browser controls via IPC ──
  const handleBack = useCallback(() => {
    api?.goBack().catch((err) => console.warn('goBack failed:', err));
  }, [api]);

  const handleForward = useCallback(() => {
    api?.goForward().catch((err) => console.warn('goForward failed:', err));
  }, [api]);

  const handleReload = useCallback(() => {
    if (api) {
      api.reload().catch(() => {});
    } else if (iframeRef.current) {
      iframeRef.current.src = iframeRef.current.src;
    }
  }, [api]);

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
      </div>

      {/* ── Placeholder div for BrowserView bounds (Electron) or Iframe (Web) ── */}
      <div className="browser-preview-container relative flex-1 overflow-hidden">
        {inElectron ? (
          <div ref={containerRef} className="w-full h-full" />
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
    </div>
  );
}
