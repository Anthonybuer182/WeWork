/**
 * Panel entry for the spreadsheet viewer — GenOffice's own renderer.
 *
 * Import order is load-bearing: the shim installs `window.desktopApi` in its
 * module body, and GenOffice's renderer reads it at module scope.
 */
import './sheets-shim';

import '../../../vendor/genoffice/apps/sheets/src/renderer/main';
