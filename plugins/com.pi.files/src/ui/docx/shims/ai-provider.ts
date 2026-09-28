/**
 * Stand-in for `@genoffice/ai-provider`.
 *
 * The plugin runs the HOST's agent, so GenOffice's provider layer is not
 * shipped. What survives is the type surface, because `shared/ipc.ts` re-exports
 * these names and the renderer type-checks against them.
 *
 * `AI_PROVIDERS` is the one runtime value. It only feeds GenOffice's own model
 * picker, which lives inside the AI panel we replaced — so an empty list is
 * both correct and honest: this plugin has no providers of its own to offer.
 * The model list belongs to the host, not here.
 */

/** GenOffice's provider descriptors. Empty: the host owns model choice. */
export const AI_PROVIDERS: AiProviderMeta[] = [];

export interface AiProviderMeta {
  id: string;
  label: string;
  models: string[];
  [key: string]: unknown;
}

export type AiProviderId = string;

export interface AiProviderConfig {
  id?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  [key: string]: unknown;
}

export interface AiSettings {
  providers?: Record<string, AiProviderConfig>;
  activeProvider?: string | null;
  [key: string]: unknown;
}

export interface AiChatRequest {
  messages?: unknown[];
  [key: string]: unknown;
}

export interface AiChatResponse {
  text?: string;
  error?: string;
  [key: string]: unknown;
}

export interface AiStreamRequest {
  requestId?: string;
  [key: string]: unknown;
}

export interface AiStreamChunk {
  requestId?: string;
  delta?: string;
  done?: boolean;
  error?: string;
  [key: string]: unknown;
}

export interface GenSparkAccountStatus {
  loggedIn?: boolean;
  email?: string | null;
  [key: string]: unknown;
}

/** Whether GenOffice's provider layer can generate images. The plugin has no
 *  provider layer — the host owns models — so this is always false. */
export function imageGenerationAvailable(..._args: unknown[]): boolean {
  return false;
}
