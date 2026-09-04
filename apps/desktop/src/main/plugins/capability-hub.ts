import { app, Notification, net } from 'electron';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { CapabilityMethod, PluginEvent, PluginPanelStatus } from '@pi/types';
import type { PluginRegistry } from './registry';
import type { BrowserManager } from '@main/browser/browser-manager';
import { extractOfficeText } from './office-extract';

export interface CapabilityDeps {
  registry: PluginRegistry;
  emitEvent: (evt: PluginEvent) => void;
  /** Browser automation capability (host-owned; plugins need "browser" permission). */
  browserManager?: BrowserManager;
}

interface CapabilitySpec {
  /** Manifest permission required to invoke; omit for always-allowed. */
  permission?: string;
  handler: (ctx: { pluginId: string; dataDir: string; params: Record<string, unknown> }) => Promise<unknown> | unknown;
}

/**
 * Routes host.* capability calls from plugin backends, enforcing the
 * permissions declared in each plugin's manifest.
 */
export class CapabilityHub {
  private readonly registry: PluginRegistry;
  private readonly emitEvent: (evt: PluginEvent) => void;
  private readonly browserManager?: BrowserManager;
  private readonly capabilities = new Map<string, CapabilitySpec>();

  constructor(deps: CapabilityDeps) {
    this.registry = deps.registry;
    this.emitEvent = deps.emitEvent;
    this.browserManager = deps.browserManager;

    this.registerCapabilities();
  }

  private registerCapabilities(): void {
    // ── app.info (always allowed) ──
    this.capabilities.set('app.info', {
      handler: ({ pluginId }) => ({
        pluginId,
        apiVersion: '1.0.0',
        appVersion: app.getVersion(),
        platform: process.platform,
      }),
    });

    // ── storage.* (permission: storage) ──
    this.capabilities.set('storage.get', {
      permission: 'storage',
      handler: ({ dataDir, params }) => this.readStorage(dataDir)[String(params.key)],
    });
    this.capabilities.set('storage.set', {
      permission: 'storage',
      handler: ({ dataDir, params }) => {
        const store = this.readStorage(dataDir);
        store[String(params.key)] = params.value;
        this.writeStorage(dataDir, store);
        return { ok: true };
      },
    });
    this.capabilities.set('storage.delete', {
      permission: 'storage',
      handler: ({ dataDir, params }) => {
        const store = this.readStorage(dataDir);
        delete store[String(params.key)];
        this.writeStorage(dataDir, store);
        return { ok: true };
      },
    });

    // ── notify.show (permission: notify) ──
    this.capabilities.set('notify.show', {
      permission: 'notify',
      handler: ({ params }) => {
        const title = String(params.title ?? '插件通知');
        const body = String(params.body ?? '');
        if (Notification.isSupported()) {
          new Notification({ title, body }).show();
        }
        return { ok: true };
      },
    });

    // ── panel.setStatus (requires contributing the panel) ──
    this.capabilities.set('panel.setStatus', {
      handler: ({ pluginId, params }) => {
        const plugin = this.registry.get(pluginId);
        const panels = plugin?.manifest.contributes?.panels ?? [];
        const panelId = params.panelId ? String(params.panelId) : panels[0]?.id;
        if (!panelId || !panels.some((p: { id: string }) => p.id === panelId)) {
          throw new Error(`plugin "${pluginId}" does not contribute panel "${panelId}"`);
        }
        const status: PluginPanelStatus = {
          pluginId,
          panelId,
          badge: params.badge as number | string | undefined,
          activity: params.activity as PluginPanelStatus['activity'],
          detail: params.detail ? String(params.detail) : undefined,
        };
        this.emitEvent({ type: 'status', status });
        return { ok: true };
      },
    });

    // ── panel.open (requires contributing the panel) ──
    // focus=false (default) follows the no-focus-steal principle: the rail
    // shows a pending badge and the active panel is NOT switched.
    this.capabilities.set('panel.open', {
      handler: ({ pluginId, params }) => {
        const plugin = this.registry.get(pluginId);
        const panels = plugin?.manifest.contributes?.panels ?? [];
        const panelId = params.panelId ? String(params.panelId) : panels[0]?.id;
        if (!panelId || !panels.some((p: { id: string }) => p.id === panelId)) {
          throw new Error(`plugin "${pluginId}" does not contribute panel "${panelId}"`);
        }
        const focus = params.focus === true;
        this.emitEvent({ type: 'panel-open', pluginId, panelId, focus });
        return { ok: true, panelId, focus };
      },
    });

    // ── filesystem.read (permission: filesystem) ──
    this.capabilities.set('filesystem.read', {
      permission: 'filesystem',
      handler: ({ params }) => {
        const path = String(params.path ?? '');
        if (!path) throw new Error('missing path');
        if (!existsSync(path)) throw new Error(`file not found: ${path}`);
        const ext = path.toLowerCase().split('.').pop() ?? '';
        if (ext === 'docx' || ext === 'xlsx' || ext === 'pptx') {
          throw new Error(`office file (${ext}) — use office.read instead`);
        }
        const size = (() => {
          try { return statSync(path).size; } catch { return 0; }
        })();
        if (size > 2 * 1024 * 1024) throw new Error('file too large (>2MB) for filesystem.read');
        return { path, content: readFileSync(path, 'utf-8'), size };
      },
    });

    // ── filesystem.write (permission: filesystem) — plugin write-back with
    // conflict detection: an expectedMtime older than the on-disk mtime means
    // the file changed since the plugin last read it; refuse to clobber. ──
    this.capabilities.set('filesystem.write', {
      permission: 'filesystem',
      handler: ({ params }) => {
        const path = String(params.path ?? '');
        if (!path) throw new Error('missing path');
        const expectedMtime = typeof params.expectedMtime === 'number' ? params.expectedMtime : undefined;
        if (expectedMtime !== undefined && existsSync(path)) {
          const actual = statSync(path).mtimeMs;
          if (Math.abs(actual - expectedMtime) > 1) {
            throw new Error(
              `conflict: file changed on disk (mtime ${Math.round(actual)}) since read (expected ${Math.round(expectedMtime)}) — re-read before writing`,
            );
          }
        }
        // Binary write: contentB64 (base64) — zip-based formats (docx/xlsx/
        // pptx) must not round-trip through utf-8 strings.
        let bytes: Buffer;
        if (typeof params.contentB64 === 'string') {
          bytes = Buffer.from(params.contentB64, 'base64');
        } else {
          bytes = Buffer.from(String(params.content ?? ''), 'utf-8');
        }
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, bytes);
        return { path, size: bytes.length, mtime: statSync(path).mtimeMs };
      },
    });

    // ── office.read (permission: filesystem) — text-level office extraction ──
    this.capabilities.set('office.read', {
      permission: 'filesystem',
      handler: ({ params }) => {
        const path = String(params.path ?? '');
        if (!path) throw new Error('missing path');
        if (!existsSync(path)) throw new Error(`file not found: ${path}`);
        const size = (() => {
          try { return statSync(path).size; } catch { return 0; }
        })();
        if (size > 20 * 1024 * 1024) throw new Error('file too large (>20MB)');
        const result = extractOfficeText(path, readFileSync(path));
        return { path, size, type: result.type, text: result.text, meta: result.meta };
      },
    });

    // ── network.fetch (permission: network:<host-pattern>) ──
    // Connector egress channel: every call is checked against the host
    // patterns the plugin declared in its manifest.
    this.capabilities.set('network.fetch', {
      handler: async ({ pluginId, params }) => {
        const plugin = this.registry.get(pluginId);
        const url = String(params.url ?? '');
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          throw new Error(`invalid url: ${url}`);
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new Error(`unsupported protocol: ${parsed.protocol}`);
        }
        const granted = (plugin?.manifest.permissions ?? [])
          .filter((p) => p.startsWith('network:'))
          .map((p) => p.slice('network:'.length))
          .some((pattern) => hostMatches(parsed.hostname, pattern));
        if (!granted) {
          throw new Error(
            `network access to "${parsed.hostname}" not granted — declare "network:${parsed.hostname}" in the manifest`,
          );
        }
        const init: RequestInit = { method: String(params.method ?? 'GET').toUpperCase() };
        if (params.headers && typeof params.headers === 'object') init.headers = params.headers as Record<string, string>;
        if (params.body != null) init.body = String(params.body);
        const res = await net.fetch(url, init);
        const text = await res.text();
        if (text.length > 2 * 1024 * 1024) throw new Error('response too large (>2MB)');
        return { ok: res.ok, status: res.status, body: text };
      },
    });

    // ── browser.* (permission: browser) — host-owned BrowserManager ──
    const bm = async () => {
      if (!this.browserManager) throw new Error('browser capability unavailable');
      // The legacy flow connected CDP from the preview panel mount; plugin
      // panels may not be open yet, so ensure the debugger is attached.
      if (!this.browserManager.isConnected()) {
        await this.browserManager.connect().catch(() => {});
      }
      return this.browserManager;
    };
    this.capabilities.set('browser.navigate', {
      permission: 'browser',
      handler: async ({ params }) => {
        const url = String(params.url ?? '');
        if (!url) throw new Error('missing url');
        const manager = await bm();
        const result = await manager.navigate(url, undefined);
        return result;
      },
    });
    this.capabilities.set('browser.back', {
      permission: 'browser',
      handler: async () => { (await bm()).navigateBack(); return { ok: true }; },
    });
    this.capabilities.set('browser.forward', {
      permission: 'browser',
      handler: async () => { (await bm()).navigateForward(); return { ok: true }; },
    });
    this.capabilities.set('browser.reload', {
      permission: 'browser',
      handler: async () => { (await bm()).reload(); return { ok: true }; },
    });
    this.capabilities.set('browser.getState', {
      permission: 'browser',
      handler: async () => (await bm()).getUrl(),
    });
    this.capabilities.set('browser.screenshot', {
      permission: 'browser',
      handler: async ({ params }) => (await bm()).screenshot({ fullPage: params?.fullPage === true }),
    });
    this.capabilities.set('browser.click', {
      permission: 'browser',
      handler: async ({ params }) => (await bm()).click(String(params.selector ?? '')),
    });
    this.capabilities.set('browser.getText', {
      permission: 'browser',
      handler: async ({ params }) => (await bm()).getText(params.selector ? String(params.selector) : undefined),
    });
    this.capabilities.set('browser.evaluate', {
      permission: 'browser',
      handler: async ({ params }) => (await bm()).evaluate(String(params.expression ?? '')),
    });
  }

  /** Validate permissions and dispatch a capability call. */
  async dispatch(pluginId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    const spec = this.capabilities.get(method as CapabilityMethod);
    if (!spec) {
      throw new Error(`unknown capability: ${method}`);
    }

    const plugin = this.registry.get(pluginId);
    if (!plugin) {
      throw new Error(`unknown plugin: ${pluginId}`);
    }

    if (spec.permission && !(plugin.manifest.permissions ?? []).includes(spec.permission)) {
      throw new Error(`permission denied: "${spec.permission}" not granted to ${pluginId}`);
    }

    return spec.handler({
      pluginId,
      dataDir: this.registry.getDataDir(pluginId),
      params: params ?? {},
    });
  }

  // ── Plugin-private JSON storage (plugins-data/<id>/storage.json) ──

  private storagePath(dataDir: string): string {
    return join(dataDir, 'storage.json');
  }

  private readStorage(dataDir: string): Record<string, unknown> {
    try {
      const p = this.storagePath(dataDir);
      if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf-8'));
    } catch (err) {
      console.warn('[plugins] storage read failed:', err);
    }
    return {};
  }

  private writeStorage(dataDir: string, store: Record<string, unknown>): void {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(this.storagePath(dataDir), JSON.stringify(store, null, 2), 'utf-8');
  }
}


/** Glob host match: "api.example.com", "*.example.com", "*" patterns. */
function hostMatches(hostname: string, pattern: string): boolean {
  if (!pattern || pattern === '*') return true;
  const parts = hostname.split('.');
  const patternParts = pattern.split('.');
  if (patternParts.length > parts.length) return false;
  const offset = parts.length - patternParts.length;
  return patternParts.every((p, i) => p === '*' || p === parts[offset + i]);
}
