import { ipcMain } from 'electron';

/**
 * LiveView panel slots — generic native-view mount points.
 *
 * A liveview panel is backed by a real `WebContentsView` that lives OUTSIDE the
 * renderer's DOM. The renderer therefore cannot lay it out: it only measures the
 * rectangle its slot occupies and reports it here, and the host positions the
 * view to match.
 *
 * Two consequences drive this design:
 *  - A view that is not hidden **occludes the DOM and swallows clicks**. Hiding
 *    is not cosmetic; the renderer reports degenerate (0×0) bounds when its slot
 *    is unmounted or display:none, and that must map to a hidden view.
 *  - A renderer reload skips React cleanup entirely, so a slot can vanish
 *    without ever calling detach. `hideAll()` is the guard for that case.
 *
 * Multiple slots are supported: each registers its own handler, and each owns
 * its own view, so slots never fight over bounds (which they would if they all
 * drove one shared view).
 *
 * Slots are not a plugin-facing concept. Plugin panels are hosted by
 * `plugin-webview.ts` (one slot per panel, keyed `<pluginId>:<panelId>`); the
 * host's own browser registers its view as `host:browser`. There is no
 * plugin-visible manifest field for either — a plugin just provides a page.
 */
export interface LiveViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LiveViewHandler {
  /** Called when the slot mounts. Use for one-time warm-up (e.g. connect CDP). */
  attach?(): void | Promise<void>;
  /** Position and reveal the view. Bounds are in window-content coordinates. */
  show(bounds: LiveViewBounds): void | Promise<void>;
  /** Hide the view so it neither paints nor intercepts input. */
  hide(): void;
}

/** Slot id of the host's embedded browser view. */
export const HOST_BROWSER_SLOT = 'host:browser';

export class LiveViewRegistry {
  private handlers = new Map<string, LiveViewHandler>();

  register(slotId: string, handler: LiveViewHandler): void {
    if (this.handlers.has(slotId)) {
      console.warn(`[liveview] slot "${slotId}" is already registered — replacing`);
    }
    this.handlers.set(slotId, handler);
  }

  unregister(slotId: string): void {
    this.handlers.get(slotId)?.hide();
    this.handlers.delete(slotId);
  }

  has(slotId: string): boolean {
    return this.handlers.has(slotId);
  }

  slots(): string[] {
    return [...this.handlers.keys()];
  }

  async attach(slotId: string): Promise<{ ok: boolean; error?: string }> {
    const handler = this.handlers.get(slotId);
    if (!handler) return { ok: false, error: `unknown liveview slot: ${slotId}` };
    await handler.attach?.();
    return { ok: true };
  }

  async setBounds(
    slotId: string,
    bounds: LiveViewBounds,
  ): Promise<{ ok: boolean; error?: string }> {
    const handler = this.handlers.get(slotId);
    if (!handler) return { ok: false, error: `unknown liveview slot: ${slotId}` };

    const { x, y, width, height } = bounds;
    // Degenerate bounds mean "not laid out" — a collapsed sidebar, a hidden
    // panel, or an unmounted slot. Hide rather than position a zero-size view.
    if (width <= 0 || height <= 0) {
      handler.hide();
      return { ok: true };
    }
    await handler.show({
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height),
    });
    return { ok: true };
  }

  detach(slotId: string): { ok: boolean } {
    this.handlers.get(slotId)?.hide();
    return { ok: true };
  }

  /**
   * Hide every view. Called when the renderer navigates: a reload never runs
   * React cleanup, so slots would otherwise keep stale bounds and invisibly
   * occlude the UI, eating real mouse clicks.
   */
  hideAll(): void {
    for (const handler of this.handlers.values()) {
      try {
        handler.hide();
      } catch (err) {
        console.error('[liveview] hide failed:', err);
      }
    }
  }
}

export function registerLiveViewIpcHandlers(registry: LiveViewRegistry): void {
  ipcMain.handle('pi:liveview:attach', (_event, payload: { slotId?: string }) =>
    registry.attach(String(payload?.slotId ?? '')),
  );

  ipcMain.handle(
    'pi:liveview:set-bounds',
    (
      _event,
      payload: { slotId?: string; x?: number; y?: number; width?: number; height?: number },
    ) =>
      registry.setBounds(String(payload?.slotId ?? ''), {
        x: payload?.x ?? 0,
        y: payload?.y ?? 0,
        width: payload?.width ?? 0,
        height: payload?.height ?? 0,
      }),
  );

  ipcMain.handle('pi:liveview:detach', (_event, payload: { slotId?: string }) =>
    registry.detach(String(payload?.slotId ?? '')),
  );
}
