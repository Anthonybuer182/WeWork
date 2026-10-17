/**
 * com.pi.files backend — office engine host + file viewer controller.
 *
 * Two jobs:
 *
 *  1. **Panel controller** — the viewer panel fetches file bytes itself over
 *     `pi-plugin://com.pi.files/ws-file?path=…`; the backend only pushes the
 *     current path on `panel.mounted({file})` and handles the write-back.
 *
 *  2. **The agent's office engine** — the whole point of this plugin: read,
 *     edit, check and create real Office files through the vendored GenOffice
 *     engines, exposed as `contributes.tools`. This is what replaces the
 *     officecli skill + binary that the desktop app used to install.
 *
 * Bytes are read with `node:fs` rather than the `filesystem.read` capability,
 * because that capability deliberately refuses docx/xlsx/pptx (it is a generic
 * text-read tool for other plugins). Writes go back through `filesystem.write`
 * so the host's mtime-conflict check still applies.
 *
 * The one thing this plugin has that no other does is a second, plugin-private
 * channel: docx editing drives a live editor in the panel through GenOffice's
 * own agent bridge, and those commands travel over the plugin's own panel port.
 * It is still plugin-internal — it never reaches the host — it just goes through
 * `ctx.send` like everything else now.
 */
import { plugin, type PluginContext, type ToolResult } from '@pi/plugin-sdk';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve as resolvePath } from 'node:path';
import { createBlankPptx, openPptx, savePptx } from '@genoffice/pptx-engine';
import { applyXlsxEdits, planXlsxEdits, readXlsxStructure, type CellOp } from './xlsx';
import { DOCX_OP_GROUPS, docxGuide, planDocxCommands, type DocxOp } from './docx';
import {
  OP_GROUPS,
  opGuide,
  opNames,
  opSignatureIndex,
  opVocabulary,
  runTxn,
  type Op,
} from '@genoffice/pptx-ops';

/**
 * The SDK's context, kept at module scope.
 *
 * One backend process serves exactly one plugin, so there is one context — and
 * the engine helpers, the viewer controller and the docx bridge all need it.
 */
let ctx: PluginContext;

const MAX_READ_BYTES = 200 * 1024 * 1024;

/** Whether two paths name the same file, forgiving `.` `..` and a trailing slash. */
function samePath(a: string, b: string): boolean {
  try {
    return resolvePath(a) === resolvePath(b);
  } catch {
    return a === b;
  }
}

/** The one panel this plugin draws into. */
const PANEL = 'viewer';

/** Push a render to the viewer. Returns false when no panel is connected. */
const renderViewer = (data: unknown): boolean => ctx.send(PANEL, 'ui.render', data);

// ── Document buckets (per-conversation viewer state) ─────────────────
//
// The viewer used to hold ONE module-global "current file", which made two
// concurrent conversations fight over a single slot — session A's openFile
// yanked session B's document off screen. Buckets key the tab strip by
// conversation: each session (or 'default' when none) owns its own open
// documents and its own focus. The panel shows the bucket of the conversation
// it currently serves (`panelSession`); a tool call resolves its bucket from
// `call.sessionId`, so an agent edits ITS conversation's document even while
// another conversation is on screen.

/** How many conversations keep their document tabs — mirrors the host's SESSIONS_KEPT. */
const MAX_BUCKETS = 8;

interface DocBucket {
  /** Open documents, in strip order. */
  tabs: string[];
  /** Which tab has focus ('' = nothing open). */
  activePath: string;
}

const buckets = new Map<string, DocBucket>();
/** The conversation the viewer panel currently serves (null = none heard yet). */
let panelSession: string | null = null;

function bucketKey(sessionId?: string | null, panelId?: string | null): string {
  const s = sessionId ?? panelSession ?? 'default';
  return panelId === PANE_PANEL ? `${s}::pane` : s;
}

function bucketFor(key: string): DocBucket {
  let b = buckets.get(key);
  if (!b) {
    b = { tabs: [], activePath: '' };
    buckets.set(key, b);
  }
  return b;
}

/** Drop the coldest buckets past the cap, never the current or default one. */
function pruneBuckets(): void {
  if (buckets.size <= MAX_BUCKETS + 1) return;
  const current = bucketKey();
  for (const key of buckets.keys()) {
    if (buckets.size <= MAX_BUCKETS + 1) break;
    if (key === current || key === 'default') continue;
    buckets.delete(key);
  }
}

/** Push a bucket to the panel. `path` stays for the renderers, tabs drive the strip. */
function renderBucket(b: DocBucket, panelId: string = PANEL): boolean {
  return ctx.send(
    panelId,
    'ui.render',
    b.activePath ? { path: b.activePath, tabs: b.tabs, activePath: b.activePath } : { tabs: [], activePath: '' },
  );
}

/** The pane panel — a second, independent viewer beside the session's main one. */
const PANE_PANEL = 'viewer-pane';

/** Whether the pane is actually connected right now, probed over its port —
 *  stateless, so a host-side restore after a restart is seen correctly (a
 *  cached flag went stale exactly there). 'ui.ping' is ignored by the page. */
function paneIsOpen(): boolean {
  try {
    return ctx.send(PANE_PANEL, 'ui.ping', {}) === true;
  } catch {
    return false;
  }
}

/**
 * The bucket a UI request addresses. The main viewer serves the session's
 * bucket; the pane panel has its OWN bucket beside it, so the split view's
 * two sides keep independent documents.
 */
function uiBucketKey(panelId?: string | null): string {
  return panelId === PANE_PANEL ? `${bucketKey()}::pane` : bucketKey();
}

/** Open (or focus) a document tab in the bucket named by `key`. */
function openFileInBucket(key: string, path: string, renderTo?: string): void {
  const p = String(path ?? '');
  const b = bucketFor(key);
  if (p) {
    const existing = b.tabs.findIndex((t) => samePath(t, p));
    if (existing >= 0) {
      // Focus in place. Re-seating the tab to the end here (the old MRU
      // behavior) made the strip reshuffle on every click of an inactive tab
      // — with two docs that reads exactly as "the tabs swapped places".
      // Strip order changes only through an explicit drag (file.reorderTab).
      b.activePath = p;
    } else {
      b.tabs.push(p);
      b.activePath = p;
    }
    // Leaving the docs renderer (a format switch reloads the panel) invalidates
    // whatever the editor last announced. A docx target keeps the stale value —
    // the fast path in ensureDocxActive compares it against the TARGET, so a
    // stale non-matching value just means "wait for the next announcement".
    const ext = p.toLowerCase().split('.').pop() ?? '';
    if (ext !== 'docx' && ext !== 'docm') mcpReadyPath = null;
  }
  renderBucket(b, renderTo);
}

/** Open (or focus) a document tab in a conversation's bucket. */
function openFile(path: string, sessionId?: string | null, renderTo?: string): void {
  openFileInBucket(bucketKey(sessionId), path, renderTo);
}

/** Close a tab; closing the focused one falls focus to its left neighbour. */
function closeTab(path: string, sessionId?: string | null, renderTo?: string): void {
  const b = bucketFor(bucketKey(sessionId));
  const idx = b.tabs.findIndex((t) => samePath(t, path));
  if (idx === -1) return;
  b.tabs.splice(idx, 1);
  if (b.activePath && samePath(b.activePath, path)) {
    b.activePath = b.tabs[Math.max(0, idx - 1)] ?? '';
  }
  renderBucket(b, renderTo);
}

/** The active document of a conversation's bucket ('' when nothing is open). */
function activeFileOf(sessionId?: string | null): string {
  return bucketFor(bucketKey(sessionId)).activePath;
}

// ── GenOffice's external-agent bridge (docx) ─────────────────────────
//
// Editing a docx means driving a LIVE Tiptap editor, so the work happens in
// the panel: GenOffice ships exactly that bridge itself
// (`apps/docs/src/renderer/mcp-bridge.ts`), and its executors are the built-in
// agent's own `executeTool` — so an external command inherits the same
// parsing, atomicity, formatting rules and stale-index guard.
//
// This side only carries the commands. They travel over the plugin's OWN
// point-to-point panel port and come back as an ordinary UI request, so
// nothing here reaches the host: no host capability, no protocol surface,
// no manifest change. The plugin's `office_*` tools are the only thing the
// agent sees, exactly as for any other plugin.
//
// The one consequence worth knowing: the document has to be OPEN in the
// viewer. That is GenOffice's own model — its built-in AI works the same way —
// and it is why `requireDocxOpen` below fails loudly instead of hanging.
const mcpPending = new Map<
  string,
  { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
>();
let mcpSeq = 0;

/** True once a docs panel has announced it can take commands. */
let mcpReady = false;

/**
 * Which document the panel's editor currently holds, as announced by
 * `mcp.ready { path }`. One panel, one live editor — this is the truth about
 * what a `mcp-command` would land on. A stale value (the panel reloaded away
 * from docs) simply fails the fast path below, and the next announcement
 * overwrites it.
 */
let mcpReadyPath: string | null = null;

/** Waiters blocked until the panel announces a specific document ready. */
const readyWaiters = new Map<string, Array<{ resolve: () => void; timer: ReturnType<typeof setTimeout> }>>();

function waitMcpReady(path: string, timeoutMs: number): Promise<void> {
  if (mcpReadyPath !== null && samePath(mcpReadyPath, path)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const entry = { resolve, timer: null as unknown as ReturnType<typeof setTimeout> };
    const remove = () => {
      clearTimeout(entry.timer);
      const arr = readyWaiters.get(path);
      if (!arr) return;
      const i = arr.indexOf(entry);
      if (i >= 0) arr.splice(i, 1);
      if (arr.length === 0) readyWaiters.delete(path);
    };
    entry.timer = setTimeout(() => {
      remove();
      reject(
        new Error(
          `the viewer did not finish opening ${basename(path)} within ${Math.round(timeoutMs / 1000)}s — ` +
            'is the file still readable?',
        ),
      );
    }, timeoutMs);
    const arr = readyWaiters.get(path) ?? [];
    arr.push(entry);
    readyWaiters.set(path, arr);
  });
}

function announceMcpReady(path: string): void {
  mcpReadyPath = path;
  const arr = readyWaiters.get(path);
  if (!arr) return;
  readyWaiters.delete(path);
  for (const w of arr) {
    clearTimeout(w.timer);
    w.resolve();
  }
}

/**
 * All docx bridge traffic for one tool call runs under this lock. The panel
 * has ONE live editor, so two concurrent calls (e.g. two conversations editing
 * two documents) must not interleave: each call re-points the editor at its
 * own document first, and letting a second call switch it mid-sequence would
 * land the first call's remaining commands on the wrong document.
 */
let mcpChain: Promise<unknown> = Promise.resolve();
function withMcpLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = mcpChain.then(fn, fn);
  mcpChain = run.catch(() => undefined);
  return run;
}

function requireDocxOpen(path: string, sessionId?: string | null): void {
  const b = bucketFor(bucketKey(sessionId));
  if (b.tabs.some((t) => samePath(t, path))) return;
  throw new Error(
    b.activePath
      ? `the viewer is showing ${b.activePath}, not ${path} — open the document you want to edit in the viewer, then retry`
      : `no document is open in the viewer — open ${path} there, then retry`,
  );
}

/**
 * Point the panel's editor at `path` and wait until it says so. Activating the
 * tab is what makes the switch visible (the tab strip moves, and a format
 * switch reloads the panel onto the docs renderer) — GenOffice's model is that
 * the document being edited IS the one open in the viewer.
 */
async function ensureDocxActive(path: string, sessionId?: string | null): Promise<void> {
  if (mcpReadyPath !== null && samePath(mcpReadyPath, path)) return;
  openFile(path, sessionId);
  await waitMcpReady(path, 60_000);
}

function mcpCommand(
  command: string,
  payload: Record<string, unknown>,
  timeoutMs = 120_000,
): Promise<unknown> {
  const requestId = 'm' + ++mcpSeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      mcpPending.delete(requestId);
      reject(
        new Error(
          `the viewer did not answer "${command}" within ${Math.round(timeoutMs / 1000)}s — ` +
            'is the document still open and finished loading?',
        ),
      );
    }, timeoutMs);
    mcpPending.set(requestId, { resolve, reject, timer });
    const delivered = ctx.send(PANEL, 'mcp-command', { requestId, command, payload });
    if (!delivered) {
      // Nothing is listening. Waiting out the full timeout would only delay a
      // failure the caller can act on right now — and this is the case the old
      // `requireDocxOpen` port check used to catch, from the other side.
      clearTimeout(timer);
      mcpPending.delete(requestId);
      reject(new Error('the file viewer is not open — open the document in the viewer, then retry'));
      return;
    }
    if (!mcpReady) {
      // Not fatal: readiness is only a hint (the panel announces it once the
      // editor has a loaded document), and the command may still be answered.
      ctx.log.info('docx bridge: no ready signal yet, sending anyway');
    }
  });
}

// ── Office engine helpers ────────────────────────────────────────────

async function readOfficeBytes(path: string): Promise<Uint8Array> {
  const info = await stat(path).catch(() => null);
  if (!info || !info.isFile()) throw new Error(`not a file: ${path}`);
  if (info.size > MAX_READ_BYTES) {
    throw new Error(`file too large for the engine (${Math.round(info.size / 1e6)}MB > ${MAX_READ_BYTES / 1e6}MB)`);
  }
  return new Uint8Array(await readFile(path));
}

/** Save engine output back to disk through the host, keeping the conflict check. */
async function writeOfficeBytes(path: string, bytes: Uint8Array, expectedMtime?: number): Promise<unknown> {
  return ctx.call('filesystem.write', {
    path,
    contentB64: Buffer.from(bytes).toString('base64'),
    expectedMtime: typeof expectedMtime === 'number' ? expectedMtime : undefined,
  });
}

// ── Tools ────────────────────────────────────────────────────────────

const text = (t: string, details?: unknown): ToolResult => ({
  content: [{ type: 'text', text: t }],
  details,
});

/**
 * Declarative card for office_edit (messageRenderer): what changed, plus a
 * one-click open in the viewer. The file path rides in the Button's props —
 * the click event loops it back as the payload — so each card opens ITS
 * document even when several edits are stacked in one conversation. Cards
 * render only what the host can draw from data; the plugin ships no UI code.
 */
const docCard = (filePath: string, opCount: number, ext: string): unknown => ({
  component: 'Card',
  props: { title: '文档已更新' },
  children: [
    {
      component: 'Row',
      props: { gap: 2 },
      children: [
        { component: 'Text', props: { text: basename(filePath), weight: 'bold' } },
        { component: 'Badge', props: { text: ext.toUpperCase() } },
      ],
    },
    { component: 'Text', props: { text: `已应用 ${opCount} 个操作并保存`, variant: 'muted' } },
    {
      component: 'Button',
      props: { label: '在查看器中打开', path: filePath },
      events: { onClick: 'open_viewer' },
    },
  ],
});

/**
 * The op vocabulary is served as DATA, not as one tool per op.
 *
 * `contributes.tools` is aggregated into the agent's tool list at session
 * creation, so a 70-variant schema would be paid on every request. Instead
 * the model asks for the vocabulary (or one group's field tables) when it
 * needs them — the same split genoffice's own AI surfaces use, and the
 * reason `op-docs.ts` exposes vocabulary / signature-index / guide
 * separately.
 */
async function toolGuide(p: Record<string, unknown>): Promise<ToolResult> {
  const domain = String(p.domain ?? 'pptx');
  if (domain === 'xlsx') {
    // Not the pptx op vocabulary: a spreadsheet edit addresses a cell, and
    // there is no op registry behind it to enumerate.
    return text(
      'xlsx ops are cell edits. Each one is:\n' +
        '  { sheet: string, cell: string, value: string | number | boolean | null }\n' +
        '\n' +
        '  sheet — a sheet name exactly as office_read reported it\n' +
        '  cell  — an A1-style address, also from office_read\n' +
        '  value — null clears the cell\n' +
        '\n' +
        'Put them in office_edit\'s `ops` array. Read first; the addresses come from office_read.\n' +
        'NOT yet supported for xlsx: adding or removing sheets, formulas, formatting,\n' +
        'charts, merged cells. Those need a different op set; say so instead of retrying.',
      { domain, op: 'setCell' },
    );
  }
  if (domain === 'docx') {
    // Not a byte-level engine: see backend/docx.ts. The ops drive the editor
    // the document is open in, which is why the guide leads with that.
    return text(docxGuide(), { domain, ops: DOCX_OP_GROUPS });
  }
  if (domain !== 'pptx') {
    return text(`domain "${domain}" is not wired yet — pptx, xlsx and docx are. Do not retry with another argument; tell the user this format has no structural editing yet.`);
  }
  const group = p.group === undefined ? undefined : String(p.group);
  if (group !== undefined) {
    const guide = opGuide(group);
    if (!guide) {
      return text(`unknown op group "${group}". Available: ${OP_GROUPS.join(', ')}`);
    }
    return text(guide, { domain, group });
  }
  if (p.style === 'signatures') {
    return text(opSignatureIndex(), { domain, count: opNames().length });
  }
  return text(
    `${opVocabulary()}\n\nCall office_guide again with { group } for one group's field tables and examples.`,
    { domain, groups: OP_GROUPS, count: opNames().length },
  );
}

async function toolRead(p: Record<string, unknown>, sessionId?: string | null): Promise<ToolResult> {
  const path = String(p.path ?? '');
  if (!path) throw new Error('office_read: path is required');
  const ext = path.toLowerCase().split('.').pop();
  if (ext === 'xlsx') {
    const sheets = await readXlsxStructure(await readOfficeBytes(path));
    // Capped per sheet: a real workbook holds more cells than an agent needs
    // to see, and the ADDRESSES are the point — they are what an edit targets.
    const MAX_CELLS = 40;
    return text(
      `${path}: ${sheets.length} sheet(s)\n` +
        sheets
          .map((s) => {
            const shown = s.cells.slice(0, MAX_CELLS);
            const more = s.cells.length - shown.length;
            const cells = shown
              .map((c) => `${c.address}=${c.value === null ? '∅' : c.value}${c.formula ? ` [${c.formula}]` : ''}`)
              .join(', ');
            return `  ${s.name} — ${s.cells.length} cell(s)${cells ? `: ${cells}` : ''}${more > 0 ? ` … ${more} more` : ''}`;
          })
          .join('\n'),
      { sheetCount: sheets.length, sheets },
    );
  }
  if (ext === 'docx') {
    // Read through the bridge, because the useful readout — block indexes
    // against the CURRENT editor state — only exists there. Reading the bytes
    // instead would produce indexes that go stale the moment anything else
    // touches the document.
    requireDocxOpen(path, sessionId);
    const result = (await withMcpLock(async () => {
      await ensureDocxActive(path, sessionId);
      return mcpCommand('read_document', {});
    })) as { text?: string } | undefined;
    return text(String(result?.text ?? ''), { path, via: 'viewer' });
  }
  if (ext !== 'pptx') {
    return text(`office_read: "${ext}" is not wired yet — pptx, xlsx and docx are. Do not retry; this format has no structural reading yet.`);
  }
  const opened = await openPptx(await readOfficeBytes(path));
  const slides = opened.deck.slides.map((s, i) => ({
    index: i,
    id: (s as unknown as { slideId?: string }).slideId ?? null,
    path: s.path,
    elements: (s.elements ?? []).map((el) => {
      const e = el as unknown as Record<string, unknown>;
      return {
        id: e.id ?? null,
        name: e.name ?? null,
        kind: e.kind ?? e.type ?? null,
        // The box is what an agent needs to reason about position; keep it
        // flat and numeric rather than dumping the element.
        ...(e.box ? { box: e.box } : {}),
      };
    }),
  }));
  return text(
    `${path}: ${slides.length} slide(s)\n` +
      slides
        .map((s) => `  [${s.index}] ${s.path} — ${s.elements.length} element(s): ` +
          s.elements.map((e) => `${e.id}(${e.kind})`).join(', '))
        .join('\n'),
    { slideCount: slides.length, slides },
  );
}

async function toolEdit(p: Record<string, unknown>, sessionId?: string | null): Promise<ToolResult> {
  const path = String(p.path ?? '');
  if (!path) throw new Error('office_edit: path is required');
  const ops = Array.isArray(p.ops) ? (p.ops as Op[]) : [];
  if (ops.length === 0) throw new Error('office_edit: ops is required and must be non-empty');
  const dryRun = p.dryRun === true;
  const ext = path.toLowerCase().split('.').pop();
  if (ext === 'xlsx') {
    // Same mtime baseline as pptx below: `filesystem.write` is a
    // compare-and-swap, so an edit made between read and save is refused
    // rather than clobbered.
    const info = await stat(path);
    const bytes = await readOfficeBytes(path);
    const cellOps = ops as unknown as CellOp[];
    if (dryRun) {
      const planned = await planXlsxEdits(bytes, cellOps);
      return text(
        `dry run ok — ${cellOps.length} op(s) validated, nothing written:\n` +
          `  would touch: ${planned.touchedEntries.join(', ') || '(nothing)'}`,
        { applied: false, dryRun: true, plan: planned.touchedEntries },
      );
    }
    const next = await applyXlsxEdits(bytes, cellOps);
    const written = await writeOfficeBytes(path, next, info.mtimeMs);
    return {
      ...text(`applied ${cellOps.length} op(s) to ${path} and saved (${next.length} bytes)`, {
        applied: true,
        mtime: (written as { mtime?: number })?.mtime,
      }),
      card: docCard(path, cellOps.length, ext),
    };
  }
  if (ext === 'docx') {
    // GenOffice's editor bridge does the work — see backend/docx.ts for why
    // there is no byte-level path here. `apply_ops` is validated as a batch by
    // the op registry itself, so a rejection names the offending op. The lock
    // spans activate → apply → save: one panel, one live editor, so another
    // call switching documents mid-sequence would land the rest of THIS
    // sequence on the wrong file.
    requireDocxOpen(path, sessionId);
    const commands = planDocxCommands(ops as unknown as DocxOp[], dryRun);
    const steps: unknown[] = [];
    const saved = await withMcpLock(async () => {
      for (const step of commands) {
        // Re-verify before EVERY command: a strip click can switch the editor
        // mid-sequence, and the next command must re-point it rather than land
        // on the user's document. Unchanged target = fast path, no switch.
        await ensureDocxActive(path, sessionId);
        steps.push(await mcpCommand(step.command, step.payload));
      }
      if (dryRun) return undefined;
      // The edits so far are in the LIVE editor; the file on disk still holds
      // the old bytes until this save. `overwrite` says "write this path
      // deliberately" — the real guard is `filesystem.write`'s mtime
      // compare-and-swap, which refuses if the file changed since the viewer
      // opened it.
      return (await mcpCommand('save_document', { path, overwrite: true })) as
        | { ok?: boolean; path?: string }
        | undefined;
    });
    if (dryRun) {
      const plan = (steps[0] as { output?: string } | undefined)?.output ?? '';
      return text(`dry run ok — ${ops.length} op(s) validated, nothing written:\n${plan}`, {
        applied: false,
        dryRun: true,
        steps,
      });
    }
    if (saved?.ok !== true) throw new Error(`office_edit: the document could not be saved to ${path}`);
    const info = await stat(path).catch(() => null);
    return {
      ...text(`applied ${ops.length} op(s) to ${path} and saved`, {
        applied: true,
        path,
        mtime: info?.mtimeMs,
        steps,
      }),
      card: docCard(path, ops.length, ext),
    };
  }
  if (ext !== 'pptx') {
    return text(`office_edit: "${ext}" is not wired yet — pptx, xlsx and docx are. Do not retry; this format has no structural editing yet.`);
  }

  // The mtime read here is the baseline the host's conflict check compares
  // against on write, so an edit made between read and save is refused
  // rather than silently clobbered.
  const info = await stat(path);
  const opened = await openPptx(await readOfficeBytes(path));
  const result = runTxn(opened, { dryRun, ops });

  // Order matters: failures first, THEN dryRun, then a real apply.
  // `runTxn` reports `applied: false` for a dry run too (nothing was
  // applied), so testing `applied` before `dryRun` sends every dry run down
  // the rejection path with an empty failure list.
  if (result.failures && result.failures.length > 0) {
    // Validation failures must NOT throw: the host turns a thrown error into
    // a bare string and drops `details`, and the typed fields are the whole
    // value — an agent self-corrects from `failures[].error`, not from prose.
    const lines = result.failures.map((f) => `  [${f.index}] ${f.error}`);
    return text(
      `nothing applied — ${result.failures.length} op(s) rejected:\n${lines.join('\n')}\n\n` +
        `Fix the listed op(s) and resend the whole batch.`,
      {
        applied: false,
        failures: result.failures,
        // Lets the agent notice its cached op list is stale.
        opsAvailable: opNames().length,
      },
    );
  }

  if (dryRun) {
    return text(`dry run ok — ${ops.length} op(s) validated, nothing written:\n  ${(result.plan ?? []).join('\n  ')}`, {
      applied: false,
      dryRun: true,
      plan: result.plan ?? [],
    });
  }

  const bytes = await savePptx(opened);
  const written = await writeOfficeBytes(path, bytes, info.mtimeMs);
  return {
    ...text(
      `applied ${result.records?.length ?? ops.length} op(s) to ${path} and saved (${bytes.length} bytes)`,
      { applied: true, records: result.records ?? [], mtime: (written as { mtime?: number })?.mtime },
    ),
    card: docCard(path, result.records?.length ?? ops.length, ext),
  };
}

// ── Tool dispatch ────────────────────────────────────────────────────

/** One tool call. The SDK turns the return value into the tool result. */
async function runTool(name: string, p: Record<string, unknown>, call: { sessionId?: string } = {}): Promise<ToolResult> {
  const sessionId = call.sessionId ?? null;
  switch (name) {
    case 'office_guide':
      return await toolGuide(p);
    case 'office_read':
      return await toolRead(p, sessionId);
    case 'office_edit':
      return await toolEdit(p, sessionId);

    // ── legacy P9a probes (kept until the viewer work lands) ──
    case 'files_probe_write': {
      if (!p.path) throw new Error('missing path');
      const result = (await ctx.call('filesystem.write', {
        path: String(p.path),
        content: String(p.content ?? ''),
        expectedMtime: typeof p.expectedMtime === 'number' ? p.expectedMtime : undefined,
      })) as { path?: string; size?: number; mtime?: number } | undefined;
      return text(`已写入 ${result?.path} (${result?.size} bytes, mtime ${Math.round(Number(result?.mtime ?? 0))})`, result);
    }
    case 'files_probe_read': {
      if (!p.path) throw new Error('missing path');
      const result = (await ctx.call('filesystem.read', { path: String(p.path) })) as { path?: string; size?: number; content?: string } | undefined;
      return text(`读取 ${result?.path} (${result?.size} bytes):\n${String(result?.content ?? '').slice(0, 4000)}`, result);
    }
    case 'files_probe_open': {
      // `panelId` is optional and defaults to the viewer, so the original P9a
      // call shape keeps working. It exists so a hidden panel (e.g. the build
      // spike) can be opened without adding a tool per panel.
      const panelId = typeof p.panelId === 'string' && p.panelId ? String(p.panelId) : 'viewer';
      if (panelId !== 'viewer') {
        await ctx.call('panel.open', { panelId, focus: true });
        return text(`已打开面板 ${panelId}`);
      }
      const target = typeof p.path === 'string' && p.path ? String(p.path) : activeFileOf(sessionId);
      if (!target) throw new Error('no file to open (pass path or click a file first)');
      await ctx.call('panel.open', { panelId: 'viewer', focus: true });
      openFile(target, sessionId);
      return text(`已在查看器中打开 ${target}`);
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// ── UI requests ──────────────────────────────────────────────────────
//
// The panel's SDK can also send `{kind:'request', id, method, params}` and
// await a `{kind:'response', id, ...}`. The desktop shim uses this for the
// two things the panel cannot do itself: call a host capability (only the
// backend may), and run Node-side code (font metrics reads font files).
async function onUiRequest(
  method: string,
  params: Record<string, unknown> = {},
  panelId?: string | null,
): Promise<unknown> {
  switch (method) {
    case 'chat.send': {
      const t = String(params.text ?? '').trim();
      if (!t) throw new Error('chat.send: text is required');
      return ctx.call('chat.send', { text: t });
    }
    case 'mcp.ready': {
      // The docs panel announces itself once its editor has a loaded document.
      // With the multi-doc viewer the announcement names WHICH document is
      // loaded — `ensureDocxActive` waits for its target to be announced, so a
      // tab switch cannot race a queued command onto the wrong editor.
      const path = String(params.path ?? '');
      if (path) announceMcpReady(path);
      mcpReady = true;
      return { ok: true };
    }
    case 'file.activateTab': {
      // Strip click: focus one of the conversation's open documents. Same
      // semantics as openFile for an already-open path (activate, never
      // duplicate). The panel's own shims take it from here (in-place for
      // docx→docx, a dispatcher reload for other formats).
      const path = String(params.path ?? '');
      if (!path) throw new Error('file.activateTab: path is required');
      openFile(path, uiBucketKey(panelId), panelId ?? undefined);
      return { ok: true };
    }
    case 'file.closeTab': {
      const path = String(params.path ?? '');
      if (!path) throw new Error('file.closeTab: path is required');
      closeTab(path, uiBucketKey(panelId), panelId ?? undefined);
      // The pane's × IS the unsplit gesture now: when its last document
      // closes, collapse the split — an emptied pane must not linger as a
      // blank column with no way to dismiss it (it has no strip entry).
      if (panelId === PANE_PANEL && bucketFor(uiBucketKey(panelId)).tabs.length === 0 && paneIsOpen()) {
        await ctx.call('panel.close', { panelId: PANE_PANEL });
      }
      return { ok: true };
    }
    case 'file.reorderTab': {
      // Strip drag: re-seat `path` before `beforePath` (end when omitted). A
      // pure order change — focus and the loaded renderer are untouched.
      const path = String(params.path ?? '');
      const beforePath = params.beforePath ? String(params.beforePath) : '';
      if (!path) throw new Error('file.reorderTab: path is required');
      const b = bucketFor(uiBucketKey(panelId));
      const from = b.tabs.findIndex((t) => samePath(t, path));
      if (from === -1) return { ok: true };
      b.tabs.splice(from, 1);
      const at = beforePath ? b.tabs.findIndex((t) => samePath(t, beforePath)) : -1;
      if (at === -1) b.tabs.push(path);
      else b.tabs.splice(at, 0, path);
      renderBucket(b, panelId ?? PANEL);
      return { ok: true, tabs: b.tabs };
    }
    case 'file.splitRight': {
      // The strip's 向右拆分: the clicked document goes INTO the pane beside
      // the main view. The main view's document never moves — the two sides
      // must not swap. Pane already open: it simply takes the clicked doc.
      if (panelId === PANE_PANEL) return { ok: false, reason: 'already-pane' };
      const path = String(params.path ?? '');
      if (!path) throw new Error('file.splitRight: path is required');
      if (paneIsOpen()) {
        openFileInBucket(uiBucketKey(PANE_PANEL), path, PANE_PANEL);
        // A deselected-but-warm pane (closed from the strip, page still alive)
        // must come back to the work area, not load invisibly.
        await ctx.call('panel.open', { panelId: PANE_PANEL, focus: true });
        return { ok: true };
      }
      await ctx.call('panel.open', {
        panelId: PANE_PANEL,
        focus: true,
        params: { file: path },
      });
      return { ok: true };
    }
    case 'mcp.result': {
      const requestId = String(params.requestId ?? '');
      const entry = mcpPending.get(requestId);
      // A late or duplicate report is not an error: the command already
      // settled (usually by timing out) and nobody is waiting any more.
      if (!entry) return { ok: false, reason: 'no such pending command' };
      mcpPending.delete(requestId);
      clearTimeout(entry.timer);
      if (params.ok === false) {
        entry.reject(new Error(String(params.error ?? 'the viewer reported a failure')));
      } else {
        entry.resolve(params.result);
      }
      return { ok: true };
    }
    case 'file.scratchPath': {
      // A stable, writable file the panel can push content into and then
      // read back over `pi-plugin://…/ws-file`. The html viewer's preview
      // frame needs exactly that shape: its iframe src is
      // `${url}?v=${nonce}` (PreviewFrame.tsx), so the URL has to stay put
      // while its CONTENT changes between reloads. GenOffice serves that
      // from `html-preview://` in its own main process; here a temp file
      // behind ws-file gives the same behaviour without a new scheme.
      //
      // One file per backend process: there is one viewer panel, and a
      // stable name is the point.
      const dir = join(tmpdir(), 'pi-files-preview');
      await mkdir(dir, { recursive: true });
      return { path: join(dir, `preview-${process.pid}.html`) };
    }
    case 'file.pickOpenPath': {
      // The host owns the dialog; the panel shim has always asked for this
      // and used to get "unknown ui request" back, which is why "打开" and
      // "另存为" quietly did nothing.
      const opened = (await ctx.call('dialog.openFile', {
        ...(params.title ? { title: String(params.title) } : {}),
        ...(params.filters ? { filters: params.filters } : {}),
        ...(params.multi ? { multi: true } : {}),
      })) as { path?: string | null; paths?: string[] } | undefined;
      return { path: opened?.path ?? null, paths: opened?.paths ?? [] };
    }
    case 'file.pickSavePath': {
      const saved = (await ctx.call('dialog.saveFile', {
        ...(params.title ? { title: String(params.title) } : {}),
        ...(params.defaultName ? { defaultName: String(params.defaultName) } : {}),
        ...(params.filters ? { filters: params.filters } : {}),
      })) as { path?: string | null } | undefined;
      return { path: saved?.path ?? null };
    }
    case 'file.write': {
      const path = String(params.path ?? '');
      if (!path) throw new Error('file.write: path is required');
      return ctx.call('filesystem.write', {
        path,
        contentB64: String(params.base64 ?? ''),
        expectedMtime: typeof params.expectedMtime === 'number' ? params.expectedMtime : undefined,
      });
    }
    case 'file.stat': {
      const path = String(params.path ?? '');
      const info = await stat(path);
      return { path, size: info.size, mtime: info.mtimeMs };
    }
    case 'pdf.save': {
      // GenOffice's PDF surgery, run here rather than reimplemented.
      //
      // `applySaveRequest` is pure bytes-in/bytes-out (1,027 lines of
      // pdf-lib work in apps/pdf/src/main/save-pdf.ts) and imports no
      // Electron. The renderer has already staged every edit — markups,
      // drawings, text edits, page ops — into the request, so all this
      // side has to do is read, apply, write.
      const path = String(params.path ?? '');
      if (!path) throw new Error('pdf.save: path is required');
      const { applySaveRequest } = await import('../../vendor/genoffice/apps/pdf/src/main/save-pdf');
      const { bytes, ...skips } = await applySaveRequest(
        new Uint8Array(await readFile(path)),
        params as never,
      );
      const written = (await ctx.call('filesystem.write', {
        path,
        contentB64: Buffer.from(bytes).toString('base64'),
        expectedMtime: typeof params.expectedMtime === 'number' ? params.expectedMtime : undefined,
      })) as { mtime?: number } | undefined;
      return { ok: true, mtime: written?.mtime, skips };
    }
    case 'font.metrics': {
      const family = String(params.family ?? '');
      // Node-only package (reads sfnt tables off disk) — the reason this
      // call has to come through here rather than run in the panel.
      const { familyVerticalMetrics } = await import('@genoffice/font-metrics');
      return familyVerticalMetrics(family) ?? null;
    }
    case 'state.get': {
      // The boot pull — the same payload openFile() pushes, so a panel that
      // loads late still learns what it should be showing without waiting on
      // the mounted push. Tabs ride along for the strip.
      const b = bucketFor(uiBucketKey(panelId));
      return b.activePath ? { path: b.activePath, tabs: b.tabs, activePath: b.activePath } : {};
    }
    default:
      throw new Error(`unknown ui request: ${method}`);
  }
}

// ── Panel events ─────────────────────────────────────────────────────

// Events are named for what happened (files.save / files.chat) rather than
// routed through the host's ui.event envelope: the SDK stamps the panel id, so
// a one-panel plugin never has to unwrap anything.
async function onEvent(_panelId: string, event: string, data: unknown): Promise<void> {
  const d = (data ?? {}) as Record<string, unknown>;

  if (event === 'files.chat') {
    // The viewer's own selection box → the conversation. `chat.send` is the
    // same path as the user typing in the composer, so the agent (and its
    // tools, including this plugin's) behaves identically.
    const t = String(d.text ?? '').trim();
    if (!t) return;
    try {
      await ctx.call('chat.send', { text: t });
    } catch (err) {
      ctx.log.error(`chat-send failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }
  if (event !== 'files.save') {
    // Same as knowledge and mail: an event this plugin does not handle is a
    // mistake worth reporting, not something to drop quietly.
    ctx.log.warn(`ignoring unknown panel event "${event}"`);
    return;
  }
  // Viewer write-back: edits are saved with mtime conflict detection.
  const { path, contentB64, expectedMtime } = d as {
    path?: string;
    contentB64?: string;
    expectedMtime?: number;
  };
  if (!path || typeof contentB64 !== 'string') return;
  try {
    const result = (await ctx.call('filesystem.write', { path, contentB64, expectedMtime })) as { mtime?: number } | undefined;
    renderViewer({ saved: true, mtime: result?.mtime });
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    ctx.log.error(`file-save failed: ${m}`);
    renderViewer({ error: `保存失败: ${m}` });
  }
}

// ── the plugin ──

plugin({
  onInit(context) {
    ctx = context;
  },

  /**
   * The panel draws from here — onInit runs before anyone has opened it.
   * `meta.sessionId` names the conversation the panel now serves: it arrives on
   * first mount AND again on every session switch, so the panel's bucket
   * follows the conversation on screen.
   *
   * On a session BOUNDARY `params` cannot be trusted: the host's per-session
   * stash runs in a PARENT effect, so the re-mount fires first with the
   * OUTGOING conversation's `{ file }` still attached — applying it here would
   * open the previous conversation's document in the new one's bucket. So a
   * boundary renders the incoming bucket as-is; a genuine file click arrives
   * as a later mount within the settled session. A fresh backend
   * (panelSession null) has no previous conversation, so its first mount
   * applies params normally.
   */
  onPanelMounted(panelId, params, _ctx, meta) {
    const sessionId = meta?.sessionId ?? null;
    const boundary = panelSession !== null && sessionId !== null && sessionId !== panelSession;
    panelSession = sessionId ?? panelSession;
    // The pane panel mounts into its OWN bucket — the split view's second
    // side never shares the main viewer's document set.
    const key = bucketKey(sessionId, panelId);
    const b = bucketFor(key);
    const file = String((params as { file?: string } | undefined)?.file ?? '');
    const target = !boundary && file ? file : b.activePath;
    if (target) openFile(target, key, panelId ?? undefined);
    else renderBucket(b, panelId ?? PANEL);
    pruneBuckets();
  },

  onTool: (name, params, _ctx, call) => runTool(name, params, call),

  /** The conversation on screen changed — show that conversation's bucket. */
  onHostEvent(event, data) {
    if (event !== 'session.changed') return;
    panelSession = (data as { sessionId?: string | null } | null)?.sessionId ?? null;
    renderBucket(bucketFor(bucketKey()));
    // The pane (when open) follows with ITS bucket — fire-and-forget; send
    // returning false just means the pane is not open.
    renderBucket(bucketFor(`${bucketKey()}::pane`), PANE_PANEL);
    pruneBuckets();
  },

  onRequest(panelId, method, params) {
    return onUiRequest(method, params, panelId);
  },

  /**
   * Card buttons from the office_edit result card (messageRenderer). The path
   * comes back in the clicked node's props, so an old card still opens its
   * own document. The card was clicked from the conversation ON SCREEN, so it
   * opens into the panel's bucket. Not async: the SDK calls this fire-and-
   * forget without awaiting, so a rejection here would escape the SDK's
   * try/catch — handle errors inline instead.
   */
  onCardEvent(_toolName, eventId, kind, payload) {
    if (kind !== 'click' || eventId !== 'open_viewer') return;
    const target = String((payload as { path?: string } | undefined)?.path ?? '') || activeFileOf();
    if (!target) return;
    void ctx
      .call('panel.open', { panelId: 'viewer', focus: true })
      .then(() => openFile(target))
      .catch((err: unknown) => {
        ctx.log.error(`open_viewer failed: ${err instanceof Error ? err.message : String(err)}`);
      });
  },

  onEvent,
});

// Re-exported so tests can reach the engine without going through a tool call
// (the smoke test needs a real deck to edit, and building it with the same
// engine the backend ships keeps the two from disagreeing).
export { createBlankPptx, openPptx, savePptx, runTxn, opNames };
