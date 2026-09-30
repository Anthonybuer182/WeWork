#!/usr/bin/env node
/**
 * Run the core tests headlessly — no Electron, no app.
 *
 * The scheduler's logic is deliberately kept in pure functions under `src/core`
 * taking an explicit `now`, so the interesting cases (a laptop asleep for eight
 * hours, a rule that repeats forever, a firing that must not happen twice) can
 * be driven on a fake clock instead of by waiting. Waiting is how these bugs get
 * missed: every one of them is silent in the running app.
 *
 * Each test is bundled with esbuild (they import TypeScript) and run in its own
 * process — a test file naturally ends in `process.exit`, which would otherwise
 * take the whole run down with it and silently skip everything after it.
 *
 * Usage:  node scripts/run-tests.mjs [name-substring ...]
 */
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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
    logLevel: 'warning',
  });

  console.log(`\n━━━ ${name} ${'━'.repeat(Math.max(0, 50 - name.length))}`);
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
