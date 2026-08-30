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

/** Plugin version of the host API this backend was built against. */
export const PLUGIN_API_VERSION = '1.0.0';

export interface PluginInitMessage {
  type: 'init';
  pluginId: string;
  apiVersion: string;
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

/** Main → backend: a selection (滑词) action was invoked. */
export interface PluginSelectionActionMessage {
  type: 'selection-action';
  id: string;
  actionId: string;
  text: string;
  source: { kind: string; pluginId?: string; label?: string };
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
  | PluginSelectionActionMessage
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

/** UI → backend request expecting a response. */
export interface UiRequestMessage {
  kind: 'request';
  id: string;
  method: string;
  params?: Record<string, unknown>;
  /** Panel the message originated from. */
  panelId?: string;
}

/** Backend → UI response to a UiRequestMessage. */
export interface UiResponseMessage {
  kind: 'response';
  id: string;
  result?: unknown;
  error?: string;
}

/** Fire-and-forget in both directions. */
export interface UiEventMessage {
  kind: 'event';
  event: string;
  data?: unknown;
  panelId?: string;
}

export type PluginUiMessage = UiRequestMessage | UiResponseMessage | UiEventMessage;

// ── Capability methods (host.* API surface) ──

export type CapabilityMethod =
  | 'app.info'
  | 'storage.get'
  | 'storage.set'
  | 'storage.delete'
  | 'notify.show'
  | 'panel.setStatus'
  | 'panel.open'
  | 'filesystem.read'
  | 'office.read'
  | 'browser.navigate'
  | 'browser.back'
  | 'browser.forward'
  | 'browser.reload'
  | 'browser.getState'
  | 'browser.screenshot'
  | 'browser.click'
  | 'browser.getText'
  | 'browser.evaluate'
  | 'network.fetch';
