#!/usr/bin/env node
/**
 * Build a local plugin market: one zip per first-party plugin, plus an index.json
 * the app can install from.
 *
 * This is the CDN, stood up on your own disk. The app installs from it through
 * exactly the path it would use for a hosted registry — download, sha256,
 * extract, validate manifest, atomic replace, permission consent — so pointing
 * `_state.json#registry` at the index here is how the whole marketplace gets
 * exercised without a server.
 *
 * What goes in a zip is the plugin's RUNTIME PAYLOAD, not its source tree:
 * manifest, `dist/` (the bundled backend), `ui-dist/` (the bundled panel),
 * `assets/`, `PLUGIN.md`. `src/ tests/ scripts/ vendor/ node_modules/` are build
 * inputs and are excluded — for com.pi.files that is the difference between
 * ~80 MB and ~900 MB.
 *
 * Usage:  node scripts/build-market.mjs [--out <dir>]
 */
import AdmZip from 'adm-zip';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGINS_DIR = join(REPO, 'plugins');

/** Build inputs, never read at runtime. */
const EXCLUDED_DIRS = new Set(['node_modules', 'src', 'tests', 'scripts', 'vendor']);
const EXCLUDED_FILES = /^(\.DS_Store|package-lock\.json|pnpm-lock\.yaml|tsconfig.*\.json|.*\.tsbuildinfo)$/;

const outFlag = process.argv.indexOf('--out');
const OUT = outFlag >= 0 ? resolve(process.argv[outFlag + 1]) : join(REPO, 'market-dist');

/**
 * One fixed timestamp for every zip entry.
 *
 * adm-zip stamps each entry with the moment it was added, so two builds of
 * identical sources produced byte-different zips — and therefore different
 * sha256s. That defeats the digest as a "did anything change?" signal, and
 * makes every rebuild invalidate a published index for no reason.
 *
 * `SOURCE_DATE_EPOCH` is honoured when set, per the reproducible-builds
 * convention; otherwise the zip epoch (1980-01-01) is used.
 */
const epoch = Number(process.env.SOURCE_DATE_EPOCH);
const SOURCE_DATE = new Date(Number.isFinite(epoch) && epoch > 0 ? epoch * 1000 : Date.UTC(1980, 0, 1));

/** Every file that belongs in the zip, as paths relative to the plugin root. */
function collectPayload(root, rel = '') {
  const out = [];
  for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) continue;
    if (entry.isFile() && EXCLUDED_FILES.test(entry.name)) continue;
    const next = rel ? join(rel, entry.name) : entry.name;
    if (entry.isDirectory()) out.push(...collectPayload(root, next));
    else out.push(next);
  }
  return out;
}

const pluginIds = readdirSync(PLUGINS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(PLUGINS_DIR, d.name, 'manifest.json')))
  .map((d) => d.name)
  .sort();

if (pluginIds.length === 0) {
  console.error(`no plugins found under ${PLUGINS_DIR}`);
  process.exit(1);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

console.log(`building market → ${OUT}\n`);

const entries = [];
for (const dir of pluginIds) {
  const root = join(PLUGINS_DIR, dir);
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf-8'));

  if (!manifest.id || !manifest.version) {
    console.error(`  ✗ ${dir}: manifest is missing id or version — skipped`);
    continue;
  }

  const zip = new AdmZip();
  let bytes = 0;
  for (const rel of collectPayload(root)) {
    const content = readFileSync(join(root, rel));
    bytes += content.length;
    // Forward slashes: a zip entry path is not an OS path, and Windows would
    // otherwise write backslashes the extractor cannot map.
    const entry = zip.addFile(rel.split('\\').join('/'), content);
    entry.header.time = SOURCE_DATE;
  }

  const zipName = `${manifest.id}-${manifest.version}.zip`;
  const zipPath = join(OUT, zipName);
  const zipBytes = zip.toBuffer();
  writeFileSync(zipPath, zipBytes);

  const sha256 = createHash('sha256').update(zipBytes).digest('hex');
  entries.push({
    id: manifest.id,
    name: manifest.name,
    description: manifest.description ?? '',
    version: manifest.version,
    url: zipPath,
    sha256,
    size: zipBytes.length,
    permissions: manifest.permissions ?? [],
  });

  const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;
  console.log(`  ${manifest.id.padEnd(18)} v${manifest.version.padEnd(8)} ${mb(zipBytes.length).padStart(9)}  (${zip.getEntries().length} files, ${mb(bytes)} raw)`);
}

const indexPath = join(OUT, 'index.json');
writeFileSync(
  indexPath,
  `${JSON.stringify({ version: 1, updated: new Date().toISOString(), plugins: entries }, null, 2)}\n`,
);

// Point the app at this index, keeping whatever it already knows about which
// plugins are enabled — clobbering that would silently re-enable the ones the
// user turned off.
const stateFile = join(homedir(), '.pi', 'agent', 'plugins', '_state.json');
let state = {};
try {
  state = JSON.parse(readFileSync(stateFile, 'utf-8'));
} catch {
  /* first run: no state file yet */
}
mkdirSync(dirname(stateFile), { recursive: true });
writeFileSync(stateFile, `${JSON.stringify({ ...state, registry: indexPath }, null, 2)}\n`);

const total = entries.reduce((n, e) => n + e.size, 0);
console.log(`\n${entries.length} plugin(s), ${(total / 1024 / 1024).toFixed(1)} MB total`);
console.log(`index:  ${indexPath}`);
console.log(`state:  ${stateFile} → registry`);
console.log(`
next:
  1. make sure nothing is installed from a previous run:
       rm -rf ~/.pi/agent/plugins/com.pi.*
  2. launch WITHOUT the dev plugin root, so the market copy is what loads:
       pnpm --filter @pi/desktop dev
  3. open 插件中心 and install — or, from a dev session, read the catalog first`);
