import type { Config, ModelInfo, ModelsConfig, ProviderEntry, ModelEntry, Skill } from '@pi/types';

export interface ConfigService {
  get(): Promise<Config>;
  update(data: Partial<Config>): Promise<Config>;
  listModels(): Promise<ModelInfo[]>;
  /** List available skills discovered from disk by the SDK */
  listSkills(): Promise<Skill[]>;
  /** Extra skill search directories (settings.skills), scanned before defaults */
  getSkillPaths(): Promise<string[]>;
  setSkillPaths(paths: string[]): Promise<void>;
  /** Read full models.json configuration */
  getModelsConfig(): Promise<ModelsConfig>;
  /** Write full models.json configuration */
  saveModelsConfig(config: ModelsConfig): Promise<void>;
  /** Add or update provider */
  upsertProvider(name: string, provider: ProviderEntry): Promise<void>;
  /** Delete provider */
  deleteProvider(name: string): Promise<void>;
  /** Add model for specified provider */
  addModel(providerName: string, model: ModelEntry): Promise<void>;
  /** Delete model for specified provider */
  deleteModel(providerName: string, modelId: string): Promise<void>;
  /** Update model for specified provider */
  updateModel(providerName: string, modelId: string, model: Partial<ModelEntry>): Promise<void>;
}
