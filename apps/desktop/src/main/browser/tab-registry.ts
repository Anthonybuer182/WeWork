import type { BrowserManager, TabInfo } from './browser-manager';

/**
 * TabRegistry — the authoritative mapping of engine tabs to conversations.
 *
 * A browser tab belongs to the conversation that opened it: two agents must
 * never fight over one "current page" (session A navigating would yank the
 * page session B's user is reading). The registry keeps one bucket per
 * conversation — its tab list and its focused tab — and routes tab lifecycle
 * through the BrowserManager. Plugin backends mirror this state (they pull on
 * init and follow `session.changed`); this side is the truth, because view
 * lives and deaths happen here.
 *
 * Bucket count mirrors the host's SESSIONS_KEPT: past it, the coldest
 * conversation's bucket drops (its live tabs keep existing — they are engine
 * resources — but no conversation claims them until re-opened).
 */

/** How many conversations keep their tab buckets. Matches panel-store SESSIONS_KEPT. */
const MAX_BUCKETS = 8;

interface Bucket {
  /** Tabs in strip order. */
  tabIds: string[];
  /** The focused tab ('' = none). */
  activeTabId: string | null;
}

/** Someone interested in tab lifecycle (main wires this to host events). */
export interface TabRegistryCallbacks {
  onTabOpened?: (tabId: string, url: string, sessionId: string) => void;
  onTabClosed?: (tabId: string, sessionId: string) => void;
}

export class TabRegistry {
  private buckets = new Map<string, Bucket>();
  private callbacks: TabRegistryCallbacks = {};

  constructor(private manager: BrowserManager) {}

  on(cb: TabRegistryCallbacks): void {
    Object.assign(this.callbacks, cb);
  }

  /** The bucket for a conversation, created on demand. */
  private bucketFor(sessionId: string): Bucket {
    let b = this.buckets.get(sessionId);
    if (!b) {
      b = { tabIds: [], activeTabId: null };
      this.buckets.set(sessionId, b);
    }
    return b;
  }

  /** Which conversation owns a tab ('' when none — the tab is unclaimed). */
  ownerOf(tabId: string): string {
    for (const [sessionId, b] of this.buckets) {
      if (b.tabIds.includes(tabId)) return sessionId;
    }
    return '';
  }

  /**
   * Open a tab in a conversation's bucket. It becomes that bucket's focus;
   * whether it becomes the VISIBLE tab depends on the panel reporting the
   * refreshed state (the backend pushes tabs and the panel refreshes its slot
   * with the new active tag).
   */
  newTab(sessionId: string, opts: { url?: string; activate?: boolean } = {}): TabInfo {
    const b = this.bucketFor(sessionId);
    const t = this.manager.createTab({ url: opts.url, activate: true });
    b.tabIds.push(t.id);
    if (opts.activate !== false) {
      b.activeTabId = t.id;
      // Make it the manager's active target too, so a slot report without a
      // tag (older panel) still lands on it.
      this.manager.activateTab(t.id);
    }
    this.prune();
    this.callbacks.onTabOpened?.(t.id, opts.url ?? '', sessionId);
    return this.info(t.id);
  }

  /**
   * A popup (window.open / target=_blank) from `sourceTabId` — it belongs to
   * the same conversation as its opener.
   */
  newTabFromPopup(sourceTabId: string, url: string): TabInfo {
    const sessionId = this.ownerOf(sourceTabId) || 'default';
    // Popups open in the background: the opener page stays visible (matches a
    // browser's "new tab" behavior when the opener is an agent-driven page).
    return this.newTab(sessionId, { url, activate: false });
  }

  /** Focus a tab within its conversation. Evicted tabs are recreated. */
  activateTab(sessionId: string, tabId: string): void {
    const b = this.bucketFor(sessionId);
    this.manager.activateTab(tabId); // throws on unknown id — the caller's bug
    if (!b.tabIds.includes(tabId)) b.tabIds.push(tabId);
    b.activeTabId = tabId;
  }

  /** Close a tab and drop it from its bucket; closing the focus falls left. */
  closeTab(tabId: string): void {
    const sessionId = this.ownerOf(tabId);
    if (sessionId) {
      const b = this.bucketFor(sessionId);
      const idx = b.tabIds.indexOf(tabId);
      if (idx >= 0) b.tabIds.splice(idx, 1);
      if (b.activeTabId === tabId) {
        b.activeTabId = b.tabIds[Math.max(0, idx - 1)] ?? null;
      }
    }
    // User-closed tabs leave no record — unlike LRU evictions, closing is
    // deliberate and a re-open should be a fresh navigation.
    this.manager.closeTab(tabId);
    if (sessionId) this.callbacks.onTabClosed?.(tabId, sessionId);
  }

  /**
   * The full tab picture for a conversation: its own tabs (in strip order,
   * focus flagged) plus any tabs it lost to the LRU (evicted, re-activatable).
   */
  list(sessionId: string): Array<TabInfo & { focused: boolean }> {
    this.adopt(sessionId);
    const b = this.bucketFor(sessionId);
    const all = this.manager.tabList();
    const mine = new Set(b.tabIds);
    const inOrder = b.tabIds
      .map((id) => all.find((t) => t.id === id))
      .filter((t): t is TabInfo => !!t)
      .map((t) => ({ ...t, focused: t.id === b.activeTabId }));
    // Evicted tabs of this conversation: they carry no bucket marker, so keep
    // them attached by convention — an evicted tab was in SOME bucket; report
    // it to the asking conversation only if it was focused there when it died.
    const evicted = all
      .filter((t) => t.evicted && !mine.has(t.id))
      .map((t) => ({ ...t, focused: false }));
    return [...inOrder, ...evicted];
  }

  /**
   * Warm-up tabs created outside any bucket (the boot tab, created so the
   * engine is ready before any conversation asks) join the first empty bucket
   * that comes asking — the first conversation to browse takes over the warm
   * view instead of paying for a second renderer.
   *
   * 'default' (no conversation on screen) never claims them: its bucket is
   * the fall-through for direct tool traffic, and a spawn-time replay with
   * sessionId null would otherwise hoard the warm tab before the real
   * conversation's session.changed lands.
   */
  private adopt(sessionId: string): void {
    if (sessionId === 'default') return;
    const claimed = new Set<string>();
    for (const b of this.buckets.values()) b.tabIds.forEach((id) => claimed.add(id));
    const unclaimed = this.manager
      .tabList()
      .filter((t) => !t.evicted && !claimed.has(t.id) && !t.active);
    const activeUnclaimed = this.manager
      .tabList()
      .find((t) => !t.evicted && !claimed.has(t.id) && t.active);
    const found = activeUnclaimed ? [activeUnclaimed, ...unclaimed] : unclaimed;
    if (found.length === 0) return;
    const b = this.bucketFor(sessionId);
    if (b.tabIds.length > 0) return;
    for (const t of found) b.tabIds.push(t.id);
    b.activeTabId = activeUnclaimed?.id ?? found[0].id;
  }

  /** Drop the coldest buckets past the cap. Live tabs are engine resources —
   *  they keep running unclaimed. */
  private prune(): void {
    if (this.buckets.size <= MAX_BUCKETS) return;
    for (const key of this.buckets.keys()) {
      if (this.buckets.size <= MAX_BUCKETS) break;
      if (key === 'default') continue;
      this.buckets.delete(key);
    }
  }

  private info(tabId: string): TabInfo {
    const t = this.manager.tabList().find((x) => x.id === tabId);
    return t ?? { id: tabId, url: '', title: '', active: false };
  }
}
