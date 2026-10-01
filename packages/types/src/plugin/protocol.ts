/**
 * Wire protocols for the plugin system.
 *
 * Two independent channels exist between a plugin backend and the host:
 *
 * 1. Control plane — the UtilityProcess built-in `process.parentPort`.
 *    Used for lifecycle, capability calls (host.* APIs) and logging.
 *    Always routed through the main process (permission-checked).
 *
 * 2. Data plane — a MessagePort pair created at activation and transferred
 *    to the renderer on first panel open. Carries UI↔backend messages
 *    point-to-point without passing through main.
 */

// ── Control plane (backend ↔ main, via process.parentPort) ──

export interface PluginInitMessage {
  type: 'init';
  pluginId: string;
  /**
   * The protocol version this host speaks. Announced so a backend can refuse
   * to run against a host it does not understand; the manifest's `apiVersion`
   * is the other half of the handshake (checked before the backend even spawns).
   */
  apiVersion: number;
  appVersion: string;
  /** Plugin-private data directory (plugins-data/<id>). */
  dataDir: string;
}

export interface PluginUiPortMessage {
  type: 'ui-port';
  /** New UI MessagePort arrives in `event.ports[0]`; replaces any previous one. */
}

/** Backend → main: capability invocation (host.* API). */
export interface CapabilityCallMessage {
  type: 'call';
  id: string;
  /** Capability method, e.g. "panel.setStatus", "storage.get", "notify.show". */
  method: string;
  params: Record<string, unknown>;
}

/** Main → backend: capability result. */
export interface CapabilityResultMessage {
  type: 'call-result';
  id: string;
  result?: unknown;
  error?: string;
}

/** Backend → main: ready handshake after boot. */
export interface PluginReadyMessage {
  type: 'ready';
}

/** Main → backend: execute a contributed command (e.g. "/mail"). */
export interface PluginCommandMessage {
  type: 'command';
  id: string;
  /** Command name as declared in the manifest, e.g. "/mail". */
  name: string;
  args?: string;
}

/** Backend → main: result of a PluginCommandMessage. */
export interface PluginCommandResultMessage {
  type: 'command-result';
  id: string;
  result?: unknown;
  error?: string;
}

/** Main → backend: agent tool invocation (contributes.tools). */
export interface PluginToolCallMessage {
  type: 'tool-call';
  id: string;
  name: string;
  params: Record<string, unknown>;
}

/** A text/image content block returned by plugin tools (agent-facing). */
export interface PluginToolContent {
  type: 'text' | 'image';
  text?: string;
  data?: string;
  mimeType?: string;
}

/** Backend → main: result of a PluginToolCallMessage. */
export interface PluginToolResultMessage {
  type: 'tool-result';
  id: string;
  content?: PluginToolContent[];
  /** Arbitrary structured details for logs or UI rendering. */
  details?: unknown;
  /** Declarative card tree rendered in the chat timeline (messageRenderer). */
  card?: import('./ui-tree.js').UiNode;
  error?: string;
}

/** Main → backend: collect auto context before a message send. */
export interface PluginContextRequestMessage {
  type: 'context-request';
  id: string;
  providerId: string;
  /** The user message about to be sent (for relevance filtering). */
  message: string;
}

/** Backend → main: context text to inject into the prompt. */
export interface PluginContextResultMessage {
  type: 'context-result';
  id: string;
  /** Injected context; empty/undefined = nothing relevant. */
  text?: string;
  error?: string;
}

/** Main → backend: push event (e.g. "browser.urlChanged"). */
export interface PluginHostEventMessage {
  type: 'host-event';
  event: string;
  data?: unknown;
}

export interface PluginLogMessage {
  type: 'log';
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
}

export interface PluginShutdownMessage {
  type: 'shutdown';
}

export type HostToPluginMessage =
  | PluginInitMessage
  | PluginUiPortMessage
  | CapabilityResultMessage
  | PluginCommandMessage
  | PluginToolCallMessage
  | PluginContextRequestMessage
  | PluginHostEventMessage
  | PluginShutdownMessage;

export type PluginToHostMessage =
  | PluginReadyMessage
  | CapabilityCallMessage
  | PluginCommandResultMessage
  | PluginToolResultMessage
  | PluginContextResultMessage
  | PluginLogMessage;

// ── Data plane (backend ↔ plugin UI, over the MessagePort pair) ──
//
// Every message names the panel it belongs to. The host relays these payloads
// opaquely, so the panel id is what lets a plugin with more than one panel tell
// its own messages apart — and it is stamped automatically by the SDK on both
// sides, so a plugin author never writes it.
//
// A panel that sends without a panelId is a bug, not a variant: the backend
// cannot know who is talking. See `plugin-sdk-js.ts` (panel side) and
// `packages/plugin-sdk` (backend side).

/**
 * Query parameter carrying the panel id on a panel's `pi-plugin://` URL.
 *
 * The panel URL is the only channel that reaches BOTH containers (native view
 * and iframe) and that the `pi-plugin://` handler can read — a scheme request
 * carries no caller identity, so without this the host cannot tell two panels
 * of the same plugin apart. Both URL builders must append it; the handler
 * turns it into `window.__piPanelId` for the injected SDK.
 */
export const PANEL_QUERY_PARAM = '__panel';

/**
 * The URL a panel's page is served from.
 *
 * Both containers must build it through here. The query param is the only way
 * the `pi-plugin://` handler can learn which panel it is serving — and a panel
 * loaded without it gets no `__piPanelId`, so it cannot route its own messages
 * and the backend cannot tell its panels apart.
 */
export function panelUrl(pluginId: string, panelId: string, entry: string): string {
  const path = entry.replace(/^\/+/, '');
  return `pi-plugin://${pluginId}/${path}?${PANEL_QUERY_PARAM}=${encodeURIComponent(panelId)}`;
}

// The message shapes that travel over that port — `kind: 'request' | 'event'`
// from the panel, `'response' | 'event'` back — live in the two places that
// actually produce them, because nothing else needs them typed:
//   panel side:  apps/desktop/src/main/plugins/plugin-sdk-js.ts
//   backend side: packages/plugin-sdk/src/index.ts (`onPanelMessage`)
// A plugin using the SDK never sees them; one that deliberately does not can
// read them there.

// ── Capability methods (host.* API surface) ──

export type CapabilityMethod =
  | 'app.info'
  | 'storage.get'
  | 'storage.set'
  | 'storage.delete'
  | 'notify.show'
  /** Put a native file picker in front of the user and return the choice. */
  | 'dialog.openFile'
  | 'dialog.saveFile'
  | 'panel.setStatus'
  | 'panel.open'
  | 'filesystem.read'
  | 'filesystem.write'
  /** Remove a file. Same mtime conflict check as write. */
  | 'filesystem.delete'
  /** Structured text extraction from docx / xlsx / pptx / pdf. */
  | 'office.read'
  | 'browser.navigate'
  | 'browser.back'
  | 'browser.forward'
  | 'browser.reload'
  | 'browser.getUrl'
  | 'browser.getState'
  | 'browser.screenshot'
  | 'browser.click'
  | 'browser.getText'
  | 'browser.evaluate'
  | 'network.fetch'
  /** Put a message into the conversation, exactly as typing it would. */
  | 'chat.send';
