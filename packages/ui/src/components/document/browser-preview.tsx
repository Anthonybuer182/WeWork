import { useState, useRef, useCallback, useEffect } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  ExternalLink,
  Circle,
  Square,
  Globe,
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
  onUrlChanged: (callback: (url: string) => void) => void;
  onRecordingState: (callback: (recording: boolean) => void) => void;
  onReplayProgress: (callback: (progress: { current: number; total: number }) => void) => void;
}

function getBrowserAPI(): BrowserAPI | undefined {
  return (window as unknown as { electronAPI?: { browser?: BrowserAPI } }).electronAPI?.browser;
}

export function BrowserPreview() {
  const webviewRef = useRef<WebviewElement | null>(null);
  const [url, setUrl] = useState('about:blank');
  const [urlInput, setUrlInput] = useState('');
  const [connected, setConnected] = useState(false);
  const [recording, setRecording] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [recordedSteps, setRecordedSteps] = useState<WorkflowStep[]>([]);
  const [replayProgress, setReplayProgress] = useState<{ current: number; total: number } | null>(null);
  const api = getBrowserAPI();

  // ── Connect to CDP when webview is ready ──
  const connectToCDP = useCallback(async () => {
    if (!api || connected) return;
    try {
      const result = await api.connect();
      if (result.connected) {
        setConnected(true);
        console.log('[BrowserPreview] CDP connected');
      } else {
        console.error('[BrowserPreview] CDP connect failed:', result.error);
      }
    } catch (err) {
      console.error('[BrowserPreview] CDP connect error:', err);
    }
  }, [api, connected]);

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

  // ── Handle webview element when it's mounted ──
  const setWebviewRef = useCallback((node: WebviewElement | null) => {
    webviewRef.current = node;
    if (!node) return;

    // Set up navigation listener
    const navListener = () => {
      const currentUrl = node.getURL();
      setUrl(currentUrl);
      setUrlInput(currentUrl);
    };

    node.addEventListener('did-navigate', navListener as EventListener);
    node.addEventListener('did-navigate-in-page', navListener as EventListener);
    node.addEventListener('did-finish-load', navListener as EventListener);

    // Connect to CDP after webview DOM is ready
    const domReadyListener = () => {
      setTimeout(connectToCDP, 300);
    };
    node.addEventListener('dom-ready', domReadyListener as EventListener);

    // Also try connecting immediately (in case dom-ready already fired)
    setTimeout(connectToCDP, 500);
  }, [connectToCDP]);

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
      // Fallback: use webview directly
      await webviewRef.current?.loadURL(targetUrl);
    }
  }, [urlInput, api]);

  // ── Webview controls ──
  const handleBack = () => webviewRef.current?.goBack();
  const handleForward = () => webviewRef.current?.goForward();
  const handleReload = () => webviewRef.current?.reload();
  const handleOpenExternal = () => {
    if (url && url !== 'about:blank') {
      window.open(url, '_blank');
    }
  };

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
    <div className="flex flex-col h-full">
      {/* ── Toolbar ── */}
      <div className="flex items-center gap-1 border-b px-2 py-1.5">
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

      {/* ── Webview ── */}
      <div className="relative flex-1 overflow-hidden">
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <webview
          ref={setWebviewRef as any}
          src="about:blank"
          className="w-full h-full"
          style={{ display: 'inline-flex', width: '100%', height: '100%' }}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          {...({ allowpopups: 'true' } as any)}
        />
        <BrowserQuoteButton webviewRef={webviewRef} />

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
