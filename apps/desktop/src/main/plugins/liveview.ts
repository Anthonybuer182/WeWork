import { ipcMain } from 'electron';
import type { BrowserManager } from '@main/browser/browser-manager';

/**
 * LiveView panel slots — generic WebContentsView mount points in the renderer.
 *
 * P4 ships one slot: the browser plugin's preview panel, backed by the shared
 * BrowserView owned by the host BrowserManager. Future liveview providers
 * register additional slot handlers here.
 */
export const BROWSER_LIVEVIEW_SLOT = 'com.pi.browser:preview';

export function registerLiveViewIpcHandlers(browserManager: BrowserManager): void {
  ipcMain.handle('pi:liveview:attach', async (_event, payload: { slotId?: string }) => {
    if (payload?.slotId !== BROWSER_LIVEVIEW_SLOT) {
      return { ok: false, error: `unknown liveview slot: ${payload?.slotId}` };
    }
    // Ensure CDP is attached so navigation events flow.
    await browserManager.connect().catch(() => {});
    return { ok: true };
  });

  ipcMain.handle('pi:liveview:set-bounds', async (_event, payload: {
    slotId?: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  }) => {
    if (payload?.slotId !== BROWSER_LIVEVIEW_SLOT) return { ok: false };
    const { x = 0, y = 0, width = 0, height = 0 } = payload;
    if (width <= 0 || height <= 0) {
      console.log('[liveview] slot reported 0×0 — hiding BrowserView');
      browserManager.hide();
      return { ok: true };
    }
    browserManager.setBounds(Math.round(x), Math.round(y), Math.round(width), Math.round(height));
    // Keep device metrics in sync for auto-zoom (mirrors the legacy preview).
    await browserManager.setDeviceMetrics(Math.round(width), Math.round(height)).catch(() => {});
    return { ok: true };
  });

  ipcMain.handle('pi:liveview:detach', (_event, payload: { slotId?: string }) => {
    if (payload?.slotId !== BROWSER_LIVEVIEW_SLOT) return { ok: false };
    browserManager.hide();
    return { ok: true };
  });
}
