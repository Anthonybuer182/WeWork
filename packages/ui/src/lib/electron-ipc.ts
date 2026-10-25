/**
 * The renderer's Electron bridge, with the one boot-race guard every store
 * needs.
 *
 * Main wires its IPC handlers asynchronously (the plugin kernel boots first),
 * while the renderer mounts in milliseconds. A store's first `invoke` can land
 * before its handler exists and rejects with "No handler registered"; retrying
 * briefly turns that into a slightly late answer instead of an empty card.
 */

export interface ElectronBridge {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on: (channel: string, cb: (...args: unknown[]) => void) => void;
}

export function electronApi(): ElectronBridge | undefined {
  return (window as unknown as { electronAPI?: ElectronBridge }).electronAPI;
}

/** Invoke with a few short backoffs; rethrows the last error when all fail. */
export async function invokeWhenReady(
  api: ElectronBridge,
  channel: string,
  arg?: unknown,
  attempts = 5,
): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await api.invoke(channel, arg);
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
    }
  }
  throw lastError;
}
