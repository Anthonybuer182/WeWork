import { useEffect, useRef, useState } from 'react';
import { MonitorX } from 'lucide-react';

/**
 * Live slot: a native WebContentsView mount point. The component
 * reports its viewport-relative bounds to the main process, which positions
 * the view over this slot; on unmount the view detaches (hidden).
 */
export function LiveSlot({
  pluginId,
  panelId,
  /**
   * Plugin web panels: tell the backend the panel mounted, and re-tell it when
   * the open params change (switching files in the same panel). The event has
   * to travel over the panel's own MessagePort, which lives in the view's
   * preload — so it goes shell → main → view rather than straight to the
   * backend, unlike the iframe path where the shell held the port itself.
   *
   * Off by default: host-managed slots (the browser preview) have no backend
   * panel to mount.
   */
  notifyMounted = false,
  params,
}: {
  pluginId: string;
  panelId: string;
  notifyMounted?: boolean;
  params?: unknown;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!notifyMounted) return;
    const api = (window as unknown as {
      electronAPI?: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    }).electronAPI;
    if (!api?.invoke) return;
    // Re-fires whenever params change; the view's preload queues it if the
    // panel's page (and its port) are not up yet.
    api.invoke('pi:plugin:panel-mounted', { pluginId, panelId, params }).catch(() => {});
  }, [pluginId, panelId, params, notifyMounted]);

  useEffect(() => {
    const api = (window as unknown as {
      electronAPI?: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    }).electronAPI;
    if (!api) {
      // Browser build: there is no host to create a native view.
      setError('原生视图仅在桌面端可用');
      return;
    }

    const slotId = `${pluginId}:${panelId}`;
    let lastBounds = '';
    let timer: ReturnType<typeof setTimeout> | null = null;

    const reportBounds = () => {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const bounds = {
        slotId,
        x: Math.round(rect.x + window.scrollX),
        y: Math.round(rect.y + window.scrollY),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
      const key = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
      if (key === lastBounds) return;
      lastBounds = key;
      // Report every transition — including 0×0 (panel switched away under
      // keepAlive renders this slot display:none). Main hides the view for
      // non-positive dims; skipping the report here would leave the view at
      // stale bounds, an invisible overlay eating real mouse clicks.
      api.invoke('pi:liveview:set-bounds', bounds).catch(() => {});
    };

    api
      .invoke('pi:liveview:attach', { slotId })
      .then((res) => {
        // The host answers `{ok:false}` for a slot it has no handler for. That
        // resolves rather than rejects, so an unchecked call would leave the
        // panel silently empty — the plugin author's only clue would be a
        // blank box. Surface it instead.
        const r = res as { ok?: boolean; error?: string } | undefined;
        if (r && r.ok === false) {
          setError(r.error ?? '该面板没有可用的原生视图');
          return;
        }
        setError(null);
        reportBounds();
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      });

    const observer = new ResizeObserver(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(reportBounds, 50);
    });
    if (containerRef.current) observer.observe(containerRef.current);
    // Also observe window resizes (layout shifts without element resize).
    const onWindowResize = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(reportBounds, 50);
    };
    window.addEventListener('resize', onWindowResize);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', onWindowResize);
      if (timer) clearTimeout(timer);
      api.invoke('pi:liveview:detach', { slotId }).catch(() => {});
    };
  }, [pluginId, panelId]);

  if (error) {
    return (
      <div
        className="flex h-full w-full flex-col items-center justify-center gap-2 p-6 text-center"
        data-panel-kind="live-slot-error"
        data-live-slot={`${pluginId}:${panelId}`}
      >
        <MonitorX className="h-6 w-6 text-muted-foreground/60" />
        <p className="text-sm text-muted-foreground">此面板需要原生视图支持</p>
        <p className="text-[11px] text-muted-foreground/70 break-all max-w-full">{error}</p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      data-panel-kind="live-slot"
      data-live-slot={`${pluginId}:${panelId}`}
      className="h-full w-full bg-background"
    />
  );
}
