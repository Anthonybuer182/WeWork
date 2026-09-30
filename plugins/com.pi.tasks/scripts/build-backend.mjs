#!/usr/bin/env node
/**
 * Bundle the plugin backend for Electron's UtilityProcess.
 *
 * `minify: false` and `keepNames: true` are deliberate: the host pipes backend
 * stderr into the app log, and a minified stack trace from a failed tick is
 * worthless.
 *
 * Usage: node scripts/build-backend.mjs
 */
import { build } from 'esbuild';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const result = await build({
  entryPoints: [join(ROOT, 'src/backend/index.ts')],
  outfile: join(ROOT, 'dist/main.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  absWorkingDir: ROOT,
  minify: false,
  keepNames: true,
  metafile: true,
  logLevel: 'warning',
});

const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
console.log(`✓ dist/main.mjs — ${(bytes / 1024).toFixed(0)} KB`);
