import { useCallback, useEffect, useRef, useState } from 'react';
import { copyText, createQuote } from '@/lib/quote-helpers';
import { useComposerStore } from '@/stores/composer-store';
import { usePluginStore } from '@/stores/plugin-store';
import type { QuoteSource } from '@pi/types';

interface SelectionState {
  x: number;
  y: number;
  text: string;
  source: { kind: QuoteSource; pluginId?: string; label: string };
}

const QUOTE_LIMIT = 2000;

/** Determine where a selection came from (chat / plugin panel). */
function detectSource(anchor: Node | null): SelectionState['source'] {
  if (!anchor) return { kind: 'chat', label: '对话' };
  const el = anchor.nodeType === 1 ? (anchor as HTMLElement) : anchor.parentElement;
  const panel = el?.closest('[data-panel-container]') as HTMLElement | null;
  if (panel) {
    const panelId = panel.getAttribute('data-panel-container') ?? '';
    if (panelId.startsWith('plugin:')) {
      const pluginId = panelId.slice('plugin:'.length).split(':')[0];
      return { kind: 'plugin', pluginId, label: pluginId };
    }
    if (panelId.startsWith('host:')) {
      return { kind: 'chat', label: panelId.slice('host:'.length) };
    }
  }
  return { kind: 'chat', label: '对话' };
}

function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el?.closest) return false;
  return !!el.closest('input, textarea, [contenteditable="true"], [data-composer]');
}

/**
 * 滑词引用 (selection quoting): a floating action menu appears on text
 * selection anywhere in the shell (chat timeline, panels, plugin iframes via
 * the injected SDK). Default action quotes into the composer; plugins
 * contribute extra actions through `contributes.selectionActions`.
 */
export function SelectionService() {
  const [state, setState] = useState<SelectionState | null>(null);
  const stateRef = useRef<SelectionState | null>(null);
  stateRef.current = state;
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const plugins = usePluginStore((s) => s.plugins);
  const executeSelectionAction = usePluginStore((s) => s.executeSelectionAction);

  const hide = useCallback(() => setState(null), []);

  const show = useCallback((x: number, y: number, text: string, source: SelectionState['source']) => {
    const trimmed = text.trim();
    if (!trimmed || trimmed.length < 2) return;
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setState({
      x: Math.min(x, window.innerWidth - 200),
      y: Math.min(y, window.innerHeight - 120),
      text: trimmed.slice(0, QUOTE_LIMIT),
      source,
    });
  }, []);

  useEffect(() => {
    const onMouseUp = (event: MouseEvent) => {
      if (isEditableTarget(event.target)) return;
      // Click inside the menu itself — let buttons work.
      if ((event.target as HTMLElement)?.closest?.('[data-selection-menu]')) return;
      const selection = window.getSelection();
      const text = selection?.toString() ?? '';
      if (!selection || selection.isCollapsed || !text.trim()) {
        hide();
        return;
      }
      show(event.clientX, event.clientY, text, detectSource(selection.anchorNode));
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide();
    };
    // Scroll: re-anchor the menu to the selection's current viewport
    // position instead of hiding it — scrolling a long chat must not kill
    // the quote/copy flow. (Host-window selections only; plugin-sourced
    // selections have no host selection to track, so those still hide.)
    const onScroll = () => {
      if (!stateRef.current) return;
      if (stateRef.current.source.kind !== 'chat') { hide(); return; }
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) { hide(); return; }
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) { hide(); return; }
      setState((s) => (s ? {
        ...s,
        x: Math.min(rect.left + rect.width / 2 - 80, window.innerWidth - 200),
        y: Math.max(8, Math.min(rect.top - 44, window.innerHeight - 120)),
      } : s));
    };

    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', onScroll, true);

    // Selections reported from plugin iframe panels (via the injected SDK).
    const onPluginSelection = (event: Event) => {
      const detail = (event as CustomEvent).detail as
        | { pluginId: string; text: string; x: number; y: number }
        | undefined;
      if (!detail?.text?.trim()) return;
      show(detail.x, detail.y, detail.text, { kind: 'plugin', pluginId: detail.pluginId, label: detail.pluginId });
    };
    window.addEventListener('pi-plugin-selection', onPluginSelection);

    // Selections from the browser liveview: a separate webContents with no
    // plugin SDK — the main process forwards them from the native
    // context-menu (right-click on selected text), already offset by the
    // BrowserView bounds into host-window coordinates.
    const api = (window as unknown as {
      electronAPI?: { on: (channel: string, cb: (...args: unknown[]) => void) => void; removeListener: (channel: string, cb: (...args: unknown[]) => void) => void };
    }).electronAPI;
    const onBrowserSelection = (data: unknown) => {
      const detail = data as { text?: string; x?: number; y?: number; url?: string } | undefined;
      if (!detail?.text?.trim()) return;
      // data: URLs are unreadable as a label — fall back to the page origin
      // or a plain label; createQuote derives hostname for real URLs.
      const url = detail.url ?? '';
      const label = url.startsWith('data:')
        ? '浏览器页面'
        : url || 'browser';
      show(detail.x ?? 200, detail.y ?? 200, detail.text, {
        kind: 'browser',
        label,
      });
    };
    api?.on('pi:browser-selection', onBrowserSelection);

    return () => {
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('pi-plugin-selection', onPluginSelection);
      api?.removeListener('pi:browser-selection', onBrowserSelection);
    };
  }, [hide, show]);

  if (!state) return null;

  const quoteToComposer = () => {
    const quote = createQuote(state.text, state.source.label, state.source.kind, {});
    useComposerStore.getState().addQuote(quote);
    hide();
  };

  const pluginActions = plugins.flatMap((plugin) =>
    (plugin.selectionActions ?? []).map((action) => ({ pluginId: plugin.id, action })),
  );

  return (
    <div
      data-selection-menu
      data-selection-text={state.text.slice(0, 40)}
      style={{ position: 'fixed', left: state.x, top: Math.max(8, state.y - 44), zIndex: 80 }}
      className="flex items-center gap-0.5 rounded-lg border bg-popover p-1 shadow-md"
    >
      <button
        type="button"
        data-selection-action="quote"
        onClick={quoteToComposer}
        className="rounded-md px-2.5 py-1 text-xs font-medium hover:bg-accent"
      >
        引用到对话
      </button>
      <button
        type="button"
        data-selection-action="copy"
        onClick={() => {
          copyText(state.text).catch(() => {});
          hide();
        }}
        className="rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        复制
      </button>
      {pluginActions.map(({ pluginId, action }) => (
        <button
          key={`${pluginId}:${action.id}`}
          type="button"
          data-selection-action={`${pluginId}:${action.id}`}
          onClick={async () => {
            executeSelectionAction(pluginId, action.id, state.text, {
              kind: state.source.kind,
              pluginId: state.source.pluginId,
              label: state.source.label,
            }).catch((err) => console.error('[selection] action failed:', err));
            hide();
          }}
          className="rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {action.title}
        </button>
      ))}
    </div>
  );
}
