/**
 * Discover the models a provider serves, using the same credentials the chat
 * path uses.
 *
 * Runs wherever `ConfigService` runs (main process, or the web dev server), so
 * the browser never talks to the provider directly: that avoids CORS, and it
 * keeps the API key out of any network code the renderer owns.
 *
 * Every supported family here is best-effort. Providers are free to change
 * their listing endpoints, and several (Azure deployments, Vertex, Bedrock)
 * cannot be listed from an API key alone — those report `unsupported` and the
 * dialog falls back to manual entry.
 */

import type {
  ProviderModelInfo,
  ProviderModelListResult,
} from '@pi/types';

const TIMEOUT_MS = 10_000;

export interface RemoteModelListInput {
  baseUrl: string;
  api: string;
  apiKey: string;
}

type Family = 'openai' | 'anthropic' | 'google' | 'unsupported';

function familyOf(api: string): Family {
  if (api === 'anthropic-messages') return 'anthropic';
  if (api === 'google-generative-ai') return 'google';
  if (
    api === 'azure-openai-responses' ||
    api === 'google-vertex' ||
    api === 'bedrock-converse-stream'
  ) {
    return 'unsupported';
  }
  // openai-completions / -responses / codex, mistral, and unknown extension
  // ids: most gateways expose the OpenAI-compatible listing shape.
  return 'openai';
}

function trimBase(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

function endpointFor(family: Family, base: string): string {
  if (family === 'anthropic') {
    // Anthropic's path is fixed at /v1/models; accept a base that already
    // carries the version segment.
    const root = base.replace(/\/v1$/, '');
    return `${root}/v1/models`;
  }
  return `${base}/models`;
}

function headersFor(family: Family, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (family === 'anthropic') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else if (family === 'google') {
    headers['x-goog-api-key'] = apiKey;
  } else {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

function positiveNumber(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const n = positiveNumber(value);
    if (n !== undefined) return n;
  }
  return undefined;
}

/**
 * Accepts the shapes in the wild: `{data:[…]}` (OpenAI), `{models:[…]}`
 * (Google), or a bare array. Items may be strings or objects; ids may be
 * prefixed with `models/` (Google) or carry only a `name` (Anthropic).
 */
function normalize(data: unknown): ProviderModelInfo[] {
  const payload = data as
    | { data?: unknown; models?: unknown }
    | unknown[]
    | null;
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.models)
        ? payload.models
        : [];

  const byId = new Map<string, ProviderModelInfo>();
  for (const raw of list) {
    if (typeof raw === 'string') {
      const id = raw.replace(/^models\//, '').trim();
      if (id) byId.set(id, { id, name: id });
      continue;
    }
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;

    // Google lists embedding and other non-chat models alongside chat ones.
    const methods = item.supportedGenerationMethods;
    if (Array.isArray(methods) && !methods.includes('generateContent')) continue;

    const rawId = item.id ?? item.model ?? item.name;
    if (typeof rawId !== 'string') continue;
    const id = rawId.replace(/^models\//, '').trim();
    if (!id) continue;

    const display =
      (typeof item.display_name === 'string' && item.display_name) ||
      (typeof item.displayName === 'string' && item.displayName) ||
      '';

    const input = Array.isArray(item.input)
      ? (item.input.filter((v) => v === 'text' || v === 'image') as ('text' | 'image')[])
      : undefined;

    const info: ProviderModelInfo = { id, name: display || id };
    const contextWindow = firstNumber(
      item.context_window,
      item.contextWindow,
      item.inputTokenLimit,
      item.max_input_tokens,
    );
    const maxTokens = firstNumber(
      item.max_output_tokens,
      item.maxOutputTokens,
      item.outputTokenLimit,
      item.max_tokens,
    );
    if (contextWindow) info.contextWindow = contextWindow;
    if (maxTokens) info.maxTokens = maxTokens;
    if (input?.length) info.input = input;
    byId.set(id, info);
  }

  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function clip(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 300);
}

export async function fetchRemoteModels(
  input: RemoteModelListInput,
): Promise<ProviderModelListResult> {
  const base = trimBase(input.baseUrl);
  const apiKey = input.apiKey.trim();
  if (!base || !apiKey) {
    return {
      ok: false,
      code: 'invalid',
      error: !base ? 'Base URL is empty' : 'API key is empty',
    };
  }

  const family = familyOf(input.api);
  if (family === 'unsupported') {
    return {
      ok: false,
      code: 'unsupported',
      error: `${input.api} cannot be listed from an API key`,
    };
  }

  const url = endpointFor(family, base);
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: headersFor(family, apiKey),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const message =
      err instanceof Error
        ? err.name === 'TimeoutError' || err.name === 'AbortError'
          ? `Timed out after ${TIMEOUT_MS / 1000}s`
          : err.message
        : String(err);
    return { ok: false, code: 'network', error: message };
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const suffix = body ? ` — ${clip(body)}` : '';
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        code: 'unauthorized',
        error: `${response.status} ${response.statusText}${suffix}`,
      };
    }
    return {
      ok: false,
      code: 'http',
      error: `${response.status} ${response.statusText}${suffix}`,
    };
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch (err) {
    return {
      ok: false,
      code: 'http',
      error: err instanceof Error ? err.message : 'Response was not JSON',
    };
  }

  return { ok: true, models: normalize(data) };
}
