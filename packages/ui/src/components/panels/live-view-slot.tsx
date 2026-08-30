import { useEffect, useRef } from 'react';

/**
 * Tier 2 liveview slot: a native WebContentsView mount point. The component
 * reports its viewport-relative bounds to the main process, which positions
 * the view over this slot; on unmount the view detaches (hidden).
 */
export function LiveViewSlot({ pluginId, panelId }: { pluginId: string; panelId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const api = (window as unknown as {
      electronAPI?: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    }).electronAPI;
    if (!api) return;

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
      if (bounds.width > 0 && bounds.height > 0) {
        api.invoke('pi:liveview:set-bounds', bounds).catch(() => {});
      }
    };

    api.invoke('pi:liveview:attach', { slotId }).then(() => {
      reportBounds();
    }).catch(() => {});

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

  return (
    <div
      ref={containerRef}
      data-panel-kind="liveview"
      data-liveview-slot={`${pluginId}:${panelId}`}
      className="h-full w-full bg-background"
    />
  );
}
