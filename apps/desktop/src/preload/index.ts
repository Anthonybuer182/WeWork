import { contextBridge, ipcRenderer } from 'electron';

export interface ElectronAPI {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeListener: (channel: string, callback: (...args: unknown[]) => void) => void;

  // ── Window Management ──
  window: {
    minimize: () => Promise<void>;
    maximize: () => Promise<void>;
    close: () => Promise<void>;
    isMaximized: () => Promise<boolean>;
  };

  // ── Dialogs ──
  dialog: {
    openFile: (options?: Record<string, unknown>) => Promise<Electron.OpenDialogReturnValue>;
    openDirectory: (options?: Record<string, unknown>) => Promise<Electron.OpenDialogReturnValue>;
    saveFile: (options?: Record<string, unknown>) => Promise<Electron.SaveDialogReturnValue>;
  };

  // ── File System ──
  fs: {
    readFile: (path: string) => Promise<{ content: string; path: string }>;
    writeFile: (path: string, content: string) => Promise<{ success: boolean; path: string }>;
    readFileBuffer: (path: string) => Promise<{ buffer: ArrayBuffer; path: string }>;
    writeFileBuffer: (path: string, buffer: ArrayBuffer) => Promise<{ success: boolean; path: string }>;
    stat: (path: string) => Promise<FileStat>;
    exists: (path: string) => Promise<boolean>;
    mkdir: (path: string) => Promise<{ success: boolean; path: string }>;
    listDir: (path: string) => Promise<DirEntry[]>;
    delete: (path: string) => Promise<{ success: boolean }>;
    rename: (oldPath: string, newPath: string) => Promise<{ success: boolean; path: string }>;
  };

  // ── Shell ──
  shell: {
    openExternal: (url: string) => Promise<void>;
    openPath: (path: string) => Promise<void>;
    showItemInFolder: (path: string) => Promise<void>;
  };

  // ── Clipboard ──
  clipboard: {
    write: (text: string) => Promise<void>;
    read: () => Promise<string>;
    writeImage: (path: string) => Promise<void>;
    clear: () => Promise<void>;
  };

  // ── App ──
  app: {
    getPath: (name: string) => Promise<string>;
    getVersion: () => Promise<string>;
  };

  // ── Browser Automation ──
  browser: {
    connect: () => Promise<{ connected: boolean; error?: string }>;
    navigate: (url: string) => Promise<{ url: string; title: string }>;
    getUrl: () => Promise<{ url: string; title: string }>;
    screenshot: () => Promise<{ base64: string }>;
    startRecording: () => Promise<{ started: boolean }>;
    stopRecording: () => Promise<{ steps: unknown[] }>;
    saveWorkflow: (name: string, steps: unknown[]) => Promise<{ name: string; saved: boolean }>;
    listWorkflows: () => Promise<unknown[]>;
    deleteWorkflow: (name: string) => Promise<{ name: string; deleted: boolean }>;
    replay: (name: string, variables?: Record<string, string>) => Promise<{ name: string; completed: boolean; stepCount: number }>;
    setViewport: (width: number, height: number) => Promise<void>;
    setZoom: (factor: number) => Promise<{ zoom: number }>;
    resetZoom: () => Promise<{ zoom: number }>;
    getZoom: () => Promise<{ zoom: number }>;
    onUrlChanged: (callback: (url: string) => void) => void;
    onRecordingState: (callback: (recording: boolean) => void) => void;
    onReplayProgress: (callback: (progress: { current: number; total: number; step: unknown }) => void) => void;
  };
}

export interface FileStat {
  exists: boolean;
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  mtime: string;
  ctime: string;
}

export interface DirEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  path: string;
}

const electronAPI: ElectronAPI = {
  invoke: (channel: string, ...args: unknown[]): Promise<unknown> => {
    return ipcRenderer.invoke(channel, ...args);
  },
  on: (channel: string, callback: (...args: unknown[]) => void): void => {
    ipcRenderer.on(channel, (_event, ...args) => callback(...args));
  },
  removeListener: (channel: string, callback: (...args: unknown[]) => void): void => {
    ipcRenderer.removeListener(channel, callback);
  },

  window: {
    minimize: () => ipcRenderer.invoke('pi:window:minimize'),
    maximize: () => ipcRenderer.invoke('pi:window:maximize'),
    close: () => ipcRenderer.invoke('pi:window:close'),
    isMaximized: () => ipcRenderer.invoke('pi:window:isMaximized'),
  },

  dialog: {
    openFile: (options) => ipcRenderer.invoke('pi:dialog:openFile', options),
    openDirectory: (options) => ipcRenderer.invoke('pi:dialog:openDirectory', options),
    saveFile: (options) => ipcRenderer.invoke('pi:dialog:saveFile', options),
  },

  fs: {
    readFile: (p) => ipcRenderer.invoke('pi:fs:readFile', p),
    writeFile: (p, content) => ipcRenderer.invoke('pi:fs:writeFile', p, content),
    readFileBuffer: (p) => ipcRenderer.invoke('pi:fs:readFileBuffer', p),
    writeFileBuffer: (p, buf) => ipcRenderer.invoke('pi:fs:writeFileBuffer', p, buf),
    stat: (p) => ipcRenderer.invoke('pi:fs:stat', p),
    exists: (p) => ipcRenderer.invoke('pi:fs:exists', p),
    mkdir: (p) => ipcRenderer.invoke('pi:fs:mkdir', p),
    listDir: (p) => ipcRenderer.invoke('pi:fs:listDir', p),
    delete: (p) => ipcRenderer.invoke('pi:fs:delete', p),
    rename: (oldPath, newPath) => ipcRenderer.invoke('pi:fs:rename', oldPath, newPath),
  },

  shell: {
    openExternal: (url) => ipcRenderer.invoke('pi:shell:openExternal', url),
    openPath: (p) => ipcRenderer.invoke('pi:shell:openPath', p),
    showItemInFolder: (p) => ipcRenderer.invoke('pi:shell:showItemInFolder', p),
  },

  clipboard: {
    write: (text) => ipcRenderer.invoke('pi:clipboard:write', text),
    read: () => ipcRenderer.invoke('pi:clipboard:read'),
    writeImage: (p) => ipcRenderer.invoke('pi:clipboard:writeImage', p),
    clear: () => ipcRenderer.invoke('pi:clipboard:clear'),
  },

  app: {
    getPath: (name) => ipcRenderer.invoke('pi:app:getPath', name),
    getVersion: () => ipcRenderer.invoke('pi:app:getVersion'),
  },

  browser: {
    connect: () => ipcRenderer.invoke('pi:browser:connect'),
    navigate: (url) => ipcRenderer.invoke('pi:browser:navigate', url),
    getUrl: () => ipcRenderer.invoke('pi:browser:getUrl'),
    screenshot: () => ipcRenderer.invoke('pi:browser:screenshot'),
    startRecording: () => ipcRenderer.invoke('pi:browser:record:start'),
    stopRecording: () => ipcRenderer.invoke('pi:browser:record:stop'),
    saveWorkflow: (name, steps) => ipcRenderer.invoke('pi:browser:saveWorkflow', name, steps),
    listWorkflows: () => ipcRenderer.invoke('pi:browser:listWorkflows'),
    deleteWorkflow: (name) => ipcRenderer.invoke('pi:browser:deleteWorkflow', name),
    replay: (name, variables?) => ipcRenderer.invoke('pi:browser:replay', name, variables),
    setViewport: (width, height) => ipcRenderer.invoke('pi:browser:setViewport', width, height),
    setZoom: (factor) => ipcRenderer.invoke('pi:browser:setZoom', factor),
    resetZoom: () => ipcRenderer.invoke('pi:browser:resetZoom'),
    getZoom: () => ipcRenderer.invoke('pi:browser:getZoom'),
    onUrlChanged: (callback) => {
      ipcRenderer.on('pi:browser:urlChanged', (_event, url) => callback(url));
    },
    onRecordingState: (callback) => {
      ipcRenderer.on('pi:browser:recordingState', (_event, recording) => callback(recording));
    },
    onReplayProgress: (callback) => {
      ipcRenderer.on('pi:browser:replayProgress', (_event, progress) => callback(progress));
    },
  },
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
