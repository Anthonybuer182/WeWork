import { useState, useEffect, useRef, useCallback } from 'react';
import { Quote as QuoteIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useComposerStore } from '@/stores/composer-store';
import { createQuote } from '@/lib/quote-helpers';

/** Minimal webview element interface for the methods we use. */
interface WebviewElement extends HTMLElement {
  executeJavaScript: (code: string) => Promise<unknown>;
  getURL: () => string;
}

interface BrowserQuoteButtonProps {
  webviewRef: React.RefObject<WebviewElement | null>;
}

/**
 * Floating Quote button for the browser webview.
 *
 * Polls the webview's selection via executeJavaScript since the webview
 * is a separate process — we can't listen to DOM events directly.
 * When text is selected, a floating Quote button appears above the
 * selection area. Clicking it adds the selected text as a quote to the
 * composer with the page URL as source.
 */
export function BrowserQuoteButton({ webviewRef }: BrowserQuoteButtonProps) {
  const [visible, setVisible] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const addQuote = useComposerStore((s) => s.addQuote);

  const checkSelection = useCallback(async () => {
    const webview = webviewRef.current;
    if (!webview) return;

    try {
      const text = await webview.executeJavaScript(
        'window.getSelection().toString()'
      ) as string;

      if (!text || text.trim().length < 2) {
        setVisible(false);
        return;
      }

      // Get selection coordinates from the webview
      const rect = await webview.executeJavaScript(`
        (function() {
          var sel = window.getSelection();
          if (!sel || sel.rangeCount === 0) return null;
          var range = sel.getRangeAt(0);
          var rect = range.getBoundingClientRect();
          return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
        })()
      `) as { left: number; top: number; width: number; height: number } | null;

      if (!rect || (rect.width === 0 && rect.height === 0)) {
        setVisible(false);
        return;
      }

      // Position relative to the container
      const containerEl = containerRef.current;
      if (!containerEl) {
        setVisible(false);
        return;
      }

      const containerRect = containerEl.getBoundingClientRect();
      const webviewRect = webview.getBoundingClientRect();

      // The webview's internal coordinates need to be offset by the webview's position
      const top = (webviewRect.top - containerRect.top) + rect.top - 36;
      const left = (webviewRect.left - containerRect.left) + rect.left + rect.width / 2;

      setPosition({ top, left });
      setVisible(true);
    } catch {
      setVisible(false);
    }
  }, [webviewRef]);

  // Poll for selection every 500ms
  useEffect(() => {
    const interval = setInterval(checkSelection, 500);
    return () => clearInterval(interval);
  }, [checkSelection]);

  // Also check on mouseup events in the container
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let debounce: ReturnType<typeof setTimeout> | null = null;
    const handleMouseUp = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(checkSelection, 200);
    };

    container.addEventListener('mouseup', handleMouseUp);
    return () => {
      container.removeEventListener('mouseup', handleMouseUp);
      if (debounce) clearTimeout(debounce);
    };
  }, [checkSelection]);

  const handleQuote = useCallback(async () => {
    const webview = webviewRef.current;
    if (!webview) return;

    try {
      const text = await webview.executeJavaScript(
        'window.getSelection().toString()'
      ) as string;

      if (!text || !text.trim()) return;

      const url = webview.getURL();
      addQuote(createQuote(text, url, 'browser', {}));

      // Clear selection
      await webview.executeJavaScript('window.getSelection().removeAllRanges()');
      setVisible(false);
    } catch {
      // Ignore errors
    }
  }, [webviewRef, addQuote]);

  if (!visible) return null;

  return (
    <div ref={containerRef} className="relative h-full w-full pointer-events-none">
      <div
        className="absolute z-50 pointer-events-auto"
        style={{ top: position.top, left: position.left, transform: 'translateX(-50%)' }}
      >
        <Button
          size="sm"
          variant="secondary"
          onClick={handleQuote}
          className="h-7 gap-1.5 shadow-md"
          title="Quote to chat"
        >
          <QuoteIcon className="h-3 w-3" />
          Quote
        </Button>
      </div>
    </div>
  );
}
