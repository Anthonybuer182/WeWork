/**
 * docx editing, carried out by GenOffice's own editor bridge.
 *
 * Unlike pptx (a pure byte-level engine) and xlsx (the gateway over an
 * EntrySource), a docx edit has no headless model here: GenOffice's document
 * model IS a live Tiptap editor, and its own AI edits by driving that editor
 * (`apps/docs/src/renderer/ai/tools.ts`). That is why this module does not
 * touch bytes at all — it describes commands for the panel to run, and the
 * panel's bridge executes them with the built-in agent's own executors.
 *
 * So this file is two things:
 *
 *   1. the VOCABULARY — what an op looks like, and which ops exist. Extracted
 *      from the registry in `ai/ops.ts` + `style-ops` / `table-ops` /
 *      `field-ops`, minus the three `hidden: true` entries (`setParagraphAttrs`,
 *      `stepIndent`, `stepHangingIndent`) that are UI-only and are rejected when
 *      the model calls them.
 *
 *   2. the PLANNER — turning `office_edit`'s flat op list into the bridge's
 *      commands, preserving order and keeping each run of registry ops in ONE
 *      `apply_ops` call so the registry's batch validation and single-undo
 *      behavior survive.
 *
 * Nothing here is GenOffice-internal state: the panel is the authority on
 * whether an op is valid, and its rejection text is passed through verbatim.
 */

/**
 * Op names the model may call, grouped the way the guide presents them.
 *
 * A grouping for reading, not a constraint — the registry validates the batch
 * as a whole and names what it did not recognize.
 */
export const DOCX_OP_GROUPS: Record<string, readonly string[]> = {
  text: ['setFont', 'setMatchedFont', 'setParagraphFormat', 'setHeadingLevel', 'findReplace'],
  lists: ['setList', 'clearList', 'applyStyle'],
  blocks: ['deleteBlocks', 'moveBlocks'],
  tables: [
    'insertTableRow',
    'deleteTableRow',
    'insertTableColumn',
    'deleteTableColumn',
    'mergeTableCells',
    'splitTableCell',
    'setTableCellFormat',
    'setTableStyle',
  ],
  images: ['setImageProperties', 'insertToc'],
  fields: ['insertField', 'insertBookmark', 'updateFields'],
};

/** Every op name the model may call. */
export const DOCX_OPS: readonly string[] = Object.values(DOCX_OP_GROUPS).flat();

/** The bridge commands that are NOT registry ops, and so are not batched. */
export const DOCX_BLOCK_COMMANDS = ['insert_content', 'replace_blocks'] as const;

/** One op as the agent writes it. Extra keys are the op's own fields. */
export interface DocxOp {
  op: string;
  target?: unknown;
  [key: string]: unknown;
}

/**
 * The guide `office_guide` returns for `domain: "docx"`.
 *
 * Written around the workflow rather than as a schema dump, because the
 * mistakes an agent actually makes here are workflow mistakes: editing without
 * reading first (stale block indexes), and forgetting that the document has to
 * be open in the viewer before any of it works.
 */
export function docxGuide(): string {
  return [
    'docx ops edit the OPEN document through GenOffice\'s own editor. They are:',
    '',
    '  { op: "<name>", target: {...}, <the op\'s fields> }',
    '',
    'Target — which part of the document the op applies to. Conditions AND together,',
    'and AT LEAST ONE is required:',
    '',
    '  blockIndexes: number[]   block indexes as office_read reported them, 0-based',
    '  containsText: string     the block\'s text contains this (+ matchCase: boolean)',
    '  nodeType: "docHeading" | "docParagraph" | "docListItem" | "image" | "table"',
    '  headingLevel: number     only with nodeType "docHeading"',
    '  scope: "selection"       only the blocks the current selection covers',
    '  range: { from, to }      explicit ProseMirror positions',
    '',
    'THE WHOLE DOCUMENT IS SPELLED BY OMITTING `target` ENTIRELY — there is no',
    '`scope: "document"`. Writing one is rejected as "target requires at least one',
    'condition", which is the validator saying it saw no condition at all.',
    '',
    '`scope: "selection"` IS NOT "the bit the user selected" — it is "whatever range is',
    'selected RIGHT NOW", and with nothing selected it silently becomes the block the',
    'CARET is in. office_read reports both (it ends with e.g. "No selection; cursor is',
    'in block 2"), so read that line before choosing. When the user selected something',
    'and then asked for a change, that selection is already gone by the time you run —',
    'use the block indexes office_read gave you instead.',
    '',
    'Fields are PATCHES: a key present sets it, null clears it, a key absent leaves it',
    'alone. So { op: "setFont", target, bold: true } bolds without touching size or colour.',
    '',
    `Ops (${DOCX_OPS.length}):`,
    ...Object.entries(DOCX_OP_GROUPS).map(([group, names]) => `  ${group.padEnd(7)} ${names.join(', ')}`),
    '',
    'Examples:',
    '  { op: "findReplace", find: "甲方", replace: "乙方" }              // whole document',
    '  { op: "setFont", target: { blockIndexes: [0] }, bold: true }',
    '  { op: "setHeadingLevel", target: { blockIndexes: [3] }, level: 1 }',
    '  { op: "setParagraphFormat", target: { containsText: "摘要" }, align: "center" }',
    '',
    'Two whole-block commands are also accepted in the same `ops` array, for adding',
    'content the op registry cannot express:',
    '',
    '  { op: "insert_content",  html: "<p>…</p>", afterBlockIndex?: number }   -1 = at the very start',
    '  { op: "replace_blocks",  startBlockIndex: number, endBlockIndex: number, html: "…" }',
    '',
    'A batch is validated as a whole: if any op is rejected, none of it is applied and the',
    'failure says which op and why. Pass dryRun: true to validate without writing.',
    '',
    'TWO THINGS THAT WILL BITE:',
    '  - The document must be OPEN in the file viewer. These ops drive a live editor;',
    '    there is no headless path. If it is not open, office_edit says so — open it',
    '    (files_probe_open) and retry.',
    '  - Block indexes come from office_read and go stale the moment anything edits the',
    '    document. Read again rather than reusing an index from earlier in the session.',
  ].join('\n');
}

/** A bridge command and its payload. */
export interface DocxCommand {
  command: 'apply_ops' | 'insert_content' | 'replace_blocks';
  payload: Record<string, unknown>;
}

/**
 * Turn a flat op list into ordered bridge commands.
 *
 * Consecutive registry ops collapse into ONE `apply_ops` so the registry
 * validates them together and a single undo reverts the batch. A block command
 * interrupts the run — it is a different executor and cannot ride along — and
 * the remaining registry ops start a new batch.
 *
 * `dryRun` reaches only `apply_ops`, which has its own dry-run mode; the two
 * block commands have none, so a dry run refuses them rather than quietly
 * editing a document the caller asked to leave alone.
 */
export function planDocxCommands(ops: readonly DocxOp[], dryRun: boolean): DocxCommand[] {
  const commands: DocxCommand[] = [];
  let batch: DocxOp[] = [];

  const flush = (): void => {
    if (batch.length === 0) return;
    commands.push({ command: 'apply_ops', payload: { ops: batch, ...(dryRun ? { dryRun: true } : {}) } });
    batch = [];
  };

  for (const entry of ops) {
    const name = typeof entry?.op === 'string' ? entry.op : '';

    if (name === 'insert_content' || name === 'replace_blocks') {
      if (dryRun) {
        throw new Error(
          `dryRun cannot validate "${name}" — it has no dry-run mode, and running it would edit the ` +
            'document. Validate the registry ops separately, or drop dryRun to apply the whole batch.',
        );
      }
      flush();
      if (name === 'insert_content') {
        const html = entry.html;
        if (typeof html !== 'string') throw new Error('insert_content: "html" is required');
        const after = entry.afterBlockIndex;
        commands.push({
          command: 'insert_content',
          payload: { html, ...(typeof after === 'number' ? { afterBlockIndex: after } : {}) },
        });
      } else {
        const { startBlockIndex: start, endBlockIndex: end, html } = entry;
        if (typeof start !== 'number' || typeof end !== 'number' || typeof html !== 'string') {
          throw new Error(
            'replace_blocks: "startBlockIndex", "endBlockIndex" (numbers) and "html" (string) are all required',
          );
        }
        commands.push({ command: 'replace_blocks', payload: { startBlockIndex: start, endBlockIndex: end, html } });
      }
      continue;
    }

    batch.push(entry);
  }

  flush();
  if (commands.length === 0) throw new Error('no ops to apply');
  return commands;
}
