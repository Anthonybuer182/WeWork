/**
 * Panel entry for the docx viewer — GenOffice's own renderer.
 *
 * Import order is load-bearing. ES modules are evaluated in the order they are
 * imported, so the shim's module body (which installs `window.desktop`) runs
 * before GenOffice's renderer body, and the renderer reads `window.desktop` at
 * module scope. Swapping these two lines yields a blank panel and a stack of
 * "cannot read property of undefined".
 */
import './desktop-shim';

// GenOffice's docs renderer, vendored verbatim. It is 277 files and ~102k
// lines; none of it is modified. The only substitution is `ai/AiPanel`, which
// the build maps to our own panel (see AiPanel.tsx).
import '../../../vendor/genoffice/apps/docs/src/renderer/main';
