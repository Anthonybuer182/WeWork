export type ModelProvider = 'anthropic' | 'openai' | 'google' | 'custom';

export type ThinkLevel = 'off' | 'low' | 'medium' | 'high';

export interface ModelInfo {
  id: string;
  name: string;
  provider: ModelProvider;
  supportsThinking: boolean;
  thinkLevels: ThinkLevel[];
  maxTokens: number;
  isAvailable: boolean;
}

/**
 * What the active model can accept. Derived from the SDK model object (the
 * `input` array in models.json); used to choose the host's system-prompt
 * capability note and to filter image tool results before they reach a model
 * that cannot read them.
 */
export interface ModelCapabilities {
  /** e.g. ['text'] or ['text', 'image']. */
  input: string[];
  /** True when `input` includes 'image'. */
  vision: boolean;
  contextWindow?: number;
  maxTokens?: number;
}
