/**
 * Plugin manifest contract — the single source of truth for a plugin's
 * identity, permissions and contributions.
 *
 * A manifest.json lives at the root of a plugin directory:
 *
 *   <root>/manifest.json
 *   <root>/dist/main.js        (backend entry, UtilityProcess)
 *   <root>/ui/                 (iframe panel assets)
 */

/** Panel content rendering tier. */
export type PanelKind = 'iframe' | 'declarative' | 'liveview';

/** Keep-alive policy for iframe/liveview panels when switched away. */
export type PanelKeepAlive = 'always' | 'lru' | 'never';

export interface PanelContribution {
  id: string;
  title?: string;
  icon?: string;
  kind: PanelKind;
  /** Path relative to the plugin root (required for `iframe` panels). */
  entry?: string;
  keepAlive?: PanelKeepAlive;
  /** Default panel width in px when opened in the right sidebar. */
  width?: number;
}

/**
 * Agent tool definition. The schema follows the MCP tool format
 * (JSON Schema based `inputSchema`), so external MCP servers can be
 * mounted as headless plugins in the future.
 */
export interface ToolContribution {
  name: string;
  description?: string;
  /** JSON Schema for the tool parameters. */
  inputSchema?: Record<string, unknown>;
  /** Path to a skill markdown doc that teaches the agent how to use this tool. */
  skillPath?: string;
}

export interface CommandContribution {
  /** Slash command including the leading slash, e.g. "/mail". */
  name: string;
  title?: string;
  description?: string;
}

export interface MessageRendererContribution {
  /** Keyed by message/tool block type, e.g. "mail:draft". */
  type: string;
  kind: 'declarative' | 'iframe';
  /** Render a live card from streaming tool args while the tool runs. */
  streaming?: boolean;
}

export interface ContextProviderContribution {
  id: string;
  /** Whether the provider runs automatically before every message send. */
  auto?: boolean;
  description?: string;
}

export interface SelectionActionContribution {
  id: string;
  title: string;
  icon?: string;
}

export interface FilePreviewContribution {
  /** File extensions to handle, e.g. ["docx", "xlsx"]. */
  match: string[];
}

export interface SkillContribution {
  /** Path relative to the plugin root pointing at a SKILL.md folder or file. */
  path: string;
}

export interface SettingsContribution {
  key: string;
  type: 'string' | 'number' | 'boolean' | 'enum';
  label?: string;
  description?: string;
  default?: unknown;
  options?: string[];
}

export interface PluginContributions {
  panels?: PanelContribution[];
  tools?: ToolContribution[];
  commands?: CommandContribution[];
  messageRenderers?: MessageRendererContribution[];
  contextProviders?: ContextProviderContribution[];
  selectionActions?: SelectionActionContribution[];
  filePreview?: FilePreviewContribution[];
  skills?: SkillContribution[];
  settings?: SettingsContribution[];
}

/**
 * Capability permission grant. Examples:
 *   "storage"            — plugin-private key/value storage
 *   "secrets:mail"       — read the "mail" namespace from the secrets vault
 *   "network:imap.*"     — outbound network to hosts matching the pattern
 *   "notify"             — desktop notifications
 *   "selection"          — register selection (滑词) actions
 *   "clipboard"          — clipboard access
 *   "browser"            — drive the host browser automation capability
 */
export type PluginPermission = string;

export interface PluginManifest {
  /** Reverse-DNS style id, lowercase. Also the directory name. */
  id: string;
  name: string;
  description?: string;
  version: string;
  author?: string;
  /** Host version compatibility, semver range. e.g. { "pi-desktop": "^1.0.0" } */
  engines?: Record<string, string>;
  /** Backend entry relative to the plugin root. Omit for UI-only plugins. */
  backend?: string;
  /** UI assets root relative to the plugin root. Omit for headless plugins. */
  ui?: string;
  permissions?: PluginPermission[];
  contributes?: PluginContributions;
}
