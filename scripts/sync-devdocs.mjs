#!/usr/bin/env node
/**
 * Sync the repo's plugin docs into the com.pi.devdocs panel, and vendor
 * marked from the pnpm store.
 *
 * docs/ is the single source of truth — the copies under
 * plugins/com.pi.devdocs/ui/ are build output, regenerated here.
 *
 * Run after editing docs/plugin-dev-guide.md, then bump the plugin's
 * manifest version and rebuild the market (see the plugin's PLUGIN.md).
 */
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_ROOT = join(REPO, 'plugins/com.pi.devdocs');

/** docs → ui/docs. Add a line here when a doc is added to the catalogue. */
const DOCS = [['docs/plugin-dev-guide.md', 'ui/docs/plugin-dev-guide.md']];

mkdirSync(join(PLUGIN_ROOT, 'ui/docs'), { recursive: true });
for (const [src, dest] of DOCS) {
  copyFileSync(join(REPO, src), join(PLUGIN_ROOT, dest));
  console.log(`synced ${src} → plugins/com.pi.devdocs/${dest}`);
}

// marked → ui/lib. The store holds several versions via transitive deps; the
// UMD build is what a plain <script src> can use, highest version wins.
const store = join(REPO, 'node_modules/.pnpm');
const candidates = readdirSync(store).filter((d) => /^marked@\d/.test(d));
if (candidates.length === 0) {
  console.error('no marked found under node_modules/.pnpm — cannot vendor');
  process.exit(1);
}
const ver = (d) => (d.match(/^marked@([\d.]+)/) ?? [])[1].split('.').map(Number);
candidates.sort((a, b) => {
  const x = ver(a);
  const y = ver(b);
  for (let i = 0; i < 3; i++) {
    if ((y[i] ?? 0) !== (x[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
  }
  return 0;
});
const umd = join(store, candidates[0], 'node_modules/marked/lib/marked.umd.js');
mkdirSync(join(PLUGIN_ROOT, 'ui/lib'), { recursive: true });
copyFileSync(umd, join(PLUGIN_ROOT, 'ui/lib/marked.umd.js'));
console.log(`vendored ${candidates[0]} → plugins/com.pi.devdocs/ui/lib/marked.umd.js`);
