import { ipcMain, BrowserWindow } from 'electron';
import type { BrowserManager } from '@main/browser';

/**
 * Register IPC handlers for browser automation.
 *
 * These handlers are used by the renderer process (React UI) to control
 * the browser. The pi-browser CLI tool goes through the HTTP server
 * instead, but both ultimately call the same BrowserManager.
 */
export function registerBrowserIpcHandlers(browserManager: BrowserManager): void {
  // ── Connect to webview via CDP ──
  // Called by the renderer when the <webview> is ready.
  ipcMain.handle('pi:browser:connect', async () => {
    try {
      await browserManager.connect();
      return { connected: true };
    } catch (err) {
      return {
        connected: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      };
    }
  });

  // ── Navigation ──
  ipcMain.handle('pi:browser:navigate', async (_event, url: string) => {
    return await browserManager.navigate(url);
  });

  ipcMain.handle('pi:browser:getUrl', async () => {
    return await browserManager.getUrl();
  });

  // ── Screenshot ──
  ipcMain.handle('pi:browser:screenshot', async () => {
    return await browserManager.screenshot();
  });

  // ── Viewport ──
  ipcMain.handle('pi:browser:setViewport', async (_event, width: number, height: number) => {
    await browserManager.setDeviceMetrics(width, height);
  });

  // ── Zoom ──
  ipcMain.handle('pi:browser:setZoom', async (_event, factor: number) => {
    return await browserManager.setZoom(factor);
  });

  ipcMain.handle('pi:browser:resetZoom', async () => {
    return await browserManager.resetZoom();
  });

  ipcMain.handle('pi:browser:getZoom', async () => {
    return { zoom: browserManager.getZoom() };
  });

  // ── Events (main → renderer) ──
  // Register callbacks that forward to all renderer windows
  browserManager.onUrlChanged((url) => {
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send('pi:browser:urlChanged', url);
    });
  });

  // When the BrowserManager needs the Browser tab to be open (e.g. CLI
  // commands arrive while the user is on the Preview tab), forward the
  // request to the renderer to switch tabs.
  browserManager.onSwitchToBrowserTab(() => {
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send('pi:browser:switchToBrowserTab');
    });
  });
}
