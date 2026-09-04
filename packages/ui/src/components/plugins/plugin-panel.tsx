import { useEffect, useRef } from 'react';
import { getPluginBridge } from '@/stores/plugin-store';
import { usePanelStore } from '@/stores/panel-store';

interface WireFrame {
  __piPlugin: true;
  pluginId: string;
  direction: 'ui' | 'backend' | 'selection' | 'resize' | 'contextmenu';
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
  | { kind: 'iframe'; pluginId: string; panelId?: string; win: () => Window | null; el?: () => HTMLIFrameElement | null }
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
  const msg = payload as { kind?: string; panelId?: string; event?: string } | null;
  if (!msg) return;

  // Exact panel target first (declarative renders carry panelId; iframe
  // panels register their own target so multi-panel plugins route precisely)
  const exact = msg.panelId ? panelTargets.get(targetKey(pluginId, msg.panelId)) : undefined;
  if (exact && exact.kind === 'iframe') {
    exact.win()?.postMessage(
      { __piPlugin: true, pluginId, direction: 'backend', payload } satisfies WireFrame,
      '*',
    );
    return;
  }
  if (exact && exact.kind === 'declarative') {
    exact.handler(payload);
    return;
  }
  // No panelId (tool responses etc.) → the plugin's first iframe target
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

/** Apply a reported content height to an autoHeight iframe panel. */
function applyAutoHeight(pluginId: string, height?: number): void {
  if (typeof height !== 'number' || height <= 0 || height > 20000) return;
  const target = [...panelTargets.values()].find(
    (t) => t.pluginId === pluginId && t.kind === 'iframe',
  ) as Extract<PanelTarget, { kind: 'iframe' }> | undefined;
  const el = target?.el?.();
  if (el?.dataset.autoHeight === 'true') {
    el.style.height = `${Math.round(height)}px`;
  }
}

/** Ask main to pop the native context menu (edit roles target the focused webContents). */
function showPluginContextMenu(pluginId: string, payload?: { x?: number; y?: number }): void {
  const bridge = getPluginBridge();
  if (!bridge?.showContextMenu) return;
  bridge.showContextMenu({ x: payload?.x ?? 0, y: payload?.y ?? 0 }).catch(() => {});
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
    } else if (data.direction === 'resize') {
      // autoHeight panels: size the iframe to its reported content height.
      applyAutoHeight(data.pluginId, (data.payload as { height?: number } | undefined)?.height);
    } else if (data.direction === 'contextmenu') {
      // Native context menu for sandboxed plugin iframes (main-process Menu).
      showPluginContextMenu(data.pluginId, data.payload as { x?: number; y?: number } | undefined);
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
  /** Host sizes the iframe to the SDK-reported content height. */
  autoHeight?: boolean;
}

/**
 * Renders one iframe plugin panel served from `pi-plugin://<pluginId>/<entry>`
 * — a unique origin per plugin (process isolation via site isolation).
 */
export function PluginPanelHost({ pluginId, panelId, entry, autoHeight }: PluginPanelHostProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const paramsRef = useRef<Record<string, unknown> | undefined>(undefined);
  // Open params (e.g. { file } for viewer panels) — re-sent on mount AND on
  // same-panel re-open with new params, mirroring DeclarativePanelHost.
  const panelKey = `plugin:${pluginId}:${panelId}`;
  const params = usePanelStore((s) => s.params[panelKey]);

  useEffect(() => {
    const bridge = getPluginBridge();
    if (!bridge) return;

    ensureRelayInstalled();
    registerTarget({
      kind: 'iframe',
      pluginId,
      panelId,
      win: () => iframeRef.current?.contentWindow ?? null,
      el: () => iframeRef.current ?? null,
    });
    // Theme tokens for the freshly mounted panel.
    setTimeout(() => pushThemeToFrames('panel-mount'), 200);
    // Ask main for a fresh UI MessagePort pair (also heals renderer reloads).
    bridge.ensurePort(pluginId).catch(() => {});

    return () => {
      unregisterTarget(pluginId, panelId);
    };
  }, [pluginId, panelId]);

  // Tell the backend the panel mounted (with open params). Sent when the
  // iframe FINISHES LOADING — a sync-rendering backend (e.g. a static list)
  // would otherwise reply before the iframe attached its message listener,
  // and the first ui.render would be dropped (races badly under
  // site-per-process cold process starts). onLoad also re-fires after
  // iframe reloads, so the backend gets a fresh render then too.
  const notifyMounted = () => {
    sendPluginEvent(pluginId, 'panel.mounted', { panelId, params: paramsRef.current }, panelId);
  };

  // Params change on an already-loaded panel → re-notify (file switch).
  useEffect(() => {
    paramsRef.current = params;
    if (params === undefined) return;
    const el = iframeRef.current;
    // Only skip the direct send when the iframe is still on its initial
    // load — onLoad will deliver the initial params for it.
    if (el && el.dataset.loaded === 'true') {
      sendPluginEvent(pluginId, 'panel.mounted', { panelId, params }, panelId);
    }
  }, [pluginId, panelId, params]);

  const src = `pi-plugin://${pluginId}/${entry.replace(/^\/+/, '')}`;

  return (
    <div className="h-full w-full overflow-auto bg-background" data-auto-height={autoHeight ? 'true' : undefined}>
      <iframe
        ref={iframeRef}
        src={src}
        title={`${pluginId}:${panelId}`}
        onLoad={(e) => {
          (e.currentTarget as HTMLIFrameElement).dataset.loaded = 'true';
          notifyMounted();
        }}
        className={autoHeight ? 'w-full border-0' : 'h-full w-full border-0'}
        style={autoHeight ? { minHeight: '80px', height: '400px' } : undefined}
        data-auto-height={autoHeight ? 'true' : undefined}
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
