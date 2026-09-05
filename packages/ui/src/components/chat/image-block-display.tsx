import { useState } from 'react';
import { Image, ImageOff, Maximize2, X, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import type { ImageBlock } from '@pi/types';

interface ImageBlockDisplayProps {
  block: ImageBlock;
  isStreaming?: boolean;
}

export function ImageBlockDisplay({ block, isStreaming }: ImageBlockDisplayProps) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [hasError, setHasError] = useState(false);
  const dataUrl = block.data
    ? `data:${block.mimeType};base64,${block.data}`
    : block.content.startsWith('data:')
      ? block.content
      : null;

  if (isStreaming && !dataUrl) {
    return (
      <div className="my-2 overflow-hidden rounded-lg border bg-muted/30">
        <div className="flex items-center gap-2 px-3 py-4">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          <span className="text-xs text-muted-foreground">Loading image...</span>
        </div>
      </div>
    );
  }

  if (!dataUrl || hasError) {
    return (
      <div className="my-2 flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-4">
        <ImageOff className="h-4 w-4 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">Image unavailable</span>
      </div>
    );
  }

  return (
    <>
      <div className="my-2 overflow-hidden rounded-lg border bg-muted/30">
        <div className="group relative">
          <img
            src={dataUrl}
            alt={block.content || 'Attached image'}
            onError={() => setHasError(true)}
            className={cn(
              'max-w-full h-auto max-h-80 object-contain cursor-pointer',
              isStreaming && 'opacity-70',
            )}
            style={{
              aspectRatio: block.width && block.height
                ? `${block.width} / ${block.height}`
                : undefined,
            }}
            onClick={() => !isStreaming && setLightboxOpen(true)}
          />
          {!isStreaming && (
            <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
              <button
                onClick={() => setLightboxOpen(true)}
                className="rounded-md bg-background/80 p-1.5 hover:bg-background"
                aria-label="View full size"
              >
                <Maximize2 className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Lightbox */}
      <Dialog open={lightboxOpen} onOpenChange={setLightboxOpen}>
        <DialogContent className="max-w-[90vw] max-h-[90vh] p-0 bg-background/95 border-none">
          <div className="relative flex items-center justify-center p-2">
            <button
              onClick={() => setLightboxOpen(false)}
              className="absolute top-2 right-2 z-10 rounded-full bg-background/60 p-1.5 hover:bg-background/80"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
            <img
              src={dataUrl}
              alt={block.content || 'Attached image'}
              className="max-w-full max-h-[85vh] object-contain rounded-md"
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
