import { useState, useEffect, useRef, useCallback } from 'react';
import { Quote as QuoteIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface FloatingQuoteButtonProps {
  onQuote: (text: string) => void;
  containerRef?: React.RefObject<HTMLElement | null>;
}

export function FloatingQuoteButton({ onQuote, containerRef }: FloatingQuoteButtonProps) {
  const [visible, setVisible] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const getSelectionText = useCallback((): { text: string; rect: DOMRect } | null => {
    // Try container's own document first
    const doc = containerRef?.current?.ownerDocument ?? document;
    let sel = doc.getSelection();
    let text = sel?.toString().trim() ?? '';
    // If empty, try iframe inside container (HTML preview uses iframe)
    if (!text && containerRef?.current) {
      const iframe = containerRef.current.querySelector('iframe');
      if (iframe?.contentDocument) {
        sel = iframe.contentDocument.getSelection();
        text = sel?.toString().trim() ?? '';
      }
    }
    if (!sel || text.length < 2) return null;
    const range = sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
    if (!range) return null;
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return null;
    return { text, rect };
  }, [containerRef]);

  const updatePosition = useCallback(() => {
    const result = getSelectionText();
    if (!result) {
      setVisible(false);
      return;
    }
    const containerEl = containerRef?.current;
    if (!containerEl) {
      setVisible(false);
      return;
    }
    const containerRect = containerEl.getBoundingClientRect();
    // Position relative to container
    const top = result.rect.top - containerRect.top - 36; // 36px above selection
    const left = result.rect.left - containerRect.left + result.rect.width / 2;
    setPosition({ top, left });
    setVisible(true);
  }, [getSelectionText, containerRef]);

  const debouncedUpdate = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(updatePosition, 200);
  }, [updatePosition]);

  // Listen to selectionchange and mouseup
  useEffect(() => {
    const doc = containerRef?.current?.ownerDocument ?? document;
    doc.addEventListener('selectionchange', debouncedUpdate);
    doc.addEventListener('mouseup', debouncedUpdate);

    // Also listen on iframe's document if present
    let iframeDoc: Document | null = null;
    if (containerRef?.current) {
      const iframe = containerRef.current.querySelector('iframe');
      if (iframe?.contentDocument) {
        iframeDoc = iframe.contentDocument;
        iframeDoc.addEventListener('selectionchange', debouncedUpdate);
        iframeDoc.addEventListener('mouseup', debouncedUpdate);
      }
    }

    return () => {
      doc.removeEventListener('selectionchange', debouncedUpdate);
      doc.removeEventListener('mouseup', debouncedUpdate);
      if (iframeDoc) {
        iframeDoc.removeEventListener('selectionchange', debouncedUpdate);
        iframeDoc.removeEventListener('mouseup', debouncedUpdate);
      }
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [debouncedUpdate, containerRef]);

  // Hide on container scroll
  useEffect(() => {
    const containerEl = containerRef?.current;
    if (!containerEl) return;
    const handleScroll = () => setVisible(false);
    containerEl.addEventListener('scroll', handleScroll, { capture: true });
    return () => containerEl.removeEventListener('scroll', handleScroll, { capture: true } as EventListenerOptions);
  }, [containerRef]);

  const handleClick = useCallback(() => {
    const result = getSelectionText();
    if (!result) return;
    onQuote(result.text);
    // Clear selection
    const doc = containerRef?.current?.ownerDocument ?? document;
    doc.getSelection()?.removeAllRanges();
    setVisible(false);
  }, [getSelectionText, onQuote, containerRef]);

  if (!visible) return null;

  return (
    <div
      className="absolute z-50"
      style={{ top: position.top, left: position.left, transform: 'translateX(-50%)' }}
    >
      <Button
        size="sm"
        variant="secondary"
        onClick={handleClick}
        className="h-7 gap-1.5 shadow-md"
        title="Quote to chat (Cmd+Shift+Q)"
      >
        <QuoteIcon className="h-3 w-3" />
        Quote
      </Button>
    </div>
  );
}
