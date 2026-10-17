import { getPluginBridge } from '@/stores/plugin-store';

/**
 * Theme push for native-view panels.
 *
 * A panel lives in its own `WebContentsView` — a top-level frame outside this
 * DOM, unreachable by `postMessage` — so the shell's theme tokens travel over
 * IPC: this module pushes them to main, which fans them out to every plugin
 * view.
 *
 * Panels were once hosted in `<iframe>`s and this file also relayed their
 * host-bound wire frames; that transport is gone along with the frames.
 */

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

let relayInstalled = false;

/**
 * Install the theme push. Idempotent, and called by every slot that hosts a
 * panel — it used to happen inside the deleted iframe host, so when panels
 * moved to native views nothing ran it any more, which silently broke the
 * theme push.
 */
function ensureRelayInstalled(): void {
  if (relayInstalled) return;
  relayInstalled = true;

  if (!getPluginBridge()) return;

  // Theme: push once, and again on every theme change (the app toggles
  // .light/.dark on <html>).
  const themeObserver = new MutationObserver(() => pushTheme());
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  setTimeout(() => pushTheme(), 300);
}

export { ensureRelayInstalled };
