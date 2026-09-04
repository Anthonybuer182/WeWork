import { app } from 'electron';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { PluginManifest, PluginRuntimeState, PluginSource, PluginInfo } from '@pi/types';
import { satisfiesVersion } from './semver';

/** Host app id used in `engines` negotiation. */
export const HOST_ENGINE_KEY = 'pi-desktop';

/** Host API contract version, bumped on breaking capability changes. */
export const HOST_API_VERSION = '1.0.0';

const PLUGIN_ID_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

export interface ResolvedPlugin {
  manifest: PluginManifest;
  rootPath: string;
  source: PluginSource;
  enabled: boolean;
  state: PluginRuntimeState;
  error?: string;
}

/** Shape of ~/.pi/agent/plugins/_state.json */
export interface PluginsStateFile {
  plugins?: Record<string, { enabled?: boolean }>;
}

const SOURCE_PRIORITY: Record<PluginSource, number> = { dev: 3, user: 2, builtin: 1 };

/**
 * Multi-root plugin discovery with priority resolution.
 *
 * Roots, highest priority first:
 *   1. dev   — paths from the PI_DEV_PLUGINS env var (colon-separated)
 *   2. user  — ~/.pi/agent/plugins/  (installed plugins)
 *   3. builtin — <resources>/plugins (ships empty in the zero-builtin strategy)
 */
export class PluginRegistry {
  private plugins = new Map<string, ResolvedPlugin>();
  private stateFile: PluginsStateFile = {};
  private agentDir: string;
  private appVersionValue: string;

  constructor(opts?: { agentDir?: string; appVersion?: string }) {
    this.agentDir = opts?.agentDir ?? getAgentDir();
    this.appVersionValue = opts?.appVersion ?? app.getVersion();
  }

  // ── Paths ──

  get appVersion(): string {
    return this.appVersionValue;
  }

  /** Marketplace index override (environment variable for dev; undefined → default). */
  get registryUrl(): string | undefined {
    return process.env.PI_PLUGIN_REGISTRY;
  }

  get pluginsRoot(): string {
    return join(this.agentDir, 'plugins');
  }

  get pluginsDataRoot(): string {
    return join(this.agentDir, 'plugins', '_data');
  }

  getDataDir(pluginId: string): string {
    return join(this.pluginsDataRoot, pluginId);
  }

  private get stateFilePath(): string {
    return join(this.agentDir, 'plugins', '_state.json');
  }

  private getBuiltinRoot(): string {
    if (app.isPackaged) {
      return join(process.resourcesPath, 'plugins');
    }
    const __dirname = dirname(fileURLToPath(import.meta.url));
    // out/main/plugins → apps/desktop/plugins
    return resolve(__dirname, '..', '..', 'plugins');
  }

  private getDevPaths(): string[] {
    const env = process.env.PI_DEV_PLUGINS;
    return env ? env.split(':').filter(Boolean) : [];
  }

  // ── State file ──

  loadState(): void {
    try {
      if (existsSync(this.stateFilePath)) {
        this.stateFile = JSON.parse(readFileSync(this.stateFilePath, 'utf-8'));
      }
    } catch (err) {
      console.warn('[plugins] Failed to read _state.json:', err);
      this.stateFile = {};
    }
  }

  private saveState(): void {
    try {
      mkdirSync(this.agentDir, { recursive: true });
      writeFileSync(this.stateFilePath, JSON.stringify(this.stateFile, null, 2), 'utf-8');
    } catch (err) {
      console.warn('[plugins] Failed to write _state.json:', err);
    }
  }

  setEnabled(pluginId: string, enabled: boolean): void {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return;
    this.stateFile.plugins = this.stateFile.plugins ?? {};
    this.stateFile.plugins[pluginId] = { ...(this.stateFile.plugins[pluginId] ?? {}), enabled };
    this.saveState();
    plugin.enabled = enabled;
  }

  // ── Scanning ──

  /** Scan all roots, validate manifests, negotiate engines, and dedupe by priority. */
  scan(): ResolvedPlugin[] {
    this.loadState();
    this.plugins.clear();

    const candidates = new Map<string, { manifest: PluginManifest; rootPath: string; source: PluginSource }>();

    const collectFrom = (rootPath: string, source: PluginSource) => {
      if (!rootPath || !existsSync(rootPath)) return;
      const stat = readdirSync(rootPath, { withFileTypes: true });

      // A root may itself be a plugin directory (single-plugin dev path).
      if (existsSync(join(rootPath, 'manifest.json'))) {
        this.addCandidate(candidates, rootPath, source);
        return;
      }
      for (const entry of stat) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        if (entry.name === '_data') continue;  // plugin data, not a plugin
        this.addCandidate(candidates, join(rootPath, entry.name), source);
      }
    };

    // Priority order matters: later (lower-priority) sources never override.
    for (const p of this.getDevPaths()) collectFrom(resolve(p), 'dev');
    collectFrom(this.pluginsRoot, 'user');
    collectFrom(this.getBuiltinRoot(), 'builtin');

    const enabledMap = this.stateFile.plugins ?? {};
    for (const [id, candidate] of candidates) {
      const plugin: ResolvedPlugin = {
        manifest: candidate.manifest,
        rootPath: candidate.rootPath,
        source: candidate.source,
        enabled: enabledMap[id]?.enabled !== false, // enabled by default
        state: 'registered',
      };
      // engines negotiation
      const range = candidate.manifest.engines?.[HOST_ENGINE_KEY];
      if (range && !satisfiesVersion(this.appVersion, range)) {
        plugin.state = 'incompatible';
        plugin.error = `requires ${HOST_ENGINE_KEY} ${range}, host is ${this.appVersion}`;
      }
      this.plugins.set(id, plugin);
    }

    return [...this.plugins.values()];
  }

  private addCandidate(
    candidates: Map<string, { manifest: PluginManifest; rootPath: string; source: PluginSource }>,
    dir: string,
    source: PluginSource,
  ): void {
    const validated = this.validateManifestDir(dir);
    if (!validated) return;
    const { manifest } = validated;
    const existing = candidates.get(manifest.id);
    if (existing && SOURCE_PRIORITY[existing.source] >= SOURCE_PRIORITY[source]) return;
    candidates.set(manifest.id, { manifest, rootPath: dir, source });
  }

  /** Read + validate a manifest.json in `dir`. Returns null (with a log) when invalid. */
  private validateManifestDir(dir: string): { manifest: PluginManifest } | null {
    const manifestPath = join(dir, 'manifest.json');
    if (!existsSync(manifestPath)) return null;

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    } catch (err) {
      console.warn(`[plugins] Invalid manifest.json in ${dir}:`, err);
      return null;
    }

    const manifest = raw as PluginManifest;
    if (!PLUGIN_ID_RE.test(manifest.id ?? '')) {
      console.warn(`[plugins] Invalid plugin id "${manifest.id}" in ${dir}`);
      return null;
    }
    if (!manifest.name || !manifest.version) {
      console.warn(`[plugins] Manifest missing name/version in ${dir}`);
      return null;
    }

    // Panel validation: iframe panels must declare an entry path.
    for (const panel of manifest.contributes?.panels ?? []) {
      if (!panel.id) {
        console.warn(`[plugins] Panel without id in ${dir}`);
        return null;
      }
      if (panel.kind === 'iframe' && !panel.entry) {
        console.warn(`[plugins] Panel "${panel.id}" is kind "iframe" but has no entry in ${dir}`);
        return null;
      }
      if (panel.entry) panel.entry = panel.entry.replace(/^\/+/, '');
    }

    // Backend entry must exist when declared.
    if (manifest.backend && !existsSync(join(dir, manifest.backend))) {
      console.warn(`[plugins] Backend entry "${manifest.backend}" not found in ${dir}`);
      return null;
    }

    return { manifest };
  }

  // ── Accessors ──

  all(): ResolvedPlugin[] {
    return [...this.plugins.values()];
  }

  get(id: string): ResolvedPlugin | undefined {
    return this.plugins.get(id);
  }

  /** Filesystem root serving `pi-plugin://<id>/...` requests. */
  getRoot(id: string): string | undefined {
    return this.plugins.get(id)?.rootPath;
  }

  setState(id: string, state: PluginRuntimeState, error?: string): void {
    const plugin = this.plugins.get(id);
    if (!plugin) return;
    plugin.state = state;
    plugin.error = error;
  }

  toInfo(plugin: ResolvedPlugin): PluginInfo {
    // Plugin-provided icon files are served from the plugin's own
    // pi-plugin:// origin (unique per plugin, cross-origin with the host).
    const pluginIconUrl = plugin.manifest.icon
      ? `pi-plugin://${plugin.manifest.id}/${plugin.manifest.icon.replace(/^\.?\//, '')}`
      : undefined;
    return {
      id: plugin.manifest.id,
      name: plugin.manifest.name,
      description: plugin.manifest.description,
      version: plugin.manifest.version,
      source: plugin.source,
      state: plugin.state,
      permissions: plugin.manifest.permissions ?? [],
      iconUrl: pluginIconUrl,
      panels: (plugin.manifest.contributes?.panels ?? []).map((p) => ({
        id: p.id,
        title: p.title ?? p.id,
        kind: p.kind,
        entry: p.entry,
        icon: p.icon,
        // Explicit declarations win over the plugin brand: panel iconPath >
        // panel vocabulary name > inherited plugin icon > Puzzle.
        iconUrl: p.iconPath
          ? `pi-plugin://${plugin.manifest.id}/${p.iconPath.replace(/^\.?\//, '')}`
          : p.icon
            ? undefined
            : pluginIconUrl,
        hidden: p.hidden === true,
        companionOf: p.companionOf,
        keepAlive: p.keepAlive,
        autoHeight: p.autoHeight,
      })),
      commands: (plugin.manifest.contributes?.commands ?? []).map((c) => ({
        name: c.name,
        title: c.title,
        description: c.description,
      })),
      tools: (plugin.manifest.contributes?.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description,
      })),
      messageRenderers: (plugin.manifest.contributes?.messageRenderers ?? []).map((m) => ({
        type: m.type,
        kind: m.kind,
        streaming: m.streaming,
      })),
      selectionActions: (plugin.manifest.contributes?.selectionActions ?? []).map((a) => ({
        id: a.id,
        title: a.title,
      })),
      contextProviders: (plugin.manifest.contributes?.contextProviders ?? []).map((c) => ({
        id: c.id,
        auto: c.auto,
        description: c.description,
      })),
      settings: (plugin.manifest.contributes?.settings ?? []).map((s) => ({
        key: s.key,
        type: s.type,
        label: s.label,
        description: s.description,
        default: s.default,
        options: s.options,
      })),
      error: plugin.error,
    };
  }

  listInfos(): PluginInfo[] {
    return this.all().filter((p) => p.enabled).map((p) => this.toInfo(p));
  }
}
