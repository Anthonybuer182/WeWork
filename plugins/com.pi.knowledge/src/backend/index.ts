/**
 * com.pi.knowledge backend — knowledge base panel + agent tools
 * (kb_save / kb_search / kb_list)
 * + kb.auto context provider (auto-inject before each message send,
 * gated by the autoContext setting).
 *
 * No plumbing here: the SDK owns the handshake, capability calls, panel
 * routing and timeouts. This file is the knowledge base itself.
 */
import { plugin, type PluginContext } from '@pi/plugin-sdk';

interface Entry {
  id: string;
  title: string;
  content: string;
  createdAt: string;
}

const PANEL = 'kb';

let entries: Entry[] = [];
let search = '';
let loaded = false;

// ── The knowledge base ──

function matches(entry: Entry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return entry.title.toLowerCase().includes(q) || entry.content.toLowerCase().includes(q);
}

async function load(ctx: PluginContext): Promise<void> {
  const saved = await ctx.call('storage.get', { key: 'entries' }).catch(() => undefined);
  entries = Array.isArray(saved) ? (saved as Entry[]) : [];
  loaded = true;
}

/**
 * Load once, whoever asks first. The panel often mounts before the backend
 * finishes reading storage, so both paths go through here rather than racing.
 */
async function ensureLoaded(ctx: PluginContext): Promise<void> {
  if (!loaded) await load(ctx);
}

async function persist(ctx: PluginContext): Promise<void> {
  await ctx.call('storage.set', { key: 'entries', value: entries }).catch(() => {});
  render(ctx);
}

function render(ctx: PluginContext): void {
  const query = search;
  ctx.send(PANEL, 'ui.render', {
    total: entries.length,
    search,
    shown: entries.filter((e) => matches(e, query)),
  });
}

function addEntry(title: string, content: string): Entry {
  const entry: Entry = {
    id: 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title: String(title).slice(0, 200),
    content: String(content ?? '').slice(0, 50_000),
    createdAt: new Date().toISOString(),
  };
  entries = [...entries, entry];
  return entry;
}

/** Keyword retrieval for the context provider: score by query-term overlap. */
function retrieve(message: string, limit = 5): Entry[] {
  const terms = String(message)
    .toLowerCase()
    .split(/[\s,，。.;；:：?？!！()（）"'「」[\]]+/)
    .filter((t) => t.length >= 2)
    .slice(0, 30);
  if (terms.length === 0) return [];
  return entries
    .map((entry) => {
      const haystack = `${entry.title}\n${entry.content}`.toLowerCase();
      const score = terms.reduce((acc, t) => acc + (haystack.includes(t) ? 1 : 0), 0);
      return { entry, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.entry);
}

// ── The plugin ──

plugin({
  async onInit(ctx) {
    await ensureLoaded(ctx);
  },

  /** The panel draws from here — onInit runs before anyone has opened it. */
  async onPanelMounted(_panelId, _params, ctx) {
    await ensureLoaded(ctx);
    render(ctx);
  },

  async onTool(name, params, ctx) {
    switch (name) {
      case 'kb_save': {
        const title = String(params.title ?? '');
        if (!title) throw new Error('missing title');
        const entry = addEntry(title, String(params.content ?? ''));
        await persist(ctx);
        return `已保存知识「${entry.title}」(${entry.content.length} 字符)`;
      }
      case 'kb_search': {
        const query = String(params.query ?? '');
        const hits = entries.filter((e) => matches(e, query));
        if (hits.length === 0) return `没有匹配「${query}」的知识条目。`;
        return hits.map((e) => `【${e.title}】\n${e.content.slice(0, 500)}`).join('\n\n');
      }
      case 'kb_list': {
        if (entries.length === 0) return '知识库为空。';
        return `知识库(${entries.length} 条):\n${entries.map((e) => `· ${e.title}`).join('\n')}`;
      }
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  },

  async onContextRequest(providerId, message, ctx) {
    if (providerId !== 'kb.auto') throw new Error(`unknown provider: ${providerId}`);
    const setting = await ctx.call('storage.get', { key: 'settings.autoContext' }).catch(() => undefined);
    // Manifest default is true; absent means never touched by the user.
    if (setting === false) return '';
    const hits = retrieve(message);
    if (hits.length === 0) return '';
    return hits.map((e) => `【${e.title}】\n${e.content.slice(0, 800)}`).join('\n\n');
  },

  /**
   * Panel events. This plugin has one panel, so the events are named for what
   * happened rather than routed through the host's `ui.event` envelope — the
   * SDK stamps the panel id either way, but a name that says what it is reads
   * better and needs no unwrapping.
   */
  async onEvent(_panelId, event, data, ctx) {
    switch (event) {
      case 'kb.add': {
        const title = String(data ?? '').trim();
        if (title) {
          addEntry(title, '');
          await persist(ctx);
        }
        break;
      }
      case 'kb.search':
        search = String(data ?? '');
        render(ctx);
        break;
      case 'kb.delete':
        entries = entries.filter((e) => e.id !== String((data as { key?: string })?.key));
        await persist(ctx);
        break;
      default:
        ctx.log.warn(`ignoring unknown panel event "${String(event)}"`);
    }
  },
});
