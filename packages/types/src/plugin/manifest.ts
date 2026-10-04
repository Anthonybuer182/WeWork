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
 *   "clipboard"          — clipboard access
 *   "browser"            — drive the host browser automation capability
 */
export type PluginPermission = string;

/**
 * The protocol version this build of the host speaks — the UPPER bound of the
 * supported range. Compatibility is a range, not an exact match:
 *
 *   plugin loads   ⇔  MIN_SUPPORTED_API_VERSION ≤ manifest.apiVersion ≤ PLUGIN_PROTOCOL_VERSION
 *
 * - Additive protocol changes (new manifest fields, new capabilities, new
 *   lifecycle events) bump ONLY PLUGIN_PROTOCOL_VERSION — every plugin in the
 *   range keeps loading untouched.
 * - Breaking changes (a field changes meaning, a feature is removed — as v3
 *   did to `selectionActions`) bump BOTH: the old current becomes the new
 *   floor. Plugins below the floor are `incompatible` with a clear
 *   "too old, update the plugin" reason instead of failing somewhere deep in
 *   a panel.
 * - A plugin declaring a version ABOVE the current is `incompatible` too —
 *   "the plugin is newer than your app, update the app".
 *
 * The exact-match policy this replaces meant every protocol bump bricked all
 * installed third-party plugins at once — untenable the moment the protocol
 * is opened to outside authors.
 *
 * History:
 *
 * 4 — added the `card-event` host→plugin message and the SDK's `onCardEvent`
 *     callback: declarative cards returned by tools (messageRenderers) can
 *     now carry interactive Buttons/Inputs, and the interaction flows back to
 *     the plugin backend. Purely additive — protocol 3 plugins load unchanged
 *     (their SDK ignores the new message), so the floor stays at 3.
 *
 * 3 — dropped `selectionActions` and the `selection` permission. The host's
 *     selection menu (滑词菜单) is gone: text selection is the panel's own
 *     business, and the one panel that had a selection UI of its own (the file
 *     viewer, driven by GenOffice) was drawing two floating menus at once.
 *     A manifest still declaring `selectionActions` is now rejected rather than
 *     silently ignored — see the `apiVersion` note on PluginManifest.
 */
export const PLUGIN_PROTOCOL_VERSION = 4;

/**
 * The OLDEST protocol version this build still loads — the lower bound of the
 * supported range. See PLUGIN_PROTOCOL_VERSION for the bump rules.
 *
 * A manifest that OMITS `apiVersion` predates versioning itself and loads
 * unchanged (the field was optional from day one) — but the plugin dev guide
 * and the marketplace listing both require it, so third-party plugins always
 * declare it and always get negotiated.
 */
export const MIN_SUPPORTED_API_VERSION = 3;

export interface PluginManifest {
  /** Reverse-DNS style id, lowercase. Also the directory name. */
  id: string;
  name: string;
  description?: string;
  version: string;
  /**
   * The plugin protocol version this plugin was written against. Loaded iff
   * it falls inside the host's supported range
   * (MIN_SUPPORTED_API_VERSION … PLUGIN_PROTOCOL_VERSION); outside the range
   * puts the plugin in the `incompatible` state with a reason saying which
   * side has to move. See PLUGIN_PROTOCOL_VERSION.
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
