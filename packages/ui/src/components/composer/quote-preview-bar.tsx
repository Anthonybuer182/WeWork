import { X, Quote as QuoteIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { Quote } from '@pi/types';

function formatMeta(q: Quote): string {
  const p: string[] = [];
  if (q.meta.startLine && q.meta.endLine) p.push(`L${q.meta.startLine}-${q.meta.endLine}`);
  if (q.meta.pageNumber) p.push(`P${q.meta.pageNumber}`);
  if (q.meta.slideNumber) p.push(`S${q.meta.slideNumber}`);
  if (q.meta.sheetName) p.push(q.meta.sheetName);
  return p.join(' · ');
}

export function QuotePreviewBar({ quotes, onRemove }: { quotes: Quote[]; onRemove: (id: string) => void }) {
  if (quotes.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {quotes.map((q) => (
        <div key={q.id} className="group relative flex items-center gap-2 rounded-md border bg-primary/5 px-2 py-1 text-xs" title={`${q.fileName} - ${formatMeta(q)}`}>
          <QuoteIcon className="h-3 w-3 shrink-0 text-primary/70" />
          <span className="max-w-[120px] truncate text-muted-foreground">{q.fileName}</span>
          {formatMeta(q) && <span className="text-[10px] text-muted-foreground/70">{formatMeta(q)}</span>}
          <span className="max-w-[100px] truncate italic text-foreground/80">"{q.content.slice(0, 40)}..."</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="h-4 w-4 shrink-0 opacity-0 group-hover:opacity-100" onClick={(e) => { e.stopPropagation(); onRemove(q.id); }} aria-label="Remove quote">
                <X className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Remove quote</TooltipContent>
          </Tooltip>
        </div>
      ))}
    </div>
  );
}
