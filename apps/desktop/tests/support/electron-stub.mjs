/**
 * The slice of `electron` the main-process modules touch at import time.
 *
 * Importing the real package from plain Node fails (it is a CJS shim that
 * expects Electron's runtime), and a unit test never registers IPC anyway, so
 * the channels are inert.
 */

export const ipcMain = {
  handle() {},
  removeHandler() {},
  on() {},
  once() {},
  removeAllListeners() {},
};

export default { ipcMain };
