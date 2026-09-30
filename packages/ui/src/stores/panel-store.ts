import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { PluginInfo, PluginPanelStatus, PanelRegion, PanelAnchor } from '@pi/types';

export type PanelKeepAlive = 'always' | 'lru' | 'never';
// Region/anchor belong to the manifest contract (plugins declare them), so the
// definitions live in @pi/types. Re-exported here because most call sites
// import these from the store alongside PanelEntry.
export type { PanelRegion, PanelAnchor };

/**
 * Unified panel entry — host panels and plugin panels share this shape.
 *
 * There is no `kind`. A panel is a panel; what differs is who provides it, and
 * that is exactly what `source` says:
 *   source === 'host'  → a React component in the shell (HOST_COMPONENTS)
 *   source === <pluginId> → a web page, hosted natively by the host
 */
export interface PanelEntry {
  /** 'host:settings' | 'host:plugins' | 'plugin:<pluginId>:<panelId>' */
  id: string;
  title: string;
  /** Icon key resolved by the rail (see panel-icons.tsx). */
  icon: string;
  /** Plugin-provided icon (pi-plugin:// URL) — takes precedence over `icon`. */
  iconUrl?: string;
  source: 'host' | string; // 'host' or pluginId
  pluginId?: string;
  panelId?: string;
  /** The panel's page, relative to the plugin root. Absent on host panels. */
  entry?: string;
  /** Not shown on the rail; still openable via panel.open / events. */
  hidden?: boolean;
  keepAlive: PanelKeepAlive;
  /** Which sidebar column this panel renders in. */
  region: PanelRegion;
  /** Position within its region's rail. Defaults to 'top'. */
  anchor?: PanelAnchor;
  /** Sort order among panels sharing a region and anchor. */
  order?: number;
}

export interface PanelRuntimeState {
  badge?: number | string;
  activity?: 'idle' | 'streaming' | 'working' | 'error';
  /** Panel open requested without focus (no-focus-steal) — rail shows a dot. */
  pending?: boolean;
}

/**
 * Panels kept mounted (hidden) when inactive — 'lru' keeps this many.
 *
 * The budget is global across regions, so a panel that must never be evicted
 * (every left-sidebar view) has to declare `keepAlive: 'always'`, not 'lru'.
 */
const LRU_KEEP = 2;

/** Preferred right-region panel when there is no prior selection. */
const DEFAULT_ACTIVE_PANEL = 'host:plugins';

const EMPTY_ACTIVE: Record<PanelRegion, string | null> = { left: null, right: null };

interface PanelStoreState {
  panels: PanelEntry[];
  /** Active panel per region — each column has its own selection. */
  activePanelIds: Record<PanelRegion, string | null>;
  /** Panels currently mounted (visible or hidden-kept-alive). Flat; filter by region at render. */
  mountedIds: string[];
  /** Last-activation order for LRU bookkeeping (most recent first). */
  recency: string[];
  runtime: Record<string, PanelRuntimeState>;
  /** Open params per panel id (e.g. { file } for preview panels). */
  params: Record<string, Record<string, unknown> | undefined>;
  /**
   * Bumped every time a panel is explicitly activated. Panels stay mounted when
   * hidden, so "focus my input on mount" fires only once — a panel that wants
   * focus on activation must depend on this instead.
   */
  activationNonces: Record<string, number>;

  setHostPanels: (panels: PanelEntry[]) => void;
  setPluginPanels: (infos: PluginInfo[]) => void;
  /** Open a panel. focus=false → badge/pending only, never steals the active panel. */
  openPanel: (id: string, opts?: { focus?: boolean; params?: Record<string, unknown> }) => void;
  /** Close the active panel of one region. */
  closePanel: (region: PanelRegion) => void;
  setPanelStatus: (status: PluginPanelStatus) => void;
  clearPending: (id: string) => void;
}

function pluginPanelId(pluginId: string, panelId: string): string {
  return `plugin:${pluginId}:${panelId}`;
}

function keepAliveFor(source: string, declared?: PanelKeepAlive): PanelKeepAlive {
  // Host panels manage their own mounts — never keep them alive behind the
  // user's back. Plugin panels default to 'lru' so switching away and back
  // does not reload the page from scratch.
  if (source === 'host') return 'never';
  return declared ?? 'lru';
}

/** Panels of one region, in rail order: top group first, then bottom. */
function regionPanels(panels: PanelEntry[], region: PanelRegion): PanelEntry[] {
  return panels
    .filter((p) => p.region === region)
    .sort((a, b) => {
      const aBottom = a.anchor === 'bottom' ? 1 : 0;
      const bBottom = b.anchor === 'bottom' ? 1 : 0;
      if (aBottom !== bBottom) return aBottom - bBottom;
      return (a.order ?? 0) - (b.order ?? 0);
    });
}

/** The panel a region falls back to when nothing is selected. */
function defaultActiveFor(panels: PanelEntry[], region: PanelRegion): string | null {
  const inRegion = regionPanels(panels, region);
  if (region === 'right') {
    return inRegion.find((p) => p.id === DEFAULT_ACTIVE_PANEL)?.id ?? inRegion[0]?.id ?? null;
  }
  return inRegion[0]?.id ?? null;
}

function activeIdSet(activePanelIds: Record<PanelRegion, string | null>): Set<string> {
  return new Set(Object.values(activePanelIds).filter((id): id is string => !!id));
}

/**
 * Recompute which panels stay mounted after an activation/deactivation.
 *
 * Takes EVERY region's active id: with a flat `mountedIds`, recomputing with
 * only one region's selection would drop the other region's active panel and
 * silently unmount it (losing file-tree expansion, list scroll, etc).
 */
function computeMounted(
  panels: PanelEntry[],
  activeIds: Set<string>,
  recency: string[],
): string[] {
  const byId = new Map(panels.map((p) => [p.id, p]));
  const mounted = new Set<string>();
  for (const id of activeIds) {
    if (byId.has(id)) mounted.add(id);
  }

  // 'always' means always: mount them whether or not they are active and
  // whether or not they were ever activated. Going through `recency` alone was
  // wrong — a panel first activated by `reconcile` (not `openPanel`) never
  // enters recency, so switching away from it unmounted it and lost its state
  // (expanded folders, list scroll). recency is also capped, so even an
  // activated 'always' panel could eventually fall out of it.
  for (const panel of panels) {
    if (panel.keepAlive === 'always') mounted.add(panel.id);
  }

  let lruBudget = LRU_KEEP;
  for (const id of recency) {
    // Actives and 'always' panels are already mounted; neither may consume the
    // LRU budget, which exists only to bound hidden 'lru' panels.
    if (activeIds.has(id) || !byId.has(id)) continue;
    const panel = byId.get(id)!;
    if (panel.keepAlive === 'lru' && lruBudget > 0) {
      mounted.add(id);
      lruBudget--;
    }
    // 'never' → never mounted while hidden
  }
  return [...mounted];
}

/**
 * Recompute derived panel state after the panel LIST changes (host panels
 * registered, plugin panels refreshed). Every mutator that replaces `panels`
 * must go through this — otherwise `mountedIds`/`activePanelIds` keep pointing
 * at panels that no longer exist, or at panels that changed region.
 *
 * Per region: keep the current selection if it still exists AND still belongs
 * to that region, else the most recently used survivor, else the default.
 */
function reconcile(
  panels: PanelEntry[],
  prev: { activePanelIds: Record<PanelRegion, string | null>; recency: string[] },
): {
  panels: PanelEntry[];
  recency: string[];
  activePanelIds: Record<PanelRegion, string | null>;
  mountedIds: string[];
} {
  const recency = prev.recency.filter((id) => panels.some((p) => p.id === id));

  const pick = (region: PanelRegion): string | null => {
    const inRegion = regionPanels(panels, region);
    const current = prev.activePanelIds[region];
    if (current && inRegion.some((p) => p.id === current)) return current;
    const recent = recency.find((id) => inRegion.some((p) => p.id === id));
    if (recent) return recent;
    return defaultActiveFor(panels, region);
  };

  const activePanelIds: Record<PanelRegion, string | null> = {
    left: pick('left'),
    right: pick('right'),
  };

  return {
    panels,
    recency,
    activePanelIds,
    mountedIds: computeMounted(panels, activeIdSet(activePanelIds), recency),
  };
}

export const usePanelStore = create<PanelStoreState>()(
  persist(
    (set, get) => ({
      panels: [],
      activePanelIds: EMPTY_ACTIVE,
      mountedIds: [],
      recency: [],
      runtime: {},
      params: {},
      activationNonces: {},

      setHostPanels: (hostPanels) =>
        set((s) =>
          reconcile([...hostPanels, ...s.panels.filter((p) => p.source !== 'host')], s),
        ),

      setPluginPanels: (infos) =>
        set((s) => {
          const pluginPanels: PanelEntry[] = infos.flatMap((plugin) =>
            plugin.panels
              // A panel is a web page. Manifest validation guarantees an entry,
              // but a malformed descriptor must not take the whole rail down.
              .filter((panel) => Boolean(panel.entry))
              .map((panel) => ({
                id: pluginPanelId(plugin.id, panel.id),
                title: panel.title,
                icon: panel.icon ?? 'puzzle',
                iconUrl: panel.iconUrl,
                source: plugin.id,
                pluginId: plugin.id,
                panelId: panel.id,
                entry: panel.entry,
                hidden: panel.hidden === true,
                keepAlive: keepAliveFor(plugin.id, panel.keepAlive),
                region: panel.region ?? 'right',
                anchor: panel.anchor,
                order: panel.order,
              })),
          );
          const hostPanels = s.panels.filter((p) => p.source === 'host');
          return reconcile([...hostPanels, ...pluginPanels], s);
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
          // Resolve the region from the entry. Unknown ids default to 'right':
          // every id arriving from outside (find-preview routing, panel-open
          // events) is plugin-owned, and plugin panels always live on the right.
          const region = s.panels.find((p) => p.id === id)?.region ?? 'right';
          const recency = [id, ...s.recency.filter((r) => r !== id)].slice(0, 12);
          const activePanelIds = { ...s.activePanelIds, [region]: id };
          delete runtime[id];
          return {
            activePanelIds,
            recency,
            runtime,
            params,
            // Bump on every explicit activation — including re-activating the
            // panel that is already active, so its input can re-take focus.
            activationNonces: { ...s.activationNonces, [id]: (s.activationNonces[id] ?? 0) + 1 },
            mountedIds: computeMounted(s.panels, activeIdSet(activePanelIds), recency),
          };
        }),

      // Right: clear the selection — the callers (panel chrome, the title bar
      // toggle) collapse the right side, leaving only the rail.
      // Left: a single-select view container has no meaningful empty state and
      // no collapse gesture, so fall back to the region's default view.
      closePanel: (region) =>
        set((s) => {
          const nextActive = region === 'left' ? defaultActiveFor(s.panels, 'left') : null;
          const activePanelIds = { ...s.activePanelIds, [region]: nextActive };
          return {
            activePanelIds,
            mountedIds: computeMounted(s.panels, activeIdSet(activePanelIds), s.recency),
          };
        }),

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
      version: 2,
      partialize: (state) => ({ activePanelIds: state.activePanelIds }),
      migrate: (persisted) => {
        const p = (persisted ?? {}) as {
          activePanelId?: string | null;
          activePanelIds?: Record<PanelRegion, string | null>;
        };
        if (p.activePanelIds) return p as never;

        // v0/v1 stored a single string id from the old ui-store tab model.
        // Migrate the legacy values, then place the survivor in a region.
        const legacy = p.activePanelId ?? null;
        const dead = legacy === null
          || legacy === 'preview' || legacy === 'browser'
          || legacy === 'host:preview' || legacy === 'host:browser';
        const id = dead ? null : legacy === 'settings' ? 'host:settings' : legacy;

        // Region is unknowable here — `panels` is still empty during migration.
        // Seed it on the right; reconcile re-homes or drops it once panels are
        // registered (that is why `setHostPanels` reconciles).
        return { activePanelIds: { left: null, right: id } } as never;
      },
    },
  ),
);

export { pluginPanelId };

/**
 * Activation counter for one panel — changes whenever that panel is explicitly
 * activated. Use as an effect dependency to focus an input on activation.
 */
export function usePanelActivation(panelId: string): number {
  return usePanelStore((s) => s.activationNonces[panelId] ?? 0);
}
