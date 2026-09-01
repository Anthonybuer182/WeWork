import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { PluginInfo, PluginPanelStatus } from '@pi/types';

export type PanelKind = 'host' | 'iframe' | 'declarative' | 'liveview';
export type PanelKeepAlive = 'always' | 'lru' | 'never';

/** Unified panel entry — host panels and plugin panels share this shape. */
export interface PanelEntry {
  /** 'host:preview' | 'host:browser' | 'host:settings' | 'plugin:<pluginId>:<panelId>' */
  id: string;
  title: string;
  /** Icon key resolved by the rail (see panel-icons.tsx). */
  icon: string;
  /** Plugin-provided icon (pi-plugin:// URL) — takes precedence over `icon`. */
  iconUrl?: string;
  kind: PanelKind;
  source: 'host' | string; // 'host' or pluginId
  pluginId?: string;
  panelId?: string;
  /** iframe panels: entry path relative to the plugin root. */
  entry?: string;
  /** Not shown on the rail; still openable via panel.open / events. */
  hidden?: boolean;
  /** Attached above this panel (same plugin) as a companion card. */
  companionOf?: string;
  keepAlive: PanelKeepAlive;
  /** iframe panels: host sizes the frame to the reported content height. */
  autoHeight?: boolean;
}

export interface PanelRuntimeState {
  badge?: number | string;
  activity?: 'idle' | 'streaming' | 'working' | 'error';
  /** Panel open requested without focus (no-focus-steal) — rail shows a dot. */
  pending?: boolean;
}

/** Panels kept mounted (hidden) when inactive — 'lru' keeps this many. */
const LRU_KEEP = 2;

interface PanelStoreState {
  panels: PanelEntry[];
  activePanelId: string | null;
  /** Panels currently mounted (visible or hidden-kept-alive). */
  mountedIds: string[];
  /** Last-activation order for LRU bookkeeping (most recent first). */
  recency: string[];
  runtime: Record<string, PanelRuntimeState>;
  /** Open params per panel id (e.g. { file } for preview panels). */
  params: Record<string, Record<string, unknown> | undefined>;

  setHostPanels: (panels: PanelEntry[]) => void;
  setPluginPanels: (infos: PluginInfo[]) => void;
  /** Open a panel. focus=false → badge/pending only, never steals the active panel. */
  openPanel: (id: string, opts?: { focus?: boolean; params?: Record<string, unknown> }) => void;
  closePanel: () => void;
  setPanelStatus: (status: PluginPanelStatus) => void;
  clearPending: (id: string) => void;
}

function pluginPanelId(pluginId: string, panelId: string): string {
  return `plugin:${pluginId}:${panelId}`;
}

function keepAliveFor(kind: PanelKind, declared?: PanelKeepAlive): PanelKeepAlive {
  if (kind === 'declarative' || kind === 'host') {
    // declarative: state lives in the backend — remount is free
    // host: components manage their own mounts; default never
    return declared && kind !== 'declarative' ? declared : 'never';
  }
  return declared ?? 'lru';
}

/** Recompute which panels stay mounted after an activation/deactivation. */
function computeMounted(
  panels: PanelEntry[],
  activeId: string | null,
  recency: string[],
): string[] {
  const byId = new Map(panels.map((p) => [p.id, p]));
  const mounted = new Set<string>();
  if (activeId && byId.has(activeId)) mounted.add(activeId);

  let lruBudget = LRU_KEEP;
  for (const id of recency) {
    if (lruBudget <= 0) break;
    if (id === activeId || !byId.has(id)) continue;
    const panel = byId.get(id)!;
    if (panel.keepAlive === 'always') {
      mounted.add(id);
    } else if (panel.keepAlive === 'lru') {
      mounted.add(id);
      lruBudget--;
    }
    // 'never' → never mounted while hidden
  }
  return [...mounted];
}

export const usePanelStore = create<PanelStoreState>()(
  persist(
    (set, get) => ({
      panels: [],
      activePanelId: null,
      mountedIds: [],
      recency: [],
      runtime: {},
      params: {},

      setHostPanels: (hostPanels) =>
        set((s) => ({ panels: [...hostPanels, ...s.panels.filter((p) => p.source !== 'host')] })),

      setPluginPanels: (infos) =>
        set((s) => {
          const pluginPanels: PanelEntry[] = infos.flatMap((plugin) =>
            plugin.panels
              .filter((panel) => panel.kind === 'iframe' || panel.kind === 'declarative' || panel.kind === 'liveview')
              .map((panel) => ({
                id: pluginPanelId(plugin.id, panel.id),
                title: panel.title,
                icon: panel.icon ?? 'puzzle',
                iconUrl: panel.iconUrl,
                kind: panel.kind,
                source: plugin.id,
                pluginId: plugin.id,
                panelId: panel.id,
                entry: panel.entry,
                hidden: panel.hidden === true,
                companionOf: panel.companionOf,
                keepAlive: keepAliveFor(panel.kind, panel.keepAlive),
                autoHeight: panel.autoHeight === true,
              })),
          );
          const hostPanels = s.panels.filter((p) => p.source === 'host');
          const panels = [...hostPanels, ...pluginPanels];
          const recency = s.recency.filter((id) => panels.some((p) => p.id === id));
          // Resolve the active panel: keep a still-valid one; otherwise fall
          // back to the most recent survivor, then the plugin center — the
          // rail never lands on an empty panel body after startup.
          const activePanelId =
            s.activePanelId && panels.some((p) => p.id === s.activePanelId)
              ? s.activePanelId
              : (recency.find((id) => panels.some((p) => p.id === id)) ?? 'host:plugins');
          return {
            panels,
            recency,
            activePanelId,
            mountedIds: computeMounted(panels, activePanelId, recency),
          };
        }),

      openPanel: (id, opts) =>
        set((s) => {
          const focus = opts?.focus !== false;
          const runtime = { ...s.runtime };
          const params = opts?.params ? { ...s.params, [id]: opts.params } : s.params;
          if (!focus) {
            runtime[id] = { ...runtime[id], pending: true };
            return { runtime, params };
          }
          const recency = [id, ...s.recency.filter((r) => r !== id)].slice(0, 12);
          delete runtime[id];
          return {
            activePanelId: id,
            recency,
            runtime,
            params,
            mountedIds: computeMounted(s.panels, id, recency),
          };
        }),

      // The X means "close the panel": clear the active panel — the caller
      // (panel chrome) also collapses the right side, leaving only the rail.
      closePanel: () => set({ activePanelId: null, mountedIds: computeMounted(get().panels, null, get().recency) }),

      setPanelStatus: (status) =>
        set((s) => {
          const id = status.panelId
            ? pluginPanelId(status.pluginId, status.panelId)
            : s.panels.find((p) => p.source === status.pluginId)?.id;
          if (!id) return s;
          return {
            runtime: {
              ...s.runtime,
              [id]: {
                ...s.runtime[id],
                badge: status.badge,
                activity: status.activity,
                detail: status.detail,
              },
            },
          };
        }),

      clearPending: (id) =>
        set((s) => {
          const rt = { ...s.runtime[id] };
          delete rt.pending;
          return { runtime: { ...s.runtime, [id]: rt } };
        }),
    }),
    {
      name: 'pi-panel-storage',
      partialize: (state) => ({
        activePanelId: state.activePanelId,
        // migrate legacy ui-store tab values ('preview'|'browser'|'settings')
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<PanelStoreState>;
        const activePanelId =
          p.activePanelId ??
          (current.activePanelId as string | null);
        // Legacy value mapping from the old ui-store tab state
        const legacy = activePanelId as string | null;
        const mapped =
          legacy === 'preview' ? 'host:preview'
          : legacy === 'browser' ? 'host:browser'
          : legacy === 'settings' ? 'host:settings'
          : legacy;
        return { ...current, activePanelId: mapped };
      },
    },
  ),
);

export { pluginPanelId };
