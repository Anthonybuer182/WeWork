/**
 * The pptx backend contract — the stage-1a deliverable.
 *
 * Stage 1a is "the agent loop with no DOM at all": open a deck, run a batch of
 * ops through the registry, serialize. This proves that loop headlessly, in a
 * couple of seconds, with no Electron — which is the whole reason pptx is
 * first: `pptx-ops` is a standalone package and `pptx-render` builds a
 * canvas-free RenderTree, so nothing here needs a browser.
 *
 * What is actually being pinned:
 *   - the registry is populated (a barrel that fails to import its op modules
 *     silently yields an empty vocabulary, and every op then reports
 *     "unknown op", which looks like a caller mistake)
 *   - a transaction mutates and serializes, and the change survives a re-open
 *   - `dryRun` validates without writing
 *   - a batch is ATOMIC: one bad op leaves the document untouched
 *   - failures carry the guided fields an agent needs to self-correct
 *     (`reason`, `available`), not just prose
 *
 * The last two are the ones worth having. A model recovers from
 * "no element e_9 on slide 2. Available: [e_2, e_3]" and blind-retries a bare
 * "failed".
 */
import { createBlankPptx, openPptx, savePptx } from '@genoffice/pptx-engine';
import { opNames, runTxn, type Op } from '@genoffice/pptx-ops';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

const slideCount = (opened) => opened.deck?.slides?.length ?? -1;

console.log('pptx backend contract\n');

// ── registry ────────────────────────────────────────────────────────────
const names = opNames();
console.log(`  registry: ${names.length} ops\n`);
check(
  'the op registry is populated',
  names.length > 20,
  `only ${names.length} op(s) — an op module failed to import, so every call would report "unknown op"`,
);
check('addBlankSlide is registered', names.includes('addBlankSlide'));
check('setFill is registered', names.includes('setFill'));

// ── a committed transaction survives a save/re-open round trip ──────────
const blank = await createBlankPptx();
const opened = await openPptx(blank);
const before = slideCount(opened);

const added = runTxn(opened, { ops: [{ op: 'addBlankSlide', target: { slide: 0 } }] });
check(
  'a transaction applies',
  added.applied === true,
  `failures: ${JSON.stringify(added.failures ?? null)}`,
);

const saved = await savePptx(opened);
check('the saved bytes differ from the input', saved.length !== blank.length || Buffer.compare(Buffer.from(saved), Buffer.from(blank)) !== 0);

const reopened = await openPptx(saved);
check(
  `the change survives a re-open (${before} → ${slideCount(reopened)} slides)`,
  slideCount(reopened) === before + 1,
);

// ── dryRun validates without writing ────────────────────────────────────
const opened2 = await openPptx(saved);
const count2 = slideCount(opened2);
const dry = runTxn(opened2, { dryRun: true, ops: [{ op: 'addBlankSlide', target: { slide: 0 } }] });
// `applied: false` is correct for a dry run — nothing was written. What marks
// success is dryRun + a validated plan.
check('dryRun validates without applying', dry.dryRun === true && dry.applied === false);
check('dryRun returns a plan', Array.isArray(dry.plan) && dry.plan.length > 0, `plan: ${JSON.stringify(dry.plan)}`);
check('dryRun did not mutate the document', slideCount(opened2) === count2);

// ── atomicity: one bad op rolls the whole batch back ────────────────────
const opened3 = await openPptx(saved);
const count3 = slideCount(opened3);
const badBatch: Op[] = [
  { op: 'addBlankSlide', target: { slide: 0 } },
  // Slide 99 does not exist. With the default atomic isolation the first op
  // must be undone, not left applied.
  { op: 'addBlankSlide', target: { slide: 99 } },
];
const failed = runTxn(opened3, { ops: badBatch });
check('a failing batch reports failure', failed.applied === false);
check(
  'a failing batch rolled back the ops before it',
  slideCount(opened3) === count3,
  `slide count changed ${count3} → ${slideCount(opened3)} despite the batch failing`,
);

// ── guided errors carry machine-readable fields ─────────────────────────
const first = failed.failures?.[0];
check('the failure names the offending op index', typeof first?.index === 'number' && first.index === 1, JSON.stringify(first));
// `op` is the whole op object as submitted, so the name is one level down.
check('the failure carries the op name', first?.op?.op === 'addBlankSlide', JSON.stringify(first?.op));
check(
  'the failure is a guided error an agent can act on',
  typeof first?.error === 'string' && first.error.length > 0,
  JSON.stringify(first?.error),
);
check(
  'the error states what was wrong AND what to do',
  /out of range/i.test(first?.error ?? '') && /Usage:/i.test(first?.error ?? ''),
  `no actionable hint in: ${first?.error}`,
);
// The atomic guarantee must be *stated*, not implied: an agent that cannot tell
// whether the earlier ops landed will re-send work that already happened.
check(
  'the error says nothing was applied',
  /Nothing was applied/i.test(first?.error ?? ''),
  `atomicity not communicated: ${first?.error}`,
);

console.log('');
if (failures) {
  console.error(`FAILED — ${failures} assertion(s)`);
  process.exit(1);
}
console.log('all assertions passed');
