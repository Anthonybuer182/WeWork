/**
 * Connector plugin scaffold — copy this directory, replace NAME with your
 * system (e.g. "crm"), and implement fetchRecords().
 *
 * Two things to change, both marked below:
 *   1. fetchRecords()  — call your system's HTTP API here
 *   2. toListItems()   — map API records to panel rows
 *
 * Everything else — the handshake, capability calls, panel routing, timers,
 * error reporting — is the SDK's job. The same `plugin(...)` shape every
 * first-party plugin uses; see docs/plugin-dev-guide.md.
 */
import { plugin, type PluginContext } from '@pi/plugin-sdk';

/** Used in storage keys and the tool name. Replaced along with NAME. */
const PLUGIN_KEY = 'NAME';

/** This plugin's one panel. Matches `contributes.panels[0].id` in the manifest. */
const PANEL = 'records';

interface Record_ {
  id: string;
  title: string;
  detail?: string;
  status?: string;
}

let records: Record_[] = [];
let keyword = '';
let loadError: string | undefined;

// ─────────────────────────────────────────────────────────────────────
// 1 · Replace this with your system's HTTP API call.
//
// `ctx.call('network.fetch', …)` goes out through the host, which is what
// makes the manifest's `network:<host>` permission meaningful — a plain
// `fetch()` would bypass the permission model entirely.
//
// Credentials belong in the secrets vault (manifest `secrets:NAME`), not in
// the source:
//
//   const { token } = await ctx.call('storage.get', { key: 'auth' });
//   const res = await ctx.call('network.fetch', {
//     url: `https://api.your-system.example/v1/records?q=${encodeURIComponent(kw)}`,
//     headers: { Authorization: `Bearer ${token}` },
//   });
//   return JSON.parse(String(res.body)).items;
// ─────────────────────────────────────────────────────────────────────
async function fetchRecords(ctx: PluginContext, filter: { keyword?: string } = {}): Promise<Record_[]> {
  void ctx;
  const mock: Record_[] = [
    { id: 'R-001', title: '示例记录', detail: '替换 fetchRecords() 以接入真实系统' },
  ];
  const kw = filter.keyword ?? '';
  return mock.filter((r) => !kw || r.title.includes(kw) || r.id.includes(kw));
}

// ─────────────────────────────────────────────────────────────────────
// 2 · Map your API records to panel rows.
// ─────────────────────────────────────────────────────────────────────
function toListItems(rows: Record_[]): Array<Record<string, unknown>> {
  return rows.map((r) => ({
    key: String(r.id),
    label: r.title,
    description: r.detail ?? '',
    badge: r.status,
  }));
}

/** Format records for the agent (plain text). */
function toToolText(rows: Record_[]): string {
  if (rows.length === 0) return '没有匹配的记录。';
  return rows.map((r) => `${r.id} | ${r.title}${r.detail ? ' | ' + r.detail : ''}`).join('\n');
}

// ── Framework wiring below (no changes needed) ──

async function refresh(ctx: PluginContext): Promise<void> {
  try {
    records = await fetchRecords(ctx, { keyword });
    loadError = undefined;
    await ctx.setBadge(PANEL, records.length > 0 ? records.length : null);
  } catch (err) {
    records = [];
    loadError = err instanceof Error ? err.message : String(err);
  }
}

function render(ctx: PluginContext): void {
  ctx.send(PANEL, 'ui.render', {
    title: `${PLUGIN_KEY} 记录(${records.length})`,
    keyword,
    error: loadError,
    rows: toListItems(records),
  });
}

plugin({
  async onInit(ctx) {
    await refresh(ctx);
  },

  /** The panel's first paint. `onInit` runs before anyone has opened it. */
  async onPanelMounted(_panelId, _params, ctx) {
    await refresh(ctx);
    render(ctx);
  },

  async onTool(name, params, ctx) {
    if (name !== `${PLUGIN_KEY}_query`) throw new Error(`unknown tool: ${name}`);
    const rows = await fetchRecords(ctx, { keyword: String(params.keyword ?? '') });
    return {
      content: [{ type: 'text', text: toToolText(rows) }],
      details: { count: rows.length },
    };
  },

  /** One panel, so the events are named for what happened. */
  async onEvent(_panelId, event, data, ctx) {
    if (event === 'conn.filter') {
      keyword = String(data ?? '');
    } else if (event === 'conn.refresh') {
      // nothing to change — just refetch
    } else {
      ctx.log.warn(`ignoring unknown panel event "${event}"`);
      return;
    }
    await refresh(ctx);
    render(ctx);
  },
});
