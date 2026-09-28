/**
 * Stand-in for GenOffice's `ai/transport`.
 *
 * Each app's `ai/transport.ts` builds the IPC channel to GenOffice's own agent
 * (`createIpcTransport` against their preload bridge). The plugin runs the host
 * agent instead, so there is no channel to build — but the apps import this
 * from App.tsx, not from AiPanel, so replacing AiPanel alone is not enough for
 * sheets.
 *
 * `createElectronTransport` therefore returns a transport that is reachable but
 * inert. Nothing routes through it: our AiPanel talks to `chat.send`.
 */
export function createElectronTransport(): {
  send: () => Promise<never>;
  cancel: () => Promise<void>;
  dispose: () => void;
} {
  const unavailable = () => Promise.reject(new Error('AI 由宿主的 agent 处理，见 AiPanel'));
  return {
    send: unavailable as never,
    cancel: async () => undefined,
    dispose: () => undefined,
  };
}

export type AgentTransport = ReturnType<typeof createElectronTransport>;
