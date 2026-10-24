import type { Transport } from '../transport/base.js';
import type { ConfigService } from '../services/config.js';
import type {
  ModelsConfig,
  ProviderEntry,
  ProviderModelListResult,
  ModelEntry,
} from '@pi/types';

export function createProxyConfigService(transport: Transport): ConfigService {
  return {
    async get() {
      return transport.request('config.get') as ReturnType<ConfigService['get']>;
    },
    async update(data: any) {
      return transport.request('config.update', { data }) as ReturnType<ConfigService['update']>;
    },
    async listModels() {
      return transport.request('config.listModels') as ReturnType<ConfigService['listModels']>;
    },
    async listSkills() {
      return transport.request('config.listSkills') as ReturnType<ConfigService['listSkills']>;
    },
    async getSkillPaths() {
      return transport.request('config.getSkillPaths') as ReturnType<ConfigService['getSkillPaths']>;
    },
    async setSkillPaths(paths: string[]) {
      return transport.request('config.setSkillPaths', { paths }) as ReturnType<ConfigService['setSkillPaths']>;
    },
    // models.json CRUD
    async getModelsConfig() {
      return transport.request('config.getModelsConfig') as Promise<ModelsConfig>;
    },
    async saveModelsConfig(config: ModelsConfig) {
      return transport.request('config.saveModelsConfig', { config }) as Promise<void>;
    },
    async upsertProvider(name: string, provider: ProviderEntry) {
      return transport.request('config.upsertProvider', { name, provider }) as Promise<void>;
    },
    async listRemoteModels(input: { baseUrl: string; api: string; apiKey: string }) {
      return transport.request('config.listRemoteModels', input) as Promise<ProviderModelListResult>;
    },

    async saveProvider(originalName: string | null, name: string, provider: ProviderEntry) {
      return transport.request('config.saveProvider', {
        originalName,
        name,
        provider,
      }) as Promise<void>;
    },

    async deleteProvider(name: string) {
      return transport.request('config.deleteProvider', { name }) as Promise<void>;
    },
    async addModel(providerName: string, model: ModelEntry) {
      return transport.request('config.addModel', { providerName, model }) as Promise<void>;
    },
    async deleteModel(providerName: string, modelId: string) {
      return transport.request('config.deleteModel', { providerName, modelId }) as Promise<void>;
    },
    async updateModel(providerName: string, modelId: string, model: Partial<ModelEntry>) {
      return transport.request('config.updateModel', { providerName, modelId, model }) as Promise<void>;
    },
  };
}
