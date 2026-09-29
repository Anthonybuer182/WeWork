/**
 * Panel entry for the html viewer — GenOffice's own renderer.
 *
 * Import order is load-bearing: the shim installs `window.htmlApi` in its module
 * body, and GenOffice's renderer reads it at module scope. ES modules evaluate
 * in import order, so the shim must come first.
 */
import './html-shim';

import '../../../vendor/genoffice/apps/html/src/renderer/main';
