import { ASK_TOOL_NAME, TODO_TOOL_NAME, type ToolCatalogEntry } from '@pi/types';
import type { MessageKey } from '@/i18n';

export const INTERACTION_TOOL_NAMES = new Set([ASK_TOOL_NAME, TODO_TOOL_NAME]);

export interface ToolGroup {
  key: string;
  title: string;
  items: ToolCatalogEntry[];
}

/**
 * Group the catalog the way both surfaces (Settings → 工具 and the composer
 * picker) show it: the two interaction tools first, then the host's own
 * built-ins, then one group per plugin. Plugin names are user-visible and
 * already localized by their authors, so they pass through untranslated.
 */
export function groupToolCatalog(
  tools: ToolCatalogEntry[],
  t: (key: MessageKey) => string,
): ToolGroup[] {
  const interaction = tools.filter((tool) => INTERACTION_TOOL_NAMES.has(tool.name));
  const builtin = tools.filter(
    (tool) => tool.source !== 'plugin' && !INTERACTION_TOOL_NAMES.has(tool.name),
  );
  const byPlugin = new Map<string, ToolCatalogEntry[]>();
  for (const tool of tools) {
    if (tool.source !== 'plugin') continue;
    const key = tool.pluginId ?? tool.pluginName ?? tool.name;
    const list = byPlugin.get(key) ?? [];
    list.push(tool);
    byPlugin.set(key, list);
  }

  const groups: ToolGroup[] = [];
  if (interaction.length > 0) {
    groups.push({ key: 'interaction', title: t('交互'), items: interaction });
  }
  if (builtin.length > 0) {
    groups.push({ key: 'builtin', title: t('内置'), items: builtin });
  }
  for (const [key, items] of byPlugin) {
    groups.push({
      key,
      title: items[0]?.pluginName ?? items[0]?.pluginId ?? t('插件'),
      items,
    });
  }
  return groups;
}
