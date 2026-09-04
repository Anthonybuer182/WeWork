/**
 * P5 market fixture builder — packages ALL official plugins into the local
 * static registry at /tmp/pi-market (the "official catalog" simulation).
 *
 *   node scripts/setup-p5-market.mjs
 */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const AdmZip = require('adm-zip');

const REPO = new URL('..', import.meta.url).pathname;
const MARKET_DIR = '/tmp/pi-market';
const PLUGINS_JSON = join(homedir(), '.pi', 'agent', 'plugins.json');

/** Official catalog: id → source dir (all under plugins/). */
const OFFICIAL = [
  { id: 'com.pi.todo', dir: 'com.pi.todo' },
  { id: 'com.pi.mail', dir: 'com.pi.mail' },
  { id: 'com.pi.calendar', dir: 'com.pi.calendar' },
  { id: 'com.pi.knowledge', dir: 'com.pi.knowledge' },
  { id: 'com.pi.erp-demo', dir: 'com.pi.erp-demo' },
  { id: 'com.pi.preview', dir: 'com.pi.preview' },
  { id: 'com.pi.browser', dir: 'com.pi.browser' },
  { id: 'com.pi.hello', dir: 'com.pi.hello' },
];

function packagePlugin(sourceDir) {
  const manifest = JSON.parse(readFileSync(join(sourceDir, 'manifest.json'), 'utf-8'));
  const zip = new AdmZip();
  zip.addLocalFolder(sourceDir);
  const zipPath = join(MARKET_DIR, `${manifest.id}-${manifest.version}.zip`);
  zip.writeZip(zipPath);
  const sha256 = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
  return {
    entry: {
      id: manifest.id,
      name: manifest.name,
      description: manifest.description ?? '',
      version: manifest.version,
      author: 'pi-official',
      url: zipPath,
      sha256,
      size: readFileSync(zipPath).length,
      permissions: manifest.permissions ?? [],
    },
  };
}

const entries = [];
for (const { dir } of OFFICIAL) {
  const sourceDir = join(REPO, 'plugins', dir);
  if (!existsSync(join(sourceDir, 'manifest.json'))) {
    console.warn(`skip (no manifest): ${dir}`);
    continue;
  }
  const { entry } = packagePlugin(sourceDir);
  entries.push(entry);
}

// Keep the P3 fixtures (notes install test + engines rejection).
const notesZip = join(MARKET_DIR, 'com.pi.notes-0.1.0.zip');
if (existsSync(notesZip)) {
  const sha256 = createHash('sha256').update(readFileSync(notesZip)).digest('hex');
  entries.push({
    id: 'com.pi.notes',
    name: '便签',
    description: '市场安装验收插件:声明式面板 + storage 能力持久化',
    version: '0.1.0',
    author: 'pi',
    url: notesZip,
    sha256,
    size: readFileSync(notesZip).length,
    permissions: ['storage'],
  });
}
const incompatZip = join(MARKET_DIR, 'com.pi.incompat-0.1.0.zip');
if (existsSync(incompatZip)) {
  entries.push({
    id: 'com.pi.incompat',
    name: '不兼容示例插件',
    description: 'engines 版本协商验收样例:要求宿主 >=99.0.0,安装应被拒绝',
    version: '0.1.0',
    author: 'pi',
    url: incompatZip,
    sha256: createHash('sha256').update(readFileSync(incompatZip)).digest('hex'),
    size: readFileSync(incompatZip).length,
    permissions: [],
  });
}

const index = { version: 1, updated: new Date().toISOString(), plugins: entries };
const indexPath = join(MARKET_DIR, 'index.json');
writeFileSync(indexPath, JSON.stringify(index, null, 2));

// Point plugins.json at the local registry (preserve existing fields).
let state = {};
if (existsSync(PLUGINS_JSON)) {
  try { state = JSON.parse(readFileSync(PLUGINS_JSON, 'utf-8')); } catch { state = {}; }
}
state.registry = indexPath;
writeFileSync(PLUGINS_JSON, JSON.stringify(state, null, 2));

console.log(`P5 market fixture ready — ${entries.length} catalog entries:`);
for (const e of entries) console.log(`  ${e.id}@${e.version} (${Math.round(e.size / 1024)}KB)`);
console.log(`  registry → ${indexPath}`);
