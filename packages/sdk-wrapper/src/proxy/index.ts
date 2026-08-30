import type { Transport } from '../transport/base.js';
import type { PiSDKClient } from '../client.js';
import { createSDKClient } from '../client.js';
import { createProxyWorkspaceService } from './workspace.js';
import { createProxySessionService } from './session.js';
import { createProxyChatService } from './chat.js';
import { createProxyFileService } from './file.js';
import { createProxyConfigService } from './config.js';
export interface ProxySDKClientOptions {
  transport: Transport;
}

/**
 * Create a PiSDKClient where all service calls are proxied through the transport.
 * This is used by renderers (web and Electron) - no Node.js imports needed.
 */
export function createProxySDKClient(options: ProxySDKClientOptions): PiSDKClient {
  const { transport } = options;

  return createSDKClient({
    transport,
    workspace: createProxyWorkspaceService(transport),
    session: createProxySessionService(transport),
    chat: createProxyChatService(transport),
    file: createProxyFileService(transport),
    config: createProxyConfigService(transport),
  });
}
