/**
 * com.pi.files backend — office engine host + file viewer controller.
 *
 * Runs in an Electron UtilityProcess. Two jobs:
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
 * `main()` is exported and only self-starts when Electron's parentPort exists,
 * so `scripts/smoke-backend.mjs` can drive the whole tool surface in plain Node.
 */

import { mkdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
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

export interface HostPort {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (ev: { data: unknown; ports?: unknown[] }) => void): void;
}

interface ToolContent {
  type: 'text';
  text: string;
}

type ToolResult = {
  content: ToolContent[];
  details?: unknown;
};

const MAX_READ_BYTES = 200 * 1024 * 1024;

/** Whether two paths name the same file, forgiving `.` `..` and a trailing slash. */
function samePath(a: string, b: string): boolean {
  try {
    return resolvePath(a) === resolvePath(b);
  } catch {
    return a === b;
  }
}

export function main(parentPort: HostPort): void {
  const state = { uiPort: null as null | { postMessage(m: unknown): void }, currentFile: '' };
  let seq = 0;
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  const post = (msg: unknown) => parentPort.postMessage(msg);
  const log = (level: string, message: string) => post({ type: 'log', level, message });

  /** Capability round-trip to the host. */
  function call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = 'c' + ++seq;
      pending.set(id, { resolve, reject });
      post({ type: 'call', id, method, params });
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`capability timeout: ${method}`));
      }, 30_000);
    });
  }

  const uiPost = (payload: unknown) => {
    try {
      state.uiPort?.postMessage(payload);
    } catch {
      /* port closed */
    }
  };
  const renderViewer = (data: unknown) =>
    uiPost({ kind: 'event', event: 'ui.render', panelId: 'viewer', data });

  function openFile(path: string): void {
    state.currentFile = String(path ?? '');
    // The viewer loads content itself over ws-file; mtime rides along so the
    // first save's conflict detection has a baseline.
    renderViewer(state.currentFile ? { path: state.currentFile } : {});
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

  function requireDocxOpen(path: string): void {
    if (!state.uiPort) {
      throw new Error('the file viewer is not open — open this document in the viewer, then retry');
    }
    const open = state.currentFile;
    if (open.toLowerCase().endsWith('.docx') && samePath(open, path)) return;
    throw new Error(
      open
        ? `the viewer is showing ${open}, not ${path} — open the document you want to edit in the viewer, then retry`
        : `no document is open in the viewer — open ${path} there, then retry`,
    );
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
      uiPost({ kind: 'event', event: 'mcp-command', data: { requestId, command, payload } });
      if (!mcpReady) {
        // Not fatal: readiness is only a hint (the panel announces it once the
        // editor has a loaded document), and the command may still be answered.
        log('info', 'docx bridge: no ready signal yet, sending anyway');
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
    return call('filesystem.write', {
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

  async function toolRead(p: Record<string, unknown>): Promise<ToolResult> {
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
      requireDocxOpen(path);
      const result = (await mcpCommand('read_document', {})) as { text?: string } | undefined;
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

  async function toolEdit(p: Record<string, unknown>): Promise<ToolResult> {
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
      return text(`applied ${cellOps.length} op(s) to ${path} and saved (${next.length} bytes)`, {
        applied: true,
        mtime: (written as { mtime?: number })?.mtime,
      });
    }
    if (ext === 'docx') {
      // GenOffice's editor bridge does the work — see backend/docx.ts for why
      // there is no byte-level path here. `apply_ops` is validated as a batch by
      // the op registry itself, so a rejection names the offending op.
      requireDocxOpen(path);
      const commands = planDocxCommands(ops as unknown as DocxOp[], dryRun);
      const steps: unknown[] = [];
      for (const step of commands) {
        steps.push(await mcpCommand(step.command, step.payload));
      }
      if (dryRun) {
        const plan = (steps[0] as { output?: string } | undefined)?.output ?? '';
        return text(`dry run ok — ${ops.length} op(s) validated, nothing written:\n${plan}`, {
          applied: false,
          dryRun: true,
          steps,
        });
      }
      // The edits so far are in the LIVE editor; the file on disk still holds
      // the old bytes until this save. `overwrite` says "write this path
      // deliberately" — the real guard is `filesystem.write`'s mtime
      // compare-and-swap, which refuses if the file changed since the viewer
      // opened it.
      const saved = (await mcpCommand('save_document', { path, overwrite: true })) as
        | { ok?: boolean; path?: string }
        | undefined;
      if (saved?.ok !== true) throw new Error(`office_edit: the document could not be saved to ${path}`);
      const info = await stat(path).catch(() => null);
      return text(`applied ${ops.length} op(s) to ${path} and saved`, {
        applied: true,
        path,
        mtime: info?.mtimeMs,
        steps,
      });
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
    return text(
      `applied ${result.records?.length ?? ops.length} op(s) to ${path} and saved (${bytes.length} bytes)`,
      { applied: true, records: result.records ?? [], mtime: (written as { mtime?: number })?.mtime },
    );
  }

  // ── Tool dispatch ────────────────────────────────────────────────────

  async function onTool(msg: { id: string; name: string; params?: Record<string, unknown> }): Promise<void> {
    const { id, name } = msg;
    const p = msg.params ?? {};
    const done = (r: ToolResult) =>
      post({ type: 'tool-result', id, content: r.content, details: r.details });

    switch (name) {
      case 'office_guide':
        return done(await toolGuide(p));
      case 'office_read':
        return done(await toolRead(p));
      case 'office_edit':
        return done(await toolEdit(p));

      // ── legacy P9a probes (kept until the viewer work lands) ──
      case 'files_probe_write': {
        if (!p.path) throw new Error('missing path');
        const result = (await call('filesystem.write', {
          path: String(p.path),
          content: String(p.content ?? ''),
          expectedMtime: typeof p.expectedMtime === 'number' ? p.expectedMtime : undefined,
        })) as { path?: string; size?: number; mtime?: number } | undefined;
        return done(text(`已写入 ${result?.path} (${result?.size} bytes, mtime ${Math.round(Number(result?.mtime ?? 0))})`, result));
      }
      case 'files_probe_read': {
        if (!p.path) throw new Error('missing path');
        const result = (await call('filesystem.read', { path: String(p.path) })) as { path?: string; size?: number; content?: string } | undefined;
        return done(text(`读取 ${result?.path} (${result?.size} bytes):\n${String(result?.content ?? '').slice(0, 4000)}`, result));
      }
      case 'files_probe_open': {
        // `panelId` is optional and defaults to the viewer, so the original P9a
        // call shape keeps working. It exists so a hidden panel (e.g. the build
        // spike) can be opened without adding a tool per panel.
        const panelId = typeof p.panelId === 'string' && p.panelId ? String(p.panelId) : 'viewer';
        if (panelId !== 'viewer') {
          await call('panel.open', { panelId, focus: true });
          return done(text(`已打开面板 ${panelId}`));
        }
        const target = typeof p.path === 'string' && p.path ? String(p.path) : state.currentFile;
        if (!target) throw new Error('no file to open (pass path or click a file first)');
        await call('panel.open', { panelId: 'viewer', focus: true });
        openFile(target);
        return done(text(`已在查看器中打开 ${target}`));
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
  async function onUiRequest(id: string, method: string, params: Record<string, unknown> = {}): Promise<void> {
    try {
      const result = await (async () => {
        switch (method) {
          case 'chat.send': {
            const t = String(params.text ?? '').trim();
            if (!t) throw new Error('chat.send: text is required');
            return call('chat.send', { text: t });
          }
          case 'mcp.ready': {
            // The docs panel announces itself once its editor has a loaded
            // document. Only a hint — `mcpCommand` does not require it — but it
            // makes the "is anything listening?" question answerable in a log.
            mcpReady = true;
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
            const opened = (await call('dialog.openFile', {
              ...(params.title ? { title: String(params.title) } : {}),
              ...(params.filters ? { filters: params.filters } : {}),
              ...(params.multi ? { multi: true } : {}),
            })) as { path?: string | null; paths?: string[] } | undefined;
            return { path: opened?.path ?? null, paths: opened?.paths ?? [] };
          }
          case 'file.pickSavePath': {
            const saved = (await call('dialog.saveFile', {
              ...(params.title ? { title: String(params.title) } : {}),
              ...(params.defaultName ? { defaultName: String(params.defaultName) } : {}),
              ...(params.filters ? { filters: params.filters } : {}),
            })) as { path?: string | null } | undefined;
            return { path: saved?.path ?? null };
          }
          case 'file.write': {
            const path = String(params.path ?? '');
            if (!path) throw new Error('file.write: path is required');
            return call('filesystem.write', {
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
            const written = (await call('filesystem.write', {
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
          default:
            throw new Error(`unknown ui request: ${method}`);
        }
      })();
      uiPost({ kind: 'response', id, result });
    } catch (err) {
      uiPost({ kind: 'response', id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // ── Panel events ─────────────────────────────────────────────────────

  async function onUiEvent(eventId: string, data: Record<string, unknown> | undefined): Promise<void> {
    if (eventId === 'chat-send') {
      // The viewer's own selection box → the conversation. `chat.send` is the
      // same path as the user typing in the composer, so the agent (and its
      // tools, including this plugin's) behaves identically.
      const t = String(data?.text ?? '').trim();
      if (!t) return;
      try {
        await call('chat.send', { text: t });
      } catch (err) {
        log('error', `chat-send failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
    if (eventId !== 'file-save') return;
    // Viewer write-back: edits are saved with mtime conflict detection.
    const { path, contentB64, expectedMtime } = (data ?? {}) as {
      path?: string;
      contentB64?: string;
      expectedMtime?: number;
    };
    if (!path || typeof contentB64 !== 'string') return;
    try {
      const result = (await call('filesystem.write', { path, contentB64, expectedMtime })) as { mtime?: number } | undefined;
      renderViewer({ saved: true, mtime: result?.mtime });
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      log('error', `file-save failed: ${m}`);
      renderViewer({ error: `保存失败: ${m}` });
    }
  }

  // ── Message pump ─────────────────────────────────────────────────────

  parentPort.on('message', (event) => {
    const msg = (event.data ?? {}) as Record<string, unknown> & { type?: string; id?: string };
    switch (msg.type) {
      case 'init':
        state.uiPort = null;
        break;
      case 'call-result': {
        const p = pending.get(String(msg.id));
        if (p) {
          pending.delete(String(msg.id));
          msg.error ? p.reject(new Error(String(msg.error))) : p.resolve(msg.result);
        }
        break;
      }
      case 'tool-call':
        onTool(msg as unknown as { id: string; name: string; params?: Record<string, unknown> }).catch((e) =>
          post({ type: 'tool-result', id: msg.id, error: e instanceof Error ? e.message : String(e) }),
        );
        break;
      case 'ui-port': {
        const port = event.ports?.[0] as { on(e: 'message', cb: (ev: { data: unknown }) => void): void; start?(): void; postMessage(m: unknown): void } | undefined;
        if (!port) break;
        state.uiPort = port;
        port.on('message', (ev) => {
          const p = ev.data as { kind?: string; id?: string; method?: string; params?: Record<string, unknown>; event?: string; panelId?: string; data?: Record<string, unknown> } | null;
          if (p?.kind === 'request') {
            onUiRequest(String(p.id), String(p.method), p.params ?? {}).catch(() => {});
            return;
          }
          if (p?.kind !== 'event') return;
          if (p.event === 'panel.mounted') {
            openFile(String((p.data?.params as { file?: string } | undefined)?.file ?? state.currentFile));
          } else if (p.event === 'ui.event' && p.panelId === 'viewer') {
            onUiEvent(String(p.data?.eventId ?? ''), p.data?.data as Record<string, unknown> | undefined).catch(() => {});
          }
        });
        port.start?.();
        break;
      }
    }
  });

  post({ type: 'ready' });
}

// Self-start under Electron's UtilityProcess; stay inert when imported for tests.
const injected = (process as unknown as { parentPort?: HostPort }).parentPort;
if (injected) main(injected);

// Re-exported so tests can reach the engine without going through a tool call
// (the smoke test needs a real deck to edit, and building it with the same
// engine the backend ships keeps the two from disagreeing).
export { createBlankPptx, openPptx, savePptx, runTxn, opNames };
