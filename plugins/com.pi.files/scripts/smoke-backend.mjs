#!/usr/bin/env node
/**
 * Drive the built plugin backend in plain Node — no Electron.
 *
 * The backend's transport is `process.parentPort`, so the whole tool surface
 * can be exercised by handing `main()` a stand-in port. That makes this the
 * cheapest real coverage in the project: it runs the same `dist/main.mjs` the
 * app ships, against the same vendored engines, in about a second.
 *
 * It catches a failure mode that is otherwise invisible — a tool registered in
 * the backend but missing from the manifest (or vice versa) looks fine from
 * both sides and simply never runs — and it pins the two behaviours an agent
 * depends on: rejected ops come back as DATA (the host drops `details` on a
 * throw), and a dry run writes nothing.
 *
 * Run from the plugin root:  node scripts/smoke-backend.mjs
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND = join(ROOT, 'dist', 'main.mjs');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

// ── A stand-in for Electron's UtilityProcess parentPort ────────────────
//
// The two directions are separate channels and must not be conflated:
// `postMessage` is backend → host, and the `'message'` event is host →
// backend. Replying to a capability call therefore has to happen from inside
// `postMessage` — a `'message'` listener would never see the backend's own
// outgoing calls, and every capability round-trip would hang.
const outbox = [];
const listeners = [];
/** What the backend asked the host for, so a test can assert the write path. */
const capabilityCalls = [];
const written = new Map();

function replyToCall(msg) {
  capabilityCalls.push(msg);
  const params = msg.params ?? {};
  let result = { ok: true };
  if (msg.method === 'filesystem.write') {
    written.set(params.path, Buffer.from(String(params.contentB64 ?? ''), 'base64'));
    result = { path: params.path, mtime: Date.now() };
  }
  setTimeout(() => hostSend({ type: 'call-result', id: msg.id, result }), 0);
}

const fakePort = {
  postMessage: (m) => {
    outbox.push(m);
    if (m && m.type === 'call') replyToCall(m);
  },
  on: (event, cb) => {
    if (event === 'message') listeners.push(cb);
  },
};
const hostSend = (msg) => {
  for (const cb of listeners) cb({ data: msg });
};

/** Wait for an outbound message matching `pred`, or time out. */
function waitFor(pred, what, timeoutMs = 20_000) {
  const started = Date.now();
  return new Promise((resolve_, reject) => {
    const tick = () => {
      const i = outbox.findIndex((m) => pred(m) && m.type !== 'call');
      if (i >= 0) return resolve_(outbox.splice(i, 1)[0]);
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(`timed out waiting for ${what}\n  saw: ${JSON.stringify(outbox.map((m) => m.type))}`));
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

console.log('backend smoke\n');

const backend = await import(pathToFileURL(BACKEND).href);
backend.main(fakePort);
await waitFor((m) => m.type === 'ready', 'the ready handshake');

async function callTool(name, params) {
  const id = `t${Math.random().toString(36).slice(2, 8)}`;
  hostSend({ type: 'tool-call', id, name, params });
  return waitFor((m) => m.type === 'tool-result' && m.id === id, `tool ${name}`);
}

// ── fixture ─────────────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'pi-files-smoke-'));
const deckPath = join(dir, 'smoke.pptx');
const original = Buffer.from(await backend.createBlankPptx());
writeFileSync(deckPath, original);
console.log(`  fixture: ${deckPath} (${original.length} bytes)\n`);

// ── office_guide: the vocabulary is served as data, not as tools ───────
{
  const r = await callTool('office_guide', { domain: 'pptx' });
  const t = r.content?.[0]?.text ?? '';
  check('office_guide returns a vocabulary', t.length > 200, `only ${t.length} chars`);
  check('the vocabulary names real ops', /addBlankSlide|setFill/.test(t), t.slice(0, 160));
  check('details carry the op count', typeof r.details?.count === 'number' && r.details.count > 20, JSON.stringify(r.details));
  check('details list the groups', Array.isArray(r.details?.groups) && r.details.groups.length > 0);
}
{
  const r = await callTool('office_guide', { domain: 'pptx', group: 'text' });
  check('office_guide returns one group', (r.content?.[0]?.text ?? '').length > 100);
  const bad = await callTool('office_guide', { domain: 'pptx', group: 'not-a-group' });
  check(
    'an unknown group lists the real ones instead of failing',
    /Available:/.test(bad.content?.[0]?.text ?? ''),
    bad.content?.[0]?.text?.slice(0, 120),
  );
}

// ── unwired domains/extensions answer plainly ──────────────────────────
{
  const r = await callTool('office_guide', { domain: 'docx' });
  check('an unwired domain says so', /not wired yet/.test(r.content?.[0]?.text ?? ''), r.content?.[0]?.text?.slice(0, 100));
  const r2 = await callTool('office_read', { path: join(dir, 'nope.docx') });
  check('an unwired extension says so', /not wired yet/.test(r2.content?.[0]?.text ?? ''));
}

// ── office_read ────────────────────────────────────────────────────────
{
  const r = await callTool('office_read', { path: deckPath });
  check('office_read reads a real deck', /slide\(s\)/.test(r.content?.[0]?.text ?? ''), r.content?.[0]?.text);
  check('office_read reports the slide count', r.details?.slideCount === 1, JSON.stringify(r.details?.slideCount));
}

// ── dryRun validates without writing ───────────────────────────────────
{
  const r = await callTool('office_edit', {
    path: deckPath,
    dryRun: true,
    ops: [{ op: 'addBlankSlide', target: { slide: 0 } }],
  });
  check('dry run validates', r.details?.dryRun === true && r.details?.applied === false, JSON.stringify(r.details));
  check('dry run wrote nothing', written.size === 0, `wrote ${[...written.keys()].join(', ')}`);
}

// ── a rejected op comes back as data, not as a throw ───────────────────
{
  const bad = await callTool('office_edit', {
    path: deckPath,
    ops: [{ op: 'addBlankSlide', target: { slide: 99 } }],
  });
  check('a rejected op does not throw', !bad.error, `threw: ${bad.error}`);
  check('a rejected op returns applied:false', bad.details?.applied === false);
  check(
    'a rejected op returns typed failures',
    Array.isArray(bad.details?.failures) && bad.details.failures.length > 0,
    JSON.stringify(bad.details?.failures),
  );
  check(
    'the failure text is actionable',
    /out of range/i.test(bad.details?.failures?.[0]?.error ?? ''),
    bad.details?.failures?.[0]?.error,
  );
  check('a rejected op wrote nothing', written.size === 0);
}

// ── the real edit ──────────────────────────────────────────────────────
{
  const ok = await callTool('office_edit', {
    path: deckPath,
    ops: [{ op: 'addBlankSlide', target: { slide: 0 } }],
  });
  check('a valid batch applies', ok.details?.applied === true, ok.content?.[0]?.text);
  check('the write went through the host capability', written.has(deckPath), `${capabilityCalls.length} capability call(s)`);
  check(
    'the write carries expectedMtime so external changes are detected',
    capabilityCalls.some((c) => c.method === 'filesystem.write' && typeof c.params?.expectedMtime === 'number'),
  );

  const saved = written.get(deckPath);
  check('the saved bytes differ from the original', saved && !saved.equals(original));

  // Re-read through the tool, so the assertion goes through the same parse path.
  writeFileSync(deckPath, saved);
  const reread = await callTool('office_read', { path: deckPath });
  check('the edit survives a re-read', reread.details?.slideCount === 2, `slideCount=${reread.details?.slideCount}`);
}

// ── the file on disk is what the engine wrote ──────────────────────────
{
  const onDisk = await readFile(deckPath);
  check('the file on disk matches what was handed to the host', onDisk.equals(written.get(deckPath)));
}

rmSync(dir, { recursive: true, force: true });

console.log('');
if (failures) {
  console.error(`FAILED — ${failures} assertion(s)`);
  process.exit(1);
}
console.log('all assertions passed');
