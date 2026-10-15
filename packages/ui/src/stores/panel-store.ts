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

/**
 * Hidden OPEN tabs mounted per region, on top of the active one. A tab is a
 * promise that switching back restores state, so open tabs mount
 * unconditionally up to this cap; the coldest tabs past it hibernate — they
 * keep their strip slot and reload on the next activation. Each mounted
 * plugin panel is a renderer process (plus possibly a browser engine view),
 * which is why the cap exists at all.
 */
const TAB_MOUNT_CAP = 6;

/** Preferred right-region panel when there is no prior selection. */
const DEFAULT_ACTIVE_PANEL = 'host:plugins';

const EMPTY_ACTIVE: Record<PanelRegion, string | null> = { left: null, right: null };
const EMPTY_TABS: Record<PanelRegion, string[]> = { left: [], right: [] };

interface PanelStoreState {
  panels: PanelEntry[];
  /** Focused panel per region — always a member of that region's tab list. */
  activePanelIds: Record<PanelRegion, string | null>;
  /**
   * Open tabs per region, in strip order. The tab strip renders this list;
   * closing a panel removes it (and unmounts it once it leaves the LRU).
   */
  openPanelIds: Record<PanelRegion, string[]>;
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
  /**
   * Whether the plugin registry has contributed its panels at least once.
   * Runtime-only (not persisted): reset false at boot, set by the first
   * `setPluginPanels`. Gates reconcile's pruning of unknown tab ids — see
   * its doc comment.
   */
  pluginPanelsSynced: boolean;

  setHostPanels: (panels: PanelEntry[]) => void;
  setPluginPanels: (infos: PluginInfo[]) => void;
  /** Open a panel. focus=false → badge/pending only, never steals the active panel. */
  openPanel: (id: string, opts?: { focus?: boolean; params?: Record<string, unknown> }) => void;
  /** Close one tab (the × on a tab / middle-click). */
  closeTab: (region: PanelRegion, id: string) => void;
  /** Move a tab within its strip (drag reorder). */
  reorderTabs: (region: PanelRegion, from: number, to: number) => void;
  setPanelStatus: (status: PluginPanelStatus) => void;
  clearPending: (id: string) => void;
}

function pluginPanelId(pluginId: string, panelId: string): string {
  return `plugin:${pluginId}:${panelId}`;
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
 * Takes EVERY region's active id and tab list: with a flat `mountedIds`,
 * recomputing with only one region's selection would drop the other region's
 * panels and silently unmount them (losing file-tree expansion, list scroll,
 * etc).
 */
function computeMounted(
  panels: PanelEntry[],
  activeIds: Set<string>,
  openPanelIds: Record<PanelRegion, string[]>,
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

  // Open tabs mount within the per-region cap; the coldest go first
  // (hibernation — the tab keeps its strip slot and reloads when used).
  // 'never' keeps its contract even as a tab: it unmounts while hidden.
  const rank = new Map(recency.map((id, i) => [id, i]));
  const rankOf = (id: string) => rank.get(id) ?? Number.MAX_SAFE_INTEGER;
  for (const region of ['left', 'right'] as PanelRegion[]) {
    const hiddenTabs = openPanelIds[region]
      .filter(
        (id) =>
          byId.has(id) &&
          !mounted.has(id) &&
          byId.get(id)!.keepAlive !== 'never',
      )
      .sort((a, b) => rankOf(a) - rankOf(b));
    let budget = TAB_MOUNT_CAP;
    for (const id of hiddenTabs) {
      if (budget <= 0) break;
      mounted.add(id);
      budget--;
    }
  }

  // Closed panels stay warm through the small LRU budget: closing a tab by
  // mistake and reopening it restores without a reload.
  const openIds = new Set([...openPanelIds.left, ...openPanelIds.right]);
  let lruBudget = LRU_KEEP;
  for (const id of recency) {
    // Actives, 'always' panels and open tabs are already mounted; neither may
    // consume the LRU budget, which exists only for recently-closed 'lru'
    // panels. 'never' → never mounted while hidden.
    if (mounted.has(id) || openIds.has(id) || !byId.has(id)) continue;
    const panel = byId.get(id)!;
    if (panel.keepAlive === 'lru' && lruBudget > 0) {
      mounted.add(id);
      lruBudget--;
    }
  }
  return [...mounted];
}

/**
 * Recompute derived panel state after the panel LIST changes (host panels
 * registered, plugin panels refreshed). Every mutator that replaces `panels`
 * must go through this — otherwise `mountedIds`/`activePanelIds` keep pointing
 * at panels that no longer exist, or at panels that changed region.
 *
 * Per region: keep the focused tab if it survived, else focus the last
 * remaining tab. A region left with no tabs behaves differently: left re-seeds
 * its default view (a single-select container has no meaningful empty state
 * and no close gesture), right stays empty — the column-open effect opens the
 * fallback as a real tab, so "nothing is open" stays honest.
 *
 * Unknown ids (panel not in the list yet) survive until the plugin registry
 * has synced once: at boot, host panels register before plugin panels, and
 * every `set` writes straight through to storage — pruning on the first
 * reconcile would clobber the persisted tab list before the plugin list
 * exists. After the first sync, an unknown id really is an uninstalled panel.
 */
function reconcile(
  panels: PanelEntry[],
  prev: {
    activePanelIds: Record<PanelRegion, string | null>;
    openPanelIds: Record<PanelRegion, string[]>;
    recency: string[];
    pluginPanelsSynced: boolean;
  },
): {
  panels: PanelEntry[];
  recency: string[];
  activePanelIds: Record<PanelRegion, string | null>;
  openPanelIds: Record<PanelRegion, string[]>;
  mountedIds: string[];
} {
  const recency = prev.recency.filter((id) => panels.some((p) => p.id === id));

  const pick = (region: PanelRegion): { active: string | null; tabs: string[] } => {
    const inRegion = regionPanels(panels, region);
    const tabs = prev.openPanelIds[region].filter((id) => {
      if (inRegion.some((p) => p.id === id)) return true;
      return !prev.pluginPanelsSynced;
    });
    const current = prev.activePanelIds[region];
    if (current && tabs.includes(current)) return { active: current, tabs };
    if (tabs.length > 0) return { active: tabs[tabs.length - 1], tabs };
    if (region === 'left') {
      const fallback = defaultActiveFor(panels, 'left');
      return { active: fallback, tabs: fallback ? [fallback] : [] };
    }
    return { active: null, tabs: [] };
  };

  const left = pick('left');
  const right = pick('right');
  const activePanelIds: Record<PanelRegion, string | null> = {
    left: left.active,
    right: right.active,
  };
  const openPanelIds: Record<PanelRegion, string[]> = { left: left.tabs, right: right.tabs };

  return {
    panels,
    recency,
    activePanelIds,
    openPanelIds,
    mountedIds: computeMounted(panels, activeIdSet(activePanelIds), openPanelIds, recency),
  };
}

export const usePanelStore = create<PanelStoreState>()(
  persist(
    (set, get) => ({
      panels: [],
      activePanelIds: EMPTY_ACTIVE,
      openPanelIds: EMPTY_TABS,
      mountedIds: [],
      recency: [],
      runtime: {},
      params: {},
      activationNonces: {},
      pluginPanelsSynced: false,

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
                // Default 'lru' so switching away and back does not reload
                // the page from scratch. (Host panels carry their own
                // keepAlive and never route through this mapping.)
                keepAlive: panel.keepAlive ?? 'lru',
                region: panel.region ?? 'right',
                anchor: panel.anchor,
                order: panel.order,
              })),
          );
          const hostPanels = s.panels.filter((p) => p.source === 'host');
          // The registry is now authoritative: sync BEFORE reconciling so this
          // very call prunes stale tab ids (an uninstalled plugin's tabs), and
          // every reconcile after it does too.
          return {
            ...reconcile(
              [...hostPanels, ...pluginPanels],
              { ...s, pluginPanelsSynced: true },
            ),
            pluginPanelsSynced: true,
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
          // Resolve the region from the entry. Unknown ids default to 'right':
          // every id arriving from outside (find-preview routing, panel-open
          // events) is plugin-owned, and plugin panels always live on the right.
          const region = s.panels.find((p) => p.id === id)?.region ?? 'right';
          const recency = [id, ...s.recency.filter((r) => r !== id)].slice(0, 12);
          // Opening a panel without a tab opens one; opening one that already
          // has a tab just focuses it — the strip never shows duplicates.
          const tabs = s.openPanelIds[region];
          const openPanelIds = tabs.includes(id)
            ? s.openPanelIds
            : { ...s.openPanelIds, [region]: [...tabs, id] };
          const activePanelIds = { ...s.activePanelIds, [region]: id };
          delete runtime[id];
          return {
            activePanelIds,
            openPanelIds,
            recency,
            runtime,
            params,
            // Bump on every explicit activation — including re-activating the
            // panel that is already active, so its input can re-take focus.
            activationNonces: { ...s.activationNonces, [id]: (s.activationNonces[id] ?? 0) + 1 },
            mountedIds: computeMounted(s.panels, activeIdSet(activePanelIds), openPanelIds, recency),
          };
        }),

      /**
       * Close one tab. Focus falls to the tab on its left (browser habit),
       * then to the one that slid into the closed slot. A right region left
       * without tabs shows its empty state and the column collapses (the tab
       * strip calls the collapse); left re-seeds its default view instead.
       */
      closeTab: (region, id) =>
        set((s) => {
          const idx = s.openPanelIds[region].indexOf(id);
          if (idx === -1) return s;
          let tabs = s.openPanelIds[region].filter((t) => t !== id);
          let active: string | null = s.activePanelIds[region];
          if (active === id) {
            active = tabs[Math.max(0, idx - 1)] ?? null;
          }
          if (tabs.length === 0 && region === 'left') {
            const fallback = defaultActiveFor(s.panels, 'left');
            tabs = fallback ? [fallback] : tabs;
            active = fallback ?? null;
          }
          const activePanelIds = { ...s.activePanelIds, [region]: active };
          const openPanelIds = { ...s.openPanelIds, [region]: tabs };
          return {
            activePanelIds,
            openPanelIds,
            mountedIds: computeMounted(s.panels, activeIdSet(activePanelIds), openPanelIds, s.recency),
          };
        }),

      // Reorder does not touch mountedIds — the mounted set is unchanged, and
      // tab-cap eviction ranks by recency, not by strip order.
      reorderTabs: (region, from, to) =>
        set((s) => {
          const tabs = [...s.openPanelIds[region]];
          if (from < 0 || from >= tabs.length || to < 0 || to >= tabs.length || from === to) {
            return s;
          }
          const [moved] = tabs.splice(from, 1);
          tabs.splice(to, 0, moved);
          return { openPanelIds: { ...s.openPanelIds, [region]: tabs } };
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
      version: 3,
      partialize: (state) => ({
        activePanelIds: state.activePanelIds,
        openPanelIds: state.openPanelIds,
      }),
      migrate: (persisted) => {
        const p = (persisted ?? {}) as {
          activePanelId?: string | null;
          activePanelIds?: Record<PanelRegion, string | null>;
        };
        if (p.activePanelIds) {
          // v2 → v3: the region's single active panel becomes its only tab.
          // Tabs pointing at since-uninstalled panels are pruned later, by the
          // reconcile that runs when the panel list registers.
          const ids = p.activePanelIds;
          return {
            activePanelIds: ids,
            openPanelIds: {
              left: ids.left ? [ids.left] : [],
              right: ids.right ? [ids.right] : [],
            },
          } as never;
        }

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
        return {
          activePanelIds: { left: null, right: id },
          openPanelIds: { left: [], right: id ? [id] : [] },
        } as never;
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
