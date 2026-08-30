export type SlashCommandCategory = 'chat' | 'workspace' | 'file' | 'config' | 'skill' | 'tool' | 'plugin' | 'other';

export interface SlashCommand {
  id: string;
  name: string;
  description: string;
  category: SlashCommandCategory;
  args?: SlashCommandArg[];
}

export interface SlashCommandArg {
  name: string;
  description: string;
  required: boolean;
  type: 'string' | 'number' | 'boolean' | 'file';
}
