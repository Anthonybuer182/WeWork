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

  // ── Recording ──
  ipcMain.handle('pi:browser:record:start', async () => {
    return await browserManager.startRecording();
  });

  ipcMain.handle('pi:browser:record:stop', async () => {
    return await browserManager.stopRecording();
  });

  // ── Workflows ──
  ipcMain.handle('pi:browser:saveWorkflow', async (_event, name: string, steps: unknown) => {
    return await browserManager.saveWorkflow(name, steps as Parameters<typeof browserManager.saveWorkflow>[1]);
  });

  ipcMain.handle('pi:browser:listWorkflows', async () => {
    return await browserManager.listWorkflows();
  });

  ipcMain.handle('pi:browser:deleteWorkflow', async (_event, name: string) => {
    return await browserManager.deleteWorkflow(name);
  });

  ipcMain.handle('pi:browser:replay', async (_event, name: string, variables?: Record<string, string>) => {
    return await browserManager.replay(name, variables ?? {});
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

  browserManager.onRecordingState((recording) => {
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send('pi:browser:recordingState', recording);
    });
  });

  browserManager.onReplayProgress((current, total, step) => {
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send('pi:browser:replayProgress', { current, total, step });
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
