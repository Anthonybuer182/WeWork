import { useRef, useCallback, type ReactNode } from 'react';
import { FloatingQuoteButton } from './floating-quote-button';
import { useUIStore } from '@/stores/ui-store';
import { useComposerStore } from '@/stores/composer-store';
import { createQuote, extractMetaFromSelection } from '@/lib/quote-helpers';
import type { QuoteSource } from '@pi/types';

export function QuoteToChatWrapper({ source, children }: { source: QuoteSource; children: ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const filePath = useUIStore((s) => s.activePreviewFilePath);
  const addQuote = useComposerStore((s) => s.addQuote);

  const handleQuote = useCallback((text: string) => {
    if (!filePath || !text.trim()) return;
    const meta = source === 'code-editor' ? {} : extractMetaFromSelection();
    addQuote(createQuote(text, filePath, source, meta));
  }, [filePath, source, addQuote]);

  return (
    <div ref={containerRef} className="relative h-full">
      {children}
      <FloatingQuoteButton onQuote={handleQuote} containerRef={containerRef} />
    </div>
  );
}
