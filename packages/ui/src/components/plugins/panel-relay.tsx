import { getPluginBridge } from '@/stores/plugin-store';

/**
 * The relay between native-view panels and the shell.
 *
 * A panel lives in its own `WebContentsView` — a top-level frame outside this
 * DOM — so it cannot post to the shell at all. Main forwards the two kinds of
 * frame a panel sends *to the shell* (as opposed to to its own backend, which
 * goes over the panel's MessagePort):
 *
 *   - `selection`   — the user selected text in a panel; the shell's selection
 *                     menu picks it up.
 *   - `contextmenu` — the panel wants the native menu, which only main can pop.
 *
 * This module also pushes the shell's theme tokens to main, which fans them out
 * to every plugin view — the views are unreachable by `postMessage`, so the
 * tokens have to travel the same way the frames do.
 *
 * There is no iframe transport here. Panels were once hosted in `<iframe>`s and
 * this file carried both paths; the iframe path was unreachable in every shipped
 * build and is gone. See `panel-slot.tsx` for what a host without native views
 * gets instead.
 */

interface WireFrame {
  __piPlugin: true;
  pluginId: string;
  direction: 'selection' | 'contextmenu';
  payload: unknown;
}

/** Theme tokens streamed into plugin panels so they match the shell. */
const THEME_VARS = [
  '--background', '--foreground', '--card', '--card-foreground',
  '--primary', '--primary-foreground', '--secondary', '--secondary-foreground',
  '--muted', '--muted-foreground', '--accent', '--accent-foreground',
  '--border', '--input', '--ring', '--radius', '--font-sans',
];

function collectThemeTokens(): Record<string, string> {
  const computed = getComputedStyle(document.documentElement);
  const tokens: Record<string, string> = {};
  for (const name of THEME_VARS) {
    const value = computed.getPropertyValue(name).trim();
    if (value) tokens[name] = value;
  }
  return tokens;
}

/** Hand the shell's theme tokens to main, which fans them out to every plugin view. */
function pushTheme(): void {
  getPluginBridge()?.setTheme?.(collectThemeTokens());
}

/** Ask main to pop the native context menu (edit roles target the focused webContents). */
function showPluginContextMenu(pluginId: string, payload?: { x?: number; y?: number }): void {
  const bridge = getPluginBridge();
  if (!bridge?.showContextMenu) return;
  bridge.showContextMenu({ x: payload?.x ?? 0, y: payload?.y ?? 0 }).catch(() => {});
}

function handleFrame(data: WireFrame | null): void {
  if (!data || data.__piPlugin !== true) return;
  if (data.direction === 'selection') {
    window.dispatchEvent(new CustomEvent('pi-plugin-selection', { detail: data.payload }));
  } else if (data.direction === 'contextmenu') {
    showPluginContextMenu(data.pluginId, data.payload as { x?: number; y?: number } | undefined);
  }
}

let relayInstalled = false;

/**
 * Install the relay. Idempotent, and called by every slot that hosts a panel —
 * it used to happen inside the deleted iframe host, so when panels moved to
 * native views nothing ran it any more, which silently broke both the theme
 * push and the selection frames.
 */
function ensureRelayInstalled(): void {
  if (relayInstalled) return;
  relayInstalled = true;

  const bridge = getPluginBridge();
  if (!bridge) return;

  // Theme: push once, and again on every theme change (the app toggles
  // .light/.dark on <html>).
  const themeObserver = new MutationObserver(() => pushTheme());
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  setTimeout(() => pushTheme(), 300);

  // Frames from native-view panels, relayed by main.
  bridge.onRelay?.((frame) => handleFrame(frame as WireFrame | null));
}

export { ensureRelayInstalled };
