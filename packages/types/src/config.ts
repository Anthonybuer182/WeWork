import type { ThinkLevel } from './model.js';

export type ThemeMode = 'light' | 'dark' | 'system';

export interface Config {
  theme: ThemeMode;
  compactMode: boolean;
  defaultModelId: string;
  defaultThinkLevel: ThinkLevel;
  autoSave: boolean;
  fontSize: number;
  codeFontSize: number;
  enableStreaming: boolean;
  /** Compact long conversations automatically when the context fills up. */
  compactionEnabled: boolean;
}

// models.json configuration types

export interface ModelEntry {
  id: string;
  name: string;
  input?: string[];
  /** Extra configuration specific to custom models */
  api?: string;
  baseUrl?: string;
  contextWindow?: number;
  maxTokens?: number;
}

export interface ProviderCompat {
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
}

export interface ProviderEntry {
  baseUrl: string;
  api: string;
  apiKey: string;
  compat?: ProviderCompat;
  models: ModelEntry[];
}

export interface ModelsConfig {
  providers: Record<string, ProviderEntry>;
}
