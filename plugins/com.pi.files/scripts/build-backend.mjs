#!/usr/bin/env node
/**
 * Bundle the plugin backend for Electron's UtilityProcess.
 *
 * The backend used to be a hand-written `dist/main.mjs` with no build step,
 * which meant it could not import the vendored engines at all — they are
 * TypeScript. Now it is bundled like the UI, but against real Node builtins:
 * `node:fs`, `node:zlib` and `node:crypto` are the genuine articles here, which
 * is exactly why the engine's Node-only paths (zip-splice, lazy media, the
 * hashing used for media dedupe) behave correctly on this side.
 *
 * Run from the plugin root:  node scripts/build-backend.mjs
 */
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const VENDOR = join(ROOT, 'vendor', 'genoffice');

/** Resolve @genoffice/<pkg>[/<sub>] against the vendored mirror. */
const genofficeResolver = {
  name: 'genoffice',
  setup(b) {
    b.onResolve({ filter: /^@genoffice\// }, (args) => {
      const m = /^@genoffice\/([a-z0-9-]+)(?:\/(.*))?$/.exec(args.path);
      if (!m) return null;
      const [, pkg, sub] = m;
      return { path: join(VENDOR, 'packages', pkg, 'src', sub ? `${sub}.ts` : 'index.ts') };
    });
  },
};

/**
 * Vite-style `?raw` imports, which genoffice uses to inline its op-reference
 * markdown into the op catalog (pptx-ops/src/op-docs.ts). Without this the
 * backend fails to bundle at all.
 */
const rawText = {
  name: 'raw-text',
  setup(b) {
    b.onResolve({ filter: /\?raw$/ }, (args) => ({
      path: resolve(args.resolveDir, args.path.replace(/\?raw$/, '')),
      namespace: 'raw-text',
    }));
    b.onLoad({ filter: /.*/, namespace: 'raw-text' }, (args) => ({
      contents: readFileSync(args.path, 'utf-8'),
      loader: 'text',
    }));
  },
};

const result = await build({
  entryPoints: [join(ROOT, 'src/backend/index.ts')],
  outfile: join(ROOT, 'dist/main.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  absWorkingDir: ROOT,
  // Not minified on purpose: the host pipes the backend's stderr into the app
  // log, and a minified stack trace there is worthless.
  minify: false,
  keepNames: true,
  metafile: true,
  // Left external so esbuild never tries to resolve jsdom's optional native
  // requires. They are absent, not loaded at runtime by this entry.
  external: ['electron', 'canvas', 'bufferutil', 'utf-8-validate'],
  plugins: [genofficeResolver, rawText],
  logLevel: 'warning',
});

const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
console.log(`bundled → dist/main.mjs (${(bytes / 1024).toFixed(0)} KB)`);
