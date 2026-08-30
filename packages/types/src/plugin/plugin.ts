/**
 * Plugin runtime state and renderer-facing info.
 */

/** Where a plugin was discovered from. Higher priority overrides lower. */
export type PluginSource = 'dev' | 'user' | 'builtin';

export type PluginRuntimeState =
  | 'registered'   // manifest validated, not yet activated
  | 'activating'   // backend UtilityProcess starting
  | 'active'       // backend ready (or no backend)
  | 'disabled'     // turned off by user via plugins.json
  | 'incompatible' // engines check failed
  | 'error'        // failed to activate (crashed beyond restart budget)
  | 'crashed';     // backend exited, restart pending

export interface PluginPanelInfo {
  id: string;
  title: string;
  kind: 'iframe' | 'declarative' | 'liveview';
  entry?: string;
  icon?: string;
  keepAlive?: 'always' | 'lru' | 'never';
}

export interface PluginCommandInfo {
  /** Slash command name as declared, e.g. "/mail". */
  name: string;
  title?: string;
  description?: string;
}

export interface PluginToolInfo {
  name: string;
  description?: string;
}

/** Message renderer contribution: renders tool results as chat cards. */
export interface PluginMessageRendererInfo {
  /** Tool name whose result this renderer decorates (e.g. "mail_create_draft"). */
  type: string;
  kind: 'declarative' | 'iframe';
  /** Render a live card from streaming tool args while the tool runs. */
  streaming?: boolean;
}

/** Selection (滑词) action contribution. */
export interface PluginSelectionActionInfo {
  id: string;
  title: string;
}

/** Context provider contribution: injects context before message sends. */
export interface PluginContextProviderInfo {
  id: string;
  /** Whether the provider runs automatically before every send. */
  auto?: boolean;
  description?: string;
}

/** Settings contribution: auto-rendered form fields in the plugin center. */
export interface PluginSettingInfo {
  key: string;
  type: 'string' | 'number' | 'boolean' | 'enum';
  label?: string;
  description?: string;
  default?: unknown;
  options?: string[];
}

/** Serializable plugin descriptor sent to the renderer via IPC. */
export interface PluginInfo {
  id: string;
  name: string;
  description?: string;
  version: string;
  source: PluginSource;
  state: PluginRuntimeState;
  permissions: string[];
  panels: PluginPanelInfo[];
  commands: PluginCommandInfo[];
  tools: PluginToolInfo[];
  messageRenderers: PluginMessageRendererInfo[];
  selectionActions: PluginSelectionActionInfo[];
  contextProviders: PluginContextProviderInfo[];
  settings: PluginSettingInfo[];
  error?: string;
}

/** Panel status pushed from plugin backends (agent activity linkage). */
export interface PluginPanelStatus {
  pluginId: string;
  panelId?: string;
  badge?: number | string;
  activity?: 'idle' | 'streaming' | 'working' | 'error';
  detail?: string;
}

/** Events pushed from main to the renderer on the `pi:plugin:event` channel. */
export type PluginEvent =
  | { type: 'status'; status: PluginPanelStatus }
  | { type: 'state-changed'; pluginId: string; state: PluginRuntimeState; error?: string }
  | { type: 'plugins-changed' }
  /** Backend requested a panel open. focus=false → badge only, no steal. */
  | { type: 'panel-open'; pluginId: string; panelId?: string; focus: boolean }
  /** Marketplace install progress phases. */
  | { type: 'install-phase'; pluginId: string; phase: import('./market.js').InstallPhase };
