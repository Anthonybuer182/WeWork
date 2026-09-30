#!/usr/bin/env node
/**
 * Bundle the panel UI.
 *
 * `publicPath` must match where the manifest's panel `entry` is served from —
 * the host serves a plugin at `pi-plugin://<id>/<entry>`, so root-absolute URLs
 * emitted by the bundler have to be rooted at the same directory, or every
 * chunk and asset 404s.
 *
 * Usage: node scripts/build-panel.mjs
 */
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'ui-dist', 'panel');

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const result = await build({
  entryPoints: [join(ROOT, 'src/ui/panel/main.tsx')],
  outdir: OUT,
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  minify: true,
  metafile: true,
  logLevel: 'warning',
  entryNames: '[name]',
  chunkNames: 'chunks/[name]-[hash]',
  assetNames: 'assets/[name]-[hash]',
  publicPath: '/ui-dist/panel/',
  resolveExtensions: ['.tsx', '.ts', '.js'],
  define: { 'process.env.NODE_ENV': '"production"' },
});

// The HTML lives in src/, not ui-dist/: this script wipes ui-dist/ on every
// build, so a hand-written file in there would last exactly one build.
copyFileSync(join(ROOT, 'src/ui/panel/index.html'), join(OUT, 'index.html'));

// A build stamp. The panel is served over a custom protocol with `no-cache`,
// but the host's WebContentsView survives reloads — this makes a stale bundle
// obvious at a glance instead of looking like "my change did nothing".
writeFileSync(join(OUT, 'build.json'), JSON.stringify({ builtAt: new Date().toISOString() }, null, 2));

const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
console.log(`✓ ui-dist/panel — ${(bytes / 1024).toFixed(0)} KB across ${Object.keys(result.metafile.outputs).length} file(s)`);
