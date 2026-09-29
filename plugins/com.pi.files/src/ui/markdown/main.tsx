/**
 * Panel entry for the markdown viewer — GenOffice's own renderer.
 *
 * Import order is load-bearing: the shim installs `window.markdownApi` in its
 * module body, and GenOffice's renderer reads it at module scope. ES modules
 * evaluate in import order, so the shim must come first.
 */
import './markdown-shim';

import '../../../vendor/genoffice/apps/markdown/src/renderer/main';
