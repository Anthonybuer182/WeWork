import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, RotateCw } from 'lucide-react';
import { LiveViewSlot } from '@/components/panels/live-view-slot';

/** The liveview slot id main registers the host browser view under. */
const BROWSER_SLOT = { pluginId: 'host', panelId: 'browser' } as const;

type BrowserApi = {
  navigate: (url: string) => Promise<{ url: string; title: string }>;
  getUrl: () => Promise<{ url: string; title: string }>;
  goBack: () => Promise<void>;
  goForward: () => Promise<void>;
  reload: () => Promise<void>;
  onUrlChanged?: (cb: (url: string) => void) => void;
};

function getBrowserApi(): BrowserApi | null {
  if (typeof window === 'undefined') return null;
  const api = (window as unknown as { electronAPI?: { browser?: BrowserApi } }).electronAPI;
  return api?.browser ?? null;
}

/**
 * The embedded browser — a HOST panel.
 *
 * The view this panel shows is the host's own: the agent's browser tools
 * (browser_navigate / browser_screenshot) drive the very same WebContentsView.
 * That is why it lives here rather than in a plugin. A plugin panel is a page
 * the plugin provides; this is the opposite — the plugin provides nothing, and
 * the host lends a resource it owns.
 *
 * The toolbar used to be a separate 44px iframe panel contributed by the
 * browser plugin. It only ever called host capabilities (navigate / back /
 * forward / reload), so it is plain React here over the existing browser IPC —
 * one fewer container, one fewer panel, no plugin backend involved.
 */
export function BrowserPanel() {
  const [url, setUrl] = useState('');
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    const api = getBrowserApi();
    if (!api) return;
    api
      .getUrl()
      .then((s) => setUrl(s?.url ?? ''))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const api = getBrowserApi();
    // The agent may navigate at any time; keep the address bar honest.
    api?.onUrlChanged?.((next) => setUrl(next ?? ''));
  }, [refresh]);

  const run = useCallback(
    (action: () => Promise<unknown>) => {
      void action()
        .then(() => setTimeout(refresh, 120))
        .catch(() => setTimeout(refresh, 120));
    },
    [refresh],
  );

  const submit = useCallback(() => {
    const value = (draft ?? '').trim();
    if (!value) return;
    const api = getBrowserApi();
    if (!api) return;
    setDraft(null);
    run(() => api.navigate(value));
  }, [draft, run]);

  // `draft` is null until the user types, so the field tracks navigation from
  // the agent without yanking text out from under a half-typed address.
  const shown = draft ?? url;

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex h-11 shrink-0 items-center gap-1.5 border-b px-2">
        <button
          type="button"
          title="后退"
          aria-label="后退"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => {
            const api = getBrowserApi();
            if (api) run(() => api.goBack());
          }}
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <button
          type="button"
          title="前进"
          aria-label="前进"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => {
            const api = getBrowserApi();
            if (api) run(() => api.goForward());
          }}
        >
          <ArrowRight className="h-4 w-4" />
        </button>
        <button
          type="button"
          title="刷新"
          aria-label="刷新"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => {
            const api = getBrowserApi();
            if (api) run(() => api.reload());
          }}
        >
          <RotateCw className="h-4 w-4" />
        </button>
        <input
          ref={inputRef}
          value={shown}
          spellCheck={false}
          placeholder="输入网址，回车打开…"
          aria-label="地址"
          className="min-w-0 flex-1 rounded-md border bg-background px-2.5 py-1 text-[12.5px] text-foreground outline-none focus:border-primary"
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            if (e.key === 'Escape') {
              setDraft(null);
              inputRef.current?.blur();
            }
          }}
        />
      </div>
      <div className="min-h-0 flex-1">
        <LiveViewSlot pluginId={BROWSER_SLOT.pluginId} panelId={BROWSER_SLOT.panelId} />
      </div>
    </div>
  );
}
