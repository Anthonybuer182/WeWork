import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { PluginInfo, PluginPanelStatus, PanelRegion, PanelAnchor, PanelScope } from '@pi/types';

export type PanelKeepAlive = 'always' | 'lru' | 'never';
// Region/anchor/scope belong to the manifest contract (plugins declare them),
// so the definitions live in @pi/types. Re-exported here because most call
// sites import these from the store alongside PanelEntry.
export type { PanelRegion, PanelAnchor, PanelScope };

/** How many conversations keep their panel state when the user moves on. */
const SESSIONS_KEPT = 8;

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
  /** Whether the panel's tabs follow the session. Defaults to 'global'. */
  scope?: PanelScope;
  /** Which sidebar column this panel renders in. */
  region: PanelRegion;
  /** Position within its region's rail. Defaults to 'top'. */
  anchor?: PanelAnchor;
  /** Sort order among panels sharing a region and anchor. */
  order?: number;
}

/**
 * The session-scoped slice of one conversation: which session-scoped panels
 * were selected, which of them was focused, and their open params (e.g. which
 * file the viewer held). Swapped out of `openPanelIds`/`params` on session
 * switch and back in on re-entry — the work area always shows "global panels +
 * the current conversation's panels".
 */
export interface SessionPanelState {
  selected: string[];
  focused: string | null;
  params: Record<string, Record<string, unknown> | undefined>;
}

export interface PanelRuntimeState {
  badge?: number | string;
  activity?: 'idle' | 'streaming' | 'working' | 'error';
  /** Panel open requested without focus (no-focus-steal) — list shows a dot. */
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
 * Selected panels mounted per region, on top of the focused one. A selection
 * is a promise that switching back restores state, so selected panels mount
 * unconditionally up to this cap; the coldest past it hibernate. Each mounted
 * plugin panel is a renderer process (plus possibly a browser engine view),
 * which is why the cap exists at all.
 */
const TAB_MOUNT_CAP = 6;

/** Preferred right-region panel when there is no prior selection. */
const DEFAULT_ACTIVE_PANEL = 'host:plugins';

const EMPTY_FOCUSED: Record<PanelRegion, string | null> = { left: null, right: null };
const EMPTY_TABS: Record<PanelRegion, string[]> = { left: [], right: [] };

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

function computeMounted(
  panels: PanelEntry[],
  focusedIds: Record<PanelRegion, string | null>,
  openPanelIds: Record<PanelRegion, string[]>,
  recency: string[],
): string[] {
  const byId = new Map(panels.map((p) => [p.id, p]));
  const mounted = new Set<string>();
  for (const id of Object.values(focusedIds)) {
    if (id && byId.has(id)) mounted.add(id);
  }

  // 'always' means always: mount them whether or not they are selected and
  // whether or not they were ever activated. Going through `recency` alone was
  // wrong — a panel first activated by `reconcile` (not `openPanel`) never
  // enters recency, so switching away from it unmounted it and lost its state
  // (expanded folders, list scroll). recency is also capped, so even an
  // activated 'always' panel could eventually fall out of it.
  for (const panel of panels) {
    if (panel.keepAlive === 'always') mounted.add(panel.id);
  }

  // Selected panels mount within the per-region cap; the coldest go first
  // (hibernation — the selection keeps its list entry and reloads when used).
  // 'never' keeps its contract even as a selection: it unmounts while hidden.
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

  // Deselected panels stay warm through the small LRU budget: deselecting by
  // mistake and reselecting restores without a reload.
  const openIds = new Set([...openPanelIds.left, ...openPanelIds.right]);
  let lruBudget = LRU_KEEP;
  for (const id of recency) {
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
 * must go through this — otherwise `mountedIds`/`focusedId` keep pointing
 * at panels that no longer exist, or at panels that changed region.
 *
 * Per region: keep the focused panel if it survived, else focus the first
 * remaining selection. A region left with no selection behaves differently:
 * left re-seeds its default view (a single-select container has no meaningful
 * empty state and no close gesture), right stays empty — the column-open
 * effect opens the fallback as a selection, so "nothing is selected" stays
 * honest.
 *
 * Unknown ids (panel not in the list yet) survive until the plugin registry
 * has synced once: at boot, host panels register before plugin panels, and
 * every `set` writes straight through to storage — pruning on the first
 * reconcile would clobber the persisted selection before the plugin list
 * exists. After the first sync, an unknown id really is an uninstalled panel.
 */
function reconcile(
  panels: PanelEntry[],
  prev: {
    focusedId: Record<PanelRegion, string | null>;
    openPanelIds: Record<PanelRegion, string[]>;
    sessionPanels: Record<string, SessionPanelState>;
    recency: string[];
    panelOrder: Record<PanelRegion, string[]>;
    paneFracs: Record<string, number>;
    pluginPanelsSynced: boolean;
  },
): {
  panels: PanelEntry[];
  recency: string[];
  focusedId: Record<PanelRegion, string | null>;
  openPanelIds: Record<PanelRegion, string[]>;
  sessionPanels: Record<string, SessionPanelState>;
  panelOrder: Record<PanelRegion, string[]>;
  paneFracs: Record<string, number>;
  mountedIds: string[];
} {
  const recency = prev.recency.filter((id) => panels.some((p) => p.id === id));

  // The header plugin list follows the registry: uninstall/disable removes an
  // entry, a freshly installed plugin appends (the user's drag order is kept
  // for everything that survives). Before the registry has synced once the
  // pruning is gated off — host panels register before plugin panels, so a
  // boot-time prune would drop every plugin id from the persisted arrangement
  // and resurrect registry order (the same gate the selection pick applies).
  const panelOrder: Record<PanelRegion, string[]> = { left: [], right: [] };
  for (const region of ['left', 'right'] as PanelRegion[]) {
    const known = regionPanels(panels, region).map((p) => p.id);
    const knownSet = new Set(known);
    const kept = prev.pluginPanelsSynced
      ? prev.panelOrder[region].filter((id) => knownSet.has(id))
      : prev.panelOrder[region];
    const keptSet = new Set(kept);
    panelOrder[region] = [...kept, ...known.filter((id) => !keptSet.has(id))];
  }

  // Session panel state gets the same sync-gate treatment as the selections:
  // prune a session's stashed panels only once the registry is authoritative,
  // and keep only panels that still point at session-scoped panels.
  let sessionPanels = prev.sessionPanels;
  if (prev.pluginPanelsSynced) {
    sessionPanels = {};
    for (const [sid, st] of Object.entries(prev.sessionPanels)) {
      const selected = (st.selected ?? []).filter((id) =>
        panels.some((p) => p.id === id && p.scope === 'session'),
      );
      const focused = st.focused && selected.includes(st.focused) ? st.focused : null;
      if (selected.length === 0 && !focused) continue;
      const params: SessionPanelState['params'] = {};
      for (const id of selected) params[id] = st.params?.[id];
      sessionPanels[sid] = { selected, focused, params };
    }
  }

  // Deselected panels take their fracs with them; unknown ids never had any.
  const knownIds = new Set(panels.map((p) => p.id));
  const paneFracs: Record<string, number> = {};
  for (const [id, frac] of Object.entries(prev.paneFracs ?? {})) {
    if (knownIds.has(id)) paneFracs[id] = frac;
  }

  const pick = (region: PanelRegion): { focused: string | null; selected: string[] } => {
    const inRegion = regionPanels(panels, region);
    const selected = prev.openPanelIds[region].filter((id) => {
      if (inRegion.some((p) => p.id === id)) return true;
      return !prev.pluginPanelsSynced;
    });
    const current = prev.focusedId[region];
    const focused = current && selected.includes(current) ? current : selected[selected.length - 1] ?? null;
    if (region === 'left' && selected.length === 0) {
      const fallback = defaultActiveFor(panels, region);
      return { focused: fallback, selected: fallback ? [fallback] : [] };
    }
    return { focused, selected };
  };

  const left = pick('left');
  const right = pick('right');

  return {
    panels,
    recency,
    focusedId: { left: left.focused, right: right.focused },
    openPanelIds: { left: left.selected, right: right.selected },
    sessionPanels,
    panelOrder,
    paneFracs,
    mountedIds: computeMounted(panels, { left: left.focused, right: right.focused }, { left: left.selected, right: right.selected }, recency),
  };
}

export const usePanelStore = create<PanelStoreState>()(
  persist(
    (set, get) => ({
      panels: [],
      focusedId: { left: null, right: null },
      openPanelIds: EMPTY_TABS,
      panelOrder: { left: [], right: [] },
      paneFracs: {},
      zoomedId: { left: null, right: null },
      currentSessionId: null,
      sessionPanels: {},
      sessionOrder: [],
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
              // but a malformed descriptor must not take the whole list down.
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
                scope: panel.scope,
                region: panel.region ?? 'right',
                anchor: panel.anchor,
                order: panel.order,
              })),
          );
          const hostPanels = s.panels.filter((p) => p.source === 'host');
          // The registry is now authoritative: sync BEFORE reconciling so this
          // very call prunes stale selections (an uninstalled plugin's panes),
          // and every reconcile after it does too.
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
          // Selecting an already-selected panel just focuses it; a NEW
          // selection is inserted at its list-order position (pane order
          // follows the plugin list's order).
          const selected = s.openPanelIds[region];
          if (selected.includes(id)) {
            delete runtime[id];
            return {
              focusedId: { ...s.focusedId, [region]: id },
              zoomedId: { ...s.zoomedId, [region]: s.zoomedId[region] },
              recency,
              runtime,
              params,
              activationNonces: { ...s.activationNonces, [id]: (s.activationNonces[id] ?? 0) + 1 },
            };
          }
          const order = s.panelOrder[region];
          const orderIdx = order.indexOf(id);
          const openPanelIds = { ...s.openPanelIds };
          if (orderIdx === -1) {
            openPanelIds[region] = [...selected, id];
          } else {
            // Insert before the first already-selected panel that comes after
            // it in the list order — panes render in list order.
            let insertAt = selected.length;
            for (let i = orderIdx + 1; i < order.length; i++) {
              const at = selected.indexOf(order[i]);
              if (at !== -1) {
                insertAt = at;
                break;
              }
            }
            openPanelIds[region] = [...selected.slice(0, insertAt), id, ...selected.slice(insertAt)];
          }
          const focusedId = { ...s.focusedId, [region]: id };
          return {
            focusedId,
            openPanelIds,
            recency,
            runtime,
            params,
            activationNonces: { ...s.activationNonces, [id]: (s.activationNonces[id] ?? 0) + 1 },
            mountedIds: computeMounted(s.panels, focusedId, openPanelIds, recency),
          };
        }),

      /**
       * Deselect a panel: its pane leaves the work area (and the header list
       * shows it unselected). Focus falls to a neighbour in list order.
       * Deselecting is deliberate — the LRU keeps the page warm for a while.
       */
      closeTab: (region, id) =>
        set((s) => {
          const selected = s.openPanelIds[region];
          const idx = selected.indexOf(id);
          if (idx === -1) return s;
          const remaining = selected.filter((t) => t !== id);
          const order = s.panelOrder[region];
          // Focus falls to the list-order neighbour that is still selected.
          let fallback: string | null = null;
          for (let i = order.indexOf(id) - 1; i >= 0; i--) {
            if (remaining.includes(order[i])) { fallback = order[i]; break; }
          }
          if (!fallback) {
            for (let i = order.indexOf(id) + 1; i < order.length; i++) {
              if (remaining.includes(order[i])) { fallback = order[i]; break; }
            }
          }
          if (!fallback && remaining.length > 0) fallback = remaining[remaining.length - 1];
          const focusedId = { ...s.focusedId, [region]: s.focusedId[region] === id ? fallback : s.focusedId[region] };
          const zoomedId = { ...s.zoomedId, [region]: s.zoomedId[region] === id ? null : s.zoomedId[region] };
          const paneFracs = { ...s.paneFracs };
          delete paneFracs[id];
          const openPanelIds = { ...s.openPanelIds, [region]: remaining };
          if (region === 'left' && remaining.length === 0) {
            const fallbackLeft = defaultActiveFor(s.panels, region);
            if (fallbackLeft) {
              openPanelIds[region] = [fallbackLeft];
              focusedId[region] = fallbackLeft;
            }
          }
          return {
            focusedId,
            zoomedId,
            paneFracs,
            openPanelIds,
            mountedIds: computeMounted(s.panels, focusedId, openPanelIds, s.recency),
          };
        }),

      // Reorder does not touch mountedIds — the mounted set is unchanged, and
      // pane-cap eviction ranks by recency, not by list order.
      reorderTabs: (region, from, to) =>
        set((s) => {
          const ids = [...s.openPanelIds[region]];
          if (from < 0 || from >= ids.length || to < 0 || to >= ids.length || from === to) {
            return s;
          }
          const [moved] = ids.splice(from, 1);
          ids.splice(to, 0, moved);
          return { openPanelIds: { ...s.openPanelIds, [region]: ids } };
        }),

      /** The user's arrangement of the header plugin list (drag reorder). */
      setPanelOrder: (region, ids) =>
        set((s) => {
          const known = regionPanels(s.panels, region).map((p) => p.id);
          const knownSet = new Set(known);
          const filtered = ids.filter((id) => knownSet.has(id));
          const filteredSet = new Set(filtered);
          const merged = [...filtered, ...known.filter((id) => !filteredSet.has(id))];
          return { panelOrder: { ...s.panelOrder, [region]: merged } };
        }),

      /** Focus a selected panel's pane (does not change the selection). */
      setFocused: (region, id) =>
        set((s) => {
          if (!s.openPanelIds[region].includes(id)) return s;
          return { focusedId: { ...s.focusedId, [region]: id } };
        }),

      /** Zoom a pane to the full column, or clear the zoom. */
      toggleZoom: (region, id) =>
        set((s) => ({
          zoomedId: { ...s.zoomedId, [region]: s.zoomedId[region] === id ? null : id },
        })),

      /** Pane width shares (fractions of the column) — sash drags write here. */
      setPaneFracs: (region, fracs) =>
        set((s) => {
          const mergedFracs = { ...s.paneFracs };
          for (const [id, frac] of Object.entries(fracs)) {
            if (s.openPanelIds[region].includes(id)) mergedFracs[id] = Math.min(0.8, Math.max(0.12, frac));
          }
          return { paneFracs: mergedFracs };
        }),

      /** The focused panel of a region (pane order follows the list). */
      focusedPanelOf: (region: PanelRegion): string | null => get().focusedId[region],

      /**
       * Switch conversations: the session-scoped slice of the selection
       * (panels, focus, params) detaches into `sessionPanels`; the incoming
       * session's slice attaches. Global panels never move. Idempotent — safe
       * to re-run after plugin registration, which re-classifies panels whose
       * scope was unknown at first call.
       */
      enterSession: (sessionId) =>
        set((s) => {
          const scopeOf = (id: string): 'session' | 'global' | 'unknown' => {
            const p = s.panels.find((x) => x.id === id);
            return p ? (p.scope === 'session' ? 'session' : 'global') : 'unknown';
          };

          // Before the plugin registry syncs, panels of not-yet-registered
          // entries are unclassifiable. Running the swap then would stash a
          // half-read selection — worst case an EMPTY stash overwriting the
          // persisted one (params are not persisted, so they cannot be
          // recovered). Defer the whole swap: the App re-enters once the
          // registry has synced.
          const stripIds = [...s.openPanelIds.left, ...s.openPanelIds.right];
          if (!s.pluginPanelsSynced && stripIds.some((id) => scopeOf(id) === 'unknown')) {
            const order = [sessionId, s.currentSessionId, ...s.sessionOrder].filter(
              (id): id is string => id !== null,
            );
            return { currentSessionId: sessionId, sessionOrder: [...new Set(order)] };
          }

          const sessionPanels = { ...s.sessionPanels };
          const params = { ...s.params };

          // ── Stash: the outgoing conversation takes its slice with it. ──
          if (s.currentSessionId !== null) {
            const stashSelected: string[] = [];
            const stashParams: SessionPanelState['params'] = {};
            let stashFocused: string | null = null;
            for (const region of ['left', 'right'] as PanelRegion[]) {
              for (const id of s.openPanelIds[region]) {
                // Only KNOWN session panels detach: an unknown id (plugin not
                // registered yet) may be global — stashing it here would pin a
                // global panel to one conversation.
                if (scopeOf(id) !== 'session') continue;
                stashSelected.push(id);
                stashParams[id] = params[id];
                delete params[id];
              }
              if (
                s.focusedId[region] &&
                scopeOf(s.focusedId[region]!) === 'session' &&
                stashSelected.includes(s.focusedId[region]!)
              ) {
                stashFocused = s.focusedId[region];
              }
            }
            const prevStash = sessionPanels[s.currentSessionId];
            const mergedParams: SessionPanelState['params'] = { ...(prevStash?.params ?? {}) };
            for (const [k, v] of Object.entries(stashParams)) {
              if (v !== undefined) mergedParams[k] = v;
            }
            for (const k of Object.keys(mergedParams)) {
              if (!stashSelected.includes(k)) delete mergedParams[k];
            }
            sessionPanels[s.currentSessionId] = {
              selected: stashSelected,
              focused: stashFocused,
              params: mergedParams,
            };
          }

          // ── Restore: the incoming conversation's slice attaches. ──
          const incoming = sessionId !== null ? sessionPanels[sessionId] : undefined;
          const openPanelIds = { ...s.openPanelIds };
          const focusedId = { ...s.focusedId };
          for (const region of ['left', 'right'] as PanelRegion[]) {
            openPanelIds[region] = s.openPanelIds[region].filter((id) => scopeOf(id) !== 'session');
            if (focusedId[region] && scopeOf(focusedId[region]!) === 'session') focusedId[region] = null;
          }
          if (incoming) {
            for (const id of incoming.selected) {
              const p = s.panels.find((x) => x.id === id);
              const region: PanelRegion = p?.region ?? 'right';
              if (!openPanelIds[region].includes(id)) {
                openPanelIds[region] = [...openPanelIds[region], id];
              }
              if (incoming.params?.[id] !== undefined) params[id] = incoming.params[id];
            }
            const incomingFocused =
              incoming.focused && incoming.selected.includes(incoming.focused) ? incoming.focused : null;
            if (incomingFocused) {
              const p = s.panels.find((x) => x.id === incomingFocused);
              focusedId[p?.region ?? 'right'] = incomingFocused;
            }
          }
          // A zoom whose pane was deselected cannot persist.
          const zoomedId = { ...s.zoomedId };
          for (const region of ['left', 'right'] as PanelRegion[]) {
            if (zoomedId[region] && !openPanelIds[region].includes(zoomedId[region]!)) {
              zoomedId[region] = null;
            }
          }

          return {
            currentSessionId: sessionId,
            sessionPanels,
            sessionOrder:
              sessionId !== null
                ? [sessionId, ...s.sessionOrder.filter((id) => id !== sessionId)].slice(0, SESSIONS_KEPT)
                : s.sessionOrder,
            openPanelIds,
            focusedId,
            zoomedId,
            params,
            mountedIds: computeMounted(s.panels, focusedId, openPanelIds, s.recency),
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
      version: 6,
      partialize: (state) => ({
        focusedId: state.focusedId,
        openPanelIds: state.openPanelIds,
        panelOrder: state.panelOrder,
        paneFracs: state.paneFracs,
        currentSessionId: state.currentSessionId,
        sessionPanels: state.sessionPanels,
        sessionOrder: state.sessionOrder,
      }),
      migrate: (persisted) => {
        const p = (persisted ?? {}) as {
          activePanelId?: string | null;
          activePanelIds?: Record<PanelRegion, string | null> | Record<PanelRegion, Record<string, string | null>>;
          openPanelIds?: Record<PanelRegion, string[]>;
          focusedId?: Record<PanelRegion, string | null>;
          sessionPanels?: Record<string, SessionPanelState>;
          sessionOrder?: string[];
          panelOrder?: Record<PanelRegion, string[]>;
          paneFracs?: Record<string, number>;
          currentSessionId?: string | null;
        };
        const sessionState = {
          currentSessionId: p.currentSessionId ?? null,
          sessionPanels: {} as Record<string, SessionPanelState>,
          sessionOrder: p.sessionOrder ?? [],
        };
        // Old stash shape (v5: per-slot actives + slotOf) → the new one.
        for (const [sid, stRaw] of Object.entries(p.sessionPanels ?? {})) {
          const st = stRaw as unknown as Record<string, unknown>;
          const tabs = (st.tabs as string[] | undefined) ?? (st.selected as string[] | undefined) ?? [];
          const active = st.active as Record<string, string | null> | string | null | undefined;
          const slotFocused =
            typeof active === 'object' && active !== null
              ? (active.A ?? active.B ?? null)
              : ((active as string | null) ?? null);
          const focused =
            (st.focused as string | null | undefined) ?? slotFocused ?? (tabs.length ? tabs[tabs.length - 1] : null);
          sessionState.sessionPanels[sid] = {
            selected: tabs,
            focused: focused && tabs.includes(focused) ? focused : null,
            params: (st.params as SessionPanelState['params']) ?? {},
          };
        }

        const focusedFrom = (): Record<PanelRegion, string | null> => {
          if (p.focusedId) return p.focusedId;
          // v5: per-slot actives → the last non-null slot becomes the focus.
          const bySlot = p.activePanelIds as
            | Record<PanelRegion, Record<string, string | null>>
            | Record<PanelRegion, string | null>
            | undefined;
          if (bySlot && typeof bySlot === 'object') {
            const read = (region: PanelRegion): string | null => {
              const v = bySlot[region];
              if (typeof v === 'string') return v;
              if (v && typeof v === 'object') return v.A ?? v.B ?? null;
              return null;
            };
            return { left: read('left'), right: read('right') };
          }
          const legacy = p.activePanelId ?? null;
          return { left: null, right: legacy };
        };

        const selected = p.openPanelIds ?? {
          left: [],
          right: (() => {
            const f = focusedFrom().right;
            return f ? [f] : [];
          })(),
        };
        const focused = focusedFrom();
        // A focus without a selection is dead on arrival.
        for (const region of ['left', 'right'] as PanelRegion[]) {
          if (focused[region] && !(selected[region] ?? []).includes(focused[region]!)) {
            focused[region] = (selected[region] ?? [])[0] ?? null;
          }
        }

        return {
          focusedId: focused,
          openPanelIds: selected,
          panelOrder: p.panelOrder ?? { left: [], right: [] },
          paneFracs: p.paneFracs ?? {},
          ...sessionState,
        } as never;
      },
    },
  ),
);

export { pluginPanelId };

function pluginPanelId(pluginId: string, panelId: string): string {
  return `plugin:${pluginId}:${panelId}`;
}

/**
 * Activation counter for one panel — changes whenever that panel is explicitly
 * activated. Use as an effect dependency to focus an input on activation.
 */
export function usePanelActivation(panelId: string): number {
  return usePanelStore((s) => s.activationNonces[panelId] ?? 0);
}

export interface PanelStoreState {
  panels: PanelEntry[];
  /** The focused pane per region — one of that region's selected panels. */
  focusedId: Record<PanelRegion, string | null>;
  /**
   * Selected panels per region, in work-area order (panes render in this
   * order). Toggling a header entry adds/removes here; closing a pane is a
   * deselection. The session stash swaps the session-scoped slice per
   * conversation.
   */
  openPanelIds: Record<PanelRegion, string[]>;
  /**
   * User arrangement of the header plugin list. The list is a switcher
   * (every installed+enabled panel is an entry, 2026-10-16), so this — not
   * selection order — is what drag-reorder writes, and the work-area pane
   * order follows it. Entries missing from the array trail in registry order;
   * unknown ids are pruned by reconcile. Persisted.
   */
  panelOrder: Record<PanelRegion, string[]>;
  /** Pane width shares per panel id (fractions of the column). Persisted. */
  paneFracs: Record<string, number>;
  /** A pane zoomed to the full column (runtime; Esc / toggle clears). */
  zoomedId: Record<PanelRegion, string | null>;
  /** The conversation whose session panels currently sit in `openPanelIds`. */
  currentSessionId: string | null;
  /** Per-conversation session-panel state, most recently entered tracked in `sessionOrder`. */
  sessionPanels: Record<string, SessionPanelState>;
  sessionOrder: string[];
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
   * `setPluginPanels`. Gates reconcile's pruning of unknown ids — see
   * its doc comment.
   */
  pluginPanelsSynced: boolean;

  setHostPanels: (panels: PanelEntry[]) => void;
  setPluginPanels: (infos: PluginInfo[]) => void;
  /** Select a panel (and focus it). focus=false → pending badge only, no steal. */
  openPanel: (id: string, opts?: { focus?: boolean; params?: Record<string, unknown> }) => void;
  /** Deselect a panel (its pane leaves the work area). */
  closeTab: (region: PanelRegion, id: string) => void;
  /** Reorder a region's selection. */
  reorderTabs: (region: PanelRegion, from: number, to: number) => void;
  /** The user's arrangement of the header plugin list (drag reorder). */
  setPanelOrder: (region: PanelRegion, ids: string[]) => void;
  /** Focus a selected panel's pane. */
  setFocused: (region: PanelRegion, id: string) => void;
  /** Zoom a pane to the full column, or clear the zoom. */
  toggleZoom: (region: PanelRegion, id: string) => void;
  /** Pane width shares (fractions of the column) — sash drags write here. */
  setPaneFracs: (region: PanelRegion, fracs: Record<string, number>) => void;
  /** The focused panel of a region. */
  focusedPanelOf: (region: PanelRegion) => string | null;
  /**
   * Switch conversations: the session-scoped slice of the selection detaches
   * into `sessionPanels`; the incoming session's slice attaches. Global
   * panels never move. Idempotent — safe to re-run after plugin registration.
   */
  enterSession: (sessionId: string | null) => void;
  setPanelStatus: (status: PluginPanelStatus) => void;
  clearPending: (id: string) => void;
}
