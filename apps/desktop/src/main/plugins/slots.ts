import { ipcMain } from 'electron';

/**
 * Live slots — generic native-view mount points.
 *
 * A live slot is backed by a real `WebContentsView` that lives OUTSIDE the
 * renderer's DOM. The renderer therefore cannot lay it out: it only measures the
 * rectangle its slot occupies and reports it here, and the host positions the
 * view to match.
 *
 * Naming note: the wire channels below are still `pi:liveview:*` — a historical
 * name from when this mechanism served the (since removed) liveview panel kind.
 * The channels are internal, shared with the web build's LiveSlot component;
 * not worth a breaking rename.
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
 * `plugin-webview.ts` (one slot per panel, keyed `<pluginId>:<panelId>`), and a
 * host engine view (the embedded browser) is registered by `plugin-webview.ts`
 * the same way under `<pluginId>:<slotName>` when the plugin's page declares a
 * live slot via `piSDK.liveSlot`. There is no plugin-visible manifest field for
 * any of this — a plugin just provides a page.
 */
export interface LiveSlotBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LiveSlotHandler {
  /** Called when the slot mounts. Use for one-time warm-up (e.g. connect CDP). */
  attach?(): void | Promise<void>;
  /** Position and reveal the view. Bounds are in window-content coordinates. */
  show(bounds: LiveSlotBounds): void | Promise<void>;
  /** Hide the view so it neither paints nor intercepts input. */
  hide(): void;
}

export class LiveSlotRegistry {
  private handlers = new Map<string, LiveSlotHandler>();
  /**
   * The last non-degenerate bounds each slot was shown at.
   *
   * `reshow` replays them for slots whose reporter cannot re-report on its own:
   * a reused plugin panel view remounts with its page exactly as it was, so its
   * ResizeObserver never fires again — but the engine view positioned inside
   * that page must come back. detach/hide deliberately do NOT clear the
   * memory; only a degenerate setBounds (the "this slot is gone" signal) does.
   */
  private lastShown = new Map<string, LiveSlotBounds>();

  register(slotId: string, handler: LiveSlotHandler): void {
    if (this.handlers.has(slotId)) {
      console.warn(`[slots] slot "${slotId}" is already registered — replacing`);
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
    if (!handler) return { ok: false, error: `unknown live slot: ${slotId}` };
    await handler.attach?.();
    return { ok: true };
  }

  async setBounds(
    slotId: string,
    bounds: LiveSlotBounds,
  ): Promise<{ ok: boolean; error?: string }> {
    const handler = this.handlers.get(slotId);
    if (!handler) return { ok: false, error: `unknown live slot: ${slotId}` };

    const { x, y, width, height } = bounds;
    // Degenerate bounds mean "not laid out" — a collapsed sidebar, a hidden
    // panel, or an unmounted slot. Hide rather than position a zero-size view.
    if (width <= 0 || height <= 0) {
      handler.hide();
      this.lastShown.delete(slotId);
      return { ok: true };
    }
    const shown = {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height),
    };
    this.lastShown.set(slotId, shown);
    await handler.show(shown);
    return { ok: true };
  }

  /**
   * Re-show a hidden slot at its last known bounds.
   *
   * For slots whose page cannot re-report (a reused panel view remounts with
   * the page exactly as it was — no resize, no observer fire). Fails with
   * `never shown` when there is nothing to replay; callers treat that as
   * "nothing to do", not as an error to surface.
   */
  async reshow(slotId: string): Promise<{ ok: boolean; error?: string }> {
    const handler = this.handlers.get(slotId);
    if (!handler) return { ok: false, error: `unknown live slot: ${slotId}` };
    const bounds = this.lastShown.get(slotId);
    if (!bounds) return { ok: false, error: 'never shown' };
    await handler.show(bounds);
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
        console.error('[slots] hide failed:', err);
      }
    }
  }
}

export function registerLiveSlotIpcHandlers(registry: LiveSlotRegistry): void {
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
