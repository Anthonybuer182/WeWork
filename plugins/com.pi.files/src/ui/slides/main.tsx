/**
 * Panel entry for the slides (pptx) viewer — GenOffice's own renderer.
 *
 * Import order is load-bearing: the shim installs `window.slidesApi` in its
 * module body, and GenOffice's renderer reads it at module scope. ES modules
 * evaluate in import order, so the shim must come first.
 */
import './slides-shim';

import '../../../vendor/genoffice/apps/slides/src/renderer/main';
