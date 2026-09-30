/**
 * Plugin manifest contract — the single source of truth for a plugin's
 * identity, permissions and contributions.
 *
 * A manifest.json lives at the root of a plugin directory:
 *
 *   <root>/manifest.json
 *   <root>/dist/main.js        (backend entry, UtilityProcess)
 *   <root>/ui/                 (panel assets)
 */

/** Keep-alive policy for a panel when it is switched away from. */
export type PanelKeepAlive = 'always' | 'lru' | 'never';

/** Which sidebar column a panel belongs to. */
export type PanelRegion = 'left' | 'right';

/** Where within its region's rail the panel sits. */
export type PanelAnchor = 'top' | 'bottom';

export interface PanelContribution {
  /** Unique within the plugin; also the `panelId` in the panel↔backend protocol. */
  id: string;
  title?: string;
  /**
   * Panel icon. Two forms, told apart by the leading `./` or `/`:
   *   "./assets/main.svg"  → a file in the plugin, served from its own origin
   *   "calendar"           → a name from the host's built-in icon vocabulary
   * A file wins over the plugin's own brand icon; a vocabulary name falls back
   * to it.
   */
  icon?: string;
  /**
   * Omit the panel from the rail — it stays openable via panel.open
   * (events/tools). Use for auxiliary panels that belong to a primary one.
   */
  hidden?: boolean;
  /**
   * Path to the panel's HTML page, relative to the plugin root.
   *
   * Required. This is what a panel IS: a web page. There is no `kind` field —
   * the host decides how to host the page (a native view on desktop), and a
   * plugin never needs to know or care.
   */
  entry: string;
  keepAlive?: PanelKeepAlive;
  /**
   * Which sidebar column the panel lives in. Defaults to 'right'.
   *
   * The left column is the global-view column (all files, all sessions), so a
   * panel belongs there when its subject is the workspace as a whole rather
   * than the thing currently being worked on.
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

/** The protocol version this build of the host speaks. */
export const PLUGIN_PROTOCOL_VERSION = 2;

export interface PluginManifest {
  /** Reverse-DNS style id, lowercase. Also the directory name. */
  id: string;
  name: string;
  description?: string;
  version: string;
  /**
   * The plugin protocol version this plugin was written against.
   * A mismatch puts the plugin in the `incompatible` state with a clear reason
   * rather than letting it half-work. See PLUGIN_PROTOCOL_VERSION.
   */
  apiVersion?: number;
  /** Host version compatibility, semver range. e.g. { "pi-desktop": "^1.0.0" } */
  engines?: Record<string, string>;
  /** Backend entry relative to the plugin root. Omit for UI-only plugins. */
  backend?: string;
  /**
   * Plugin icon file, path relative to the plugin root — the plugin's brand
   * mark, shown in the plugin center's installed list (and marketplace).
   */
  icon?: string;
  permissions?: PluginPermission[];
  contributes?: PluginContributions;
}
