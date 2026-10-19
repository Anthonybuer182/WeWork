#!/usr/bin/env node
/**
 * Publish the repo's plugins to the local market, and optionally install them
 * into the user plugin root — the "customer path" that `pnpm dev:desktop`
 * loads.
 *
 * Why this exists: the repo checkout and ~/.pi/agent/plugins are two separate
 * roots. During development the app can run either one (dev root wins when
 * PI_DEV_PLUGINS is set), but there is no direct repo → user-root sync. The
 * supported route is the market: build the plugin, package it with a sha256,
 * then install it through the same verify/extract/atomic-replace path the
 * plugin center uses.
 *
 * Steps:
 *   1. build every selected plugin that has a `build` script (backends and,
 *      for com.pi.files / com.pi.tasks, the panel bundle)
 *   2. rebuild market-dist (zips + index.json) with stamped versions by
 *      default, so the plugin center shows 更新 and keeps `.previous` for
 *      rollback
 *   3. with --install, install the fresh zips into ~/.pi/agent/plugins
 *
 * Usage:
 *   node scripts/publish-plugins.mjs [--only id[,id]] [--no-build]
 *                                    [--no-stamp] [--stamp-label <label>]
 *                                    [--install] [--out <dir>]
 *
 * Examples:
 *   pnpm plugins:publish --only com.pi.browser          # build + market
 *   pnpm plugins:publish --only com.pi.browser --install
 *   pnpm plugins:publish --no-stamp                     # same-version 重装
 */
import AdmZip from 'adm-zip';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGINS_DIR = join(REPO, 'plugins');

// ── args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: node scripts/publish-plugins.mjs [options]

  --only <id[,id]>      build/publish only these plugins (other market entries kept)
  --no-build            skip the plugin build step
  --no-stamp            keep the manifest version (plugin center shows 重装)
  --stamp-label <s>     label for the -dev.<label> suffix
  --install             install the freshly built zips into ~/.pi/agent/plugins
  --out <dir>           market output directory (default: market-dist). A custom
                        dir does not repoint the app's live registry
  -h, --help            this text`);
  process.exit(0);
}
function flagValue(name) {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const value = args[i + 1];
  if (!value || value.startsWith('--')) {
    console.error(`${name} needs a value`);
    process.exit(1);
  }
  return value;
}
const ONLY = (flagValue('--only') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const NO_BUILD = args.includes('--no-build');
const NO_STAMP = args.includes('--no-stamp');
const INSTALL = args.includes('--install');
const DEFAULT_OUT = join(REPO, 'market-dist');
const OUT_FLAG = flagValue('--out');
const OUT = resolve(OUT_FLAG ?? DEFAULT_OUT);
const STAMP_LABEL = flagValue('--stamp-label');

// ── discover ────────────────────────────────────────────────────────────
let plugins = readdirSync(PLUGINS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(PLUGINS_DIR, d.name, 'manifest.json')))
  .map((d) => d.name)
  .sort();

if (ONLY.length > 0) {
  const missing = ONLY.filter((id) => !plugins.includes(id));
  if (missing.length > 0) {
    console.error(`unknown plugin id(s): ${missing.join(', ')}`);
    console.error(`available: ${plugins.join(', ')}`);
    process.exit(1);
  }
  plugins = plugins.filter((id) => ONLY.includes(id));
}

// ── 1. build ────────────────────────────────────────────────────────────
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
if (!NO_BUILD) {
  for (const id of plugins) {
    const root = join(PLUGINS_DIR, id);
    const pkgFile = join(root, 'package.json');
    if (!existsSync(pkgFile)) {
      console.log(`[publish] ${id}: no build step (static plugin)`);
      continue;
    }
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf-8'));
    if (!pkg.scripts?.build) {
      console.log(`[publish] ${id}: no build script`);
      continue;
    }
    console.log(`[publish] ${id}: ${pkg.scripts.build}`);
    const r = spawnSync(npm, ['run', 'build'], { cwd: root, stdio: 'inherit', env: process.env });
    if (r.error) {
      console.error(`[publish] ${id}: build failed to start: ${r.error.message}`);
      process.exit(1);
    }
    if (r.status !== 0) {
      console.error(`[publish] ${id}: build exited with ${r.status}`);
      process.exit(1);
    }
  }
}

// ── 2. market ───────────────────────────────────────────────────────────
const marketArgs = [join(REPO, 'scripts', 'build-market.mjs'), '--out', OUT];
if (ONLY.length > 0) marketArgs.push('--only', plugins.join(','));
if (!NO_STAMP) marketArgs.push('--stamp');
if (STAMP_LABEL) marketArgs.push('--stamp-label', STAMP_LABEL);
// A custom output dir is for isolated/test markets. Repointing the live
// `_state.json#registry` at it would silently break the running app's
// install/update source.
if (OUT !== DEFAULT_OUT) marketArgs.push('--skip-state');
{
  const r = spawnSync(process.execPath, marketArgs, { stdio: 'inherit', env: process.env });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// ── 3. install into the user plugin root ────────────────────────────────
if (!INSTALL) {
  console.log('\nmarket ready. Install/update through the plugin center, or re-run with --install.');
  process.exit(0);
}

const agentDir = process.env.PI_AGENT_DIR ?? join(homedir(), '.pi', 'agent');
const pluginsRoot = join(agentDir, 'plugins');
const stagingRoot = join(pluginsRoot, '.staging');
const previousRoot = join(pluginsRoot, '.previous');
const indexPath = join(OUT, 'index.json');
const index = JSON.parse(readFileSync(indexPath, 'utf-8'));
const wanted = index.plugins.filter((e) => ONLY.length === 0 || ONLY.includes(e.id));

if (wanted.length === 0) {
  console.error(`[publish] index has no entries for ${ONLY.join(', ')}`);
  process.exit(1);
}

function findPluginRoot(extractDir) {
  if (existsSync(join(extractDir, 'manifest.json'))) return extractDir;
  const dirs = readdirSync(extractDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  if (dirs.length === 1 && existsSync(join(extractDir, dirs[0].name, 'manifest.json'))) {
    return join(extractDir, dirs[0].name);
  }
  return null;
}

function readVersion(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8')).version ?? null;
  } catch {
    return null;
  }
}

let installed = 0;
for (const entry of wanted) {
  const zipPath = isAbsolute(entry.url) ? entry.url : join(dirname(indexPath), entry.url);
  if (!existsSync(zipPath)) throw new Error(`zip missing for ${entry.id}: ${zipPath}`);
  const zipBytes = readFileSync(zipPath);
  const sha = createHash('sha256').update(zipBytes).digest('hex');
  if (!entry.sha256 || sha !== entry.sha256.toLowerCase()) {
    throw new Error(`integrity check failed for ${entry.id}`);
  }

  const extractDir = join(stagingRoot, `${entry.id}-${entry.version}`);
  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });
  new AdmZip(zipBytes).extractAllTo(extractDir, true);

  const root = findPluginRoot(extractDir);
  if (!root) throw new Error(`zip for ${entry.id} contains no manifest.json`);
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf-8'));
  if (manifest.id !== entry.id) throw new Error(`manifest id "${manifest.id}" ≠ "${entry.id}"`);
  if (manifest.version !== entry.version) {
    throw new Error(`manifest version "${manifest.version}" ≠ catalog "${entry.version}"`);
  }
  if (manifest.backend && !existsSync(join(root, manifest.backend))) {
    throw new Error(`backend "${manifest.backend}" missing from ${entry.id} package`);
  }

  const target = join(pluginsRoot, entry.id);
  mkdirSync(pluginsRoot, { recursive: true });
  if (existsSync(target)) {
    const outgoing = readVersion(target);
    if (outgoing && outgoing !== entry.version) {
      const previous = join(previousRoot, entry.id);
      mkdirSync(dirname(previous), { recursive: true });
      rmSync(previous, { recursive: true, force: true });
      renameSync(target, previous);
      console.log(`[publish] ${entry.id}: kept v${outgoing} as .previous`);
    } else {
      const scrap = join(stagingRoot, `${entry.id}-replaced-${Date.now()}`);
      renameSync(target, scrap);
      rmSync(scrap, { recursive: true, force: true });
    }
  }
  renameSync(root, target);
  if (root !== extractDir) rmSync(extractDir, { recursive: true, force: true });
  console.log(`[publish] installed ${entry.id}@${entry.version}`);
  installed++;
}

console.log(`\n[publish] ${installed} plugin(s) installed into ${pluginsRoot}`);
console.log('[publish] restart the running app (or launch it) to load the new copies.');
