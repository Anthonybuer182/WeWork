import { create } from 'zustand';
import type { SlashCommand } from '@pi/types';
import { t, type MessageKey } from '@/i18n';

export interface RegisteredCommand extends SlashCommand {
  /** 'host' or a pluginId. */
  source: string;
}

/**
 * Host-built-in slash commands (the host is the zeroth contributor).
 * Handlers live in the composer (they need composer context); this registry
 * owns the declarative command list that the slash menu renders.
 */
export const HOST_COMMANDS: RegisteredCommand[] = [
  { id: 'cmd-help', name: '/help', description: 'Show help information', category: 'chat', source: 'host' },
  { id: 'cmd-clear', name: '/clear', description: 'Clear the current conversation', category: 'chat', source: 'host' },
  { id: 'cmd-compact', name: '/compact', description: 'Compact conversation context', category: 'chat', source: 'host' },
  { id: 'cmd-model', name: '/model', description: 'Switch the AI model', category: 'config', source: 'host' },
  { id: 'cmd-config', name: '/config', description: 'Show or update config', category: 'config', source: 'host' },
];

/**
 * Host command copy. Descriptions live here rather than in HOST_COMMANDS so a
 * language switch re-renders them (the registry is created once, at startup).
 * Plugin commands keep their own description — that text belongs to the plugin.
 */
const HOST_COMMAND_DESCRIPTIONS: Record<string, MessageKey> = {
  '/help': '显示帮助信息',
  '/clear': '清空当前对话',
  '/compact': '压缩对话上下文',
  '/model': '切换 AI 模型',
  '/config': '查看或修改配置',
};

export function commandDescription(
  command: { name: string; description?: string },
  t: (key: MessageKey) => string,
): string {
  const key = HOST_COMMAND_DESCRIPTIONS[command.name];
  return key ? t(key) : (command.description ?? '');
}

export const COMMAND_CATEGORY_LABELS: Record<string, MessageKey> = {
  chat: '对话',
  config: '配置',
  plugin: '插件',
  other: '其他',
};

interface CommandStoreState {
  commands: RegisteredCommand[];
  setPluginCommands: (pluginId: string, cmds: { name: string; title?: string; description?: string }[]) => void;
  clearPluginCommands: (pluginId: string) => void;
}

export const useCommandStore = create<CommandStoreState>()((set) => ({
  commands: HOST_COMMANDS,

  setPluginCommands: (pluginId, cmds) =>
    set((s) => ({
      commands: [
        ...s.commands.filter((c) => c.source !== pluginId),
        ...cmds.map((c) => ({
          id: `cmd-${pluginId}-${c.name}`,
          name: c.name,
          description: c.description ?? c.title ?? t('插件 {id} 命令', { id: pluginId }),
          category: 'plugin' as const,
          source: pluginId,
        })),
      ],
    })),

  clearPluginCommands: (pluginId) =>
    set((s) => ({ commands: s.commands.filter((c) => c.source !== pluginId) })),
}));
