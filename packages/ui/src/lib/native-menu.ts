export interface PopupMenuItem {
  id: string;
  label: string;
  disabled?: boolean;
  separatorBefore?: boolean;
}

type Resolver = (id: string | null) => void;

const resolvers = new Map<number, Resolver>();
let seq = 0;
let installed = false;

interface ElectronApiShape {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on: (channel: string, callback: (...args: unknown[]) => void) => void;
}

function electronApi(): ElectronApiShape | null {
  const api = (window as unknown as { electronAPI?: Partial<ElectronApiShape> }).electronAPI;
  if (!api?.invoke || !api?.on) return null;
  return api as ElectronApiShape;
}

function settle(nonce: number | undefined, id: string | null): void {
  if (nonce == null) return;
  const resolve = resolvers.get(nonce);
  if (!resolve) return;
  resolvers.delete(nonce);
  resolve(id);
}

function install(api: ElectronApiShape): void {
  if (installed) return;
  installed = true;
  // Click round-trips the chosen item; the popup's close-callback settles a
  // dismissal (Esc / outside click) with null. Click fires first, so the
  // dismiss finds nothing pending on a normal selection.
  api.on('pi:menu:click', (...args: unknown[]) => {
    const payload = args[0] as { nonce?: number; id?: string } | undefined;
    settle(payload?.nonce, payload?.id ?? null);
  });
  api.on('pi:menu:dismiss', (...args: unknown[]) => {
    const payload = args[0] as { nonce?: number } | undefined;
    settle(payload?.nonce, null);
  });
}

/**
 * Test seam. The contextBridge-exposed `electronAPI` cannot be monkey-patched
 * from the page (its function properties are read-only), so automated tests
 * set `window.__popupMenuOverride` to capture the payload and simulate the
 * choice without touching the real IPC/native menu.
 */
interface PopupOverride {
  (items: PopupMenuItem[], at: { x: number; y: number }): string | null | Promise<string | null>;
}
declare global {
  interface Window {
    __popupMenuOverride?: PopupOverride;
  }
}

/**
 * Show a popup menu at window coordinates and resolve with the clicked item
 * id (null on dismissal).
 *
 * Desktop uses a NATIVE OS menu (`Menu.popup`): plugin panels are native
 * WebContentsViews stacked above all window DOM, so a DOM dropdown anchored
 * in the header band would be covered as soon as it reached the panel body —
 * the OS menu composites above everything. The web build hosts no native
 * views, so there a small portal dropdown is safe and keeps the API usable
 * outside Electron.
 */
export function showPopupMenu(items: PopupMenuItem[], at: { x: number; y: number }): Promise<string | null> {
  const override = typeof window !== 'undefined' ? window.__popupMenuOverride : undefined;
  if (override) return Promise.resolve(override(items, at));
  const api = electronApi();
  if (api) {
    install(api);
    const nonce = ++seq;
    return new Promise((resolve) => {
      resolvers.set(nonce, resolve);
      // The OS menu emits nothing when dismissed without a click; the
      // deadline only prevents a resolver from dangling forever.
      setTimeout(() => {
        if (resolvers.has(nonce)) {
          resolvers.delete(nonce);
          resolve(null);
        }
      }, 120_000);
      api
        .invoke('pi:menu:popup', { nonce, x: Math.round(at.x), y: Math.round(at.y), items })
        .catch(() => {
          if (resolvers.has(nonce)) {
            resolvers.delete(nonce);
            resolve(null);
          }
        });
    });
  }

  // Web fallback: a minimal fixed-position dropdown.
  return new Promise((resolve) => {
    const host = document.createElement('div');
    host.dataset.testid = 'popup-menu-dom';
    host.style.cssText =
      'position:fixed;z-index:9999;min-width:160px;background:var(--popover,#fff);color:inherit;' +
      'border:1px solid var(--border,#ddd);border-radius:6px;padding:4px;box-shadow:0 4px 16px rgba(0,0,0,.15);';
    let done = false;
    const finish = (id: string | null) => {
      if (done) return;
      done = true;
      host.remove();
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      resolve(id);
    };
    const onDown = (e: MouseEvent) => {
      if (host.contains(e.target as Node)) return;
      finish(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish(null);
    };
    for (const item of items) {
      if (item.separatorBefore) {
        const hr = document.createElement('div');
        hr.style.cssText = 'height:1px;background:var(--border,#ddd);margin:4px 0;';
        host.appendChild(hr);
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = item.label;
      btn.style.cssText =
        'display:block;width:100%;text-align:left;padding:4px 8px;font-size:12px;border-radius:4px;' +
        'background:none;border:none;cursor:pointer;' +
        (item.disabled === false ? '' : '');
      btn.onmouseenter = () => (btn.style.background = 'var(--accent,#eee)');
      btn.onmouseleave = () => (btn.style.background = 'none');
      btn.onclick = () => finish(item.id);
      host.appendChild(btn);
    }
    document.body.appendChild(host);
    // Keep the menu on screen.
    const rect = host.getBoundingClientRect();
    host.style.left = `${Math.min(at.x, window.innerWidth - rect.width - 8)}px`;
    host.style.top = `${Math.min(at.y, window.innerHeight - rect.height - 8)}px`;
    setTimeout(() => {
      document.addEventListener('mousedown', onDown, true);
      document.addEventListener('keydown', onKey, true);
    }, 0);
  });
}
