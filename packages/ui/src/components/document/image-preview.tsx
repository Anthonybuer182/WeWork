import { useState, useCallback, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSDK } from '@/hooks/use-sdk';
import { useUIStore } from '@/stores/ui-store';
import { LoadingSpinner } from '@/components/common/loading-spinner';
import { Image as ImageIcon, ExternalLink, ZoomIn, ZoomOut, Maximize2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { openWithSystemApp } from '@/lib/utils';

const IMAGE_EXTENSIONS = /\.(png|jpg|jpeg|gif|svg|webp|bmp|ico|avif)$/i;

const SCALE_LEVELS = [0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0];

export function ImagePreview() {
  const sdk = useSDK();
  const activeWorkspaceId = useUIStore((s) => s.activeWorkspaceId);
  const activePreviewFilePath = useUIStore((s) => s.activePreviewFilePath);
  const [scale, setScale] = useState(1.0);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const { data: file, isLoading, error } = useQuery({
    queryKey: ['file', activeWorkspaceId, activePreviewFilePath],
    queryFn: () => sdk.file.read(activeWorkspaceId!, activePreviewFilePath!),
    enabled:
      !!activeWorkspaceId &&
      !!activePreviewFilePath &&
      IMAGE_EXTENSIONS.test(activePreviewFilePath),
  });

  // Reset state when file changes
  useEffect(() => {
    setScale(1.0);
    setNaturalSize(null);
  }, [activePreviewFilePath]);

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

  const resetZoom = useCallback(() => setScale(1.0), []);

  const fitWidth = useCallback(() => {
    if (!naturalSize || !containerRef.current) {
      setScale(1.0);
      return;
    }
    const containerWidth = containerRef.current.clientWidth - 32;
    const newScale = Math.max(0.1, Math.min(4.0, containerWidth / naturalSize.w));
    setScale(newScale);
  }, [naturalSize]);

  // Keyboard zoom shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable) return;
      if ((e.ctrlKey || e.metaKey) && (e.key === '+' || e.key === '=')) {
        e.preventDefault();
        zoomIn();
      } else if ((e.ctrlKey || e.metaKey) && e.key === '-') {
        e.preventDefault();
        zoomOut();
      } else if ((e.ctrlKey || e.metaKey) && e.key === '0') {
        e.preventDefault();
        resetZoom();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [zoomIn, zoomOut, resetZoom]);

  // Ctrl/Cmd + wheel zoom
  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      if (e.deltaY < 0) zoomIn();
      else zoomOut();
    }
  }, [zoomIn, zoomOut]);

  if (
    !activePreviewFilePath ||
    !IMAGE_EXTENSIONS.test(activePreviewFilePath)
  ) {
    return null;
  }

  const fileName = activePreviewFilePath.split(/[/\\]/).pop() ?? 'Image';

  if (isLoading) return <LoadingSpinner message="Loading image..." />;

  // Build image src from file content
  const src = (() => {
    if (!file?.content) return undefined;
    if (file.encoding === 'base64') {
      const ext = fileName.split('.').pop()?.toLowerCase();
      const mimeMap: Record<string, string> = {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        svg: 'image/svg+xml',
        webp: 'image/webp',
        bmp: 'image/bmp',
        ico: 'image/x-icon',
        avif: 'image/avif',
      };
      const mimeType = file.mimeType ?? mimeMap[ext ?? ''] ?? 'image/png';
      return `data:${mimeType};base64,${file.content}`;
    }
    if (file.content.startsWith('data:')) return file.content;
    return undefined;
  })();

  if (error || !src) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between px-4 py-2 border-b bg-muted/30 shrink-0">
          <span className="text-xs text-muted-foreground truncate flex-1 mr-2">{fileName}</span>
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
        <div className="flex-1 flex items-center justify-center bg-muted/20">
          <div className="flex flex-col items-center gap-2 text-muted-foreground">
            <ImageIcon className="h-16 w-16" />
            <p className="text-xs text-destructive">
              {error ? 'Failed to load image' : 'Image not available'}
            </p>
          </div>
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
          {naturalSize && (
            <span className="text-[10px] opacity-50 ml-2">
              {naturalSize.w} × {naturalSize.h}px
            </span>
          )}
        </span>
        <div className="flex items-center gap-1">
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
          <div className="w-px h-4 bg-border mx-1" />
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

      {/* Image display */}
      <div
        ref={containerRef}
        onWheel={handleWheel}
        className="flex-1 overflow-auto bg-neutral-200 dark:bg-neutral-800 flex items-center justify-center p-4"
      >
        <img
          src={src}
          alt={fileName}
          onLoad={(e) => {
            const img = e.currentTarget;
            setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
          }}
          onClick={resetZoom}
          className="shadow-lg rounded-sm transition-transform"
          style={{
            transform: `scale(${scale})`,
            transformOrigin: 'center',
            cursor: scale !== 1.0 ? 'zoom-out' : 'zoom-in',
            maxWidth: scale === 1.0 ? '100%' : 'none',
            maxHeight: scale === 1.0 ? '100%' : 'none',
          }}
          draggable={false}
        />
      </div>
    </div>
  );
}
