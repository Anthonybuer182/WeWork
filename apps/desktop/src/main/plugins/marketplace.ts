import { net } from 'electron';
import AdmZip from 'adm-zip';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'fs';
import { join } from 'path';
import type { MarketEntry, MarketIndex, PluginManifest } from '@pi/types';
import type { PluginRegistry } from './registry';
import { satisfiesVersion } from './semver';
import { HOST_ENGINE_KEY } from './registry';

/** Placeholder official registry; override via _state.json#registry for dev. */
export const DEFAULT_REGISTRY_URL = 'https://plugins.pi-coding.dev/index.json';

/**
 * Static-index marketplace: fetch catalog, download + verify zips,
 * extract to .staging, validate, and atomically install into the user
 * plugins root.
 */
export class PluginMarketplace {
  private readonly registry: PluginRegistry;
  private indexCache: { at: number; index: MarketIndex } | null = null;
  private readonly cacheMs = 60_000;

  constructor(registry: PluginRegistry) {
    this.registry = registry;
  }

  /** Registry index URL: _state.json#registry or the default. */
  get registryUrl(): string {
    return this.registry.registryUrl ?? DEFAULT_REGISTRY_URL;
  }

  async catalog(force = false): Promise<MarketEntry[]> {
    if (!force && this.indexCache && Date.now() - this.indexCache.at < this.cacheMs) {
      return this.indexCache.index.plugins;
    }
    // Re-read state so registry URL changes apply without a restart.
    this.registry.loadState();
    const index = await this.fetchIndex(this.registryUrl);
    this.indexCache = { at: Date.now(), index };
    return index.plugins;
  }

  async getEntry(id: string): Promise<MarketEntry | undefined> {
    return (await this.catalog()).find((e) => e.id === id);
  }

  private async fetchIndex(url: string): Promise<MarketIndex> {
    const raw = await this.fetchBytes(url);
    const index = JSON.parse(raw.toString('utf-8')) as MarketIndex;
    if (!index || !Array.isArray(index.plugins)) {
      throw new Error('invalid registry index: missing plugins[]');
    }
    return index;
  }

  private async fetchBytes(url: string): Promise<Buffer> {
    if (/^https?:\/\//i.test(url)) {
      const res = await net.fetch(url);
      if (!res.ok) throw new Error(`fetch ${url} failed: HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    }
    // Local file path (dev/test registries)
    if (!existsSync(url)) throw new Error(`registry file not found: ${url}`);
    return readFileSync(url);
  }

  /**
   * Download + verify + validate an entry, returning the extracted staging
   * dir ready to be atomically renamed into the plugins root. The caller
   * (PluginSystem) handles process lifecycle and re-registration.
   */
  async stageInstall(
    entry: MarketEntry,
    onPhase?: (phase: 'downloading' | 'verifying' | 'installing') => void,
  ): Promise<{ stagedDir: string; manifest: PluginManifest }> {
    onPhase?.('downloading');
    const zipBytes = await this.fetchBytes(entry.url);

    onPhase?.('verifying');
    if (entry.sha256) {
      const actual = createHash('sha256').update(zipBytes).digest('hex');
      if (actual !== entry.sha256.toLowerCase()) {
        throw new Error(`integrity check failed for ${entry.id} (sha256 mismatch)`);
      }
    }

    onPhase?.('installing');
    const zip = new AdmZip(zipBytes);
    // Extract into a fresh staging dir.
    const stagingRoot = join(this.registry.pluginsRoot, '.staging');
    rmSync(join(stagingRoot, `${entry.id}-${entry.version}`), { recursive: true, force: true });
    const extractDir = join(stagingRoot, `${entry.id}-${entry.version}`);
    mkdirSync(extractDir, { recursive: true });
    zip.extractAllTo(extractDir, true);

    // Locate the manifest: zip root, or a single wrapping directory.
    const root = this.findPluginRoot(extractDir);
    if (!root) {
      throw new Error(`zip for ${entry.id} contains no manifest.json`);
    }

    const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf-8')) as PluginManifest;
    if (manifest.id !== entry.id) {
      throw new Error(`manifest id "${manifest.id}" does not match catalog id "${entry.id}"`);
    }
    if (manifest.version !== entry.version) {
      throw new Error(`manifest version "${manifest.version}" does not match catalog version "${entry.version}"`);
    }
    if (manifest.backend && !existsSync(join(root, manifest.backend))) {
      throw new Error(`backend entry "${manifest.backend}" missing in package`);
    }

    // engines negotiation — refuse before touching the plugins root.
    const appVersion = this.registry.appVersion;
    const range = manifest.engines?.[HOST_ENGINE_KEY];
    if (range && !satisfiesVersion(appVersion, range)) {
      throw new Error(
        `"${manifest.id}" ${manifest.version} requires ${HOST_ENGINE_KEY} ${range}, host is ${appVersion}`,
      );
    }

    return { stagedDir: root, manifest };
  }

  private findPluginRoot(extractDir: string): string | null {
    if (existsSync(join(extractDir, 'manifest.json'))) return extractDir;
    // Handle zips that wrap everything in a single folder.
    if (!existsSync(extractDir)) return null;
    const entries = readdirSync(extractDir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory());
    if (dirs.length === 1 && existsSync(join(extractDir, dirs[0].name, 'manifest.json'))) {
      return join(extractDir, dirs[0].name);
    }
    return null;
  }

  /** Atomically move a staged dir into the user plugins root. */
  commitInstall(stagedDir: string, pluginId: string): string {
    const target = join(this.registry.pluginsRoot, pluginId);
    mkdirSync(this.registry.pluginsRoot, { recursive: true });

    // Replace-in-place: move old aside, move new in, drop old.
    const stagingRoot = join(this.registry.pluginsRoot, '.staging');
    const backup = join(stagingRoot, `${pluginId}-replaced-${Date.now()}`);
    if (existsSync(target)) {
      renameSync(target, backup);
    }
    renameSync(stagedDir, target);
    if (existsSync(backup)) {
      rmSync(backup, { recursive: true, force: true });
    }
    return target;
  }
}
