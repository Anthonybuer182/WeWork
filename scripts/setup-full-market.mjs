/**
 * Build a local market fixture with ALL first-party plugins,
 * then install them through the real market flow into ~/.pi/agent/plugins/.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';

const REPO = new URL('..', import.meta.url).pathname;
const MARKET_DIR = '/tmp/pi-full-market';
const PLUGINS = readdirSync(join(REPO, 'plugins'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'market' && d.name !== 'templates')
  .map((d) => d.name);

console.log('Plugins:', PLUGINS.join(', '));

mkdirSync(MARKET_DIR, { recursive: true });

// Build each plugin into a zip
const entries = [];
for (const name of PLUGINS) {
  const srcDir = join(REPO, 'plugins', name);
  const manifest = JSON.parse(readFileSync(join(srcDir, 'manifest.json'), 'utf-8'));
  const zipName = `${name}-${manifest.version}.zip`;
  const zipPath = join(MARKET_DIR, zipName);

  // Use ditto (macOS) for zip
  execSync(`cd "${srcDir}" && zip -qr "${zipPath}" . -x ".DS_Store" -x "node_modules/*" -x "package-lock.json"`);

  const sha256 = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
  const size = statSync(zipPath).size;
  entries.push({
    id: manifest.id,
    name: manifest.name,
    description: manifest.description ?? '',
    version: manifest.version,
    author: manifest.author ?? 'pi',
    url: zipPath,
    sha256,
    size,
    permissions: manifest.permissions ?? [],
  });
  console.log(`  ${name} v${manifest.version} → ${zipName} (${(size / 1024).toFixed(0)}KB)`);
}

// Write index
const index = { plugins: entries };
writeFileSync(join(MARKET_DIR, 'index.json'), JSON.stringify(index, null, 2));
console.log(`\nMarket index: ${MARKET_DIR}/index.json (${entries.length} plugins)`);

// Point plugins.json at this registry + CLEAR devPaths
const stateFile = join(homedir(), '.pi/agent/plugins/_state.json');
const state = {
  registry: join(MARKET_DIR, 'index.json'),
  devPaths: [],  // 清空 — 走 market 安装
  plugins: {},
};
mkdirSync(join(homedir(), '.pi/agent/plugins'), { recursive: true }); writeFileSync(stateFile, JSON.stringify(state, null, 2));
console.log('_state.json: devPaths cleared');
