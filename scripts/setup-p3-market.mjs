/**
 * P3 market fixture builder — packages the example plugins into a local
 * static registry at /tmp/pi-market and points ~/.pi/agent/plugins.json at it.
 *
 *   node scripts/setup-p3-market.mjs
 */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const AdmZip = require('adm-zip');

const REPO = new URL('..', import.meta.url).pathname;
const MARKET_DIR = '/tmp/pi-market';
const PLUGINS_JSON = join(homedir(), '.pi', 'agent', 'plugins.json');

function packagePlugin(sourceDir, zipName) {
  const zip = new AdmZip();
  zip.addLocalFolder(sourceDir);
  const zipPath = join(MARKET_DIR, zipName);
  zip.writeZip(zipPath);
  const sha256 = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
  return { zipPath, sha256, size: readFileSync(zipPath).length };
}

mkdirSync(MARKET_DIR, { recursive: true });

// ── com.pi.notes: functional installable plugin ──
const notesSrc = join(REPO, 'examples/plugins/market/com.pi.notes');
const notes = packagePlugin(notesSrc, 'com.pi.notes-0.1.0.zip');

// ── com.pi.incompat: engines rejection fixture ──
const incompatSrc = join('/tmp/pi-incompat-src');
cpSync(join(REPO, 'examples/plugins/market/com.pi.incompat'), incompatSrc, { recursive: true });
const incompat = packagePlugin(incompatSrc, 'com.pi.incompat-0.1.0.zip');

// ── static index ──
const index = {
  version: 1,
  updated: new Date().toISOString(),
  plugins: [
    {
      id: 'com.pi.notes',
      name: '便签',
      description: '市场安装验收插件:声明式面板 + storage 能力持久化',
      version: '0.1.0',
      author: 'pi',
      url: notes.zipPath,
      sha256: notes.sha256,
      size: notes.size,
      permissions: ['storage'],
    },
    {
      id: 'com.pi.incompat',
      name: '不兼容示例插件',
      description: 'engines 版本协商验收样例:要求宿主 >=99.0.0,安装应被拒绝',
      version: '0.1.0',
      author: 'pi',
      url: incompat.zipPath,
      sha256: incompat.sha256,
      size: incompat.size,
      permissions: [],
    },
  ],
};
const indexPath = join(MARKET_DIR, 'index.json');
writeFileSync(indexPath, JSON.stringify(index, null, 2));

// ── point plugins.json at the local registry (preserve existing fields) ──
let state = {};
if (existsSync(PLUGINS_JSON)) {
  try { state = JSON.parse(readFileSync(PLUGINS_JSON, 'utf-8')); } catch { state = {}; }
}
state.registry = indexPath;
writeFileSync(PLUGINS_JSON, JSON.stringify(state, null, 2));

console.log('P3 market fixture ready:');
console.log('  index:   ', indexPath);
console.log('  notes zip:', notes.zipPath, `(${notes.size} bytes, sha256 ok)`);
console.log('  registry →', PLUGINS_JSON);
