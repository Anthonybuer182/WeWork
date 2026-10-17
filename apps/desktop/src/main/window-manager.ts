import { BrowserWindow, screen } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Height of the renderer-drawn title bar; must match TitleBar's h-11 (2.75rem). */
export const TITLE_BAR_HEIGHT = 44;

export function createMainWindow(): BrowserWindow {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const isMac = process.platform === 'darwin';
  const isWindows = process.platform === 'win32';

  const mainWindow = new BrowserWindow({
    width: Math.min(1400, width),
    height: Math.min(900, height),
    minWidth: 900,
    minHeight: 600,
    title: 'Pi Coding Agent',
    show: !process.env.PI_E2E,
    // The renderer draws a full-width title bar. Each platform keeps its native
    // window controls a different way:
    //   macOS   — hiddenInset, traffic lights float over our bar (left inset)
    //   Windows — titleBarOverlay, caption buttons float over our bar (right inset)
    //   Linux   — frameless; the renderer draws its own controls
    ...(isMac
      ? { titleBarStyle: 'hiddenInset' as const }
      : isWindows
        ? {
            titleBarStyle: 'hidden' as const,
            // Colors are provisional; the renderer pushes the resolved theme
            // colors over `pi:window:setTitleBarOverlay` on every theme change.
            titleBarOverlay: {
              color: '#ffffff',
              symbolColor: '#3f3f46',
              height: TITLE_BAR_HEIGHT,
            },
          }
        : { frame: false }),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // In development, load from vite dev server
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  return mainWindow;
}
