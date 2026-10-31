import { Menu } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import type { WindowRegistry } from './windows';

/**
 * macOS app menu. Spelled out instead of `role: 'appMenu'` so dev builds show
 * the product name rather than the package name — and, more importantly, so
 * we never call `app.setName()`, which would move the userData directory.
 */
const APP_MENU: MenuItemConstructorOptions = {
  label: 'Pi Coding Agent',
  submenu: [
    { role: 'about' },
    { type: 'separator' },
    { role: 'hide' },
    { role: 'hideOthers' },
    { role: 'unhide' },
    { type: 'separator' },
    { role: 'quit' },
  ],
};

/**
 * The application menu.
 *
 * Electron ships a default menu when none is set; replacing it means the
 * standard roles (Edit copy/paste, View reload, Window) have to be spelled
 * out again, otherwise macOS loses its text-editing accelerators the moment
 * we add a File menu of our own.
 */
export function installApplicationMenu(windows: WindowRegistry): void {
  const isMac = process.platform === 'darwin';

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? ([APP_MENU] satisfies MenuItemConstructorOptions[]) : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Window',
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            windows.newFromFocused();
          },
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'GitHub',
          click: () => {
            void import('electron').then(({ shell }) =>
              shell.openExternal('https://github.com/Anthonybuer182/WeWork'),
            );
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
