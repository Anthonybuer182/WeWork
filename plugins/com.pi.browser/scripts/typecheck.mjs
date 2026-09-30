#!/usr/bin/env node
/**
 * Typecheck the plugin's own source.
 *
 * `typescript` is not a dependency of this plugin — it resolves from the repo
 * root. Walking up finds whichever install is in scope instead of relying on
 * `npx`, which reaches for the network when it finds nothing.
 *
 * Usage: node scripts/typecheck.mjs
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

function findTsc() {
  for (let dir = ROOT; ; dir = dirname(dir)) {
    const bin = join(dir, 'node_modules', 'typescript', 'bin', 'tsc');
    if (existsSync(bin)) return bin;
    // dirname('/') is '/', so this is the top.
    if (dirname(dir) === dir) return null;
  }
}

const tsc = findTsc();
if (!tsc) {
  console.error('✗ no typescript found in any node_modules above ' + ROOT);
  process.exit(2);
}

const run = spawnSync(process.execPath, [tsc, '--noEmit'], {
  cwd: ROOT,
  encoding: 'utf-8',
  maxBuffer: 64 * 1024 * 1024,
});

const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim();
if (run.error) {
  console.error('✗ tsc could not run:', run.error.message);
  process.exit(2);
}
if (output) {
  console.error(output);
  process.exit(1);
}
console.log('✓ src/ clean');
