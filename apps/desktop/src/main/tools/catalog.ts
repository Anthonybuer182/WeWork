/**
 * The list of tools the settings page and the composer picker show.
 *
 * Only tools the model can actually see are listed: the four active SDK
 * built-ins, the host's own tools, and whatever enabled plugins contribute.
 * `read` / `bash` / `edit` / `write` are included deliberately — they are
 * capabilities with real consequences, and "this conversation may not touch
 * the filesystem" is a legitimate request. The picker defaults to all-on, so
 * nothing is lost by showing them.
 */

import type { ToolCatalogEntry } from '@pi/types';
import type { AgentCustomTool } from '../agent-tools';

const BUILTIN_TOOLS: ToolCatalogEntry[] = [
  { name: 'read', label: 'read', description: '读取文件内容', source: 'builtin', readOnly: true },
  { name: 'bash', label: 'bash', description: '执行 shell 命令', source: 'builtin' },
  { name: 'edit', label: 'edit', description: '修改文件', source: 'builtin' },
  { name: 'write', label: 'write', description: '写入文件', source: 'builtin' },
];

export function buildToolCatalog(
  hostTools: AgentCustomTool[],
  pluginTools: AgentCustomTool[],
  pluginName: (pluginId: string | undefined) => string | undefined,
): ToolCatalogEntry[] {
  return [
    ...BUILTIN_TOOLS,
    ...hostTools.map((tool) => ({
      name: tool.name,
      label: tool.label || tool.name,
      description: tool.description,
      source: 'host' as const,
      readOnly: tool.readOnly,
    })),
    ...pluginTools.map((tool) => ({
      name: tool.name,
      label: tool.label || tool.name,
      description: tool.description,
      source: 'plugin' as const,
      pluginId: tool.pluginId,
      pluginName: pluginName(tool.pluginId),
      readOnly: tool.readOnly,
    })),
  ];
}
