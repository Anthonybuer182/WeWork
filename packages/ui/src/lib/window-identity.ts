import type { StateStorage } from 'zustand/middleware';

/**
 * Window identity and storage scoping, with no import of any store.
 *
 * Kept dependency-free on purpose: the stores import this file, and a module
 * that imported the stores back would form a cycle at module-init time (the
 * persist keys have to be decided while the store is being created).
 *
 * Electron shares localStorage across every BrowserWindow in the same
 * partition (the origin is the same), so window-scoped UI state must be
 * namespaced by window id — Electron issue #1184. The web build has no
 * windowId and keeps the historical, unscoped keys.
 */

interface DesktopBridge {
  windowId?: number | null;
  invoke?: (channel: string, ...args: unknown[]) => Promise<unknown>;
}

export function getDesktopBridge(): DesktopBridge | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { electronAPI?: DesktopBridge }).electronAPI ?? null;
}

/** This window's registry id, or null in the web build. */
export function getDesktopWindowId(): number | null {
  const id = getDesktopBridge()?.windowId;
  return typeof id === 'number' ? id : null;
}

/** True when the app is running in the multi-window desktop shell. */
export function hasDesktopWindowApi(): boolean {
  return getDesktopWindowId() != null && typeof getDesktopBridge()?.invoke === 'function';
}

/**
 * Stable per-window identity for renderer-side persisted state.
 *
 * `windowId` is reassigned 1..N on every launch, so it cannot key anything
 * that must survive a restart; this id is created with the window, saved in
 * the window-state file and passed back on restore. A NEW window never
 * shares it, which is what keeps "which panels are open" from leaking into
 * windows the user just opened.
 */
export function getDesktopLayoutId(): string | null {
  if (getDesktopWindowId() == null) return null;
  try {
    return new URLSearchParams(window.location.search).get('piLayout');
  } catch {
    return null;
  }
}

/**
 * A zustand persist storage scoped to this window.
 *
 * `baseKey` stays the key on the web and on the very first desktop run after
 * the upgrade; on desktop the live key becomes `baseKey:w<id>`. Reads fall
 * back to the legacy key so the existing layout survives the migration; the
 * next write lands on the scoped key.
 */
export function windowScopedStorage(baseKey: string): StateStorage {
  const scopedKey = (): string => {
    const id = getDesktopWindowId();
    return id == null ? baseKey : `${baseKey}:w${id}`;
  };

  return {
    getItem: (_name: string): string | null => {
      try {
        const key = scopedKey();
        const value = localStorage.getItem(key);
        if (value != null) return value;
        return key === baseKey ? null : localStorage.getItem(baseKey);
      } catch {
        return null;
      }
    },
    setItem: (_name: string, value: string): void => {
      try {
        localStorage.setItem(scopedKey(), value);
      } catch {
        /* quota / private mode — persistence is best-effort */
      }
    },
    removeItem: (_name: string): void => {
      try {
        localStorage.removeItem(scopedKey());
      } catch {
        /* ignore */
      }
    },
  };
}
