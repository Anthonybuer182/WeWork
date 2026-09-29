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
 *
 * The rejection message is written for the user, not for a log. sheets' agent
 * loop reports a run before it calls the transport, and its `onError` puts the
 * error text in the STATUS BAR — so this sentence is the last thing a sheets
 * submission shows there, right after the instruction has already been
 * forwarded to the host. It says where the answer actually is.
 */
export function createElectronTransport(): {
  send: () => Promise<never>;
  cancel: () => Promise<void>;
  dispose: () => void;
} {
  const unavailable = () =>
    Promise.reject(new Error('由宿主 AI 处理中，回复见主对话'));
  return {
    send: unavailable as never,
    cancel: async () => undefined,
    dispose: () => undefined,
  };
}

export type AgentTransport = ReturnType<typeof createElectronTransport>;
