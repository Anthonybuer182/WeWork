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
  // ── Connect to BrowserView via CDP ──
  // Called by the renderer when the Browser tab is opened.
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

  // ── Bounds (renderer reports placeholder div position) ──
  ipcMain.handle('pi:browser:setBounds', async (_event, x: number, y: number, width: number, height: number) => {
    browserManager.setBounds(x, y, width, height);
  });

  ipcMain.handle('pi:browser:getBounds', async () => {
    return browserManager.getBounds();
  });

  ipcMain.handle('pi:browser:hide', async () => {
    browserManager.hide();
  });

  // ── Execute JavaScript in page ──
  ipcMain.handle('pi:browser:executeJavaScript', async (_event, code: string) => {
    return await browserManager.evaluate(code);
  });

  // ── Navigation ──
  ipcMain.handle('pi:browser:navigate', async (_event, url: string) => {
    return await browserManager.navigate(url);
  });

  ipcMain.handle('pi:browser:getUrl', async () => {
    return await browserManager.getUrl();
  });

  // ── Toolbar navigation (back/forward/reload) ──
  ipcMain.handle('pi:browser:goBack', async () => {
    browserManager.navigateBack();
  });

  ipcMain.handle('pi:browser:goForward', async () => {
    browserManager.navigateForward();
  });

  ipcMain.handle('pi:browser:reload', async () => {
    browserManager.reload();
  });

  ipcMain.handle('pi:browser:loadURL', async (_event, url: string) => {
    browserManager.loadURL(url);
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
