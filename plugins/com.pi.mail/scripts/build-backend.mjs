#!/usr/bin/env node
/**
 * Bundle the plugin backend for Electron's UtilityProcess.
 *
 * `minify: false` and `keepNames: true` are deliberate: the host pipes backend
 * stderr into the app log, and a minified stack trace from a failed handler is
 * worthless.
 *
 * `@pi/plugin-sdk` is bundled in, not loaded at runtime — the host forks this
 * file and nothing else, so anything the backend needs must be inside it.
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
  // CJS deps bundled into an ESM file (imapflow pulls in pino) may still call
  // `require()` dynamically — esbuild's ESM output has no such global. Wire it
  // to a real resolver so those calls keep working at runtime.
  banner: {
    js: "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);",
  },
});

const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
console.log(`✓ dist/main.mjs — ${(bytes / 1024).toFixed(0)} KB`);
