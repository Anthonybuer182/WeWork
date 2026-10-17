/**
 * The viewer panel's document tab strip — the multi-doc UI.
 *
 * One strip at the top of the panel page, IN DOCUMENT FLOW: the renderers own
 * `#root` below it and nothing here may overlay them (the panel page is a
 * native view; anything floating would be covered or would eat clicks). The
 * strip squeezes `#root`, which is exactly the mechanism that already makes
 * the panel work at all heights.
 *
 * State comes from the backend: every `ui.render` that carries `tabs` redraws
 * the strip. Clicks go back as ordinary UI requests — `file.activateTab` /
 * `file.closeTab` — and the backend re-pushes the bucket, which both the strip
 * and the loaded renderer react to. The strip never decides WHAT to render:
 * a tab click only asks.
 */

const stripId = 'pi-files-tabs';

interface RenderPayload {
  event?: string;
  data?: { tabs?: unknown; activePath?: unknown };
}

const CSS = `
#${stripId} {
  display: none;
  flex: none;
  align-items: stretch;
  gap: 2px;
  height: 28px;
  padding: 2px 4px 0;
  overflow-x: auto;
  background: hsl(var(--background, 222 19% 7%));
  border-bottom: 1px solid hsl(var(--border, 217 19% 27%));
  user-select: none;
}
#${stripId} .pi-file-tab {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 56px;
  max-width: 180px;
  padding: 0 6px;
  border-radius: 6px 6px 0 0;
  font-size: 11px;
  line-height: 24px;
  color: hsl(var(--muted-foreground, 215 14% 60%));
  cursor: default;
  white-space: nowrap;
}
#${stripId} .pi-file-tab span {
  overflow: hidden;
  text-overflow: ellipsis;
}
#${stripId} .pi-file-tab:hover {
  background: hsl(var(--accent, 217 33% 24%) / 0.5);
}
#${stripId} .pi-file-tab.active {
  background: hsl(var(--accent, 217 33% 24%));
  color: hsl(var(--accent-foreground, 210 40% 96%));
}
#${stripId} .pi-file-tab .pi-file-tab-close {
  flex: none;
  width: 14px;
  height: 14px;
  padding: 0;
  border: 0;
  border-radius: 3px;
  background: transparent;
  color: inherit;
  font-size: 11px;
  line-height: 14px;
  cursor: pointer;
  opacity: 0;
}
#${stripId} .pi-file-tab:hover .pi-file-tab-close,
#${stripId} .pi-file-tab.active .pi-file-tab-close {
  opacity: 0.7;
}
#${stripId} .pi-file-tab .pi-file-tab-close:hover {
  opacity: 1;
  background: hsl(var(--accent-foreground, 210 40% 96%) / 0.15);
}
`;

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

/** The doc-tab context menu — a NATIVE popup (OS-level, same as the
 *  browser's tab menu): floats above everything, styled by the system. */
function openTabMenu(path: string, at: { x: number; y: number }): void {
  const items = [{ id: 'split-right', label: '向右拆分' }];
  void window.piSDK?.showPopupMenu?.(items, at.x, at.y).then((picked) => {
    if (picked === 'split-right') {
      void window.piSDK?.request('file.splitRight', { path });
    }
  });
}

function renderStrip(tabs: string[], activePath: string): void {
  const bar = document.getElementById(stripId);
  if (!bar) return;
  if (tabs.length === 0) {
    bar.style.display = 'none';
    bar.textContent = '';
    return;
  }
  bar.style.display = 'flex';
  bar.textContent = '';
  for (const path of tabs) {
    const tab = document.createElement('div');
    tab.className = 'pi-file-tab' + (path === activePath ? ' active' : '');
    tab.title = path;
    // Drag to reorder: the drop target names the position ("before that
    // doc"); the backend bucket is the truth for strip order.
    tab.draggable = true;
    tab.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData('text/plain', path);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    });
    tab.addEventListener('dragover', (e) => e.preventDefault());
    tab.addEventListener('drop', (e) => {
      e.preventDefault();
      const from = e.dataTransfer?.getData('text/plain');
      if (from && from !== path) void window.piSDK?.request('file.reorderTab', { path: from, beforePath: path });
    });
    const label = document.createElement('span');
    label.textContent = baseName(path);
    tab.appendChild(label);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'pi-file-tab-close';
    close.textContent = '×';
    close.setAttribute('aria-label', `关闭 ${baseName(path)}`);
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      void window.piSDK?.request('file.closeTab', { path });
    });
    tab.appendChild(close);
    tab.addEventListener('click', () => {
      if (path === activePath) return;
      void window.piSDK?.request('file.activateTab', { path });
    });
    tab.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openTabMenu(path, { x: e.clientX, y: e.clientY });
    });
    tab.addEventListener('dblclick', (e) => {
      e.preventDefault();
      openTabMenu(path, { x: e.clientX, y: e.clientY });
    });
    bar.appendChild(tab);
  }
}

/** Mount the strip. Call once per page load, before the dispatcher pulls state. */
export function mountTabsBar(): void {
  if (document.getElementById(stripId)) return;
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  const bar = document.createElement('div');
  bar.id = stripId;
  bar.setAttribute('data-panel-tabs', 'viewer');
  document.body.insertBefore(bar, document.getElementById('root'));

  window.piSDK?.onMessage((payload) => {
    const msg = payload as RenderPayload | null;
    if (msg?.event !== 'ui.render') return;
    const data = msg.data;
    // Only a push that carries the bucket redraws the strip — `{saved}` /
    // `{error}` pushes must not blank it.
    if (!data || !Array.isArray(data.tabs)) return;
    renderStrip(data.tabs.map(String), typeof data.activePath === 'string' ? data.activePath : '');
  });


  // Boot pull. The host pushes `ui.render` on MOUNT only — a format-switch
  // reload (or DevTools reload) comes back with no push, and the dispatcher's
  // own state.get pull feeds the renderers but not this strip. Same source of
  // truth, same shape.
  void window.piSDK
    ?.request('state.get')
    .then((state) => {
      const data = state as { tabs?: unknown; activePath?: unknown } | null;
      if (!data || !Array.isArray(data.tabs)) return;
      renderStrip(data.tabs.map(String), typeof data.activePath === 'string' ? data.activePath : '');
    })
    .catch(() => {
      /* older backend without tabs — the strip stays hidden until a push */
    });
}
