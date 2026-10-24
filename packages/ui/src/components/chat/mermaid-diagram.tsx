import { useLayoutEffect, useRef, useState, useCallback } from 'react';
import { Copy, Check, Maximize2, Minimize2, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/i18n';

interface MermaidDiagramProps {
  source: string;
  isStreaming?: boolean;
}

let initDone = false;
const svgCache = new Map<string, string>();

export function MermaidDiagram({ source, isStreaming }: MermaidDiagramProps) {
  const svgContainerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const renderIdRef = useRef(0);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(source);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = source;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [source]);

  useLayoutEffect(() => {
    if (isStreaming) return;
    const trimmed = source.trim();
    if (!trimmed) return;

    // Increment render ID to cancel any pending render
    renderIdRef.current += 1;
    const currentRenderId = renderIdRef.current;

    const container = svgContainerRef.current;
    if (!container) return;

    // Check cache first — if we've rendered this source before, insert synchronously
    const cachedSvg = svgCache.get(trimmed);
    if (cachedSvg) {
      container.replaceChildren();
      const wrapper = document.createElement('div');
      wrapper.innerHTML = cachedSvg;
      container.appendChild(wrapper);
      return;
    }

    // Show loading indicator
    container.replaceChildren();
    const loadingEl = document.createElement('div');
    loadingEl.textContent = 'Loading diagram...';
    loadingEl.className = 'animate-pulse text-muted-foreground py-4';
    container.appendChild(loadingEl);

    // Track the source we're rendering to detect if it changes mid-render
    const sourceToRender = trimmed;

    (async () => {
      try {
        const mermaid = await import('mermaid');

        // Check if this render is still valid
        if (currentRenderId !== renderIdRef.current) return;

        if (!initDone) {
          const isDark = document.documentElement.classList.contains('dark');
          mermaid.default.initialize({
            startOnLoad: false,
            theme: isDark ? 'dark' : 'default',
            securityLevel: 'loose',
          });
          initDone = true;
        }

        const { svg: renderedSvg } = await mermaid.default.render(
          'mermaid-' + Math.random().toString(36).slice(2),
          sourceToRender,
        );

        // Check if this render is still valid
        if (currentRenderId !== renderIdRef.current) return;

        // Get fresh reference to container (it may have been recreated)
        const el = svgContainerRef.current;
        if (!el || !el.isConnected) return;

        // Insert the rendered SVG
        el.replaceChildren();
        const wrapper = document.createElement('div');
        wrapper.innerHTML = renderedSvg;
        el.appendChild(wrapper);
        svgCache.set(sourceToRender, renderedSvg);
        setError(null);
      } catch (err) {
        if (currentRenderId !== renderIdRef.current) return;
        const message = err instanceof Error ? err.message : t('未知错误');
        setError(message);
      }
    })();

    return () => {
      // Bump the render ID to cancel the pending async work
      renderIdRef.current += 1;
    };
  }, [source, isStreaming]);

  // Streaming state: show code block with a "rendering..." hint
  if (isStreaming) {
    return (
      <div className="group relative my-2">
        <div className="flex items-center justify-between px-3 py-1.5 bg-muted/60 border border-border rounded-t-md border-b-0">
          <span className="flex items-center gap-2 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
            mermaid
            <span className="text-[10px] font-normal italic normal-case tracking-normal text-muted-foreground">
              rendering...
            </span>
          </span>
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors opacity-0 group-hover:opacity-100"
          >
            {copied ? (
              <>
                <Check className="h-3 w-3" />
                {t('已复制！')}
              </>
            ) : (
              <>
                <Copy className="h-3 w-3" />
                Copy
              </>
            )}
          </button>
        </div>
        <pre className="!mt-0 !rounded-t-none overflow-auto max-h-96">
          <code>{source}</code>
        </pre>
      </div>
    );
  }

  // Error state: show error + original code
  if (error) {
    return (
      <div className="group relative my-2">
        <div className="flex items-center justify-between px-3 py-1.5 bg-muted/60 border border-border rounded-t-md border-b-0">
          <span className="flex items-center gap-2 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
            mermaid
            <span className="flex items-center gap-1 text-[10px] font-normal italic normal-case tracking-normal text-red-500">
              <AlertTriangle className="h-3 w-3" />
              {t('渲染失败')}
            </span>
          </span>
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors opacity-0 group-hover:opacity-100"
          >
            {copied ? (
              <>
                <Check className="h-3 w-3" />
                {t('已复制！')}
              </>
            ) : (
              <>
                <Copy className="h-3 w-3" />
                Copy
              </>
            )}
          </button>
        </div>
        <div className="px-3 py-1.5 bg-red-50 dark:bg-red-950/30 border-x border-border text-[11px] text-red-600 dark:text-red-400 font-mono whitespace-pre-wrap">
          {error}
        </div>
        <pre className="!mt-0 !rounded-t-none overflow-auto max-h-96">
          <code>{source}</code>
        </pre>
      </div>
    );
  }

  return (
    <div className="group relative my-2">
      <div className="flex items-center justify-between px-3 py-1.5 bg-muted/60 border border-border rounded-t-md border-b-0">
        <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
          mermaid
        </span>
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={() => setZoomed(!zoomed)}
            className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
            aria-label={zoomed ? t('缩小') : t('放大')}
          >
            {zoomed ? (
              <Minimize2 className="h-3 w-3" />
            ) : (
              <Maximize2 className="h-3 w-3" />
            )}
          </button>
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
            aria-label={copied ? t('已复制') : t('复制源码')}
          >
            {copied ? (
              <>
                <Check className="h-3 w-3" />
                {t('已复制！')}
              </>
            ) : (
              <>
                <Copy className="h-3 w-3" />
                Copy
              </>
            )}
          </button>
        </div>
      </div>
      <div
        className={cn(
          'border border-border border-t-0 rounded-b-md bg-background flex items-center justify-center p-4 overflow-auto',
          zoomed ? 'max-h-none' : 'max-h-96',
        )}
      >
        <div
          ref={svgContainerRef}
          className="flex items-center justify-center"
        />
      </div>
    </div>
  );
}
