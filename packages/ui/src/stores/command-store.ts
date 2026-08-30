import { create } from 'zustand';
import type { SlashCommand } from '@pi/types';

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
          description: c.description ?? c.title ?? `插件 ${pluginId} 命令`,
          category: 'plugin' as const,
          source: pluginId,
        })),
      ],
    })),

  clearPluginCommands: (pluginId) =>
    set((s) => ({ commands: s.commands.filter((c) => c.source !== pluginId) })),
}));
