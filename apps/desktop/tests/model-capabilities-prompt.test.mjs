/**
 * The standing capability note must describe the model that is actually
 * selected. The old prompt claimed vision for every model, which is how a
 * text-only run ended up screenshotting and cropping an image it could never
 * see.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelCapabilitiesOf } from '../../../packages/sdk-wrapper/src/adapters/config.ts';
import {
  HOST_TEXT_ONLY_PROMPT,
  HOST_UNKNOWN_CAPABILITY_PROMPT,
  HOST_VISION_PROMPT,
  buildHostAppendSystemPrompt,
  capabilityPromptFor,
  isHostCapabilityPrompt,
} from '../../../packages/sdk-wrapper/src/adapters/chat.ts';

const NO_INTERACTION_TOOLS = new Set();

test('modelCapabilitiesOf distinguishes vision, text-only and unknown', () => {
  const vision = modelCapabilitiesOf({ input: ['text', 'image'], contextWindow: 128_000 });
  assert.deepEqual(vision?.input, ['text', 'image']);
  assert.equal(vision?.vision, true);
  assert.equal(vision?.contextWindow, 128_000);

  const text = modelCapabilitiesOf({ input: ['text'] });
  assert.equal(text?.vision, false);

  assert.equal(modelCapabilitiesOf({ input: [] }), undefined);
  assert.equal(modelCapabilitiesOf(undefined), undefined);
});

test('capabilityPromptFor picks the matching note', () => {
  assert.equal(capabilityPromptFor({ input: ['text', 'image'], vision: true }), HOST_VISION_PROMPT);
  assert.equal(capabilityPromptFor({ input: ['text'], vision: false }), HOST_TEXT_ONLY_PROMPT);
  assert.equal(capabilityPromptFor(undefined), HOST_UNKNOWN_CAPABILITY_PROMPT);
  assert.equal(capabilityPromptFor(null), HOST_UNKNOWN_CAPABILITY_PROMPT);
});

test('a text-only model is never told it has vision', () => {
  const segments = buildHostAppendSystemPrompt('', NO_INTERACTION_TOOLS, {
    input: ['text'],
    vision: false,
  });
  assert.deepEqual(segments, [HOST_TEXT_ONLY_PROMPT]);
  assert.equal(segments.includes(HOST_VISION_PROMPT), false);
});

test('a vision model gets the existing vision note', () => {
  const segments = buildHostAppendSystemPrompt('', NO_INTERACTION_TOOLS, {
    input: ['text', 'image'],
    vision: true,
  });
  assert.deepEqual(segments, [HOST_VISION_PROMPT]);
});

test('an unknown capability gets the neutral note', () => {
  assert.deepEqual(buildHostAppendSystemPrompt('', NO_INTERACTION_TOOLS), [
    HOST_UNKNOWN_CAPABILITY_PROMPT,
  ]);
});

test('host capability prompts are recognized and user text is not', () => {
  assert.equal(isHostCapabilityPrompt(HOST_VISION_PROMPT), true);
  assert.equal(isHostCapabilityPrompt(HOST_TEXT_ONLY_PROMPT), true);
  assert.equal(isHostCapabilityPrompt(HOST_UNKNOWN_CAPABILITY_PROMPT), true);
  assert.equal(isHostCapabilityPrompt('You have vision.'), false);
});
