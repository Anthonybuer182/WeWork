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

/** A model advertised by a provider's own listing endpoint (`GET …/models`). */
export interface ProviderModelInfo {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: ('text' | 'image')[];
}

export type ProviderModelListErrorCode =
  | 'unsupported'
  | 'unauthorized'
  | 'network'
  | 'http'
  | 'invalid';

/**
 * Result of asking a provider what it serves. Failure is a value, not a throw:
 * discovery is optional, and a provider that will not list its models must not
 * stop the user from typing one in.
 */
export interface ProviderModelListResult {
  ok: boolean;
  models?: ProviderModelInfo[];
  code?: ProviderModelListErrorCode;
  error?: string;
}
