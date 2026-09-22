#!/usr/bin/env node
/**
 * Launch the desktop app with THIS repo's `plugins/` as a dev plugin root.
 *
 * Why this script exists: the plugin registry resolves roots by priority
 * (dev 3 > user 2 > builtin 1), and `~/.pi/agent/plugins/` always shadows
 * everything below it. The repo's top-level `plugins/` directory is not a
 * builtin root either — `getBuiltinRoot()` resolves to `apps/desktop/plugins`.
 * So without `PI_DEV_PLUGINS`, edits to `plugins/<id>/` are never loaded and
 * the app silently runs whatever stale copy sits in `~/.pi/agent/plugins/`.
 * That has repeatedly looked like "my change had no effect".
 *
 * Usage:  node scripts/dev-plugin.mjs [extra args for electron-vite]
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const DEV_ROOT = join(REPO, 'plugins');

process.env.PI_DEV_PLUGINS = DEV_ROOT;

// ── Make it visually unambiguous which root is live ────────────────────
console.log(`[dev-plugin] PI_DEV_PLUGINS = ${DEV_ROOT}`);

try {
  const userRoot = join(homedir(), '.pi', 'agent', 'plugins');
  const devIds = readdirSync(DEV_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(DEV_ROOT, d.name, 'manifest.json')))
    .map((d) => d.name);
  const userIds = existsSync(userRoot)
    ? readdirSync(userRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(join(userRoot, d.name, 'manifest.json')))
        .map((d) => d.name)
    : [];
  const shadowed = devIds.filter((id) => userIds.includes(id));
  console.log(`[dev-plugin] dev plugins   : ${devIds.join(', ') || '(none)'}`);
  if (shadowed.length) {
    console.log(`[dev-plugin] shadowing ${shadowed.length} user copy/copies: ${shadowed.join(', ')}`);
  }
} catch (err) {
  console.warn('[dev-plugin] could not enumerate plugin roots:', err.message);
}

// ── Launch ─────────────────────────────────────────────────────────────
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const child = spawn(pnpm, ['--filter', '@pi/desktop', 'dev', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
  cwd: REPO,
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
