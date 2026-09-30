import type { PanelEntry } from '@/stores/panel-store';

/**
 * Built-in left-sidebar panels, shared by both apps so the left column is
 * defined once.
 *
 * `keepAlive: 'always'` is REQUIRED for these — their DOM state (expanded
 * folders, list scroll, virtualization) has to survive switching views, and
 * 'lru' would let them compete for the global LRU budget with right-side
 * plugin panels and get evicted.
 */
export const HOST_LEFT_PANELS: PanelEntry[] = [
  {
    id: 'host:files',
    title: '文件',
    icon: 'files',
    source: 'host',
    keepAlive: 'always',
    region: 'left',
    order: 0,
  },
  {
    id: 'host:sessions',
    title: '会话',
    icon: 'sessions',
    source: 'host',
    keepAlive: 'always',
    region: 'left',
    order: 1,
  },
  {
    id: 'host:search',
    title: '搜索',
    icon: 'search',
    source: 'host',
    keepAlive: 'always',
    region: 'left',
    order: 2,
  },
  {
    // The agent's standing context. A host panel rather than a plugin because
    // it edits the agent's own configuration — SYSTEM.md, APPEND_SYSTEM.md,
    // AGENTS.md — which is the same kind of thing the settings panel does to
    // models.json, and the same kind of thing these three are: a global view of
    // the workspace rather than of what is currently open.
    id: 'host:context',
    title: '上下文',
    icon: 'sliders',
    source: 'host',
    keepAlive: 'always',
    region: 'left',
    order: 3,
  },
];
