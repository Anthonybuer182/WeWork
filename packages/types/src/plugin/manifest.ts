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

/** Which sidebar column a panel belongs to. */
export type PanelRegion = 'left' | 'right';

/** Where within its region's rail the panel sits. */
export type PanelAnchor = 'top' | 'bottom';

export interface PanelContribution {
  id: string;
  title?: string;
  /** Icon name from the host's built-in vocabulary (fallback: Puzzle). */
  icon?: string;
  /**
   * Plugin-provided icon file, path relative to the plugin root (e.g.
   * './ui/assets/panel.svg'). Served from the plugin's own pi-plugin://
   * origin; takes precedence over the vocabulary `icon`. SVGs render via
   * <img> so they can never execute scripts in the host.
   */
  iconPath?: string;
  /**
   * Omit the panel from the rail — it stays openable via panel.open
   * (events/tools). Use for auxiliary panels that belong to a primary one.
   */
  hidden?: boolean;
  /**
   * Render this declarative panel as a companion card attached above a
   * liveview panel of the same plugin (e.g. a control bar over the live
   * view). The companion is not listed on the rail itself.
   */
  companionOf?: string;
  kind: PanelKind;
  /** Path relative to the plugin root (required for `iframe` panels). */
  entry?: string;
  keepAlive?: PanelKeepAlive;
  /** Default panel width in px when opened in the right sidebar. */
  width?: number;
  /** Let the host size the iframe to its content height (SDK reports it). */
  autoHeight?: boolean;
  /**
   * Which sidebar column the panel lives in. Defaults to 'right'.
   *
   * The left column is the global-view column (all files, all sessions), so a
   * panel belongs there when its subject is the workspace as a whole rather
   * than the thing currently being worked on.
   *
   * Ignored for `kind: 'liveview'`, which is pinned right: every liveview
   * panel shares one native view, and a hidden left-side slot reporting 0x0
   * would blank the visible one.
   */
  region?: PanelRegion;
  /** Position within its region's rail. Defaults to 'top'. */
  anchor?: PanelAnchor;
  /** Sort order among panels sharing a region and anchor. Defaults to 0. */
  order?: number;
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
  /**
   * Plugin icon file, path relative to the plugin root — the plugin's brand
   * mark, shown in the plugin center's installed list (and marketplace).
   */
  icon?: string;
  permissions?: PluginPermission[];
  contributes?: PluginContributions;
}
