import { app, BrowserWindow, MessageChannelMain } from 'electron';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import type {
  CapabilityCallMessage,
  InstallPhase,
  InstallResult,
  MarketEntry,
  PluginEvent,
  PluginInfo,
  PluginToolContent,
  UiNode,
} from '@pi/types';
import { PluginRegistry, HOST_API_VERSION } from './registry';
import { CapabilityHub } from './capability-hub';
import { PluginProcess, spawnBackend } from './plugin-process';
import { registerPluginProtocolHandler } from './protocol';
import { PluginMarketplace } from './marketplace';
import type { BrowserManager } from '@main/browser/browser-manager';

export { registerPluginSchemePrivileges, PI_PLUGIN_SCHEME, registerMemoryFile, clearMemoryFile } from './protocol';
export { PluginRegistry } from './registry';
export { PluginMarketplace, DEFAULT_REGISTRY_URL } from './marketplace';

/** Agent tool definition shape expected by createAgentSession({ customTools }). */
export interface AgentCustomTool {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{
    content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType?: string }>;
    details: unknown;
  }>;
}

/**
 * Facade wiring the plugin kernel together:
 * registry (discovery) + UtilityProcess backends + capability routing +
 * pi-plugin:// protocol + event fan-out to renderer windows.
 */
export class PluginSystem {
  readonly registry: PluginRegistry;
  readonly capabilityHub: CapabilityHub;
  readonly marketplace: PluginMarketplace;
  private processes = new Map<string, PluginProcess>();
  /** Active UI port pairs: `${pluginId}:${webContentsId}` — ensureUiPort is idempotent on these. */
  private uiPortKeys = new Map<string, boolean>();
  /** Notified whenever the aggregate tool/skill set changes. */
  onExtensionsChanged: (() => void) | null = null;
  /** Resolves when init() has finished — IPC handlers gate reads on this. */
  private initPromise: Promise<void> | null = null;

  constructor(opts?: { agentDir?: string; browserManager?: BrowserManager }) {
    this.registry = new PluginRegistry({ ...opts, appVersion: app.getVersion() });
    this.capabilityHub = new CapabilityHub({
      registry: this.registry,
      emitEvent: (evt) => this.emitEvent(evt),
      browserManager: opts?.browserManager,
    });
    this.marketplace = new PluginMarketplace(this.registry);
  }

  /** Scan roots, activate enabled plugins (spawn backends), serve the protocol. */
  init(): Promise<void> {
    this.initPromise ??= this.doInit();
    return this.initPromise;
  }

  /**
   * Await kernel boot. The file:// renderer loads in milliseconds in packaged
   * builds and its first `pi:plugin:list` may race `init()` — handlers
   * registered before boot queue on this instead of seeing an empty registry.
   */
  async whenReady(): Promise<void> {
    if (this.initPromise) await this.initPromise;
  }

  private async doInit(): Promise<void> {
    this.registry.scan();
    registerPluginProtocolHandler(this.registry);

    const appVersion = app.getVersion();
    for (const plugin of this.registry.all()) {
      if (!plugin.enabled) continue;
      if (plugin.state === 'incompatible') {
        console.warn(`[plugins] ${plugin.manifest.id} incompatible: ${plugin.error}`);
        continue;
      }
      this.syncPluginSkills(plugin);
      if (!plugin.manifest.backend) continue; // UI-only plugin — no process
      await this.activate(plugin.manifest.id, plugin.rootPath, plugin.manifest.backend, appVersion);
    }

    console.log(
      `[plugins] kernel ready — ${this.registry.all().length} plugin(s) discovered, ` +
      `${this.processes.size} backend(s) running, ${this.aggregateTools().length} agent tool(s) (api ${HOST_API_VERSION})`,
    );
    this.onExtensionsChanged?.();
  }

  private async activate(pluginId: string, rootPath: string, backendEntry: string, appVersion: string): Promise<void> {
    try {
      this.registry.setState(pluginId, 'activating');
      const dataDir = this.registry.getDataDir(pluginId);
      mkdirSync(dataDir, { recursive: true });

      const proc = await spawnBackend({ pluginId, rootPath, backendEntry, dataDir, appVersion });
      proc.onCapabilityCall = (msg) => this.handleCapabilityCall(pluginId, msg);
      proc.onStateChange = (state, error) => {
        this.registry.setState(pluginId, state, error);
        this.emitEvent({ type: 'state-changed', pluginId, state, error });
      };
      this.processes.set(pluginId, proc);
      this.registry.setState(pluginId, 'active');
      this.emitEvent({ type: 'state-changed', pluginId, state: 'active' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[plugins] activate ${pluginId} failed:`, message);
      this.registry.setState(pluginId, 'error', message);
      this.emitEvent({ type: 'state-changed', pluginId, state: 'error', error: message });
    }
  }

  /** Drop the UI port registration for a plugin (backend stopped/crashed). */
  private clearUiPorts(pluginId: string): void {
    for (const key of [...this.uiPortKeys.keys()]) {
      if (key.startsWith(`${pluginId}:`)) this.uiPortKeys.delete(key);
    }
  }

  /** Kill a running backend (if any) and drop it from the process map. */
  private stopPlugin(pluginId: string): void {
    const proc = this.processes.get(pluginId);
    if (proc) {
      proc.kill();
      this.clearUiPorts(pluginId);
      this.processes.delete(pluginId);
    }
  }

  /**
   * After a registry re-scan (install/uninstall/enable), restore the runtime
   * state of unaffected plugins: scan() rebuilds entries as 'registered',
   * but their backends are still running.
   */
  private refreshRuntimeStates(): void {
    for (const [pluginId, proc] of this.processes) {
      const plugin = this.registry.get(pluginId);
      if (plugin && plugin.enabled && proc.running) {
        this.registry.setState(pluginId, 'active');
      }
    }
  }

  /** Activate one registry entry at runtime (used by init / install / enable). */
  private async activateResolved(pluginId: string): Promise<void> {
    const plugin = this.registry.get(pluginId);
    if (!plugin || !plugin.enabled) return;
    if (plugin.state === 'incompatible') return;
    this.syncPluginSkills(plugin);
    if (!plugin.manifest.backend) {
      this.registry.setState(pluginId, 'active');
      this.emitEvent({ type: 'state-changed', pluginId, state: 'active' });
      return;
    }
    await this.activate(pluginId, plugin.rootPath, plugin.manifest.backend, app.getVersion());
  }

  /**
   * Sync contributes.skills into ~/.pi/agent/skills/<pluginId>/ so the SDK's
   * DefaultResourceLoader discovers them (namespaced per plugin).
   */
  private syncPluginSkills(plugin: { manifest: { id: string; contributes?: { skills?: Array<{ path: string }> } }; rootPath: string }): void {
    const skills = plugin.manifest.contributes?.skills ?? [];
    if (skills.length === 0) return;
    const agentSkillsDir = join(this.registry.pluginsRoot, '..', 'skills');
    const pluginSkillDir = join(agentSkillsDir, plugin.manifest.id);
    try {
      rmSync(pluginSkillDir, { recursive: true, force: true });
      for (const skill of skills) {
        const src = join(plugin.rootPath, skill.path);
        if (!existsSync(src)) {
          console.warn(`[plugins] skill path missing: ${src}`);
          continue;
        }
        cpSync(src, join(pluginSkillDir, basename(skill.path)), { recursive: true });
      }
    } catch (err) {
      console.warn(`[plugins] skill sync failed for ${plugin.manifest.id}:`, err);
    }
  }

  /** Remove a plugin's contributed skills from the agent skills dir. */
  private removePluginSkills(pluginId: string): void {
    const pluginSkillDir = join(this.registry.pluginsRoot, '..', 'skills', pluginId);
    try {
      rmSync(pluginSkillDir, { recursive: true, force: true });
    } catch { /* best-effort */ }
  }

  /** Push a host event to every running backend holding the permission. */
  pushHostEvent(event: string, permission: string, data?: unknown): void {
    for (const [pluginId, proc] of this.processes) {
      const plugin = this.registry.get(pluginId);
      if (!plugin?.enabled) continue;
      if (!(plugin.manifest.permissions ?? []).includes(permission)) continue;
      try {
        proc.pushHostEvent(event, data);
      } catch { /* best-effort */ }
    }
  }

  /** All agent tools contributed by enabled plugins (for customTools). */
  aggregateTools(): AgentCustomTool[] {
    const tools: AgentCustomTool[] = [];
    for (const plugin of this.registry.all()) {
      if (!plugin.enabled || plugin.state === 'incompatible') continue;
      for (const tool of plugin.manifest.contributes?.tools ?? []) {
        const pluginId = plugin.manifest.id;
        tools.push({
          name: tool.name,
          label: tool.name,
          description: tool.description ?? `Plugin tool from ${pluginId}`,
          parameters: tool.inputSchema ?? { type: 'object', properties: {}, additionalProperties: false },
          execute: async (_toolCallId, params) => {
            const result = await this.executeTool(pluginId, tool.name, params ?? {});
            const content = (result.content ?? []).map((c) =>
              c.type === 'image' && c.data
                ? { type: 'image' as const, data: c.data, mimeType: c.mimeType ?? 'image/png' }
                : { type: 'text' as const, text: c.text ?? '' },
            );
            // Card tree rides in details → adapter lifts it into the block.
            return { content, details: { ...(result.details ?? null), card: result.card } };
          },
        });
      }
    }
    return tools;
  }

  /** Execute one agent tool in its plugin backend (agent loop entry point). */
  async executeTool(
    pluginId: string,
    name: string,
    params: Record<string, unknown>,
  ): Promise<{ content?: PluginToolContent[]; details?: unknown; card?: UiNode }> {
    const proc = this.processes.get(pluginId);
    if (!proc) {
      throw new Error(`plugin "${pluginId}" has no backend (tool "${name}")`);
    }
    return proc.executeTool(name, params);
  }

  /** Collect auto-injected context from one provider (pre-send hook). */
  async executeContextProvider(pluginId: string, providerId: string, message: string): Promise<string | undefined> {
    const proc = this.processes.get(pluginId);
    if (!proc) return undefined;
    const plugin = this.registry.get(pluginId);
    const providers = plugin?.manifest.contributes?.contextProviders ?? [];
    if (!providers.some((p) => p.id === providerId)) {
      throw new Error(`plugin "${pluginId}" does not contribute context provider "${providerId}"`);
    }
    return proc.requestContext(providerId, message);
  }

  /** All auto context providers of enabled plugins. */
  listAutoContextProviders(): Array<{ pluginId: string; providerId: string }> {
    const out: Array<{ pluginId: string; providerId: string }> = [];
    for (const plugin of this.registry.all()) {
      if (!plugin.enabled || plugin.state === 'incompatible' || plugin.state === 'error') continue;
      for (const provider of plugin.manifest.contributes?.contextProviders ?? []) {
        if (provider.auto) out.push({ pluginId: plugin.manifest.id, providerId: provider.id });
      }
    }
    return out;
  }

  /** Read plugin settings (manifest defaults merged with stored values). */
  getPluginSettings(pluginId: string): Record<string, unknown> {
    const plugin = this.registry.get(pluginId);
    if (!plugin) return {};
    const declared = plugin.manifest.contributes?.settings ?? [];
    const stored = this.readPluginStorage(pluginId);
    const out: Record<string, unknown> = {};
    for (const setting of declared) {
      const key = `settings.${setting.key}`;
      out[setting.key] = key in stored ? stored[key] : setting.default;
    }
    return out;
  }

  /** Write one plugin setting into its private storage. */
  setPluginSetting(pluginId: string, key: string, value: unknown): { ok: boolean; error?: string } {
    const plugin = this.registry.get(pluginId);
    if (!plugin) return { ok: false, error: `unknown plugin: ${pluginId}` };
    const declared = plugin.manifest.contributes?.settings ?? [];
    if (!declared.some((s) => s.key === key)) {
      return { ok: false, error: `plugin "${pluginId}" does not declare setting "${key}"` };
    }
    const stored = this.readPluginStorage(pluginId);
    stored[`settings.${key}`] = value;
    this.writePluginStorage(pluginId, stored);
    return { ok: true };
  }

  private readPluginStorage(pluginId: string): Record<string, unknown> {
    try {
      const file = join(this.registry.getDataDir(pluginId), 'storage.json');
      if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf-8'));
    } catch { /* corrupted → start fresh */ }
    return {};
  }

  private writePluginStorage(pluginId: string, store: Record<string, unknown>): void {
    try {
      mkdirSync(this.registry.getDataDir(pluginId), { recursive: true });
      writeFileSync(join(this.registry.getDataDir(pluginId), 'storage.json'), JSON.stringify(store, null, 2), 'utf-8');
    } catch (err) {
      console.warn(`[plugins] settings write failed for ${pluginId}:`, err);
    }
  }

  /** Execute a selection (滑词) action in its plugin backend. */
  async executeSelectionAction(
    pluginId: string,
    actionId: string,
    text: string,
    source: { kind: string; pluginId?: string; label?: string },
  ): Promise<unknown> {
    const proc = this.processes.get(pluginId);
    if (!proc) {
      throw new Error(`plugin "${pluginId}" has no backend`);
    }
    // Verify the action is actually contributed by this plugin.
    const plugin = this.registry.get(pluginId);
    const actions = plugin?.manifest.contributes?.selectionActions ?? [];
    if (!actions.some((a) => a.id === actionId)) {
      throw new Error(`plugin "${pluginId}" does not contribute selection action "${actionId}"`);
    }
    return proc.executeSelectionAction(actionId, text, source);
  }

  // ── Marketplace / lifecycle management ──

  async catalog(force = false): Promise<MarketEntry[]> {
    return this.marketplace.catalog(force);
  }

  /** Install (or update) a plugin from the marketplace catalog. */
  async installFromMarket(pluginId: string, onPhase?: (phase: InstallPhase) => void): Promise<InstallResult> {
    try {
      const entry = await this.marketplace.getEntry(pluginId);
      if (!entry) return { ok: false, error: `"${pluginId}" not found in registry` };

      // Stop the running backend before replacing files.
      this.stopPlugin(pluginId);

      const { stagedDir } = await this.marketplace.stageInstall(entry, (p) => onPhase?.(p));
      this.marketplace.commitInstall(stagedDir, pluginId);

      // Re-scan (picks up the new dir), then activate.
      this.registry.scan();
      this.refreshRuntimeStates();
      await this.activateResolved(pluginId);

      console.log(`[plugins] installed ${pluginId}@${entry.version}`);
      this.emitEvent({ type: 'plugins-changed' });
      this.onExtensionsChanged?.();
      return { ok: true, pluginId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[plugins] install ${pluginId} failed:`, message);
      this.emitEvent({ type: 'plugins-changed' });
      return { ok: false, error: message, pluginId };
    }
  }

  /** Remove a plugin's code; plugin data is preserved unless asked otherwise. */
  async uninstall(pluginId: string, opts?: { keepData?: boolean }): Promise<InstallResult> {
    const plugin = this.registry.get(pluginId);
    if (!plugin) return { ok: false, error: `"${pluginId}" is not installed` };

    this.stopPlugin(pluginId);
    this.removePluginSkills(pluginId);
    try {
      rmSync(plugin.rootPath, { recursive: true, force: true });
      if (opts?.keepData === false) {
        rmSync(this.registry.getDataDir(pluginId), { recursive: true, force: true });
      }
      this.registry.scan();
      this.refreshRuntimeStates();
      console.log(`[plugins] uninstalled ${pluginId} (data ${opts?.keepData === false ? 'removed' : 'kept'})`);
      this.emitEvent({ type: 'plugins-changed' });
      this.onExtensionsChanged?.();
      return { ok: true, pluginId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message, pluginId };
    }
  }

  /** Enable/disable a plugin at runtime. */
  async setEnabled(pluginId: string, enabled: boolean): Promise<InstallResult> {
    const plugin = this.registry.get(pluginId);
    if (!plugin) return { ok: false, error: `"${pluginId}" is not installed` };

    this.registry.setEnabled(pluginId, enabled);
    if (!enabled) {
      this.stopPlugin(pluginId);
      this.registry.setState(pluginId, 'disabled');
    } else {
      // fresh scan so state resets from 'disabled'
      this.registry.scan();
      this.refreshRuntimeStates();
      await this.activateResolved(pluginId);
    }
    this.emitEvent({ type: 'plugins-changed' });
    this.onExtensionsChanged?.();
    return { ok: true, pluginId };
  }

  /** All installed plugins, including disabled/incompatible ones. */
  listAllInfos(): PluginInfo[] {
    return this.registry.all().map((p) => this.registry.toInfo(p));
  }

  /**
   * Resolve which plugin panel handles a file preview (filePreview
   * contribution, matched by extension). Returns a panel id like
   * "plugin:<id>:<panelId>", or null when no plugin claims the extension.
   */
  findPreviewHandler(filePath: string): string | null {
    const ext = filePath.toLowerCase().split('.').pop()?.split('?')[0] ?? '';
    if (!ext) return null;
    // Source priority: dev (under development) > user (market-installed) >
    // builtin — a user-installed viewer overrides the bundled one for the
    // extensions it claims.
    const ranked = [...this.registry.all()].sort(
      (a, b) => sourcePriority(b.source) - sourcePriority(a.source),
    );
    for (const plugin of ranked) {
      if (!plugin.enabled || plugin.state === 'incompatible' || plugin.state === 'error') continue;
      const previews = plugin.manifest.contributes?.filePreview ?? [];
      if (!previews.some((p) => (p.match ?? []).includes(ext))) continue;
      const panel = plugin.manifest.contributes?.panels?.[0];
      if (!panel) continue;
      return `plugin:${plugin.manifest.id}:${panel.id}`;
    }
    return null;
  }

  private handleCapabilityCall(pluginId: string, msg: CapabilityCallMessage): void {
    const proc = this.processes.get(pluginId);
    if (!proc) return;
    this.capabilityHub
      .dispatch(pluginId, msg.method, msg.params)
      .then((result) => proc.sendCallResult(msg.id, result))
      .catch((err) => proc.sendCallResult(msg.id, undefined, err instanceof Error ? err.message : String(err)));
  }

  /**
   * Hand a fresh UI MessagePort pair to the plugin: one end goes to the
   * backend process, the other is transferred to the requesting renderer.
   * A fresh pair per call makes renderer reloads (dev HMR) self-healing.
   */
  ensureUiPort(pluginId: string, sender: Electron.WebContents): { ok: boolean; error?: string; reused?: boolean } {
    const proc = this.processes.get(pluginId);
    if (!proc) {
      return { ok: false, error: `plugin "${pluginId}" has no backend` };
    }
    // Idempotent per (plugin, renderer): each new port pair replaces the
    // backend's state.uiPort, so a second ensurePort while the renderer's
    // FIRST port is still queued would leave the renderer's outbox messages
    // stranded on a port pair the backend no longer listens to.
    const portKey = `${pluginId}:${sender.id}`;
    if (this.uiPortKeys.get(portKey)) {
      return { ok: true, reused: true };
    }
    this.uiPortKeys.set(portKey, true);
    const { port1, port2 } = new MessageChannelMain();
    try {
      proc.sendUiPort(port1);
      sender.postMessage('pi:plugin:port', { pluginId }, [port2]);
    } catch (err) {
      console.error(`[plugins] ensureUiPort(${pluginId}) transfer failed:`, err);
      return { ok: false, error: String(err) };
    }
    return { ok: true };
  }

  listInfos(): PluginInfo[] {
    return this.registry.listInfos();
  }

  /** Execute a plugin-contributed command in its backend. */
  async executeCommand(pluginId: string, name: string, args?: string): Promise<unknown> {
    const proc = this.processes.get(pluginId);
    if (!proc) {
      throw new Error(`plugin "${pluginId}" has no backend`);
    }
    return proc.executeCommand(name, args);
  }

  /** Build the pi-plugin:// URL for a panel. */
  panelUrl(pluginId: string, entry: string): string {
    return `pi-plugin://${pluginId}/${entry.replace(/^\/+/, '')}`;
  }

  private emitEvent(evt: PluginEvent): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('pi:plugin:event', evt);
      }
    }
  }

  dispose(): void {
    for (const proc of this.processes.values()) {
      proc.kill();
    }
    this.processes.clear();
  }
}

function sourcePriority(source: 'dev' | 'user' | 'builtin'): number {
  return source === 'dev' ? 3 : source === 'user' ? 2 : 1;
}
