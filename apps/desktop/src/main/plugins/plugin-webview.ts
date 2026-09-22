import { join } from 'path';
import type { BrowserWindow } from 'electron';
import { WebContentsView, ipcMain } from 'electron';
import type { LiveViewRegistry } from './liveview';
import type { PluginRegistry } from './registry';

/**
 * Plugin web panels as native views.
 *
 * Every plugin panel that declares `kind: 'iframe'` and an `entry` is a web
 * page. This hosts those pages in a `WebContentsView` instead of an iframe, so
 * a panel gets a real top-level frame: correct IME, working print/alert/download
 * (an iframe sandbox blocks all three), its own renderer process, and no
 * dependence on the shell's DOM.
 *
 * Three consequences, all deliberate:
 *
 *  - **The shell cannot draw over a panel.** Native views sit above ALL DOM.
 *    Popups drawn *inside* a panel are unaffected (that is how genoffice does
 *    its selection popover); only host-level overlays over a panel are lost.
 *  - **Panel bounds are reported, not laid out.** A WebContentsView keeps
 *    exactly the rectangle it is given, so the renderer measures its slot and
 *    reports the rect here. 0×0 means "hide" — leaving a stale view visible
 *    would swallow real mouse clicks.
 *  - **The UI message channel moves.** The page can no longer reach the shell
 *    via `window.parent`; `preload/plugin-view.ts` re-establishes it, and
 *    `plugin-sdk-js.ts` shims `window.parent` so existing plugin code is
 *    unchanged.
 */
export class PluginWebViews {
  private readonly views = new Map<string, WebContentsView>();
  /** Slots we have registered a handler for, so re-registration is cheap. */
  private readonly registered = new Set<string>();
  /**
   * Last theme the shell pushed. A view created after that push would
   * otherwise never learn the shell's colours, because the shell only
   * broadcasts on change and on panel mount of the panels IT renders.
   */
  private lastTheme: Record<string, string> | null = null;

  constructor(
    private readonly opts: {
      registry: PluginRegistry;
      liveViews: LiveViewRegistry;
      getWindow: () => BrowserWindow | null;
    },
  ) {}

  /**
   * Relay host-bound traffic from a plugin view (selection, resize) to the
   * shell renderer.
   *
   * The shell already knows how to handle these wire frames — it did so when
   * panels were iframes and the message arrived via `window.parent`. Feeding
   * them over IPC instead means that handler stays the single implementation,
   * rather than growing a second one for native views.
   */
  installIpc(): void {
    ipcMain.on('pi:plugin:view-frame', (_event, frame) => {
      this.opts.getWindow()?.webContents.send('pi:plugin:relay', frame);
    });

    // Theme tokens are collected in the shell (it owns the CSS variables), so
    // the shell pushes them here and main fans them out to every plugin view.
    ipcMain.on('pi:plugin:set-theme', (_event, tokens: Record<string, string>) => {
      if (!tokens || typeof tokens !== 'object') return;
      this.lastTheme = tokens;
      for (const view of this.views.values()) {
        if (view.webContents.isDestroyed()) continue;
        view.webContents.send('pi:plugin:theme', tokens);
      }
    });

    /**
     * The shell raises `panel.mounted` (it owns the panel's open params), but
     * the port it must travel on belongs to the panel's own view. Route the
     * event to that view so its preload can put it on the wire.
     *
     * `handle`, not `on`: the renderer calls `electronAPI.invoke`, and a
     * `ipcMain.on` listener would leave that call rejecting with "No handler
     * registered" — a mismatch that looks like the event simply never arrived.
     */
    ipcMain.handle(
      'pi:plugin:panel-mounted',
      (_event, msg: { pluginId?: string; panelId?: string; params?: unknown }) => {
        const slotId = `${msg?.pluginId}:${msg?.panelId}`;
        const view = this.views.get(slotId);
        if (!view || view.webContents.isDestroyed()) {
          return { ok: false, error: `no view for ${slotId}` };
        }
        view.webContents.send('pi:plugin:panel-mounted', {
          panelId: msg?.panelId,
          params: msg?.params,
        });
        return { ok: true };
      },
    );
  }

  /**
   * Register a liveview slot for every plugin web panel. Called at boot and
   * again whenever the plugin set changes (install / enable / disable).
   */
  sync(): void {
    const { registry, liveViews } = this.opts;

    for (const plugin of registry.all()) {
      if (!plugin.enabled || plugin.state === 'incompatible' || plugin.state === 'error') continue;
      const pluginId = plugin.manifest.id;

      for (const panel of plugin.manifest.contributes?.panels ?? []) {
        if (panel.kind !== 'iframe' || !panel.entry) continue;
        const slotId = `${pluginId}:${panel.id}`;
        if (this.registered.has(slotId)) continue;
        this.registered.add(slotId);

        liveViews.register(slotId, {
          attach: () => {
            this.ensureView(slotId, pluginId, panel.entry as string);
          },
          show: (bounds) => {
            const view = this.ensureView(slotId, pluginId, panel.entry as string);
            if (!view) return;
            const win = this.opts.getWindow();
            if (!win) return;
            view.setBounds({
              x: Math.round(bounds.x),
              y: Math.round(bounds.y),
              width: Math.round(bounds.width),
              height: Math.round(bounds.height),
            });
            // addChildView is idempotent-by-replacement: adding an already
            // attached child would reorder it, so track attachment explicitly.
            if (!this.attached.has(slotId)) {
              win.contentView.addChildView(view);
              this.attached.add(slotId);
            }
          },
          hide: () => this.hideSlot(slotId),
        });
      }
    }
  }

  /** Slots currently present in the window's view tree. */
  private readonly attached = new Set<string>();

  private hideSlot(slotId: string): void {
    const view = this.views.get(slotId);
    if (!view) return;
    const win = this.opts.getWindow();
    if (win && this.attached.has(slotId)) {
      try {
        win.contentView.removeChildView(view);
      } catch {
        /* window or view already gone */
      }
    }
    this.attached.delete(slotId);
  }

  /** Hide every panel view — the stale-overlay guard for renderer reloads. */
  hideAll(): void {
    for (const slotId of [...this.attached]) this.hideSlot(slotId);
  }

  /** Tear down a panel's view entirely (plugin disabled / uninstalled). */
  private destroySlot(slotId: string): void {
    this.hideSlot(slotId);
    const view = this.views.get(slotId);
    this.views.delete(slotId);
    this.registered.delete(slotId);
    try {
      view?.webContents.close();
    } catch {
      /* already gone */
    }
  }

  /**
   * Lazily create the view for a slot, or return the existing one.
   *
   * Created on first attach rather than at boot so that a plugin with many
   * panels costs nothing until a panel is actually shown, and so a panel that
   * is never opened never loads its page.
   */
  private ensureView(slotId: string, pluginId: string, entry: string): WebContentsView | null {
    const existing = this.views.get(slotId);
    if (existing && !existing.webContents.isDestroyed()) return existing;
    if (existing) this.destroySlot(slotId); // dead webContents (crash) → rebuild

    const view = new WebContentsView({
      webPreferences: {
        // Same posture as the shell window (window-manager.ts): the preload
        // needs Node's process.argv to learn its plugin id, and runs with
        // contextIsolation on so the page never sees ipcRenderer directly.
        preload: join(__dirname, '../preload/plugin-view.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        // The preload reads this to know which plugin it is serving — a view is
        // created per panel, so it cannot be baked into the script.
        additionalArguments: [`--pi-plugin-id=${pluginId}`],
      },
    });
    // Start hidden at 0×0: the renderer reports real bounds in show().
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 });

    // The pi-plugin:// handler injects __pi_sdk.js into HTML responses, so the
    // page gets the SDK exactly as it did inside an iframe.
    const url = `pi-plugin://${pluginId}/${entry.replace(/^\/+/, '')}`;
    view.webContents.loadURL(url).catch((err) => {
      console.error(`[plugin-view] load failed for ${slotId}:`, err?.message ?? err);
    });

    // Late-created views miss the shell's last theme push, so replay it once
    // the page can receive it.
    view.webContents.on('did-finish-load', () => {
      if (this.lastTheme && !view.webContents.isDestroyed()) {
        view.webContents.send('pi:plugin:theme', this.lastTheme);
      }
    });

    // A crashed renderer leaves a blank rectangle above the shell; surface it
    // rather than letting it silently swallow clicks.
    view.webContents.on('render-process-gone', (_e, details) => {
      console.error(`[plugin-view] ${slotId} renderer gone: ${details.reason}`);
      this.hideSlot(slotId);
      this.views.delete(slotId);
    });

    this.views.set(slotId, view);
    return view;
  }
}
