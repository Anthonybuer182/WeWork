import { useState } from 'react';
import { Quote, ChevronDown, ChevronRight, FileText } from 'lucide-react';
import { cn, isPreviewableInRightPanel } from '@/lib/utils';
import { useUIStore } from '@/stores/ui-store';
import type { QuoteBlock } from '@pi/types';

interface QuoteBlockDisplayProps {
  block: QuoteBlock;
}

const PREVIEW_LIMIT = 200;

/** Build a human-readable metadata label (e.g. "Lines 12-34", "Page 3", "Slide 5", "Sheet: Data"). */
function buildMetaLabel(block: QuoteBlock): string | null {
  const parts: string[] = [];
  if (block.startLine && block.endLine) {
    parts.push(`Lines ${block.startLine}-${block.endLine}`);
  } else if (block.startLine) {
    parts.push(`Line ${block.startLine}`);
  }
  if (block.pageNumber) parts.push(`Page ${block.pageNumber}`);
  if (block.slideNumber) parts.push(`Slide ${block.slideNumber}`);
  if (block.sheetName) parts.push(`Sheet: ${block.sheetName}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

export function QuoteBlockDisplay({ block }: QuoteBlockDisplayProps) {
  const [expanded, setExpanded] = useState(false);
  const setActivePreviewFile = useUIStore((s) => s.setActivePreviewFile);

  const metaLabel = buildMetaLabel(block);
  const canOpenInPanel = !!block.filePath && isPreviewableInRightPanel(block.filePath);
  const previewText = block.content.length > PREVIEW_LIMIT
    ? block.content.slice(0, PREVIEW_LIMIT)
    : block.content;
  const isTruncated = block.content.length > PREVIEW_LIMIT;

  const handleFileClick = () => {
    if (canOpenInPanel && block.filePath) {
      setActivePreviewFile(block.filePath);
    }
  };

  return (
    <div className="my-1 rounded-lg border bg-muted/30 overflow-hidden">
      {/* Header: icon + file name + meta + expand toggle */}
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <Quote className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            {canOpenInPanel ? (
              <button
                type="button"
                onClick={handleFileClick}
                className="text-xs font-medium truncate hover:text-primary hover:underline inline-flex items-center gap-1"
                title="Open in preview panel"
              >
                <FileText className="h-3 w-3" />
                {block.fileName}
              </button>
            ) : (
              <span className="text-xs font-medium truncate inline-flex items-center gap-1">
                <FileText className="h-3 w-3" />
                {block.fileName}
              </span>
            )}
            {metaLabel && (
              <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                {metaLabel}
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="p-1 rounded hover:bg-muted shrink-0"
          title={expanded ? 'Collapse' : 'Expand'}
        >
          {expanded
            ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
        </button>
      </div>

      {/* Quote content preview / full */}
      <div className="border-t">
        <pre
          className={cn(
            'text-[11px] leading-relaxed p-3 overflow-auto bg-muted/20 font-mono whitespace-pre-wrap break-all',
            expanded ? 'max-h-64' : 'max-h-24',
          )}
        >
          {expanded ? block.content : previewText}
          {!expanded && isTruncated && (
            <span className="text-muted-foreground">…</span>
          )}
        </pre>
      </div>
    </div>
  );
}
