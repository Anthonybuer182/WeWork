import { ipcMain, dialog, app } from 'electron';
import { ModelRegistry, AuthStorage, SettingsManager } from '@earendil-works/pi-coding-agent';
import {
  createRealWorkspaceService,
  createRealSessionService,
  createRealFileService,
  createRealConfigService,
  createRealChatService,
} from '@pi/sdk-wrapper/adapters';
import type { WorkspaceService, SessionService, FileService, ConfigService, ChatService, SendMessageParams } from '@pi/sdk-wrapper';

// Services are created during registerIpcHandlers() (called from app.whenReady)
// to avoid module-load-time initialization in packaged builds.
let workspaceService: WorkspaceService;
let sessionService: SessionService;
let fileService: FileService;
let configService: ConfigService;
let chatService: ChatService;

interface SdkRequest {
  id: string;
  method: string;
  params: unknown;
}

export interface RegisterIpcHandlersOptions {
  /** Supplies plugin-contributed agent tools (customTools for the SDK). */
  customToolsProvider?: () => unknown[];
}

export function registerIpcHandlers(
  settingsManager: SettingsManager,
  modelRegistry?: ModelRegistry,
  options?: RegisterIpcHandlersOptions,
): { chatService: ChatService } {
  // Shared ModelRegistry so config writes refresh chat's visible model list.
  // If an external registry is provided, use it (allows sharing with VLM analyzer).
  const sharedModelRegistry = modelRegistry ?? ModelRegistry.create(AuthStorage.inMemory());

  // app.getPath('home') is stable across platforms and never points inside
  // the app bundle (unlike process.cwd() in packaged builds).
  const defaultCwd = app.getPath('home');

  workspaceService = createRealWorkspaceService();
  sessionService = createRealSessionService();
  fileService = createRealFileService();
  configService = createRealConfigService(defaultCwd, undefined, sharedModelRegistry, settingsManager);
  chatService = createRealChatService(defaultCwd, sharedModelRegistry, settingsManager, {
    customToolsProvider: options?.customToolsProvider,
  });

  // ── Standard request/response ──
  ipcMain.handle('pi:sdk:request', async (_event, request: SdkRequest) => {
    const { id, method, params } = request;
    try {
      const result = await routeRequest(method, params);
      return { id, result };
    } catch (error) {
      return {
        id,
        error: {
          code: -1,
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  });

  // ── Streaming request ──
  ipcMain.handle('pi:sdk:stream', async (event, { method, params, streamId }) => {
    const [service, action] = (method as string).split('.');
    if (service !== 'chat' || action !== 'sendMessageStream') {
      event.sender.send('pi:stream:chunk:' + streamId, {
        type: 'error',
        error: `Unsupported streaming method: ${method}`,
      });
      return;
    }

    const p = params as unknown as SendMessageParams;

    try {
      await chatService.sendMessageStream(
        p,
        (chunk) => {
          event.sender.send('pi:stream:chunk:' + streamId, chunk);
        },
      );
      event.sender.send('pi:stream:chunk:' + streamId, { type: 'done' });
    } catch (err) {
      event.sender.send('pi:stream:chunk:' + streamId, {
        type: 'error',
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  });

  // ── Stream abort (for AbortSignal-based cancellation from renderer) ──
  ipcMain.handle('pi:sdk:stream:abort', async (_event, { streamId }) => {
    await chatService.stopGeneration(streamId);
  });

  return { chatService };
}

async function routeRequest(method: string, params: unknown): Promise<unknown> {
  const [service, action] = method.split('.');
  if (!service || !action) {
    throw new Error(`Invalid method format: ${method}`);
  }

  switch (service) {
    case 'workspace': return handleWorkspace(action, params);
    case 'session': return handleSession(action, params);
    case 'chat': return handleChat(action, params);
    case 'file': return handleFile(action, params);
    case 'config': return handleConfig(action, params);
    case 'system': return handleSystem(action);
    default:
      throw new Error(`Unknown service: ${service}`);
  }
}

async function handleWorkspace(action: string, params: unknown): Promise<unknown> {
  const p = params as Record<string, unknown>;
  switch (action) {
    case 'list': return workspaceService.list();
    case 'get': return workspaceService.get(p.id as string);
    case 'create': return workspaceService.create(p.name as string, p.path as string);
    case 'delete': return workspaceService.delete(p.id as string);
    case 'update': return workspaceService.update(p.id as string, p.data as Record<string, unknown>);
    default: throw new Error(`Unknown workspace action: ${action}`);
  }
}

async function handleSession(action: string, params: unknown): Promise<unknown> {
  const p = params as Record<string, unknown>;
  switch (action) {
    case 'list': return sessionService.list(p.workspaceId as string);
    case 'get': return sessionService.get(p.id as string);
    case 'create': return sessionService.create(p.workspaceId as string, p.title as string | undefined);
    case 'delete': return sessionService.delete(p.id as string);
    case 'updateTitle': return sessionService.updateTitle(p.id as string, p.title as string);
    case 'getTree': return sessionService.getTree(p.id as string);
    default: throw new Error(`Unknown session action: ${action}`);
  }
}

async function handleChat(action: string, params: unknown): Promise<unknown> {
  const p = params as Record<string, unknown>;
  switch (action) {
    case 'sendMessage':
      return chatService.sendMessage(p as unknown as SendMessageParams);
    case 'getMessages':
      return chatService.getMessages(p.sessionId as string, p.limit as number | undefined, p.offset as number | undefined);
    case 'stopGeneration':
      return chatService.stopGeneration(p.sessionId as string);
    case 'steer':
      return chatService.steer(p.sessionId as string, p.content as string, p.images as any);
    case 'followUp':
      return chatService.followUp(p.sessionId as string, p.content as string, p.images as any);
    case 'navigateTree':
      return chatService.navigateTree(p.sessionId as string, p.entryId as string, p.options as any);
    case 'compact':
      return chatService.compact(p.sessionId as string, p.customInstructions as string | undefined);
    default: throw new Error(`Unknown chat action: ${action}`);
  }
}

async function handleFile(action: string, params: unknown): Promise<unknown> {
  const p = params as Record<string, unknown>;
  switch (action) {
    case 'read': return fileService.read(p.workspaceId as string, p.path as string);
    case 'list': return fileService.list(p.workspaceId as string, (p.directory ?? p.dirPath) as string | undefined);
    case 'write': return fileService.write(p.workspaceId as string, p.path as string, p.content as string);
    case 'readOffice': return fileService.readOffice(p.workspaceId as string, p.path as string);
    default: throw new Error(`Unknown file action: ${action}`);
  }
}

async function handleConfig(action: string, params: unknown): Promise<unknown> {
  const p = params as Record<string, unknown>;
  switch (action) {
    case 'get': return configService.get();
    case 'update': return configService.update(p.data as any);
    case 'listModels': return configService.listModels();
    case 'listSkills': return configService.listSkills();
    case 'getModelsConfig': return configService.getModelsConfig();
    case 'saveModelsConfig': return configService.saveModelsConfig(p.config as any);
    case 'upsertProvider': return configService.upsertProvider(p.name as string, p.provider as any);
    case 'deleteProvider': return configService.deleteProvider(p.name as string);
    case 'addModel': return configService.addModel(p.providerName as string, p.model as any);
    case 'deleteModel': return configService.deleteModel(p.providerName as string, p.modelId as string);
    case 'updateModel': return configService.updateModel(p.providerName as string, p.modelId as string, p.model as any);
    default: throw new Error(`Unknown config action: ${action}`);
  }
}

async function handleSystem(action: string): Promise<unknown> {
  switch (action) {
    case 'selectDirectory': {
      const result = await dialog.showOpenDialog({
        title: 'Select workspace folder',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (result.canceled || result.filePaths.length === 0) {
        return null;
      }
      return result.filePaths[0];
    }
    default: throw new Error(`Unknown system action: ${action}`);
  }
}
