#!/usr/bin/env node
/**
 * Run the engine tests headlessly — no Electron, no app.
 *
 * The vendored engines are TypeScript source with extensionless relative
 * imports, so Node cannot load them directly even with type stripping. esbuild
 * bundles each test (resolving @genoffice/* into vendor/genoffice/) and the
 * result is imported and run.
 *
 * This is the cheapest real coverage in the project: it exercises the same
 * engine code the plugin ships, against the same vendored copy, in a couple of
 * seconds. See the plan's verification section.
 *
 * Usage:  node scripts/run-tests.mjs [test-name ...]
 *         (no args = every tests/*.ts)
 */
import { build } from 'esbuild';
import { readdirSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(ROOT, 'vendor', 'genoffice');
const OUT = join(ROOT, 'tests', '.build');

const only = process.argv.slice(2);
const names = readdirSync(join(ROOT, 'tests'))
  .filter((f) => f.endsWith('.ts'))
  .filter((f) => only.length === 0 || only.some((o) => f.includes(o)));

if (names.length === 0) {
  console.error(`no tests matched ${JSON.stringify(only)}`);
  process.exit(2);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

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
 * markdown into the op catalog (pptx-ops/src/op-docs.ts). esbuild has no idea
 * what they are, so they are resolved to the underlying file and loaded as
 * text. genoffice's own packages/cli/build.mjs carries the same plugin.
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

let failed = 0;
for (const name of names) {
  const outfile = join(OUT, name.replace(/\.ts$/, '.mjs'));
  await build({
    entryPoints: [join(ROOT, 'tests', name)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    // Keep real node builtins — this is the Node target, no shims (decision 4).
    external: ['electron', 'canvas'],
    plugins: [genofficeResolver, rawText],
    logLevel: 'warning',
  });

  console.log(`\n━━━ ${name} ${'━'.repeat(Math.max(0, 50 - name.length))}`);
  try {
    await import(pathToFileURL(outfile).href);
  } catch (err) {
    failed++;
    console.error(`  ✗ threw: ${err?.stack ?? err}`);
  }
}

if (failed) {
  console.error(`\n${failed} test file(s) failed`);
  process.exit(1);
}
