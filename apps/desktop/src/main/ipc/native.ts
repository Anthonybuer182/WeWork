import { ipcMain, dialog, shell, clipboard, app, BrowserWindow, nativeImage } from 'electron';
import fs from 'fs';
import path from 'path';
import { TITLE_BAR_HEIGHT } from '../window-manager.js';

export function registerNativeIpcHandlers(): void {
  // ── Window Management ──

  ipcMain.handle('pi:window:minimize', () => {
    BrowserWindow.getFocusedWindow()?.minimize();
  });

  ipcMain.handle('pi:window:maximize', () => {
    const win = BrowserWindow.getFocusedWindow();
    if (win?.isMaximized()) {
      win.unmaximize();
    } else {
      win?.maximize();
    }
  });

  ipcMain.handle('pi:window:close', () => {
    BrowserWindow.getFocusedWindow()?.close();
  });

  ipcMain.handle('pi:window:isMaximized', () => {
    return BrowserWindow.getFocusedWindow()?.isMaximized() ?? false;
  });

  // Keep the Windows titleBarOverlay in step with the app theme. Throws (and is
  // swallowed) on macOS/Linux, which have no overlay to update.
  ipcMain.handle(
    'pi:window:setTitleBarOverlay',
    (_event, options: { color: string; symbolColor: string }) => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      if (!win) return;
      try {
        win.setTitleBarOverlay({
          color: options.color,
          symbolColor: options.symbolColor,
          height: TITLE_BAR_HEIGHT,
        });
      } catch {
        // Not supported on this platform.
      }
    },
  );

  // ── File Dialogs ──

  ipcMain.handle('pi:dialog:openFile', async (_event, options?: Electron.OpenDialogOptions) => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return { canceled: true, filePaths: [] };
    return dialog.showOpenDialog(win, {
      properties: ['openFile'],
      ...options,
    });
  });

  ipcMain.handle('pi:dialog:openDirectory', async (_event, options?: Electron.OpenDialogOptions) => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return { canceled: true, filePaths: [] };
    return dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      ...options,
    });
  });

  ipcMain.handle('pi:dialog:saveFile', async (_event, options?: Electron.SaveDialogOptions) => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return { canceled: true, filePath: undefined };
    return dialog.showSaveDialog(win, options ?? {});
  });

  // ── File System ──

  ipcMain.handle('pi:fs:readFile', async (_event, filePath: string) => {
    try {
      const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
      const content = fs.readFileSync(resolved, 'utf-8');
      return { content, path: resolved };
    } catch (err) {
      throw new Error(`Failed to read file: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  });

  ipcMain.handle('pi:fs:writeFile', async (_event, filePath: string, content: string) => {
    try {
      const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, content, 'utf-8');
      return { success: true, path: resolved };
    } catch (err) {
      throw new Error(`Failed to write file: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  });

  ipcMain.handle('pi:fs:readFileBuffer', async (_event, filePath: string) => {
    try {
      const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
      const buffer = fs.readFileSync(resolved);
      return { buffer, path: resolved };
    } catch (err) {
      throw new Error(`Failed to read file buffer: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  });

  ipcMain.handle('pi:fs:writeFileBuffer', async (_event, filePath: string, buffer: ArrayBuffer) => {
    try {
      const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, Buffer.from(buffer));
      return { success: true, path: resolved };
    } catch (err) {
      throw new Error(`Failed to write file buffer: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  });

  ipcMain.handle('pi:fs:stat', async (_event, filePath: string) => {
    try {
      const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
      const stat = fs.statSync(resolved);
      return {
        exists: true,
        isFile: stat.isFile(),
        isDirectory: stat.isDirectory(),
        size: stat.size,
        mtime: stat.mtime.toISOString(),
        ctime: stat.ctime.toISOString(),
      };
    } catch {
      return { exists: false };
    }
  });

  ipcMain.handle('pi:fs:exists', async (_event, filePath: string) => {
    const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
    return fs.existsSync(resolved);
  });

  ipcMain.handle('pi:fs:mkdir', async (_event, dirPath: string) => {
    try {
      const resolved = path.isAbsolute(dirPath) ? dirPath : path.resolve(dirPath);
      fs.mkdirSync(resolved, { recursive: true });
      return { success: true, path: resolved };
    } catch (err) {
      throw new Error(`Failed to create directory: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  });

  ipcMain.handle('pi:fs:listDir', async (_event, dirPath: string) => {
    try {
      const resolved = path.isAbsolute(dirPath) ? dirPath : path.resolve(dirPath);
      const entries = fs.readdirSync(resolved, { withFileTypes: true });
      return entries.map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
        path: path.join(resolved, entry.name),
      }));
    } catch (err) {
      throw new Error(`Failed to list directory: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  });

  ipcMain.handle('pi:fs:delete', async (_event, targetPath: string) => {
    try {
      const resolved = path.isAbsolute(targetPath) ? targetPath : path.resolve(targetPath);
      if (fs.statSync(resolved).isDirectory()) {
        fs.rmSync(resolved, { recursive: true, force: true });
      } else {
        fs.unlinkSync(resolved);
      }
      return { success: true };
    } catch (err) {
      throw new Error(`Failed to delete: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  });

  ipcMain.handle('pi:fs:rename', async (_event, oldPath: string, newPath: string) => {
    try {
      const resolvedOld = path.isAbsolute(oldPath) ? oldPath : path.resolve(oldPath);
      const resolvedNew = path.isAbsolute(newPath) ? newPath : path.resolve(newPath);
      fs.renameSync(resolvedOld, resolvedNew);
      return { success: true, path: resolvedNew };
    } catch (err) {
      throw new Error(`Failed to rename: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  });

  // ── Shell ──

  ipcMain.handle('pi:shell:openExternal', async (_event, url: string) => {
    await shell.openExternal(url);
  });

  ipcMain.handle('pi:shell:openPath', async (_event, targetPath: string) => {
    const resolved = path.isAbsolute(targetPath) ? targetPath : path.resolve(targetPath);
    await shell.openPath(resolved);
  });

  ipcMain.handle('pi:shell:showItemInFolder', (_event, targetPath: string) => {
    const resolved = path.isAbsolute(targetPath) ? targetPath : path.resolve(targetPath);
    shell.showItemInFolder(resolved);
  });

  // ── Clipboard ──

  ipcMain.handle('pi:clipboard:write', (_event, text: string) => {
    clipboard.writeText(text);
  });

  ipcMain.handle('pi:clipboard:read', () => {
    return clipboard.readText();
  });

  ipcMain.handle('pi:clipboard:writeImage', (_event, imagePath: string) => {
    const resolved = path.isAbsolute(imagePath) ? imagePath : path.resolve(imagePath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Image file not found: ${resolved}`);
    }
    const img = nativeImage.createFromPath(resolved);
    if (img.isEmpty()) {
      throw new Error(`Failed to load image from: ${resolved}`);
    }
    clipboard.writeImage(img);
  });

  ipcMain.handle('pi:clipboard:clear', () => {
    clipboard.clear();
  });

  // ── App Info ──

  ipcMain.handle('pi:app:getPath', (_event, name: string) => {
    const validPaths = ['home', 'appData', 'userData', 'sessionData', 'temp', 'exe', 'module', 'desktop', 'documents', 'downloads', 'music', 'pictures', 'videos', 'recent', 'logs', 'crashDumps'];
    if (!validPaths.includes(name)) {
      throw new Error(`Invalid path name: ${name}. Valid names: ${validPaths.join(', ')}`);
    }
    return app.getPath(name as any);
  });

  ipcMain.handle('pi:app:getVersion', () => {
    return app.getVersion();
  });
}
