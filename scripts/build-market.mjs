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
 * Usage:  node scripts/build-market.mjs [--out <dir>] [--only <id[,id]>]
 *                                       [--stamp] [--stamp-label <label>]
 *                                       [--skip-state]
 *
 *   --only         build only the listed plugin ids. Existing entries for the
 *                  other plugins are kept from the current index (incremental
 *                  publish), so one plugin's build does not stamp or re-zip
 *                  the rest.
 *   --stamp        rewrite the packaged manifest's version to
 *                  `<version>-dev.<label>` and use it in the index too. The
 *                  plugin center compares version strings, so a stamped build
 *                  shows as 更新 (instead of 重装) and keeps `.previous` for
 *                  rollback. The repo manifest is never modified.
 *   --stamp-label  label for --stamp (default: local YYYYMMDDHHmmss)
 */
import AdmZip from 'adm-zip';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
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
 * Packaging flow (apps/desktop pack:*) runs this with --skip-state: it wants
 * the market files on disk but must not repoint the build machine's
 * _state.json#registry at them as a side effect.
 */
const SKIP_STATE = process.argv.includes('--skip-state');

const onlyFlag = process.argv.indexOf('--only');
const ONLY = onlyFlag >= 0
  ? (process.argv[onlyFlag + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  : null;
if (onlyFlag >= 0 && (!ONLY || ONLY.length === 0)) {
  console.error('--only needs a comma-separated list of plugin ids');
  process.exit(1);
}

const STAMP = process.argv.includes('--stamp');
const stampLabelFlag = process.argv.indexOf('--stamp-label');
function defaultStampLabel() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
const STAMP_LABEL = stampLabelFlag >= 0 ? process.argv[stampLabelFlag + 1] : defaultStampLabel();
if (stampLabelFlag >= 0 && !STAMP_LABEL) {
  console.error('--stamp-label needs a value');
  process.exit(1);
}

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

let pluginIds = readdirSync(PLUGINS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(PLUGINS_DIR, d.name, 'manifest.json')))
  .map((d) => d.name)
  .sort();

if (ONLY) {
  const missing = ONLY.filter((id) => !pluginIds.includes(id));
  if (missing.length > 0) {
    console.error(`unknown plugin id(s): ${missing.join(', ')}`);
    console.error(`available: ${pluginIds.join(', ')}`);
    process.exit(1);
  }
  pluginIds = pluginIds.filter((id) => ONLY.includes(id));
}

if (pluginIds.length === 0) {
  console.error(`no plugins found under ${PLUGINS_DIR}`);
  process.exit(1);
}

const indexPath = join(OUT, 'index.json');

// Incremental publish: with --only, keep the other plugins' published entries
// and zips untouched. A full build starts from an empty output directory.
let previousEntries = [];
if (ONLY) {
  try {
    const previous = JSON.parse(readFileSync(indexPath, 'utf-8'));
    previousEntries = Array.isArray(previous.plugins) ? previous.plugins : [];
  } catch {
    /* first run: no previous index */
  }
  if (previousEntries.length === 0) {
    console.warn('note: no existing index — the catalog will contain only the selected plugin(s)');
  }
} else {
  rmSync(OUT, { recursive: true, force: true });
}
mkdirSync(OUT, { recursive: true });

console.log(`building market → ${OUT}${ONLY ? ` (only: ${ONLY.join(', ')})` : ''}\n`);

const entries = [];
for (const dir of pluginIds) {
  const root = join(PLUGINS_DIR, dir);
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf-8'));

  if (!manifest.id || !manifest.version) {
    console.error(`  ✗ ${dir}: manifest is missing id or version — skipped`);
    continue;
  }

  // A manifest entry is a promise about the zip's contents. `ui-dist/` is
  // gitignored build output, so a clean checkout that skips the plugin build
  // would otherwise produce a zip with no panel — discovered only at load
  // time on a user machine. Fail here, where the cause is one command away.
  const declared = [manifest.backend, manifest.icon]
    .concat((manifest.contributes?.panels ?? []).map((p) => p.entry))
    .filter(Boolean);
  const missing = declared.filter((rel) => !existsSync(join(root, rel)));
  if (missing.length > 0) {
    console.error(`  ✗ ${dir}: manifest references missing build outputs:`);
    for (const rel of missing) console.error(`      ${rel}`);
    console.error(`      build the plugin first (npm run build inside plugins/${dir})`);
    process.exit(1);
  }

  const zip = new AdmZip();
  let bytes = 0;
  // A stamped build rewrites the packaged manifest only. The repo manifest
  // stays clean; the market (and therefore the installed copy) carries the
  // dev version, which is what makes the plugin center show 更新 + rollback.
  const packagedVersion = STAMP ? `${manifest.version}-dev.${STAMP_LABEL}` : manifest.version;
  for (const rel of collectPayload(root)) {
    if (STAMP && rel === 'manifest.json') continue; // re-added below, stamped
    const content = readFileSync(join(root, rel));
    bytes += content.length;
    // Forward slashes: a zip entry path is not an OS path, and Windows would
    // otherwise write backslashes the extractor cannot map.
    const entry = zip.addFile(rel.split('\\').join('/'), content);
    entry.header.time = SOURCE_DATE;
  }
  if (STAMP) {
    const packaged = { ...manifest, version: packagedVersion };
    const content = Buffer.from(`${JSON.stringify(packaged, null, 2)}\n`, 'utf-8');
    bytes += content.length;
    const entry = zip.addFile('manifest.json', content);
    entry.header.time = SOURCE_DATE;
  }

  const zipName = `${manifest.id}-${packagedVersion}.zip`;
  const zipPath = join(OUT, zipName);
  const zipBytes = zip.toBuffer();
  writeFileSync(zipPath, zipBytes);
  // Version changed: drop this plugin's older zips so the market directory
  // does not accumulate dead artifacts across dev publishes.
  for (const f of readdirSync(OUT)) {
    if (f.startsWith(`${manifest.id}-`) && f.endsWith('.zip') && f !== zipName) {
      rmSync(join(OUT, f), { force: true });
    }
  }

  const sha256 = createHash('sha256').update(zipBytes).digest('hex');
  entries.push({
    id: manifest.id,
    name: manifest.name,
    description: manifest.description ?? '',
    version: packagedVersion,
    apiVersion: manifest.apiVersion,
    // Relative to the index. An absolute build-machine path would be baked
    // into the index and then dangle inside a packaged app installed
    // somewhere else; the marketplace resolves relative entries against the
    // index URL, so a relocated (bundled or hosted) market keeps working.
    url: zipName,
    sha256,
    size: zipBytes.length,
    permissions: manifest.permissions ?? [],
  });

  const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;
  const versionNote = STAMP ? ` v${packagedVersion.padEnd(8)} (from ${manifest.version})` : ` v${manifest.version.padEnd(8)}      `;
  console.log(`  ${manifest.id.padEnd(18)}${versionNote} ${mb(zipBytes.length).padStart(9)}  (${zip.getEntries().length} files, ${mb(bytes)} raw)`);
}

// Incremental publish keeps the other plugins' existing entries. Refuse to
// write an index that points at zips we would have deleted.
let mergedEntries = entries;
if (ONLY) {
  const selected = new Set(ONLY);
  // Older indexes may carry absolute zip paths; normalize them to paths
  // relative to this index so a relocated market keeps working.
  const kept = previousEntries
    .filter((e) => !selected.has(e.id))
    .map((e) => (isAbsolute(e.url) && dirname(e.url) === OUT ? { ...e, url: basename(e.url) } : e));
  const missingZips = kept.filter((e) => {
    const zipPath = isAbsolute(e.url) ? e.url : join(OUT, e.url);
    return !existsSync(zipPath);
  });
  if (missingZips.length > 0) {
    console.error('✗ the previous index references zips that are not present:');
    for (const e of missingZips) console.error(`    ${e.id} → ${e.url}`);
    console.error('  run a full market build (pnpm setup:market) to regenerate it');
    process.exit(1);
  }
  mergedEntries = [...kept, ...entries].sort((a, b) => a.id.localeCompare(b.id));
}

writeFileSync(
  indexPath,
  `${JSON.stringify({ version: 1, updated: new Date().toISOString(), plugins: mergedEntries }, null, 2)}\n`,
);

// Point the app at this index, keeping whatever it already knows about which
// plugins are enabled — clobbering that would silently re-enable the ones the
// user turned off.
const stateFile = join(homedir(), '.pi', 'agent', 'plugins', '_state.json');
if (SKIP_STATE) {
  console.log('skipping _state.json update (--skip-state)');
} else {
  let state = {};
  try {
    state = JSON.parse(readFileSync(stateFile, 'utf-8'));
  } catch {
    /* first run: no state file yet */
  }
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, `${JSON.stringify({ ...state, registry: indexPath }, null, 2)}\n`);
}

const total = mergedEntries.reduce((n, e) => n + e.size, 0);
console.log(`\n${mergedEntries.length} plugin(s) in the index, ${(total / 1024 / 1024).toFixed(1)} MB total`);
console.log(`index:  ${indexPath}`);
if (!SKIP_STATE) console.log(`state:  ${stateFile} → registry`);
console.log(`
next:
  1. customer-path app (loads ~/.pi/agent/plugins):
       pnpm dev:desktop
  2. open 插件中心 and install/update — or install headlessly:
       pnpm plugins:publish --install
  3. plugin authoring (repo plugins, live edits):
       pnpm dev:desktop:plugins`);
