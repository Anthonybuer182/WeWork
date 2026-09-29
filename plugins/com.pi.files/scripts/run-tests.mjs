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
import { spawnSync } from 'node:child_process';
import { readdirSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

  // Each test runs in its OWN process, for one reason: a test file naturally
  // ends with `process.exit(failures ? 1 : 0)`, and importing it into this
  // process lets that exit take the whole run down with it. It did — the first
  // file alphabetically called an unconditional exit, so every test after it
  // was silently skipped while the runner still reported success. Spawning
  // contains the exit and makes its code the result.
  const result = spawnSync(process.execPath, [outfile], { stdio: 'inherit' });
  if (result.status !== 0) {
    failed++;
    if (result.error) console.error(`  ✗ could not run: ${result.error.message}`);
    else if (result.signal) console.error(`  ✗ killed by ${result.signal}`);
    else console.error(`  ✗ exited ${result.status}`);
  }
}

if (failed) {
  console.error(`\n${failed} test file(s) failed`);
  process.exit(1);
}
