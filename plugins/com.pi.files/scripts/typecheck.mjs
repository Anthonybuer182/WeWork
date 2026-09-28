#!/usr/bin/env node
/**
 * Typecheck the plugin's own source.
 *
 * Plain `tsc --noEmit` cannot serve as a check here: the program includes the
 * ~460k lines of GenOffice under `vendor/`, which this plugin compiles verbatim
 * and does not own. Those files carry a standing pile of type errors, so a bare
 * `tsc` run always exits non-zero and tells you nothing about your change.
 *
 * So: report the errors in `src/`, fail on those, and print the vendor count so
 * it is never mistaken for zero. A vendor error is not actionable from here —
 * fixing one would break the byte-for-byte match that `vendor-genoffice.mjs
 * --check` guards.
 *
 * Usage: node scripts/typecheck.mjs
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/**
 * `typescript` is not a dependency of this plugin; it resolves from the repo
 * root. Walking up finds whichever install is in scope instead of relying on
 * `npx`, which reaches for the network when it finds nothing.
 */
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

const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
const errors = output.split('\n').filter((line) => /error TS\d+/.test(line));
// `tsc` prints paths relative to cwd, so our own files are exactly the ones
// that start with `src/`.
const ours = errors.filter((line) => line.startsWith('src/'));
const vendored = errors.length - ours.length;

if (ours.length > 0) {
  console.error(`✗ ${ours.length} error(s) in src/\n`);
  for (const line of ours) console.error(`  ${line}`);
  console.error(`\n(${vendored} further errors inside vendor/ — compiled as-is, not ours to fix)`);
  process.exit(1);
}

if (run.error) {
  console.error('✗ tsc could not run:', run.error.message);
  process.exit(2);
}

console.log(`✓ src/ clean — ${vendored} error(s) inside vendor/, compiled as-is`);
