import { useState } from 'react';
import {
  ChevronDown,
  Copy,
  Check,
  FileCode2,
  FileText,
  FileSpreadsheet,
  Presentation,
  FileType,
  ExternalLink,
} from 'lucide-react';
import { cn, isPreviewableInRightPanel } from '@/lib/utils';
import { useUIStore } from '@/stores/ui-store';
import type { QuoteBlock } from '@pi/types';

interface QuoteBlockDisplayProps {
  block: QuoteBlock;
}

/** Source-type → icon + colored badge + left border accent. */
const SOURCE_CONFIG: Record<string, {
  icon: typeof FileText;
  label: string;
  badge: string;
  accent: string;
}> = {
  'code-editor': {
    icon: FileCode2,
    label: 'CODE',
    badge: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
    accent: 'border-l-blue-500',
  },
  markdown: {
    icon: FileText,
    label: 'MD',
    badge: 'bg-slate-500/10 text-slate-600 dark:text-slate-400',
    accent: 'border-l-slate-500',
  },
  html: {
    icon: FileCode2,
    label: 'HTML',
    badge: 'bg-orange-500/10 text-orange-600 dark:text-orange-400',
    accent: 'border-l-orange-500',
  },
  'pdf-text': {
    icon: FileText,
    label: 'PDF',
    badge: 'bg-red-500/10 text-red-600 dark:text-red-400',
    accent: 'border-l-red-500',
  },
  'pdf-canvas': {
    icon: FileText,
    label: 'PDF',
    badge: 'bg-red-500/10 text-red-600 dark:text-red-400',
    accent: 'border-l-red-500',
  },
  docx: {
    icon: FileType,
    label: 'DOCX',
    badge: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
    accent: 'border-l-blue-500',
  },
  xlsx: {
    icon: FileSpreadsheet,
    label: 'XLSX',
    badge: 'bg-green-500/10 text-green-600 dark:text-green-400',
    accent: 'border-l-green-500',
  },
  pptx: {
    icon: Presentation,
    label: 'PPTX',
    badge: 'bg-orange-500/10 text-orange-600 dark:text-orange-400',
    accent: 'border-l-orange-500',
  },
};

const DEFAULT_CONFIG = {
  icon: FileText,
  label: 'QUOTE',
  badge: 'bg-slate-500/10 text-slate-600 dark:text-slate-400',
  accent: 'border-l-slate-400',
};

/** Auto-expand quotes shorter than this to save a click. */
const AUTO_EXPAND_THRESHOLD = 120;

function getSourceConfig(source: string) {
  return SOURCE_CONFIG[source] ?? DEFAULT_CONFIG;
}

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

/** Prepend line numbers to each line of code content. */
function renderCodeWithLineNumbers(content: string, startLine?: number): string {
  if (!startLine) return content;
  const lines = content.split('\n');
  const maxDigits = String(startLine + lines.length - 1).length;
  return lines
    .map((line, i) => {
      const num = String(startLine + i).padStart(maxDigits, ' ');
      return `${num} │ ${line}`;
    })
    .join('\n');
}

export function QuoteBlockDisplay({ block }: QuoteBlockDisplayProps) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const setActivePreviewFile = useUIStore((s) => s.setActivePreviewFile);

  const config = getSourceConfig(block.source);
  const SourceIcon = config.icon;
  const metaLabel = buildMetaLabel(block);
  const canOpenInPanel = !!block.filePath && isPreviewableInRightPanel(block.filePath);
  const isCode = block.source === 'code-editor';
  const isShort = block.content.length <= AUTO_EXPAND_THRESHOLD;
  const showFull = expanded || isShort;

  const displayContent = showFull
    ? isCode
      ? renderCodeWithLineNumbers(block.content, block.startLine)
      : block.content
    : block.content.slice(0, 100);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(block.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard may not be available */ }
  };

  const handleOpenInPanel = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (canOpenInPanel && block.filePath) {
      setActivePreviewFile(block.filePath);
    }
  };

  const handleHeaderClick = () => {
    // If previewable, open in panel; otherwise toggle expand
    if (canOpenInPanel) {
      setActivePreviewFile(block.filePath!);
    } else if (!isShort) {
      setExpanded(!expanded);
    }
  };

  return (
    <div className={cn(
      'my-1 rounded-lg border border-l-2 bg-muted/30 overflow-hidden',
      config.accent,
    )}>
      {/* Header */}
      <div
        className={cn(
          'flex items-center gap-2.5 px-3 py-2 transition-colors',
          (canOpenInPanel || !isShort) && 'cursor-pointer hover:bg-muted/50',
        )}
        onClick={handleHeaderClick}
      >
        <SourceIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs font-medium truncate">{block.fileName}</span>
            <span className={cn(
              'text-[9px] font-semibold px-1.5 py-0.5 rounded uppercase tracking-wide',
              config.badge,
            )}>
              {config.label}
            </span>
            {metaLabel && (
              <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                {metaLabel}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-0.5 shrink-0" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            onClick={handleCopy}
            className="p-1 rounded hover:bg-muted transition-colors"
            title="Copy quote content"
          >
            {copied
              ? <Check className="h-3.5 w-3.5 text-green-500" />
              : <Copy className="h-3.5 w-3.5 text-muted-foreground" />}
          </button>
          {canOpenInPanel && (
            <button
              type="button"
              onClick={handleOpenInPanel}
              className="p-1 rounded hover:bg-muted transition-colors"
              title="Open in preview panel"
            >
              <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          )}
          {!isShort && (
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              className="p-1 rounded hover:bg-muted transition-colors"
              title={expanded ? 'Collapse' : 'Expand'}
            >
              <ChevronDown className={cn(
                'h-3.5 w-3.5 text-muted-foreground transition-transform',
                expanded && 'rotate-180',
              )} />
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="border-t relative">
        <pre
          className={cn(
            'text-[11px] leading-relaxed p-3 overflow-auto bg-muted/20 font-mono whitespace-pre-wrap break-all',
            showFull ? 'max-h-64' : 'max-h-20',
          )}
        >
          {displayContent}
          {!showFull && <span className="text-muted-foreground"> …</span>}
        </pre>
        {/* Gradient fade when collapsed */}
        {!showFull && (
          <div className="absolute bottom-0 left-0 right-0 h-6 bg-gradient-to-t from-muted/80 to-transparent pointer-events-none" />
        )}
      </div>
    </div>
  );
}
