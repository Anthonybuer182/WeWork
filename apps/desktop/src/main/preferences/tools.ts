/**
 * Which tools the agent may use, globally.
 *
 * The model decides when to call a tool; the user decides whether it exists.
 * A disabled tool is removed from the model's tool list (and from the standing
 * prompt), not merely discouraged — there is no "please don't" version of a
 * capability.
 *
 * This is the GLOBAL default. A conversation may restrict it further from the
 * composer; it can never re-enable something switched off here, which keeps
 * the two surfaces from fighting and matches how skills already behave.
 *
 * Persisted in userData, main-authoritative: the value must be known before
 * the first session is created, which is earlier than any renderer round-trip.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { ipcMain } from 'electron';
import type { ToolCatalogEntry } from '@pi/types';

const STORAGE_VERSION = 1;

interface StoredFile {
  version: number;
  disabled: string[];
}

/** Pre-catalog settings file: two booleans instead of a name list. */
interface LegacyInteractionFile {
  version?: number;
  settings?: { asktool?: unknown; todotool?: unknown };
}

export class ToolSettingsService {
  private disabled: string[];
  /** Serializes writes; a shared `.tmp` would otherwise race with itself. */
  private writeChain: Promise<void> = Promise.resolve();
  private writeSeq = 0;
  /** Distinguishes temp names across service instances (dev reload, tests). */
  private readonly instanceId = Math.random().toString(36).slice(2, 10);

  constructor(
    private filePath: string,
    /** Previous `interaction-settings.json`, migrated once on first load. */
    private legacyFilePath: string | undefined,
  ) {
    this.disabled = this.load();
  }

  /*
   * Deliberately no "sessions changed" callback. The chat adapter compares the
   * list it is handed on every send and rebuilds an idle session when it
   * differs; clearing the session CACHE here would be wrong while a run is
   * streaming — a following steer/followUp would construct a second
   * AgentSession over the same transcript, with two writers.
   */

  getDisabled(): string[] {
    return [...this.disabled];
  }

  /** Replace the global disabled list. Unknown shapes are treated as empty. */
  setDisabled(raw: unknown): string[] {
    const next = normalizeNames(raw);
    if (sameSet(next, this.disabled)) return this.getDisabled();
    this.disabled = next;
    void this.persist();
    return this.getDisabled();
  }

  private load(): string[] {
    if (existsSync(this.filePath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as StoredFile;
        if (parsed?.version === STORAGE_VERSION) return normalizeNames(parsed.disabled);
      } catch (err) {
        console.warn(`[tools] could not read ${this.filePath}:`, err);
      }
    }
    return this.migrateLegacy();
  }

  private migrateLegacy(): string[] {
    if (!this.legacyFilePath || !existsSync(this.legacyFilePath)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.legacyFilePath, 'utf8')) as LegacyInteractionFile;
      const disabled: string[] = [];
      if (parsed?.settings?.asktool === false) disabled.push('asktool');
      if (parsed?.settings?.todotool === false) disabled.push('todotool');
      if (disabled.length > 0) {
        this.disabled = disabled;
        void this.persist();
      }
      return disabled;
    } catch (err) {
      console.warn(`[tools] could not migrate ${this.legacyFilePath}:`, err);
      return [];
    }
  }

  /** Last-chance synchronous flush for the app's `will-quit`. */
  flushSync(): void {
    try {
      const tmp = this.tempPath();
      writeFileSync(tmp, JSON.stringify(this.buildBody()), 'utf8');
      renameSync(tmp, this.filePath);
    } catch (err) {
      console.warn('[tools] could not flush tool settings:', err);
    }
  }

  private persist(): Promise<void> {
    const run = this.writeChain.then(() => this.writeNow());
    this.writeChain = run.catch(() => undefined);
    return run;
  }

  private async writeNow(): Promise<void> {
    const tmp = this.tempPath();
    try {
      await writeFile(tmp, JSON.stringify(this.buildBody()), 'utf8');
      await rename(tmp, this.filePath);
    } catch (err) {
      console.warn('[tools] could not persist tool settings:', err);
    }
  }

  private tempPath(): string {
    this.writeSeq += 1;
    return `${this.filePath}.${process.pid}.${this.instanceId}.${this.writeSeq}.tmp`;
  }

  private buildBody(): StoredFile {
    return { version: STORAGE_VERSION, disabled: this.disabled };
  }
}

function normalizeNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const name = item.trim();
    if (name) seen.add(name);
  }
  return [...seen];
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((name) => set.has(name));
}

/** The tools the model can currently see, for settings and the composer. */
export type ToolCatalogProvider = () => ToolCatalogEntry[];

/** IPC surface consumed by the renderer's tool store. */
export function registerToolSettingsIpc(
  service: ToolSettingsService,
  listCatalog: ToolCatalogProvider,
): void {
  ipcMain.handle('pi:tools:list', () => listCatalog());
  ipcMain.handle('pi:tools:get', () => ({ disabled: service.getDisabled() }));
  ipcMain.handle('pi:tools:set', (_event, patch: unknown) => {
    const disabled = (patch as { disabled?: unknown } | undefined)?.disabled;
    return { disabled: service.setDisabled(disabled) };
  });
}
