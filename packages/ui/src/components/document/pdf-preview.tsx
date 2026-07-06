import { useState, useEffect, useRef, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSDK } from '@/hooks/use-sdk';
import * as pdfjsLib from 'pdfjs-dist';
import { FileText, Text, Eye, ExternalLink, ZoomIn, ZoomOut, Maximize2, Quote as QuoteIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useUIStore } from '@/stores/ui-store';
import { useComposerStore } from '@/stores/composer-store';
import { createQuote } from '@/lib/quote-helpers';
import { LoadingSpinner } from '@/components/common/loading-spinner';
import { openWithSystemApp } from '@/lib/utils';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

const SCALE_LEVELS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0];

function PDFPageCanvas({
  pdfDoc,
  pageNum,
  scale,
  onRendered,
}: {
  pdfDoc: pdfjsLib.PDFDocumentProxy | null;
  pageNum: number;
  scale: number;
  onRendered: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<pdfjsLib.RenderTask | null>(null);
  const onRenderedRef = useRef(onRendered);
  onRenderedRef.current = onRendered;

  useEffect(() => {
    if (!pdfDoc) return;
    let cancelled = false;

    async function render() {
      const canvas = canvasRef.current;
      if (!canvas) return;
      try {
        const page = await pdfDoc!.getPage(pageNum);
        if (cancelled) return;
        const viewport = page.getViewport({ scale });
        canvas.height = viewport.height;
        canvas.width = viewport.width;
        renderTaskRef.current = page.render({ canvas, viewport });
        await renderTaskRef.current.promise;
        if (!cancelled) {
          onRenderedRef.current();
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'RenderingCancelledException') return;
        console.error(`Failed to render page ${pageNum}:`, err);
      }
    }

    render();
    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
    };
  }, [pdfDoc, pageNum, scale]);

  return (
    <canvas
      ref={canvasRef}
      className="shadow-xl bg-white rounded-sm"
      style={{ maxWidth: '100%', height: 'auto' }}
    />
  );
}

function PDFThumbnail({
  pdfDoc,
  pageNum,
  isActive,
  onClick,
}: {
  pdfDoc: pdfjsLib.PDFDocumentProxy | null;
  pageNum: number;
  isActive: boolean;
  onClick: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<pdfjsLib.RenderTask | null>(null);
  const [rendered, setRendered] = useState(false);
  const containerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!pdfDoc || rendered) return;
    let cancelled = false;

    async function renderThumbnail() {
      const canvas = canvasRef.current;
      if (!canvas) return;
      try {
        const page = await pdfDoc!.getPage(pageNum);
        if (cancelled) return;
        const viewport = page.getViewport({ scale: 0.2 });
        canvas.height = viewport.height;
        canvas.width = viewport.width;
        renderTaskRef.current = page.render({ canvas, viewport });
        await renderTaskRef.current.promise;
        if (!cancelled) setRendered(true);
      } catch (err) {
        if (err instanceof Error && err.name === 'RenderingCancelledException') return;
        console.error(`Failed to render thumbnail ${pageNum}:`, err);
      }
    }

    // Lazy load: only render when visible
    const container = containerRef.current;
    if (!container) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          renderThumbnail();
          observer.disconnect();
        }
      },
      { threshold: 0.1 },
    );
    observer.observe(container);

    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
      observer.disconnect();
    };
  }, [pdfDoc, pageNum, rendered]);

  return (
    <button
      ref={containerRef}
      onClick={onClick}
      className={`w-full text-left p-1.5 mb-1.5 rounded border-2 transition-all ${
        isActive
          ? 'border-primary bg-primary/10'
          : 'border-transparent hover:border-border hover:bg-muted/30'
      }`}
    >
      <div className="bg-white rounded-sm overflow-hidden flex items-center justify-center" style={{ minHeight: 60 }}>
        <canvas ref={canvasRef} className="max-w-full" style={{ height: 'auto' }} />
        {!rendered && (
          <div className="flex items-center justify-center h-[60px] w-full">
            <div className="animate-spin rounded-full h-4 w-4 border-2 border-primary border-t-transparent" />
          </div>
        )}
      </div>
      <div className="text-[10px] text-muted-foreground text-center mt-1 truncate">
        {pageNum}
      </div>
    </button>
  );
}

export function PDFPreview() {
  const sdk = useSDK();
  const activeWorkspaceId = useUIStore((s) => s.activeWorkspaceId);
  const activePreviewFilePath = useUIStore((s) => s.activePreviewFilePath);

  const { data: file, isLoading: isFileLoading } = useQuery({
    queryKey: ['file', activeWorkspaceId, activePreviewFilePath],
    queryFn: () => sdk.file.read(activeWorkspaceId!, activePreviewFilePath!),
    enabled: !!activeWorkspaceId && !!activePreviewFilePath && activePreviewFilePath.endsWith('.pdf'),
  });

  const [numPages, setNumPages] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'preview' | 'text'>('preview');
  const [renderedPages, setRenderedPages] = useState<Set<number>>(new Set());
  const [activePage, setActivePage] = useState(1);
  const [pageTexts, setPageTexts] = useState<Map<number, string>>(new Map());
  const [extractingPage, setExtractingPage] = useState(false);
  const [scale, setScale] = useState(1.5);
  const pdfDocRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  useEffect(() => {
    let cancelled = false;
    async function loadPDF() {
      if (!file?.content) return;
      setLoading(true);
      setError(null);
      try {
        let pdfData: ArrayBuffer;
        if (file.encoding === 'base64') {
          const binaryStr = atob(file.content);
          const bytes = new Uint8Array(binaryStr.length);
          for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
          pdfData = bytes.buffer;
        } else {
          pdfData = new ArrayBuffer(0);
        }
        const pdf = await pdfjsLib.getDocument({ data: pdfData }).promise;
        if (cancelled) return;
        pdfDocRef.current = pdf;
        setNumPages(pdf.numPages);
        setRenderedPages(new Set());
        setPageTexts(new Map());
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load PDF');
        setLoading(false);
      }
    }
    loadPDF();
    return () => { cancelled = true; };
  }, [file]);

  const handlePageRendered = useCallback((pageNum: number) => {
    setRenderedPages((prev) => {
      if (prev.has(pageNum)) return prev;
      const next = new Set(prev);
      next.add(pageNum);
      return next;
    });
  }, []);

  // IntersectionObserver for scroll-sync
  useEffect(() => {
    const container = scrollRef.current;
    if (!container || numPages === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        let best: { page: number; ratio: number } = { page: -1, ratio: 0 };
        for (const entry of entries) {
          if (entry.isIntersecting && entry.intersectionRatio > best.ratio) {
            const page = Number((entry.target as HTMLElement).dataset.pageNum);
            if (!isNaN(page)) {
              best = { page, ratio: entry.intersectionRatio };
            }
          }
        }
        if (best.page >= 0) setActivePage(best.page);
      },
      { root: container, threshold: [0, 0.1, 0.25, 0.5, 0.75, 1] },
    );

    pageRefs.current.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [numPages, scale]);

  const scrollToPage = useCallback((pageNum: number) => {
    const el = pageRefs.current.get(pageNum);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  // Zoom controls
  const zoomIn = useCallback(() => {
    setScale((s) => {
      const next = SCALE_LEVELS.find((l) => l > s + 0.01);
      return next ?? s;
    });
  }, []);

  const zoomOut = useCallback(() => {
    setScale((s) => {
      const prev = [...SCALE_LEVELS].reverse().find((l) => l < s - 0.01);
      return prev ?? s;
    });
  }, []);

  const fitWidth = useCallback(async () => {
    if (!pdfDocRef.current || !scrollRef.current) {
      setScale(1.0);
      return;
    }
    try {
      const page = await pdfDocRef.current.getPage(1);
      const viewport = page.getViewport({ scale: 1.0 });
      const containerWidth = scrollRef.current.clientWidth - 32; // subtract padding (p-4 = 16px each side)
      const newScale = Math.max(0.5, Math.min(3.0, containerWidth / viewport.width));
      setScale(newScale);
    } catch {
      setScale(1.0);
    }
  }, []);

  const addQuote = useComposerStore((s) => s.addQuote);

  const handleQuotePage = useCallback(async () => {
    if (!activePreviewFilePath || !pdfDocRef.current) return;
    let text = pageTexts.get(activePage);
    if (!text) {
      try {
        const page = await pdfDocRef.current.getPage(activePage);
        const content = await page.getTextContent();
        text = content.items.map((item) => 'str' in item ? item.str : '').join(' ').trim();
      } catch {
        text = '';
      }
    }
    if (text) addQuote(createQuote(text, activePreviewFilePath, 'pdf-canvas', { pageNumber: activePage }));
  }, [activePage, activePreviewFilePath, pageTexts, addQuote]);

  // Keyboard navigation
  useEffect(() => {
    if (mode !== 'preview' || loading) return;
    const handler = (e: KeyboardEvent) => {
      // Check if we're not in an input field
      const target = e.target as HTMLElement;
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable) return;

      if (e.key === 'ArrowDown' || e.key === 'PageDown') {
        e.preventDefault();
        const next = Math.min(activePage + 1, numPages);
        if (next !== activePage) scrollToPage(next);
      } else if (e.key === 'ArrowUp' || e.key === 'PageUp') {
        e.preventDefault();
        const prev = Math.max(activePage - 1, 1);
        if (prev !== activePage) scrollToPage(prev);
      } else if (e.key === 'Home') {
        e.preventDefault();
        scrollToPage(1);
      } else if (e.key === 'End') {
        e.preventDefault();
        scrollToPage(numPages);
      } else if ((e.ctrlKey || e.metaKey) && (e.key === '+' || e.key === '=')) {
        e.preventDefault();
        zoomIn();
      } else if ((e.ctrlKey || e.metaKey) && e.key === '-') {
        e.preventDefault();
        zoomOut();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [mode, loading, activePage, numPages, scrollToPage, zoomIn, zoomOut]);

  // Ctrl/Cmd + wheel zoom
  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      if (e.deltaY < 0) zoomIn();
      else zoomOut();
    }
  }, [zoomIn, zoomOut]);

  // Auto-extract all pages' text when switching to Text mode
  useEffect(() => {
    if (mode !== 'text' || !pdfDocRef.current || pageTexts.size > 0) return;
    let cancelled = false;
    async function extract() {
      setExtractingPage(true);
      const texts = new Map<number, string>();
      for (let i = 1; i <= numPages; i++) {
        if (cancelled) break;
        try {
          const page = await pdfDocRef.current!.getPage(i);
          const content = await page.getTextContent();
          const pageText = content.items
            .map((item) => ('str' in item ? item.str : ''))
            .join(' ');
          texts.set(i, pageText.trim());
        } catch {
          texts.set(i, '');
        }
      }
      if (!cancelled) {
        setPageTexts(texts);
        setExtractingPage(false);
      }
    }
    extract();
    return () => {
      cancelled = true;
    };
  }, [mode, numPages, pageTexts.size]);

  if (!activePreviewFilePath) return null;
  if (isFileLoading) return <LoadingSpinner message="Loading PDF..." />;

  const fileName = activePreviewFilePath.split(/[/\\]/).pop() ?? 'PDF Document';

  if (error) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-muted-foreground p-8">
          <FileText className="h-12 w-12 text-destructive" />
          <p className="text-sm font-medium">Failed to load PDF</p>
          <p className="text-xs text-destructive text-center">{error}</p>
        </div>
      </div>
    );
  }

  if (!loading && numPages === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <FileText className="h-12 w-12" />
          <p className="text-sm font-medium">PDF Preview</p>
          <p className="text-xs">{fileName}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 border-b bg-muted/30 shrink-0">
        <span className="text-xs text-muted-foreground truncate flex-1 mr-2">
          {fileName}
        </span>
        <div className="flex items-center gap-1">
          {mode === 'preview' && (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={zoomOut}
                disabled={scale <= SCALE_LEVELS[0]}
                className="h-7 w-7 p-0"
                title="Zoom out (Ctrl+-)"
              >
                <ZoomOut className="h-3 w-3" />
              </Button>
              <span className="text-xs text-muted-foreground w-12 text-center tabular-nums">
                {Math.round(scale * 100)}%
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={zoomIn}
                disabled={scale >= SCALE_LEVELS[SCALE_LEVELS.length - 1]}
                className="h-7 w-7 p-0"
                title="Zoom in (Ctrl++)"
              >
                <ZoomIn className="h-3 w-3" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={fitWidth}
                className="h-7 w-7 p-0"
                title="Fit width"
              >
                <Maximize2 className="h-3 w-3" />
              </Button>
              <Button variant="ghost" size="sm" onClick={handleQuotePage} className="h-7 text-xs gap-1.5" title="Quote this page to chat">
                <QuoteIcon className="h-3 w-3" />
                Quote Page
              </Button>
              <div className="w-px h-4 bg-border mx-1" />
              <span className="text-xs text-muted-foreground mr-2 tabular-nums">
                {activePage} / {numPages}
              </span>
            </>
          )}
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
            <Text className="h-3 w-3" />
            Text
          </Button>
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

      {/* Main: page sidebar + content */}
      <div className="flex flex-1 min-h-0">
        {/* Page sidebar with thumbnails */}
        {mode === 'preview' && (
          <div className="w-32 border-r bg-muted/10 overflow-y-auto shrink-0 p-2">
            {Array.from({ length: numPages }, (_, i) => i + 1).map((p) => (
              <PDFThumbnail
                key={p}
                pdfDoc={pdfDocRef.current}
                pageNum={p}
                isActive={p === activePage}
                onClick={() => scrollToPage(p)}
              />
            ))}
          </div>
        )}

        {/* Pages stacked vertically */}
        <div ref={scrollRef} onWheel={handleWheel} className="flex-1 overflow-y-auto bg-neutral-200 dark:bg-neutral-800 p-4">
          {loading || extractingPage ? (
            <div className="flex items-center justify-center h-full">
              <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
            </div>
          ) : mode === 'text' ? (
            /* Text mode: selectable text blocks per page */
            <div className="flex flex-col items-center gap-6 pb-8">
              {Array.from({ length: numPages }, (_, i) => i + 1).map((pageNum) => (
                <div
                  key={pageNum}
                  data-page-num={pageNum}
                  ref={(el) => {
                    if (el) pageRefs.current.set(pageNum, el);
                    else pageRefs.current.delete(pageNum);
                  }}
                  className="flex flex-col items-center max-w-3xl w-full"
                >
                  <div className="text-xs text-muted-foreground mb-2">
                    Page {pageNum} of {numPages}
                  </div>
                  <div className="bg-white shadow-sm rounded-lg p-6 w-full">
                    <p className="text-sm leading-relaxed whitespace-pre-wrap select-text cursor-text">
                      {pageTexts.get(pageNum) || 'No text content on this page.'}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            /* Preview mode: canvas rendering */
            <div className="flex flex-col items-center gap-8 pb-8">
              {Array.from({ length: numPages }, (_, i) => i + 1).map((pageNum) => (
                <div
                  key={pageNum}
                  data-page-num={pageNum}
                  ref={(el) => {
                    if (el) pageRefs.current.set(pageNum, el);
                    else pageRefs.current.delete(pageNum);
                  }}
                  className="flex flex-col items-center"
                >
                  <div className="text-xs text-muted-foreground mb-2">
                    Page {pageNum} of {numPages}
                  </div>
                  {!renderedPages.has(pageNum) && (
                    <div
                      className="bg-white shadow-xl flex items-center justify-center rounded-sm"
                      style={{ width: 600, height: 800 }}
                    >
                      <div className="animate-spin rounded-full h-6 w-6 border-2 border-primary border-t-transparent" />
                    </div>
                  )}
                  <PDFPageCanvas
                    pdfDoc={pdfDocRef.current}
                    pageNum={pageNum}
                    scale={scale}
                    onRendered={() => handlePageRendered(pageNum)}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
