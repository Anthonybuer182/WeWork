/**
 * The docx op planner: turning office_edit's flat op list into the bridge's
 * ordered commands.
 *
 * This is the one piece of the docx path that is ours rather than GenOffice's —
 * everything past it (validation, application, save) runs in the panel, in their
 * registry, and is covered by driving the real bridge. What this pins is the
 * part a regression here would break silently:
 *
 *   - registry ops stay in ONE apply_ops, so the registry's batch validation and
 *     single-undo behavior survive (splitting them would quietly weaken both)
 *   - a block command interrupts that run instead of riding along, and order is
 *     preserved across the split
 *   - a dry run cannot reach a command that has no dry-run mode — otherwise
 *     "validate without writing" would write
 */
import { DOCX_OPS, docxGuide, planDocxCommands } from '../src/backend/docx';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

const op = (name: string, extra: Record<string, unknown> = {}) => ({ op: name, ...extra });

console.log('docx op planner\n');

// ── batching ────────────────────────────────────────────────────────────
{
  const cmds = planDocxCommands(
    [op('setFont', { bold: true }), op('setHeadingLevel', { level: 1 }), op('setList')],
    false,
  );
  check('consecutive registry ops become ONE apply_ops', cmds.length === 1, `got ${cmds.length}`);
  check('the batch keeps every op', (cmds[0]?.payload.ops as unknown[])?.length === 3);
  check('a real run carries no dryRun flag', !('dryRun' in (cmds[0]?.payload ?? {})));
}

{
  const cmds = planDocxCommands([op('setFont', { bold: true })], true);
  check('dryRun reaches apply_ops', cmds[0]?.payload.dryRun === true);
}

// ── block commands split the run, and order survives ────────────────────
{
  const cmds = planDocxCommands(
    [
      op('setFont', { bold: true }),
      op('insert_content', { html: '<p>x</p>', afterBlockIndex: 2 }),
      op('setList'),
      op('setHeadingLevel', { level: 2 }),
    ],
    false,
  );
  check('a block command splits the batch', cmds.length === 3, `got ${cmds.length}`);
  check(
    'order is preserved',
    cmds.map((c) => c.command).join(',') === 'apply_ops,insert_content,apply_ops',
    cmds.map((c) => c.command).join(','),
  );
  check('the first batch holds only the op before it', (cmds[0]?.payload.ops as unknown[])?.length === 1);
  check('the second batch holds the two after it', (cmds[2]?.payload.ops as unknown[])?.length === 2);
  check('insert_content carries its payload', cmds[1]?.payload.html === '<p>x</p>');
}

{
  const cmds = planDocxCommands([op('replace_blocks', { startBlockIndex: 1, endBlockIndex: 3, html: '<p>y</p>' })], false);
  check('replace_blocks becomes its own command', cmds.length === 1 && cmds[0]?.command === 'replace_blocks');
  check('replace_blocks carries its range', cmds[0]?.payload.startBlockIndex === 1 && cmds[0]?.payload.endBlockIndex === 3);
}

// ── refusals ────────────────────────────────────────────────────────────
{
  let refused = false;
  try {
    planDocxCommands([op('insert_content', { html: '<p>x</p>' })], true);
  } catch {
    refused = true;
  }
  check('a dry run refuses insert_content rather than applying it', refused);
}

{
  let refused = false;
  try {
    planDocxCommands([op('insert_content', {})], false);
  } catch {
    refused = true;
  }
  check('insert_content without html is refused', refused);
}

{
  let refused = false;
  try {
    planDocxCommands([op('replace_blocks', { startBlockIndex: 0 })], false);
  } catch {
    refused = true;
  }
  check('replace_blocks missing its range is refused', refused);
}

{
  let refused = false;
  try {
    planDocxCommands([], false);
  } catch {
    refused = true;
  }
  check('an empty op list is refused', refused);
}

// ── the vocabulary the guide promises ───────────────────────────────────
{
  // `setParagraphAttrs` / `stepIndent` / `stepHangingIndent` are `hidden: true`
  // in GenOffice's registry — UI-only, and rejected when the model calls them.
  // Listing them would send the agent at ops it cannot use.
  const hidden = ['setParagraphAttrs', 'stepIndent', 'stepHangingIndent'];
  check('hidden ops are not advertised', hidden.every((h) => !DOCX_OPS.includes(h)), DOCX_OPS.join(', '));
  check('the list is deduplicated', new Set(DOCX_OPS).size === DOCX_OPS.length);
  check('known ops are present', ['setFont', 'findReplace', 'deleteBlocks', 'setTableStyle'].every((n) => DOCX_OPS.includes(n)));
}

// ── the guide must not send the agent at ops that get rejected ──────────
//
// This is a real regression, not a hypothetical. The guide was first written
// from GenOffice's `Target` TYPE, which declares `scope?: 'selection' |
// 'document'` — but the runtime validator only counts `'selection'` as a
// condition, so `target: { scope: "document" }` is rejected with "target
// requires at least one condition". An agent followed the guide, wrote exactly
// that, and burned a turn on it. The type is wider than the validator; the
// guide has to describe the validator.
{
  const guide = docxGuide();
  check('the guide says how to mean the whole document', /OMITTING `target` ENTIRELY/i.test(guide));
  check('the guide says there is no scope "document"', /no\s+`scope: "document"`/i.test(guide));
  check('the guide no longer claims a default of "document"', !/default "document"/.test(guide));
  check(
    'the guide warns that scope:"selection" falls back to the caret',
    /CARET is in/i.test(guide),
  );
  check(
    'every example is an op the registry will accept',
    !/target: \{ scope: "document"/.test(guide),
    guide.split('\n').filter((l) => /scope: "document"/.test(l)).join(' | '),
  );
}

console.log(failures === 0 ? '\nall assertions passed' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
