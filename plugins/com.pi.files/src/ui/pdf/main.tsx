/**
 * Panel entry for the pdf viewer — GenOffice's own renderer.
 *
 * Import order is load-bearing: the shim installs `window.pdfApi` in its module
 * body, and GenOffice's renderer reads it at module scope. ES modules evaluate
 * in import order, so the shim must come first.
 */
import './pdf-shim';

import '../../../vendor/genoffice/apps/pdf/src/renderer/main';
