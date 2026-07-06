import { useState, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSDK } from '@/hooks/use-sdk';
import { useUIStore } from '@/stores/ui-store';
import { LoadingSpinner } from '@/components/common/loading-spinner';
import { Video as VideoIcon, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { openWithSystemApp } from '@/lib/utils';

const VIDEO_EXTENSIONS = /\.(mp4|webm|mov|m4v|ogv|mkv|avi|3gp)$/i;

const MIME_MAP: Record<string, string> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  ogv: 'video/ogg',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  '3gp': 'video/3gpp',
};

export function VideoPreview() {
  const sdk = useSDK();
  const activeWorkspaceId = useUIStore((s) => s.activeWorkspaceId);
  const activePreviewFilePath = useUIStore((s) => s.activePreviewFilePath);
  const [unsupported, setUnsupported] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  const { data: file, isLoading, error } = useQuery({
    queryKey: ['file', activeWorkspaceId, activePreviewFilePath],
    queryFn: () => sdk.file.read(activeWorkspaceId!, activePreviewFilePath!),
    enabled:
      !!activeWorkspaceId &&
      !!activePreviewFilePath &&
      VIDEO_EXTENSIONS.test(activePreviewFilePath),
  });

  // Reset unsupported state when file changes
  useEffect(() => {
    setUnsupported(false);
  }, [activePreviewFilePath]);

  if (
    !activePreviewFilePath ||
    !VIDEO_EXTENSIONS.test(activePreviewFilePath)
  ) {
    return null;
  }

  const fileName = activePreviewFilePath.split(/[/\\]/).pop() ?? 'Video';
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';

  if (isLoading) return <LoadingSpinner message="Loading video..." />;

  // Build video src from file content
  const src = (() => {
    if (!file?.content) return undefined;
    if (file.encoding === 'base64') {
      const mimeType = file.mimeType ?? MIME_MAP[ext] ?? 'video/mp4';
      return `data:${mimeType};base64,${file.content}`;
    }
    if (file.content.startsWith('data:')) return file.content;
    return undefined;
  })();

  if (error || !src) {
    return (
      <div className="flex flex-col h-full">
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
        <div className="flex-1 flex items-center justify-center bg-neutral-200 dark:bg-neutral-800">
          <div className="flex flex-col items-center gap-3 text-muted-foreground">
            <VideoIcon className="h-16 w-16" />
            <p className="text-xs text-destructive">
              {error ? 'Failed to load video' : 'Video not available'}
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
        </span>
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

      {/* Video display */}
      <div className="flex-1 flex items-center justify-center bg-neutral-900 dark:bg-neutral-950 p-4 overflow-auto">
        {unsupported ? (
          <div className="flex flex-col items-center gap-3 text-muted-foreground max-w-md text-center">
            <VideoIcon className="h-16 w-16" />
            <p className="text-sm font-medium">This video format may not be supported by the browser</p>
            <p className="text-xs opacity-70">
              The <span className="font-mono">.{ext}</span> format may not play in the built-in preview.
              Try opening it with your system's default video player.
            </p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => openWithSystemApp(activePreviewFilePath!, activeWorkspaceId!)}
              className="mt-2 h-8 text-xs gap-1.5"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open with system app
            </Button>
          </div>
        ) : (
          <video
            ref={videoRef}
            controls
            autoPlay={false}
            className="max-w-full max-h-full rounded-sm shadow-2xl"
            style={{ backgroundColor: '#000' }}
            onError={() => setUnsupported(true)}
          >
            <source src={src} type={MIME_MAP[ext] ?? 'video/mp4'} />
            {/* Fallback: browser cannot play this video format */}
            <div className="flex flex-col items-center gap-3 text-muted-foreground p-8 text-center">
              <VideoIcon className="h-16 w-16" />
              <p className="text-sm">Your browser cannot play this video format (.{ext}).</p>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => openWithSystemApp(activePreviewFilePath!, activeWorkspaceId!)}
                className="mt-2 h-8 text-xs gap-1.5"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Open with system app
              </Button>
            </div>
          </video>
        )}
      </div>
    </div>
  );
}
