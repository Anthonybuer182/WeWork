import { useState, useEffect, useRef, useCallback } from 'react';
import { Quote as QuoteIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useComposerStore } from '@/stores/composer-store';
import { createQuote } from '@/lib/quote-helpers';

/** Minimal webview element interface for the methods we use. */
interface WebviewElement extends HTMLElement {
  executeJavaScript: (code: string) => Promise<unknown>;
  getURL: () => string;
  addEventListener: (event: string, listener: (e: unknown) => void) => void;
  removeEventListener: (event: string, listener: (e: unknown) => void) => void;
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
      const top = Math.max(4, (webviewRect.top - containerRect.top) + rect.top - 36);
      const left = (webviewRect.left - containerRect.left) + rect.left + rect.width / 2;

      setPosition({ top, left });
      setVisible(true);
    } catch (err) {
      console.warn('[BrowserQuoteButton] checkSelection error:', err);
      setVisible(false);
    }
  }, [webviewRef]);

  // Poll for selection every 300ms
  useEffect(() => {
    const interval = setInterval(checkSelection, 300);
    return () => clearInterval(interval);
  }, [checkSelection]);

  // Inject a mouseup listener into the webview so we get immediate
  // selection notifications instead of waiting for the next poll.
  // The injected script does console.log('__pi_sel__') on mouseup,
  // which we catch via the webview's 'console-message' event.
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    const MOUSEUP_MARKER = '__pi_sel__';

    const injectListener = () => {
      try {
        webview.executeJavaScript(`
          if (!window.__pi_mouseup_injected) {
            window.__pi_mouseup_injected = true;
            document.addEventListener('mouseup', () => {
              console.log(${JSON.stringify(MOUSEUP_MARKER)});
            });
          }
        `).catch(() => {});
      } catch {
        // Webview not ready yet — will retry on did-finish-load
      }
    };

    const handleConsoleMessage = (e: unknown) => {
      // Electron's <webview> console-message event puts the message in
      // event.detail.message (not event.message)
      const ev = e as { detail?: { message?: string }; message?: string };
      const msg = ev?.detail?.message ?? ev?.message ?? '';
      if (msg.includes(MOUSEUP_MARKER)) {
        setTimeout(checkSelection, 50);
      }
    };

    const handleFinishLoad = () => injectListener();

    webview.addEventListener('did-finish-load', handleFinishLoad);
    webview.addEventListener('console-message', handleConsoleMessage);

    // Try injecting immediately in case the page is already loaded
    injectListener();

    return () => {
      webview.removeEventListener('did-finish-load', handleFinishLoad);
      webview.removeEventListener('console-message', handleConsoleMessage);
    };
  }, [webviewRef, checkSelection]);

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

  return (
    <div ref={containerRef} className="absolute inset-0 pointer-events-none" style={{ zIndex: 10 }}>
      {visible && (
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
      )}
    </div>
  );
}
