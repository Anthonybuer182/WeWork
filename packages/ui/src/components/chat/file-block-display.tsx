import { useState } from 'react';
import {
  File,
  FileText,
  FileCode2,
  FileImage,
  FileSpreadsheet,
  FileAudio,
  FileVideo,
  FileArchive,
  Download,
  Eye,
  EyeOff,
  ExternalLink,
} from 'lucide-react';
import { cn, isPreviewableInRightPanel, openWithSystemApp } from '@/lib/utils';
import { useUIStore } from '@/stores/ui-store';
import type { FileBlock } from '@pi/types';

interface FileBlockDisplayProps {
  block: FileBlock;
}

const PRESENTABLE_TEXT_TYPES = new Set([
  'text/plain',
  'text/html',
  'text/css',
  'text/csv',
  'text/xml',
  'text/javascript',
  'text/typescript',
  'text/markdown',
  'text/x-python',
  'text/x-java',
  'text/x-rust',
  'text/x-go',
  'text/x-c',
  'text/x-c++',
  'application/json',
  'application/javascript',
  'application/typescript',
  'application/xml',
  'application/x-yaml',
  'application/x-sh',
  'application/x-python',
]);

/** Check if a file should be expandable (has preview or other content) */
function isExpandable(mimeType: string) {
  return (
    PRESENTABLE_TEXT_TYPES.has(mimeType) ||
    mimeType.startsWith('audio/') ||
    mimeType.startsWith('video/')
  );
}

function getFileIcon(mimeType: string, fileName?: string) {
  if (mimeType.startsWith('image/')) return FileImage;
  if (mimeType.startsWith('audio/')) return FileAudio;
  if (mimeType.startsWith('video/')) return FileVideo;
  if (mimeType.includes('spreadsheet') || mimeType.includes('excel') || mimeType.includes('csv')) return FileSpreadsheet;
  if (mimeType.includes('pdf')) return FileText;
  if (mimeType.includes('zip') || mimeType.includes('tar') || mimeType.includes('gzip') || mimeType.includes('rar')) return FileArchive;

  // Check file extension for code
  const ext = (fileName || '').split('.').pop()?.toLowerCase();
  const codeExts = new Set(['ts', 'tsx', 'js', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'swift', 'kt', 'sh', 'bash', 'zsh', 'yaml', 'yml', 'toml', 'json', 'xml', 'html', 'css', 'scss', 'less', 'sql', 'graphql', 'md', 'mdx']);
  if (ext && codeExts.has(ext)) return FileCode2;

  return File;
}

function formatFileSize(bytes?: number): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FileBlockDisplay({ block }: FileBlockDisplayProps) {
  const [expanded, setExpanded] = useState(false);
  const setActivePreviewFile = useUIStore((s) => s.setActivePreviewFile);
  const setMemoryPreview = useUIStore((s) => s.setMemoryPreview);
  const activeWorkspaceId = useUIStore((s) => s.activeWorkspaceId);
  const displayName = block.fileName || block.content || 'Unknown file';
  const Icon = getFileIcon(block.mimeType, block.fileName);
  const showPreview = PRESENTABLE_TEXT_TYPES.has(block.mimeType) && block.data;
  const expandable = isExpandable(block.mimeType);
  const canOpenInPanel = !!block.workspacePath && isPreviewableInRightPanel(block.workspacePath);
  const hasMemoryData = !block.workspacePath && !!block.data;

  let previewText = '';
  if (showPreview && block.data) {
    try {
      // atob returns binary string; decode UTF-8 bytes properly
      const binary = atob(block.data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      previewText = new TextDecoder().decode(bytes);
    } catch {
      previewText = '[Binary content - cannot preview]';
    }
  }

  const handleClick = () => {
    // Always open in right panel if possible — same behavior as Files sidebar
    if (hasMemoryData && block.data) {
      const virtualPath = `__memory__/${displayName}`;
      setMemoryPreview(virtualPath, {
        fileName: displayName,
        mimeType: block.mimeType,
        data: block.data,
      });
      setActivePreviewFile(virtualPath);
    } else if (canOpenInPanel && block.workspacePath) {
      setActivePreviewFile(block.workspacePath);
    } else {
      setExpanded(!expanded);
    }
  };

  // Whether the click action opens the right panel (like Files sidebar click)
  const opensRightPanel = canOpenInPanel || hasMemoryData;

  return (
    <div className="my-1 rounded-lg border bg-muted/30 overflow-hidden">
      {/* File header */}
      <button
        onClick={handleClick}
        className={cn(
          'flex items-center gap-2.5 w-full px-3 py-2.5 hover:bg-muted/50 transition-colors text-left',
          opensRightPanel && 'cursor-pointer',
        )}
      >
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium truncate">{displayName}</p>
          {block.fileSize != null && (
            <p className="text-[10px] text-muted-foreground">{formatFileSize(block.fileSize)}</p>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {opensRightPanel && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                if (canOpenInPanel && block.workspacePath) {
                  openWithSystemApp(block.workspacePath, activeWorkspaceId ?? undefined);
                } else if (hasMemoryData && block.data) {
                  const a = document.createElement('a');
                  a.href = `data:${block.mimeType};base64,${block.data}`;
                  a.download = displayName;
                  a.style.display = 'none';
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                }
              }}
              className="p-1 rounded hover:bg-muted"
              title="Open with system app"
            >
              <ExternalLink className="h-3.5 w-3.5 text-blue-500" />
            </button>
          )}
          {!opensRightPanel && expandable && (
            expanded
              ? <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />
              : <Eye className="h-3.5 w-3.5 text-muted-foreground" />
          )}
          {/* Only show download for workspace files — attached files are local */}
          {canOpenInPanel && block.data && (
            <a
              href={`data:${block.mimeType};base64,${block.data}`}
              download={displayName}
              onClick={(e) => e.stopPropagation()}
              className="p-1 rounded hover:bg-muted"
              title="Download"
            >
              <Download className="h-3.5 w-3.5 text-muted-foreground" />
            </a>
          )}
        </div>
      </button>

      {/* Preview area */}
      {expanded && showPreview && (
        <div className="border-t">
          <pre className="text-[11px] leading-relaxed p-3 max-h-48 overflow-auto bg-muted/20 font-mono whitespace-pre-wrap break-all">
            {previewText.slice(0, 5000)}
            {previewText.length > 5000 && (
              <span className="text-muted-foreground">\n... (truncated)</span>
            )}
          </pre>
        </div>
      )}

      {/* Audio preview */}
      {expanded && block.mimeType.startsWith('audio/') && block.data && (
        <div className="border-t p-2">
          <audio
            controls
            className="w-full h-8"
            src={`data:${block.mimeType};base64,${block.data}`}
          />
        </div>
      )}

      {/* Video preview */}
      {expanded && block.mimeType.startsWith('video/') && block.data && (
        <div className="border-t p-2">
          <video
            controls
            className="max-w-full max-h-64 rounded"
            src={`data:${block.mimeType};base64,${block.data}`}
          />
        </div>
      )}
    </div>
  );
}
