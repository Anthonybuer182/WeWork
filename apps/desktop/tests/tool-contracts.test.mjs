/**
 * The tool-contract layer: prompt snippets/guidelines, output bounds, image
 * filtering, and error normalization.
 *
 * These are pure functions on purpose — the `afterToolCall` gate is a thin
 * wrapper around `applyToolContract`, so the behavior that decides what the
 * MODEL sees can be asserted without booting Electron or an agent session.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_MAX_OUTPUT_CHARS,
  DEFAULT_MAX_OUTPUT_LINES,
  ToolContractRegistry,
  applyToolContract,
  deriveSnippet,
} from '../src/main/tools/contracts.ts';

test('deriveSnippet uses the first description line and caps its length', () => {
  assert.equal(deriveSnippet('alpha', 'Read alpha.\nSecond line.'), 'Read alpha.');
  assert.equal(deriveSnippet('alpha', '# Heading\nbody'), 'Heading');
  assert.equal(deriveSnippet('alpha', undefined), 'alpha tool');
  const long = deriveSnippet('alpha', 'x'.repeat(400));
  assert.equal(long.length, 120);
  assert.ok(long.endsWith('…'));
});

test('summary wins over the description', () => {
  const registry = new ToolContractRegistry({
    alpha: { domain: 'demo', summary: 'Read alpha', guidelines: ['first bullet'] },
  });
  assert.equal(registry.snippetFor('alpha', 'A much longer description'), 'Read alpha');
  assert.deepEqual(registry.guidelinesFor('alpha'), ['first bullet']);
});

test('manifest contract overrides a core summary and keeps the core guidance', () => {
  const registry = new ToolContractRegistry({
    alpha: { domain: 'demo', summary: 'Core summary', guidelines: ['core rule'] },
  });
  registry.register('alpha', undefined, 'manifest');
  assert.equal(registry.snippetFor('alpha'), 'Core summary');
  registry.register('alpha', { summary: 'Manifest summary' }, 'manifest');
  assert.equal(registry.snippetFor('alpha'), 'Manifest summary');
  assert.deepEqual(registry.guidelinesFor('alpha'), ['core rule']);
});

test('a tool without a manifest contract gets a default domain and limits', () => {
  const registry = new ToolContractRegistry({});
  registry.register('plain_tool', undefined, 'manifest');
  const contract = registry.resolve('plain_tool');
  assert.equal(contract?.domain, 'plugin');
  assert.equal(contract?.limits.maxOutputChars, DEFAULT_MAX_OUTPUT_CHARS);
  assert.equal(contract?.limits.maxOutputLines, DEFAULT_MAX_OUTPUT_LINES);
});

test('unsupported operations and image requirements become guidelines', () => {
  const registry = new ToolContractRegistry({
    edit: {
      unsupported: [
        { operation: 'row inserts', alternativeTool: 'other_edit', hint: 'Do not hand-edit XML.' },
      ],
      requiresModel: { input: 'image' },
    },
  });
  const guidelines = registry.guidelinesFor('edit') ?? [];
  assert.ok(guidelines.some((line) => line.includes('row inserts')));
  assert.ok(guidelines.some((line) => line.includes('other_edit')));
  assert.ok(guidelines.some((line) => line.includes('images')));
});

test('output over the contract limit is truncated with a marker, details untouched', () => {
  const registry = new ToolContractRegistry({ big: { limits: { maxOutputChars: 1_000 } } });
  const details = { keep: true };
  const outcome = applyToolContract({
    toolName: 'big',
    contract: registry.resolve('big'),
    content: [{ type: 'text', text: 'x'.repeat(5_000) }],
    details,
    isError: false,
  });
  assert.equal(outcome.info.truncated, true);
  assert.equal(outcome.changed, true);
  assert.deepEqual(outcome.details, details);
  const text = outcome.content.map((block) => block.text ?? '').join('');
  assert.ok(text.length < 1_100);
  assert.ok(text.includes('output truncated'));
});

test('truncation names the cursor parameter when the contract declares one', () => {
  const registry = new ToolContractRegistry({
    paged: { limits: { maxOutputChars: 1_000, cursorParam: 'offset' } },
  });
  const outcome = applyToolContract({
    toolName: 'paged',
    contract: registry.resolve('paged'),
    content: [{ type: 'text', text: 'x'.repeat(5_000) }],
    details: {},
    isError: false,
  });
  assert.ok(outcome.content.at(-1)?.text?.includes('`offset`'));
});

test('a tool without a contract is not truncated (built-ins keep their own bounds)', () => {
  const outcome = applyToolContract({
    toolName: 'bash',
    content: [{ type: 'text', text: 'x'.repeat(60_000) }],
    details: {},
    isError: false,
  });
  assert.equal(outcome.info.truncated, false);
  assert.equal(outcome.changed, false);
  assert.equal(outcome.content[0].text.length, 60_000);
});

test('images are dropped for a text-only model and kept for a vision model', () => {
  const content = [
    { type: 'text', text: 'done' },
    { type: 'image', data: 'AAAA', mimeType: 'image/png' },
  ];
  const textOnly = applyToolContract({
    toolName: 'snap',
    content,
    details: {},
    isError: false,
    modelInput: ['text'],
  });
  assert.equal(textOnly.content.some((block) => block.type === 'image'), false);
  assert.ok(textOnly.content.some((block) => block.text?.includes('image omitted')));
  assert.equal(textOnly.info.imagesDropped, 1);

  const vision = applyToolContract({
    toolName: 'snap',
    content,
    details: {},
    isError: false,
    modelInput: ['text', 'image'],
  });
  assert.equal(vision.content.some((block) => block.type === 'image'), true);
  assert.equal(vision.info.imagesDropped, 0);
});

test('an existing image-omitted note is not duplicated', () => {
  const outcome = applyToolContract({
    toolName: 'read',
    content: [
      { type: 'text', text: '[Current model does not support images. The image will be omitted]' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    ],
    details: {},
    isError: false,
    modelInput: ['text'],
  });
  const notes = outcome.content.filter(
    (block) => block.type === 'text' && /image (?:was )?omitted|does not support images/i.test(block.text ?? ''),
  );
  assert.equal(notes.length, 1);
});

test('an error from a registered tool gets a tool-name prefix and stays an error', () => {
  const registry = new ToolContractRegistry({ broken: {} });
  const outcome = applyToolContract({
    toolName: 'broken',
    contract: registry.resolve('broken'),
    content: [{ type: 'text', text: 'it failed' }],
    details: {},
    isError: true,
  });
  assert.equal(outcome.isError, true);
  assert.equal(outcome.content[0].text, '[broken] it failed');
});

test('an empty error still explains which tool failed', () => {
  const registry = new ToolContractRegistry({ broken: {} });
  const outcome = applyToolContract({
    toolName: 'broken',
    contract: registry.resolve('broken'),
    content: [],
    details: {},
    isError: true,
  });
  assert.equal(outcome.content[0].text, '[broken] failed without a message');
});

test('a bad contract cannot set a zero or unbounded limit', () => {
  const registry = new ToolContractRegistry({
    weird: { limits: { maxOutputChars: 0, maxOutputLines: 10_000_000 } },
  });
  const contract = registry.resolve('weird');
  assert.equal(contract?.limits.maxOutputChars, 1_000);
  assert.equal(contract?.limits.maxOutputLines, 10_000);
});
