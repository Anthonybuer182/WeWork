import { app, screen } from 'electron';
import type { Rectangle } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

/**
 * Per-window state that must survive a restart.
 *
 * The shape mirrors the window-management pattern every large Electron app
 * uses (VS Code's `IWindowState` / `WindowsStateHandler`): geometry plus the
 * window's view state, one entry per window, saved when the window closes or
 * the app quits and replayed at launch. Geometry is validated against the
 * displays that exist NOW — a monitor unplugged since the last run must not
 * produce an off-screen window.
 */
export interface PersistedWindowState {
  /**
   * Stable identity for renderer-side per-window state (which panels are
   * open). Window ids are reassigned 1..N on every launch, so they cannot key
   * persisted layout; this id is generated once and travels with the window.
   */
  layoutId?: string;
  bounds: Rectangle;
  maximized: boolean;
  workspaceId: string | null;
  workspacePath: string | null;
  sessionId: string | null;
}

interface PersistedWindowsFile {
  version: 1;
  windows: PersistedWindowState[];
}

const MIN_VISIBLE = 80;

export class WindowStateStore {
  private readonly file: string;

  constructor(userDataDir?: string) {
    this.file = join(userDataDir ?? app.getPath('userData'), 'window-state.json');
  }

  load(): PersistedWindowState[] {
    if (!existsSync(this.file)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as PersistedWindowsFile;
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.windows)) return [];
      return parsed.windows.filter((w) => this.isUsable(w));
    } catch (err) {
      console.warn('[window-state] unreadable, starting fresh:', err);
      return [];
    }
  }

  save(windows: PersistedWindowState[]): void {
    const body: PersistedWindowsFile = { version: 1, windows };
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(body, null, 2), 'utf8');
      renameSync(tmp, this.file);
    } catch (err) {
      console.warn('[window-state] save failed:', err);
    }
  }

  /** True when the saved rectangle still lands on a current display. */
  private isUsable(state: PersistedWindowState): boolean {
    const b = state?.bounds;
    if (!b || ![b.x, b.y, b.width, b.height].every((n) => Number.isFinite(n))) return false;
    if (b.width < 400 || b.height < 300) return false;
    return screen.getAllDisplays().some((display) => {
      const a = display.workArea;
      const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      return overlapX >= MIN_VISIBLE && overlapY >= MIN_VISIBLE;
    });
  }
}
