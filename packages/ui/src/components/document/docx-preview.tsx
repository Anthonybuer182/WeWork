import { useState, useCallback, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSDK } from '@/hooks/use-sdk';
import { useUIStore } from '@/stores/ui-store';
import { Eye, FileText, AlignLeft, ExternalLink, ZoomIn, ZoomOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LoadingSpinner } from '@/components/common/loading-spinner';
import { openWithSystemApp } from '@/lib/utils';
import { renderAsync } from 'docx-preview';

interface TocEntry {
  id: string;
  level: number;
  text: string;
}

export function DocxPreview() {
  const sdk = useSDK();
  const activeWorkspaceId = useUIStore((s) => s.activeWorkspaceId);
  const activePreviewFilePath = useUIStore((s) => s.activePreviewFilePath);
  const [mode, setMode] = useState<'preview' | 'text'>('preview');
  const [activeHeadingId, setActiveHeadingId] = useState<string | null>(null);
  const [headings, setHeadings] = useState<TocEntry[]>([]);
  const [textContent, setTextContent] = useState('');
  const [rendering, setRendering] = useState(true);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const renderedRef = useRef(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ['office', activeWorkspaceId, activePreviewFilePath],
    queryFn: () => sdk.file.readOffice(activeWorkspaceId!, activePreviewFilePath!),
    enabled: !!activeWorkspaceId && !!activePreviewFilePath && activePreviewFilePath.endsWith('.docx'),
  });

  // Render DOCX using docx-preview
  useEffect(() => {
    if (!data || data.doc.type !== 'docx' || !containerRef.current) return;
    if (renderedRef.current) return;

    const docxData = data.doc.data;
    let cancelled = false;
    setRendering(true);
    setRenderError(null);

    let headingObserver: IntersectionObserver | undefined;

    async function renderDocx() {
      try {
        const base64Data = docxData;
        // Decode base64 to binary string then to Uint8Array
        const binaryStr = atob(base64Data);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
        const blob = new Blob([bytes], {
          type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        });

        // Clear container
        if (containerRef.current) {
          containerRef.current.innerHTML = '';
        }

        await renderAsync(blob, containerRef.current!, undefined, {
          className: 'docx-container',
          inWrapper: true,
          ignoreWidth: false,
          ignoreHeight: false,
          breakPages: true,
          experimental: true,
          useBase64URL: true,
        });

        if (cancelled) return;

        // Extract headings from rendered DOM
        const extractedHeadings: TocEntry[] = [];
        const headingSelector = 'h1, h2, h3, h4, h5, h6';
        const headingElements = containerRef.current?.querySelectorAll(headingSelector);
        headingElements?.forEach((el, idx) => {
          const level = parseInt(el.tagName[1]);
          const text = el.textContent?.trim() ?? '';
          if (text) {
            const id = `docx-h-${idx}`;
            el.id = id;
            extractedHeadings.push({ id, level, text });
          }
        });
        setHeadings(extractedHeadings);

        // Extract text content for text mode - preserve paragraph breaks
        const paragraphs = containerRef.current?.querySelectorAll('p, h1, h2, h3, h4, h5, h6, div.docx-pagebreak, table');
        let text = '';
        paragraphs?.forEach((el) => {
          const t = el.textContent?.trim();
          if (t) text += t + '\n';
        });
        setTextContent(text || containerRef.current?.textContent?.trim() || '');

        // Set up intersection observer for active heading tracking
        if (extractedHeadings.length > 0 && scrollContainerRef.current) {
          headingObserver = new IntersectionObserver(
            (entries) => {
              let best: { id: string; ratio: number } | null = null;
              for (const entry of entries) {
                if (entry.isIntersecting && (!best || entry.intersectionRatio > best.ratio)) {
                  best = { id: (entry.target as HTMLElement).id, ratio: entry.intersectionRatio };
                }
              }
              if (best) {
                setActiveHeadingId(best.id);
              }
            },
            { root: scrollContainerRef.current, threshold: [0, 0.25, 0.5, 0.75, 1] },
          );
          extractedHeadings.forEach((h) => {
            const el = containerRef.current?.querySelector(`#${h.id}`);
            if (el) headingObserver!.observe(el);
          });
        }

        renderedRef.current = true;
        setRendering(false);
      } catch (err) {
        if (cancelled) return;
        console.error('DOCX render error:', err);
        setRenderError(err instanceof Error ? err.message : 'Failed to render document');
        setRendering(false);
      }
    }

    renderDocx();

    return () => {
      cancelled = true;
      headingObserver?.disconnect();
    };
  }, [data]);

  // Reset rendered flag when file changes
  useEffect(() => {
    renderedRef.current = false;
    setHeadings([]);
    setTextContent('');
    setActiveHeadingId(null);
  }, [activePreviewFilePath]);

  const scrollToHeading = useCallback((headingId: string) => {
    const el = containerRef.current?.querySelector(`#${headingId}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  if (!activePreviewFilePath) return null;
  if (isLoading) return <LoadingSpinner message="Loading document..." />;

  const fileName = activePreviewFilePath.split(/[/\\]/).pop() ?? 'Document.docx';

  if (error || !data || data.doc.type !== 'docx') {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        <div className="flex flex-col items-center gap-2">
          <FileText className="h-8 w-8" />
          <span>{error ? 'Failed to load document' : 'Unsupported document'}</span>
        </div>
      </div>
    );
  }

  if (renderError) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        <div className="flex flex-col items-center gap-2">
          <FileText className="h-8 w-8 text-destructive" />
          <span className="text-destructive">{renderError}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-2 border-b bg-muted/30 shrink-0">
        <span className="text-xs text-muted-foreground truncate flex-1 mr-2">
          {fileName}
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant={mode === 'preview' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setMode('preview')}
            className="h-7 text-xs gap-1.5"
          >
            <Eye className="h-3 w-3" />
            Preview
          </Button>
          <Button
            variant={mode === 'text' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setMode('text')}
            className="h-7 text-xs gap-1.5"
          >
            <AlignLeft className="h-3 w-3" />
            Text
          </Button>
          {mode === 'preview' && (
            <>
              <div className="w-px h-5 bg-border mx-1" />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}
                className="h-7 w-7 p-0"
                title="Zoom out"
              >
                <ZoomOut className="h-3 w-3" />
              </Button>
              <span className="text-xs text-muted-foreground tabular-nums w-10 text-center">
                {Math.round(zoom * 100)}%
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setZoom((z) => Math.min(3, z + 0.25))}
                className="h-7 w-7 p-0"
                title="Zoom in"
              >
                <ZoomIn className="h-3 w-3" />
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => openWithSystemApp(activePreviewFilePath!, activeWorkspaceId!)}
            className="h-7 text-xs gap-1.5"
            title="Open with system app"
          >
            <ExternalLink className="h-3 w-3" />
          </Button>
        </div>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* TOC sidebar */}
        {mode === 'preview' && headings.length > 0 && (
          <div className="w-44 border-r bg-muted/10 overflow-y-auto shrink-0 p-2">
            <div className="text-[11px] font-medium text-muted-foreground mb-2 px-1">
              Contents
            </div>
            {headings.map((h) => (
              <button
                key={h.id}
                onClick={() => scrollToHeading(h.id)}
                className={`w-full text-left py-1 px-2 mb-0.5 rounded text-xs transition-colors ${
                  h.id === activeHeadingId
                    ? 'bg-primary/10 text-primary font-medium'
                    : 'text-muted-foreground hover:bg-muted/30'
                }`}
                style={{ paddingLeft: `${4 + (h.level - 1) * 10}px` }}
              >
                <span className="line-clamp-1">{h.text}</span>
              </button>
            ))}
          </div>
        )}

        {/* Content */}
        <div ref={scrollContainerRef} className="flex-1 overflow-auto bg-neutral-200 dark:bg-neutral-800 p-4">
          {mode === 'preview' ? (
            <div className="flex justify-center relative">
              <div
                ref={containerRef}
                className="docx-container mx-auto"
                style={{ minHeight: '100%', zoom }}
              />
              {rendering && (
                <div className="absolute inset-0 flex items-center justify-center bg-white/50">
                  <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
                </div>
              )}
            </div>
          ) : (
            <div className="max-w-3xl mx-auto bg-white shadow-sm rounded-lg p-6">
              <pre className="text-sm whitespace-pre-wrap font-sans text-foreground leading-relaxed">
                {textContent || 'No text content.'}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
