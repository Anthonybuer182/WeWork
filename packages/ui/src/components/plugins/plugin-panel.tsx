import { useEffect, useRef } from 'react';
import { getPluginBridge } from '@/stores/plugin-store';

interface WireFrame {
  __piPlugin: true;
  pluginId: string;
  direction: 'ui' | 'backend' | 'selection';
  payload: unknown;
}

/**
 * Relays messages between plugin panels and their backend UtilityProcess.
 *
 * iframe panel:  iframe ↔ window.parent postMessage ↔ preload bridge ↔ MessagePort ↔ backend
 * declarative:   DeclarativePanelHost registers a handler ↔ preload bridge ↔ backend
 *
 * Backend → UI routing: messages carrying a `panelId` (e.g. ui.render events)
 * dispatch to the target registered for that panel; response messages (no
 * panelId) go to the plugin's iframe panel (they answer iframe SDK requests).
 */
type PanelTarget =
  | { kind: 'iframe'; pluginId: string; panelId?: string; win: () => Window | null }
  | { kind: 'declarative'; pluginId: string; panelId: string; handler: (payload: unknown) => void };

const panelTargets = new Map<string, PanelTarget>(); // key: `${pluginId}:${panelId ?? '*'}`

function targetKey(pluginId: string, panelId?: string): string {
  return `${pluginId}:${panelId ?? '*'}`;
}

function registerTarget(target: PanelTarget): void {
  panelTargets.set(targetKey(target.pluginId, target.panelId), target);
}

function unregisterTarget(pluginId: string, panelId?: string): void {
  panelTargets.delete(targetKey(pluginId, panelId));
}

let relayInstalled = false;

function dispatchBackendMessage(pluginId: string, payload: unknown): void {
  const msg = payload as { kind?: string; panelId?: string } | null;
  if (!msg) return;

  // Exact panel target first (declarative renders carry panelId)
  if (msg.panelId) {
    const exact = panelTargets.get(targetKey(pluginId, msg.panelId));
    if (exact && exact.kind === 'declarative') {
      exact.handler(payload);
      return;
    }
  }
  // Responses & panel-less messages → the plugin's iframe target
  const iframe = [...panelTargets.values()].find(
    (t) => t.pluginId === pluginId && t.kind === 'iframe',
  ) as Extract<PanelTarget, { kind: 'iframe' }> | undefined;
  iframe?.win()?.postMessage(
    { __piPlugin: true, pluginId, direction: 'backend', payload } satisfies WireFrame,
    '*',
  );
}

/** Theme tokens streamed into plugin iframes so panels match the shell. */
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

function pushThemeToFrames(reason: string): void {
  const tokens = collectThemeTokens();
  for (const target of panelTargets.values()) {
    if (target.kind !== 'iframe') continue;
    const win = target.win();
    win?.postMessage(
      { __piPlugin: true, pluginId: target.pluginId, direction: 'theme', payload: { tokens, reason } },
      '*',
    );
  }
}

function ensureRelayInstalled(): void {
  if (relayInstalled) return;
  relayInstalled = true;

  const bridge = getPluginBridge();
  if (!bridge) return;

  bridge.onMessage((pluginId, payload) => dispatchBackendMessage(pluginId, payload));

  // Theme bridge: push tokens once and again on every theme change
  // (the app toggles .light/.dark on <html>).
  const themeObserver = new MutationObserver(() => pushThemeToFrames('theme-change'));
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  setTimeout(() => pushThemeToFrames('init'), 300);

  window.addEventListener('message', (event) => {
    const data = event.data as WireFrame | null;
    if (!data || data.__piPlugin !== true) return;
    if (data.direction === 'ui') {
      bridge.send(data.pluginId, data.payload);
    } else if (data.direction === 'selection') {
      // Selection made inside a plugin iframe — surface to the selection service.
      window.dispatchEvent(new CustomEvent('pi-plugin-selection', { detail: data.payload }));
    }
  });
}

/** Fire-and-forget event to a plugin backend over the UI data plane. */
export function sendPluginEvent(
  pluginId: string,
  event: string,
  data?: unknown,
  panelId?: string,
): void {
  const bridge = getPluginBridge();
  bridge?.send(pluginId, { kind: 'event', event, data, panelId });
}

export { registerTarget, unregisterTarget, ensureRelayInstalled };

export interface PluginPanelHostProps {
  pluginId: string;
  panelId: string;
  entry: string;
}

/**
 * Renders one iframe plugin panel served from `pi-plugin://<pluginId>/<entry>`
 * — a unique origin per plugin (process isolation via site isolation).
 */
export function PluginPanelHost({ pluginId, panelId, entry }: PluginPanelHostProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const bridge = getPluginBridge();
    if (!bridge) return;

    ensureRelayInstalled();
    registerTarget({
      kind: 'iframe',
      pluginId,
      panelId,
      win: () => iframeRef.current?.contentWindow ?? null,
    });
    // Theme tokens for the freshly mounted panel.
    setTimeout(() => pushThemeToFrames('panel-mount'), 200);
    // Ask main for a fresh UI MessagePort pair (also heals renderer reloads).
    bridge.ensurePort(pluginId).catch(() => {});

    return () => {
      unregisterTarget(pluginId, panelId);
    };
  }, [pluginId, panelId]);

  const src = `pi-plugin://${pluginId}/${entry.replace(/^\/+/, '')}`;

  return (
    <div className="h-full w-full overflow-hidden bg-background">
      <iframe
        ref={iframeRef}
        src={src}
        title={`${pluginId}:${panelId}`}
        className="h-full w-full border-0"
        data-panel-kind="iframe"
        // allow-same-origin keeps the plugin's own pi-plugin:// origin (needed
        // for fetch/storage within the panel); the origin is unique per plugin
        // and never same-origin with the host shell, so escaping the sandbox
        // only escapes into the plugin's own origin.
        sandbox="allow-scripts allow-same-origin"
        allow="clipboard-write"
      />
    </div>
  );
}
