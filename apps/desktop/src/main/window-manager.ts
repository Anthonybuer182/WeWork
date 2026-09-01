import { BrowserWindow, screen, Menu } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createMainWindow(): BrowserWindow {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  const mainWindow = new BrowserWindow({
    width: Math.min(1400, width),
    height: Math.min(900, height),
    minWidth: 900,
    minHeight: 600,
    title: 'Pi Coding Agent',
    show: !process.env.PI_E2E,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Native context menu for host-rendered DOM (chat, panels, composer).
  mainWindow.webContents.on('context-menu', (_event, params) => {
    const template: Electron.MenuItemConstructorOptions[] = [];
    if (params.isEditable) {
      template.push({ label: '剪切', role: 'cut', enabled: params.editFlags.canCut });
      template.push({ label: '复制', role: 'copy', enabled: params.editFlags.canCopy });
      template.push({ label: '粘贴', role: 'paste', enabled: params.editFlags.canPaste });
      template.push({ type: 'separator' });
      template.push({ label: '全选', role: 'selectAll', enabled: params.editFlags.canSelectAll });
    } else if (params.selectionText) {
      template.push({ label: '复制', role: 'copy' });
    } else {
      template.push({ label: '重新加载', click: () => mainWindow.webContents.reload() });
    }
    Menu.buildFromTemplate(template).popup({ window: mainWindow, x: params.x, y: params.y });
  });

  // In development, load from vite dev server
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  return mainWindow;
}
