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
    setViewport: (width: number, height: number) => Promise<void>;
    setZoom: (factor: number) => Promise<{ zoom: number }>;
    resetZoom: () => Promise<{ zoom: number }>;
    getZoom: () => Promise<{ zoom: number }>;
    setBounds: (x: number, y: number, width: number, height: number) => Promise<void>;
    getBounds: () => Promise<{ x: number; y: number; width: number; height: number }>;
    executeJavaScript: (code: string) => Promise<{ result: unknown }>;
    goBack: () => Promise<void>;
    goForward: () => Promise<void>;
    reload: () => Promise<void>;
    loadURL: (url: string) => Promise<void>;
    hide: () => Promise<void>;
    onUrlChanged: (callback: (url: string) => void) => void;
    onSwitchToBrowserTab: (callback: () => void) => void;
    onQuote: (callback: (data: { text: string; url: string; title: string }) => void) => void;
  };

  // ── Plugin System ──
  // (exposed as a separate `window.pluginBridge` global — see bottom of file)
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
    setViewport: (width, height) => ipcRenderer.invoke('pi:browser:setViewport', width, height),
    setZoom: (factor) => ipcRenderer.invoke('pi:browser:setZoom', factor),
    resetZoom: () => ipcRenderer.invoke('pi:browser:resetZoom'),
    getZoom: () => ipcRenderer.invoke('pi:browser:getZoom'),
    setBounds: (x, y, width, height) => ipcRenderer.invoke('pi:browser:setBounds', x, y, width, height),
    getBounds: () => ipcRenderer.invoke('pi:browser:getBounds'),
    executeJavaScript: (code) => ipcRenderer.invoke('pi:browser:executeJavaScript', code),
    goBack: () => ipcRenderer.invoke('pi:browser:goBack'),
    goForward: () => ipcRenderer.invoke('pi:browser:goForward'),
    reload: () => ipcRenderer.invoke('pi:browser:reload'),
    loadURL: (url) => ipcRenderer.invoke('pi:browser:loadURL', url),
    hide: () => ipcRenderer.invoke('pi:browser:hide'),
    onUrlChanged: (callback) => {
      ipcRenderer.on('pi:browser:urlChanged', (_event, url) => callback(url));
    },
    onSwitchToBrowserTab: (callback) => {
      ipcRenderer.on('pi:browser:switchToBrowserTab', () => callback());
    },
    onQuote: (callback) => {
      ipcRenderer.on('pi:browser:quote', (_event, data) => callback(data));
    },
  },

};

// ── Plugin System bridge ──────────────────────────────────────────────
// Exposed as its own `window.pluginBridge` global. UI data-plane
// MessagePorts live in this (isolated) world — the main world only sees
// plain-JSON relays through contextBridge.
interface PortLike {
  on(event: 'message', listener: (ev: { data: unknown }) => void): unknown;
  start(): void;
  postMessage(message: unknown): void;
  close(): void;
}

const pluginBridge = (() => {
  const pluginPorts = new Map<string, PortLike>();
  // Messages sent before a port arrives are buffered and flushed on arrival.
  const outbox = new Map<string, unknown[]>();
  let messageCallback: ((pluginId: string, payload: unknown) => void) | null = null;
  let eventCallback: ((event: unknown) => void) | null = null;

  ipcRenderer.on('pi:plugin:port', (event, meta: { pluginId: string }) => {
    const port = (event.ports as unknown as PortLike[] | undefined)?.[0];
    if (!port) return;
    // Replace any previous port for this plugin (fresh pair per ensurePort).
    const old = pluginPorts.get(meta.pluginId);
    if (old) old.close();

    const onPortMessage = (ev: { data: unknown }) => {
      messageCallback?.(meta.pluginId, ev.data);
    };
    if (typeof port.on === 'function') {
      // Electron (EventEmitter-style) MessagePort
      port.on('message', onPortMessage);
      port.start();
    } else {
      // DOM-style MessagePort (isolated world): onmessage auto-starts
      (port as unknown as { onmessage: typeof onPortMessage }).onmessage = onPortMessage;
    }
    pluginPorts.set(meta.pluginId, port);

    // Flush messages queued while the port was in flight (e.g. a panel's
    // initial "mounted" event sent right after ensurePort).
    const queued = outbox.get(meta.pluginId);
    outbox.delete(meta.pluginId);
    for (const payload of queued ?? []) {
      try { port.postMessage(payload); } catch { /* dropped */ }
    }
  });

  ipcRenderer.on('pi:plugin:event', (_event, evt) => eventCallback?.(evt));

  return {
    list: (): Promise<unknown[]> => ipcRenderer.invoke('pi:plugin:list'),
    listAll: (): Promise<unknown[]> => ipcRenderer.invoke('pi:plugin:list-all'),
    ensurePort: (pluginId: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('pi:plugin:ensure-port', { pluginId }),
    executeCommand: (pluginId: string, name: string, args?: string): Promise<{ ok: boolean; result?: unknown; error?: string }> =>
      ipcRenderer.invoke('pi:plugin:execute-command', { pluginId, name, args }),
    market: {
      catalog: (force?: boolean): Promise<{ ok: boolean; plugins: unknown[]; error?: string; registryUrl?: string }> =>
        ipcRenderer.invoke('pi:plugin:market:catalog', { force }),
      install: (pluginId: string): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('pi:plugin:market:install', { pluginId }),
      uninstall: (pluginId: string, keepData?: boolean): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('pi:plugin:uninstall', { pluginId, keepData }),
      setEnabled: (pluginId: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('pi:plugin:set-enabled', { pluginId, enabled }),
    },
    findPreview: (path: string): Promise<{ panelId: string | null }> =>
      ipcRenderer.invoke('pi:plugin:find-preview', { path }),
    collectContext: (message: string): Promise<{ ok: boolean; sections: string[] }> =>
      ipcRenderer.invoke('pi:plugin:collect-context', { message }),
    getSettings: (pluginId: string): Promise<{ ok: boolean; settings?: Record<string, unknown>; error?: string }> =>
      ipcRenderer.invoke('pi:plugin:get-settings', { pluginId }),
    setSetting: (pluginId: string, key: string, value: unknown): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('pi:plugin:set-setting', { pluginId, key, value }),
    listTools: (): Promise<unknown[]> => ipcRenderer.invoke('pi:plugin:list-tools'),
    executeTool: (pluginId: string, name: string, params?: Record<string, unknown>): Promise<{ ok: boolean; content?: unknown[]; details?: unknown; error?: string }> =>
      ipcRenderer.invoke('pi:plugin:execute-tool', { pluginId, name, params }),
    executeSelectionAction: (pluginId: string, actionId: string, text: string, source?: { kind: string; pluginId?: string; label?: string }): Promise<{ ok: boolean; result?: unknown; error?: string }> =>
      ipcRenderer.invoke('pi:plugin:selection-action', { pluginId, actionId, text, source }),
    send: (pluginId: string, payload: unknown): void => {
      const port = pluginPorts.get(pluginId);
      if (port) {
        port.postMessage(payload);
      } else {
        // No port yet (ensurePort in flight) — buffer until it arrives.
        const queue = outbox.get(pluginId) ?? [];
        queue.push(payload);
        outbox.set(pluginId, queue);
      }
    },
    onMessage: (callback: (pluginId: string, payload: unknown) => void): void => {
      messageCallback = callback;
    },
    onEvent: (callback: (event: unknown) => void): void => {
      eventCallback = callback;
    },
  };
})();

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
contextBridge.exposeInMainWorld('pluginBridge', pluginBridge);
