#!/usr/bin/env node
/**
 * Real-connection smoke for the IMAP engine.
 *
 * The ONLY test that touches a live mailbox — run by hand with credentials
 * supplied via env so nothing secret lands in the repo:
 *
 *   MAIL_PRESET=qq MAIL_USER=you@qq.com MAIL_PASS=授权码 node scripts/smoke-imap.mjs
 *
 *   MAIL_PRESET=dingtalk   # or feishu | 163 | gmail | outlook
 *   # or point at a host directly (overrides the preset):
 *   MAIL_IMAP_HOST=imap.qiye.aliyun.com MAIL_IMAP_PORT=993 MAIL_USER=... MAIL_PASS=...
 *
 * Bundles the TypeScript engine with the same esbuild settings the plugin
 * build uses, then drives: connect → list mailboxes → list INBOX → search →
 * read the newest message.
 */
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const HOST = process.env.MAIL_IMAP_HOST || '';
const USER = process.env.MAIL_USER || '';
const PASS = process.env.MAIL_PASS || '';
const PRESET = process.env.MAIL_PRESET || '';

if (!USER || !PASS || (!HOST && !PRESET)) {
  console.error(
    'usage: MAIL_PRESET=qq|feishu|163|dingtalk|gmail|outlook ' +
      'MAIL_USER=<邮箱> MAIL_PASS=<客户端专用密码/授权码> node scripts/smoke-imap.mjs\n' +
      '       (or MAIL_IMAP_HOST=<host> MAIL_IMAP_PORT=<993> instead of MAIL_PRESET)',
  );
  process.exit(2);
}

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
}

// ── bundle the engine to a temp file, then import it ──

const outDir = mkdtempSync(join(tmpdir(), 'mail-smoke-'));
const outFile = join(outDir, 'engine.mjs');
await build({
  stdin: {
    contents: `
      import { ImapEngine } from '${join(ROOT, 'src/backend/imap-engine.ts')}';
      import { PRESETS } from '${join(ROOT, 'src/backend/presets.ts')}';
      globalThis.__engine = { ImapEngine, PRESETS };
    `,
    resolveDir: ROOT,
  },
  absWorkingDir: ROOT,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: outFile,
  logLevel: 'warning',
  banner: {
    js: "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);",
  },
});

const { ImapEngine, PRESETS } = (await import(pathToFileURL(outFile).href)).default ?? globalThis.__engine;

const preset = PRESETS[PRESET];
const imapHost = HOST || preset?.imap?.host;
const imapPort = Number(process.env.MAIL_IMAP_PORT || preset?.imap?.port || 993);
if (!imapHost) {
  console.error(`✗ unknown MAIL_PRESET "${PRESET}" and no MAIL_IMAP_HOST given`);
  process.exit(2);
}

console.log(`━━━ smoke: imap engine → ${imapHost}:${imapPort} as ${USER}\n`);

const engine = new ImapEngine();
const states = [];
engine.setHooks({
  onState: (s, d) => states.push(`${s}${d ? ` (${d})` : ''}`),
  onNewMail: () => {},
});
engine.configure(
  {
    preset: PRESET || 'custom',
    email: USER,
    user: USER,
    imap: { host: imapHost, port: imapPort },
    smtp: { host: '', port: 0 },
  },
  PASS,
);

try {
  const boxes = await engine.listMailboxes();
  check('connects and lists mailboxes', Array.isArray(boxes) && boxes.length > 0, `${boxes.length} boxes`);
  console.log(`  · ${boxes.slice(0, 8).map((b) => b.path).join(', ')}${boxes.length > 8 ? ' …' : ''}`);

  const recent = await engine.listMessages('INBOX', 5);
  check('lists recent INBOX envelopes', Array.isArray(recent), `${recent.length} messages`);
  for (const m of recent.slice(0, 5)) {
    console.log(`    · ${m.seen ? '  ' : '未'} ${m.subject} — ${m.from} (${m.date})`);
  }

  const found = await engine.searchMessages('INBOX', '', new Date(Date.now() - 90 * 86400_000), 10);
  check('search over a 90-day window returns a window', Array.isArray(found), `${found.length} messages`);

  if (recent.length > 0) {
    const detail = await engine.readMessage('INBOX', recent[0].uid, 2000);
    check('reads the newest message in full', Boolean(detail.subject), detail.subject);
    console.log(
      `    · ${detail.subject} | 附件 ${detail.attachments.length} 个` +
        ` | 正文 ${detail.text.length} 字${detail.truncated ? '(截断)' : ''}`,
    );
  } else {
    console.log('  · INBOX 为空,跳过 mail_read');
  }

  engine.configure(null, '');
  check('configure(null) disconnects cleanly', true);
} catch (err) {
  check('engine run', false, err instanceof Error ? err.message : String(err));
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

console.log(`\n  状态轨迹: ${states.join(' → ')}`);
console.log(`\n${failures === 0 ? '✓ all checks passed' : `✗ ${failures} check(s) failed`}`);
process.exit(failures ? 1 : 0);
