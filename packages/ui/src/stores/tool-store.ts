import { create } from 'zustand';
import type { ToolCatalogEntry } from '@pi/types';
import { electronApi, invokeWhenReady } from '@/lib/electron-ipc';

/**
 * The agent's tool catalog and the global on/off switches (Settings → 工具).
 *
 * Main owns the switches (it filters the tool list before a session exists,
 * which is earlier than any renderer round-trip). This store is the renderer's
 * projection for the settings page and the composer's per-conversation picker:
 * `catalog` is everything the model could see, `disabled` is what the user
 * switched off globally.
 *
 * The model decides *when* to call a tool; these switches decide whether the
 * capability exists at all.
 */

interface ToolState {
  catalog: ToolCatalogEntry[];
  disabled: string[];
  loaded: boolean;
  sync: () => Promise<void>;
  setEnabled: (name: string, enabled: boolean) => void;
}

export const useToolStore = create<ToolState>((set, get) => ({
  catalog: [],
  disabled: [],
  loaded: false,

  sync: async () => {
    const api = electronApi();
    if (!api) return;
    // The catalog always contains at least the built-in tools, so an empty
    // answer means "plugin boot has not filled it yet" (the IPC handler is
    // registered before boot to avoid a no-handler race). Retry briefly.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        const [catalog, state] = await Promise.all([
          invokeWhenReady(api, 'pi:tools:list'),
          invokeWhenReady(api, 'pi:tools:get'),
        ]);
        const entries = Array.isArray(catalog) ? (catalog as ToolCatalogEntry[]) : [];
        if (entries.length === 0 && attempt < 5) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          continue;
        }
        const disabled = (state as { disabled?: unknown } | undefined)?.disabled;
        set({
          catalog: entries,
          disabled: Array.isArray(disabled)
            ? disabled.filter((n): n is string => typeof n === 'string')
            : [],
          loaded: true,
        });
        return;
      } catch (err) {
        if (attempt === 5) console.warn('[tools] could not read the tool catalog:', err);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  },

  setEnabled: (name, enabled) => {
    const previous = get().disabled;
    const next = enabled
      ? previous.filter((n) => n !== name)
      : [...new Set([...previous, name])];
    if (next.length === previous.length && next.every((n, i) => n === previous[i])) return;
    // Optimistic: the switch must feel instant. Main's reply is authoritative.
    set({ disabled: next });
    const api = electronApi();
    if (!api) return;
    api
      .invoke('pi:tools:set', { disabled: next })
      .then((result) => {
        const disabled = (result as { disabled?: unknown } | undefined)?.disabled;
        if (Array.isArray(disabled)) {
          set({ disabled: disabled.filter((n): n is string => typeof n === 'string') });
        }
      })
      .catch(() => set({ disabled: previous }));
  },
}));

/**
 * Plugin install/enable changes the catalog at runtime; main announces it so
 * an open picker does not keep offering tools that no longer exist.
 */
export function initToolBridge(): void {
  const api = electronApi();
  if (!api?.on) return;
  api.on('pi:tools:changed', () => {
    void useToolStore.getState().sync();
  });
}
