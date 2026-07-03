import { useState, useEffect, useRef, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSDK } from '@/hooks/use-sdk';
import * as pdfjsLib from 'pdfjs-dist';
import { FileText, Text, Eye, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useUIStore } from '@/stores/ui-store';
import { LoadingSpinner } from '@/components/common/loading-spinner';
import { openWithSystemApp } from '@/lib/utils';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

function PDFPageCanvas({
  pdfDoc,
  pageNum,
  onRendered,
}: {
  pdfDoc: pdfjsLib.PDFDocumentProxy | null;
  pageNum: number;
  onRendered: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<pdfjsLib.RenderTask | null>(null);
  const renderedRef = useRef(false);
  const onRenderedRef = useRef(onRendered);
  onRenderedRef.current = onRendered;

  useEffect(() => {
    if (!pdfDoc || renderedRef.current) return;
    let cancelled = false;

    async function render() {
      const canvas = canvasRef.current;
      if (!canvas) return;
      try {
        const page = await pdfDoc!.getPage(pageNum);
        if (cancelled) return;
        const viewport = page.getViewport({ scale: 1.5 });
        canvas.height = viewport.height;
        canvas.width = viewport.width;
        renderTaskRef.current = page.render({ canvas, viewport });
        await renderTaskRef.current.promise;
        if (!cancelled) {
          renderedRef.current = true;
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
  }, [pdfDoc, pageNum]);

  return (
    <canvas
      ref={canvasRef}
      className="shadow-lg bg-white"
      style={{ maxWidth: '100%', height: 'auto' }}
    />
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
  const [pageLabels, setPageLabels] = useState<string[]>([]);
  const [pageTexts, setPageTexts] = useState<Map<number, string>>(new Map());
  const [extractingPage, setExtractingPage] = useState(false);
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
        setLoading(false);

        // Extract first text line from each page for sidebar labels
        const labels: string[] = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          if (cancelled) break;
          try {
            const page = await pdf.getPage(i);
            const content = await page.getTextContent();
            const firstTextItem = content.items.find(
              (item) => 'str' in item && typeof item.str === 'string' && item.str.trim().length > 0,
            );
            labels.push(firstTextItem ? (firstTextItem as any).str.trim() : '');
          } catch {
            labels.push('');
          }
        }
        if (!cancelled) setPageLabels(labels);
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
  }, [numPages]);

  const scrollToPage = useCallback((pageNum: number) => {
    const el = pageRefs.current.get(pageNum);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

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
          {fileName} ({numPages} pages)
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
        {/* Page sidebar */}
        <div className="w-36 border-r bg-muted/10 overflow-y-auto shrink-0 p-2">
          {Array.from({ length: numPages }, (_, i) => i + 1).map((p) => (
            <button
              key={p}
              onClick={() => scrollToPage(p)}
              className={`w-full text-left p-2 mb-1.5 rounded border text-xs transition-colors ${
                p === activePage
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-transparent hover:bg-muted/30 text-muted-foreground'
              }`}
            >
              <div className="font-medium text-[11px] truncate">
                {p}. {pageLabels[p - 1] || `Page ${p}`}
              </div>
            </button>
          ))}
        </div>

        {/* Pages stacked vertically */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto bg-muted/20 p-4">
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
            <div className="flex flex-col items-center gap-6 pb-8">
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
                      className="bg-white shadow-lg flex items-center justify-center"
                      style={{ width: 600, height: 800 }}
                    >
                      <div className="animate-spin rounded-full h-6 w-6 border-2 border-primary border-t-transparent" />
                    </div>
                  )}
                  <PDFPageCanvas
                    pdfDoc={pdfDocRef.current}
                    pageNum={pageNum}
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
