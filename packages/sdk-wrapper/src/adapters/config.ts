import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import type { ConfigService } from '../services/config.js';
import { SettingsManager, AuthStorage, ModelRegistry, getAgentDir, loadSkills } from '@earendil-works/pi-coding-agent';
import type { Skill as SdkSkill } from '@earendil-works/pi-coding-agent';
import type { Config, ModelInfo, ModelProvider, ModelsConfig, ProviderEntry, ModelEntry, Skill } from '@pi/types';

// ── Multimodal model auto-detection ──

/**
 * Known multimodal model name patterns.
 * When a model's "input" field doesn't explicitly include "image",
 * these patterns are used to auto-detect vision-capable models and
 * automatically set input: ["text", "image"].
 */
const KNOWN_MULTIMODAL_PATTERNS: RegExp[] = [
  // Explicit VL/vision markers
  /vl/i, /vision/i, /visual/i, /multimodal/i,
  // OpenAI vision models
  /gpt-4o/i, /gpt-4-turbo/i, /gpt-4-v/i,
  // Anthropic Claude 3+ (all support vision)
  /claude-3/i, /claude-4/i, /claude-sonnet/i, /claude-opus/i,
  // Google Gemini (all support vision)
  /gemini/i,
  // Open-source VL models
  /pixtral/i, /llava/i, /cogv/i, /internvl/i, /minicpm-v/i,
  /deepseek-vl/i, /glm-4v/i, /yi-vl/i, /phi-3-v/i,
  /moondream/i, /paligemma/i, /florence/i, /owlv/i,
  // Qwen VL series
  /qwen-vl/i, /qwen2-vl/i, /qwen2.5-vl/i,
  // MiniMax multimodal models (M1, M3 support vision; M2.x does NOT)
  /minimax-m1/i, /minimax-m3/i,
  // DeepSeek models (Janus, VL series are vision-capable)
  /janus/i,
  // Step series (step-1v, step-1o-vision)
  /step.*v/i,
  // Doubao vision models
  /doubao.*vision/i, /doubao.*vl/i,
  // Ernie VL models
  /ernie.*vl/i, /ernie-4/i,
  // Hunyuan vision
  /hunyuan.*vision/i, /hunyuan.*vl/i, /hunyuan-turbos/i,
  // Spark / iFlytek VL
  /spark.*vl/i,
];

/** Auto-detect and fix the "input" field for known multimodal models. */
function normalizeModelInput(model: ModelEntry): ModelEntry {
  // If already explicitly set to include image, don't touch it
  if (model.input?.includes('image')) return model;
  // If explicitly set to text-only by user, respect that choice
  if (model.input !== undefined && model.input.length > 0 && !model.input.includes('image')) {
    // Only override text-only if name matches a known multimodal pattern
    const name = ((model.name || model.id) ?? '').toLowerCase();
    if (KNOWN_MULTIMODAL_PATTERNS.some((p) => p.test(name))) {
      // Was text-only but name suggests multimodal — user probably forgot to set it.
      // Override to multimodal so the agent can send images to this model.
      return { ...model, input: ['text', 'image'] };
    }
    // Text-only and no name match — user intended this
    return model;
  }
  // input is undefined — auto-detect from name
  const name = ((model.name || model.id) ?? '').toLowerCase();
  if (KNOWN_MULTIMODAL_PATTERNS.some((p) => p.test(name))) {
    return { ...model, input: ['text', 'image'] };
  }
  return model;
}

// Map real SDK thinking levels to our Config thinking levels
function toConfigThinkLevel(level?: string): Config['defaultThinkLevel'] {
  switch (level) {
    case 'off': return 'off';
    case 'minimal': return 'low';
    case 'low': return 'low';
    case 'medium': return 'medium';
    case 'high': return 'high';
    case 'xhigh': return 'high';
    default: return 'medium';
  }
}

// Map our think levels to real SDK levels
function toRealThinkLevel(level?: string): 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | undefined {
  switch (level) {
    case 'off': return 'off';
    case 'low': return 'low';
    case 'medium': return 'medium';
    case 'high': return 'high';
    default: return undefined;
  }
}

// SDK thinking levels → our ThinkLevel set (deduped)
const VALID_THINK_LEVELS: ReadonlySet<string> = new Set(['off', 'low', 'medium', 'high']);

function toThinkLevels(thinkingLevelMap?: Record<string, string | null>): ('off' | 'low' | 'medium' | 'high')[] {
  if (!thinkingLevelMap) return ['off', 'low', 'medium', 'high'];
  const levels = new Set<string>();
  for (const l of Object.keys(thinkingLevelMap)) {
    if (l === 'minimal') levels.add('low');
    else if (l === 'xhigh') levels.add('high');
    else if (VALID_THINK_LEVELS.has(l)) levels.add(l);
  }
  return [...levels] as ('off' | 'low' | 'medium' | 'high')[];
}

// Normalize SDK provider to our ModelProvider type
function toModelProvider(raw: string): ModelProvider {
  if (raw === 'openai' || raw.startsWith('openai')) return 'openai';
  if (raw === 'google' || raw === 'google-vertex') return 'google';
  if (raw === 'anthropic') return 'anthropic';
  return 'custom';
}

// Environment variable names for built-in providers
const BUILT_IN_PROVIDER_ENV_KEYS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
};

function getConfiguredModelProviders(): Set<string> {
  const providers = new Set<string>();

  // 1. Providers from models.json
  const modelsJsonPath = join(getAgentDir(), 'models.json');
  try {
    if (existsSync(modelsJsonPath)) {
      const raw = readFileSync(modelsJsonPath, 'utf-8');
      const config = JSON.parse(raw);
      if (config?.providers) {
        for (const name of Object.keys(config.providers)) {
          providers.add(name);
        }
      }
    }
  } catch {
    // models.json unreadable – skip
  }

  // 2. Built-in providers with env var API keys
  for (const [provider, envKey] of Object.entries(BUILT_IN_PROVIDER_ENV_KEYS)) {
    if (process.env[envKey]) {
      providers.add(provider);
    }
  }

  return providers;
}

// models.json helpers

function getModelsJsonModelIds(): Set<string> {
  const config = readModelsConfig();
  const ids = new Set<string>();
  for (const provider of Object.values(config.providers)) {
    for (const model of provider.models) {
      ids.add(model.id);
    }
  }
  return ids;
}

function getModelsJsonPath(): string {
  return join(getAgentDir(), 'models.json');
}

function readModelsConfig(): ModelsConfig {
  const path = getModelsJsonPath();
  try {
    if (existsSync(path)) {
      const raw = readFileSync(path, 'utf-8');
      const parsed = JSON.parse(raw);
      return { providers: parsed?.providers ?? {} };
    }
  } catch {
    // unreadable or malformed
  }
  return { providers: {} };
}

function writeModelsConfig(config: ModelsConfig): void {
  const path = getModelsJsonPath();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * One-time migration to auto-patch existing models whose names match known
 * multimodal patterns but have input: ["text"]. This ensures models like
 * MiniMax-M3 are recognized as vision-capable even if they were configured
 * before the auto-detection feature was added.
 *
 * Returns the number of models patched, or 0 if no changes were needed.
 */
export function migrateModelsConfig(): number {
  const config = readModelsConfig();
  let patched = 0;

  for (const provider of Object.values(config.providers)) {
    if (!provider.models) continue;
    for (let i = 0; i < provider.models.length; i++) {
      const original = provider.models[i];
      const normalized = normalizeModelInput(original);
      if (normalized !== original) {
        provider.models[i] = normalized;
        patched++;
      }
    }
  }

  if (patched > 0) {
    writeModelsConfig(config);
  }
  return patched;
}

// Re-read configured providers after models.json changes
function refreshConfiguredProviders(modelRegistry: ModelRegistry): Set<string> {
  // Re-create registry to pick up changes
  const providers = getConfiguredModelProviders();
  // Force registry refresh
  try {
    modelRegistry.refresh();
  } catch {
    // refresh might not be available on in-memory instance
  }
  return providers;
}

export function createRealConfigService(cwd: string, agentDir?: string, modelRegistry?: ModelRegistry, settingsManager?: SettingsManager): ConfigService {
  const settings = settingsManager ?? SettingsManager.create(cwd, agentDir);
  const registry = modelRegistry ?? ModelRegistry.create(AuthStorage.inMemory());
  const resolvedAgentDir = agentDir || getAgentDir();

  // Determine which providers have usable auth (mutable after models.json writes)
  let configuredProviders = getConfiguredModelProviders();

  return {
    async get(): Promise<Config> {
      const globalSettings = settings.getGlobalSettings();
      const projectSettings = settings.getProjectSettings();
      const merged = { ...globalSettings, ...projectSettings };

      let rawDefaultModelId = settings.getDefaultModel() || merged.defaultModel || 'claude-sonnet-4';

      // Validate: only keep the default model if it's in models.json AND has configured auth
      const configuredModelIds = getModelsJsonModelIds();
      const availableModels = registry.getAvailable();
      const validModels = availableModels.filter((m) => configuredModelIds.has(m.id));
      if (rawDefaultModelId && !validModels.some((m) => m.id === rawDefaultModelId)) {
        rawDefaultModelId = validModels[0]?.id ?? '';
      }

      return {
        theme: (merged.theme as Config['theme']) ?? 'system',
        compactMode: false,
        defaultModelId: rawDefaultModelId,
        defaultThinkLevel: toConfigThinkLevel(settings.getDefaultThinkingLevel()),
        autoSave: true,
        fontSize: 14,
        codeFontSize: 13,
        enableStreaming: true,
      };
    },

    async update(data: Partial<Config>): Promise<Config> {
      if (data.defaultModelId) {
        settings.setDefaultModel(data.defaultModelId);
      }
      if (data.defaultThinkLevel) {
        settings.setDefaultThinkingLevel(toRealThinkLevel(data.defaultThinkLevel)!);
      }
      if (data.theme) {
        settings.setTheme(data.theme);
      }
      await settings.flush();
      return this.get();
    },

    async listModels(): Promise<ModelInfo[]> {
      // Auto-migrate existing models (e.g. MiniMax-M3) to include image support.
      // This runs on every models listing so users don't need to restart the app.
      const patched = migrateModelsConfig();
      if (patched > 0) {
        console.log(`[config] Auto-migrated ${patched} model(s) to multimodal (image input).`);
      }
      // Refresh from disk so listModels and getModelsConfig stay in sync
      configuredProviders = refreshConfiguredProviders(registry);
      // Only return models that are explicitly configured in models.json
      const configuredModelIds = getModelsJsonModelIds();
      const models = registry.getAll().filter((m) =>
        configuredProviders.has(m.provider) && configuredModelIds.has(m.id),
      );
      return models.map((m) => ({
        id: m.id,
        name: m.name,
        provider: toModelProvider(m.provider),
        supportsThinking: m.reasoning,
        thinkLevels: m.reasoning ? toThinkLevels(m.thinkingLevelMap) : ['off'],
        maxTokens: m.maxTokens,
        isAvailable: true,
      }));
    },

    async listSkills(): Promise<Skill[]> {
      // Build skill path list with correct priority:
      //   1. ~/.agents/skills/       — user-installed via pi CLI (wins on collision)
      //   2. Settings skill paths     — any extra path configured by user
      //   3. ~/.pi/agent/skills/     — bundled skills migrated on first launch (fallback)
      //   4. <cwd>/.pi/skills/       — project-level skills
      //
      // We use includeDefaults: false so we control the scan order.
      const skillPaths: string[] = [];

      // 1. User-installed skills — highest priority
      const agentsSkillsDir = join(homedir(), '.agents', 'skills');
      if (existsSync(agentsSkillsDir)) {
        skillPaths.push(agentsSkillsDir);
      }

      // 2. Settings-configured skill paths
      skillPaths.push(...settings.getSkillPaths());

      // 3. Agent skills (includes bundled skills after first-launch migration)
      const agentSkillsDir = join(resolvedAgentDir, 'skills');
      if (existsSync(agentSkillsDir) && !skillPaths.includes(agentSkillsDir)) {
        skillPaths.push(agentSkillsDir);
      }

      // 4. Project skills
      const projectSkillsDir = join(cwd, '.pi', 'skills');
      if (existsSync(projectSkillsDir) && !skillPaths.includes(projectSkillsDir)) {
        skillPaths.push(projectSkillsDir);
      }

      const result = loadSkills({
        cwd,
        agentDir: resolvedAgentDir,
        skillPaths,
        includeDefaults: false,
      });
      return result.skills.map((s: SdkSkill) => ({
        id: `skill-${s.name}`,
        name: s.name,
        description: s.description,
        category: 'custom' as Skill['category'],
        enabled: true,
      }));
    },

    // models.json CRUD

    async getModelsConfig(): Promise<ModelsConfig> {
      // Auto-migrate existing models in case they were configured before this feature
      migrateModelsConfig();
      return readModelsConfig();
    },

    async saveModelsConfig(config: ModelsConfig): Promise<void> {
      // Normalize model inputs for known multimodal models
      for (const provider of Object.values(config.providers)) {
        if (provider.models) {
          provider.models = provider.models.map(normalizeModelInput);
        }
      }
      writeModelsConfig(config);
      configuredProviders = refreshConfiguredProviders(registry);
    },

    async upsertProvider(name: string, provider: ProviderEntry): Promise<void> {
      const current = readModelsConfig();
      // Normalize model inputs for known multimodal models
      if (provider.models) {
        provider.models = provider.models.map(normalizeModelInput);
      }
      current.providers[name] = provider;
      writeModelsConfig(current);
      configuredProviders = refreshConfiguredProviders(registry);
    },

    async deleteProvider(name: string): Promise<void> {
      const current = readModelsConfig();
      delete current.providers[name];
      writeModelsConfig(current);
      configuredProviders = refreshConfiguredProviders(registry);
    },

    async addModel(providerName: string, model: ModelEntry): Promise<void> {
      const current = readModelsConfig();
      const provider = current.providers[providerName];
      if (!provider) throw new Error(`Provider "${providerName}" does not exist`);
      if (provider.models.find((m) => m.id === model.id)) {
        throw new Error(`Model "${model.id}" already exists`);
      }
      provider.models.push(normalizeModelInput(model));
      writeModelsConfig(current);
      configuredProviders = refreshConfiguredProviders(registry);
    },

    async deleteModel(providerName: string, modelId: string): Promise<void> {
      const current = readModelsConfig();
      const provider = current.providers[providerName];
      if (!provider) throw new Error(`Provider "${providerName}" does not exist`);
      provider.models = provider.models.filter((m) => m.id !== modelId);
      writeModelsConfig(current);
      configuredProviders = refreshConfiguredProviders(registry);
    },

    async updateModel(providerName: string, modelId: string, model: Partial<ModelEntry>): Promise<void> {
      const current = readModelsConfig();
      const provider = current.providers[providerName];
      if (!provider) throw new Error(`Provider "${providerName}" does not exist`);
      const idx = provider.models.findIndex((m) => m.id === modelId);
      if (idx === -1) throw new Error(`Model "${modelId}" does not exist`);
      provider.models[idx] = { ...provider.models[idx], ...model, id: modelId };
      writeModelsConfig(current);
      configuredProviders = refreshConfiguredProviders(registry);
    },
  };
}
