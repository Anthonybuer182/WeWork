import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { StateStorage } from 'zustand/middleware';
import { getDesktopLayoutId, getDesktopWindowId } from '@/lib/window-identity';
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
  /** 'host:plugins' | 'host:sessions' | 'plugin:<pluginId>:<panelId>' */
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
  /** This panel's split companion (see PluginPanelInfo.companion). */
  companion?: string;
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

/**
 * The panel the LEFT column falls back to when nothing is selected. The right
 * column deliberately has no fallback: its tab strip is the switcher and an
 * empty body is the honest "you have not opened anything yet".
 */
function defaultActiveFor(panels: PanelEntry[], region: PanelRegion): string | null {
  return regionPanels(panels, region)[0]?.id ?? null;
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
 * empty state and no close gesture), right stays empty — the column opens
 * with the tab strip and no active panel until the user picks one.
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
      // Only plugin ids may be temporarily unknown (their registry syncs after
      // host panels register). A host id that is gone — e.g. `host:settings`,
      // which became a dialog — must be pruned immediately: waiting for a
      // plugin sync that never comes (the web build has no plugins) would
      // leave the column focused on a panel with no body.
      return !prev.pluginPanelsSynced && id.startsWith('plugin:');
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

/**
 * Panel state lives in two scopes.
 *
 *  - ARRANGEMENT (tab order, pane widths) belongs to the WORKSPACE: VS Code
 *    keeps a folder's layout with the folder, so reopening it anywhere — or
 *    restarting into it — restores the same arrangement.
 *  - WHICH PANELS ARE OPEN belongs to the WINDOW, keyed by its stable layout
 *    id. A restored window comes back the way you left it; a NEW window
 *    starts empty, so it never inherits another window's panels (the plugin
 *    center used to appear this way in every new window).
 */
const PANEL_STORAGE_BASE = 'pi-panel-storage';
let layoutWorkspace: string | null = null;

function arrangementKey(): string {
  if (layoutWorkspace) return `${PANEL_STORAGE_BASE}:ws:${layoutWorkspace}`;
  const windowId = getDesktopWindowId();
  return windowId == null ? PANEL_STORAGE_BASE : `${PANEL_STORAGE_BASE}:w${windowId}`;
}

function selectionKey(): string {
  const layoutId = getDesktopLayoutId();
  if (layoutId) return `${PANEL_STORAGE_BASE}:sel:${layoutId}`;
  const windowId = getDesktopWindowId();
  return windowId == null ? `${PANEL_STORAGE_BASE}:sel` : `${PANEL_STORAGE_BASE}:sel:w${windowId}`;
}

function legacyPanelKeys(): string[] {
  const keys: string[] = [];
  const windowId = getDesktopWindowId();
  if (windowId != null) keys.push(`${PANEL_STORAGE_BASE}:w${windowId}`);
  keys.push(PANEL_STORAGE_BASE);
  return keys;
}

interface StoredBlob {
  version?: number;
  state?: Record<string, unknown>;
}

function readBlob(key: string): StoredBlob | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as StoredBlob) : null;
  } catch {
    return null;
  }
}

const panelStorage: StateStorage = {
  getItem: (): string | null => {
    let arrangement = readBlob(arrangementKey());
    // One-time fallback for layouts written before arrangement/selection were
    // split: the old per-window blob held both.
    if (!arrangement) {
      for (const legacy of legacyPanelKeys()) {
        arrangement = readBlob(legacy);
        if (arrangement) break;
      }
    }
    const selection = readBlob(selectionKey());
    if (!arrangement && !selection) return null;
    const state = { ...(arrangement?.state ?? {}), ...(selection?.state ?? {}) };
    const version = Math.max(arrangement?.version ?? 0, selection?.version ?? 0) || undefined;
    return JSON.stringify({ state, version });
  },
  setItem: (_name: string, value: string): void => {
    try {
      const parsed = JSON.parse(value) as StoredBlob;
      const s = parsed.state ?? {};
      localStorage.setItem(
        arrangementKey(),
        JSON.stringify({
          version: parsed.version,
          state: { panelOrder: s.panelOrder, paneFracs: s.paneFracs },
        }),
      );
      localStorage.setItem(
        selectionKey(),
        JSON.stringify({
          version: parsed.version,
          state: {
            openPanelIds: s.openPanelIds,
            focusedId: s.focusedId,
            currentSessionId: s.currentSessionId,
            sessionPanels: s.sessionPanels,
            sessionOrder: s.sessionOrder,
          },
        }),
      );
    } catch {
      /* quota / private mode — best-effort */
    }
  },
  removeItem: (): void => {
    try {
      localStorage.removeItem(arrangementKey());
      localStorage.removeItem(selectionKey());
    } catch {
      /* ignore */
    }
  },
};

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
                companion: panel.companion,
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

          // Split-companion adjacency (VS Code's 向右拆分): opening the
          // companion of an already-selected panel re-seats it RIGHT AFTER its
          // main panel in the arrangement — never appended at the row's end —
          // and clears the region's zoom, which would otherwise keep the new
          // pane hidden off-layout.
          const entry = s.panels.find((p) => p.id === id);
          const mainPanel = entry?.panelId
            ? s.panels.find((p) => p.companion === entry.panelId)
            : undefined;
          let order = s.panelOrder[region];
          let zoomedId = s.zoomedId;
          if (mainPanel && selected.includes(mainPanel.id)) {
            const stripped = order.filter((x) => x !== id);
            const mainIdx = stripped.indexOf(mainPanel.id);
            if (mainIdx !== -1) {
              order = [...stripped.slice(0, mainIdx + 1), id, ...stripped.slice(mainIdx + 1)];
            }
            if (zoomedId[region]) zoomedId = { ...zoomedId, [region]: null };
          }

          if (selected.includes(id)) {
            delete runtime[id];
            return {
              focusedId: { ...s.focusedId, [region]: id },
              zoomedId,
              panelOrder: { ...s.panelOrder, [region]: order },
              recency,
              runtime,
              params,
              activationNonces: { ...s.activationNonces, [id]: (s.activationNonces[id] ?? 0) + 1 },
            };
          }
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
            zoomedId,
            panelOrder: { ...s.panelOrder, [region]: order },
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
      version: 9,
      // Arrangement → workspace key, selections → window key: see panelStorage.
      storage: createJSONStorage(() => panelStorage),
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
        // v5..v8 mixed arrangement and "which panels are open" in one blob;
        // those selections were written before panels were scoped to the
        // window, so they cannot be attributed reliably. Carry over the
        // arrangement only; from v9 on both scopes are stored separately.
        const p = (persisted ?? {}) as {
          panelOrder?: Record<PanelRegion, string[]>;
          paneFracs?: Record<string, number>;
        };
        const DEVDOCS_PANEL = 'plugin:com.pi.devdocs:docs';
        const order = p.panelOrder ?? { left: [], right: [] };
        // v7 default: the dev-docs panel is a reference surface, kept last in
        // the right tab strip unless the user drags it elsewhere.
        if (Array.isArray(order.right) && order.right.includes(DEVDOCS_PANEL)) {
          order.right = [...order.right.filter((id) => id !== DEVDOCS_PANEL), DEVDOCS_PANEL];
        }
        return {
          panelOrder: order,
          paneFracs: p.paneFracs ?? {},
        } as never;
      },
    },
  ),
);

/**
 * Two windows on the SAME workspace share one layout key, and localStorage is
 * one blob per key: without this, the other window's next persist write (any
 * status event is enough) would put its stale arrangement back and the drag a
 * user just made would quietly revert.
 *
 * Only the ARRANGEMENT travels — panelOrder and pane widths. Which panels are
 * open stays per window: the two windows sit on different conversations, and
 * syncing selections would drag one window's session panels into the other.
 * The comparison stops the echo: the write this triggers lands back here as an
 * identical value, and equal fields are ignored.
 */
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (!event.newValue || event.key !== arrangementKey()) return;
    try {
      const parsed = JSON.parse(event.newValue) as
        | { state?: { panelOrder?: unknown; paneFracs?: unknown } }
        | null;
      const incoming = parsed?.state;
      if (!incoming) return;
      const current = usePanelStore.getState();
      const nextOrder = (incoming.panelOrder ?? current.panelOrder) as PanelStoreState['panelOrder'];
      const nextFracs = (incoming.paneFracs ?? current.paneFracs) as PanelStoreState['paneFracs'];
      const sameOrder = JSON.stringify(nextOrder) === JSON.stringify(current.panelOrder);
      const sameFracs = JSON.stringify(nextFracs) === JSON.stringify(current.paneFracs);
      if (sameOrder && sameFracs) return;
      usePanelStore.setState({
        panelOrder: nextOrder,
        paneFracs: nextFracs,
      });
    } catch {
      /* malformed payload — keep the current layout */
    }
  });
}

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

/**
 * Point the panel store at a workspace's layout and load it.
 *
 * Called by the UI store whenever the active workspace changes (and once at
 * boot after rehydration). The workspace's saved panels become the store's
 * state; switching back re-reads the same key, so layout follows the folder —
 * the way VS Code remembers a folder's layout rather than a window's.
 */
export function setPanelLayoutWorkspace(workspaceId: string | null): void {
  const next = workspaceId ?? null;
  if (layoutWorkspace === next) return;
  layoutWorkspace = next;
  void usePanelStore.persist.rehydrate();
}
