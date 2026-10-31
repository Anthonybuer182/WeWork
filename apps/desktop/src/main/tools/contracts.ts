/**
 * Tool contracts: what a tool can do, what it cannot, and how big its result
 * may be before the host intervenes.
 *
 * The SDK's model-facing tool declaration keeps only name/description/params,
 * so contract metadata cannot ride on the tool object. Instead this registry
 * translates the useful parts into the two channels the model actually reads —
 * `promptSnippet` (the Available tools section) and `promptGuidelines` (the
 * Guidelines section) — and enforces the output bounds in one place,
 * `session.agent.afterToolCall`, which sees built-in and custom tools alike.
 *
 * Nothing here patches the agent core or a vendor package. Everything is
 * optional: a plugin without a contract still gets a derived one-line summary
 * and the default output bounds; a built-in tool (no registry entry) is left
 * alone except for image filtering, because the SDK already bounds its own
 * output.
 */

import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { ToolContract } from '@pi/types';

export type ContractSource = 'manifest' | 'host' | 'core';

/** A contract after defaults/clamping; every registered tool has limits. */
export interface ResolvedToolContract extends ToolContract {
  source: ContractSource;
  domain: string;
  limits: {
    maxOutputChars: number;
    maxOutputLines: number;
    cursorParam?: string;
  };
}

/** The subset of TextContent | ImageContent this module touches. */
export interface ToolContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  [key: string]: unknown;
}

export interface ToolContractEvent {
  tool: string;
  sessionKey: string;
  domain: string;
  source: ContractSource | 'builtin';
  ok: boolean;
  truncated: boolean;
  imagesDropped: number;
  outputChars: number;
  modelInput: string[] | null;
}

export interface ApplyToolContractInput {
  toolName: string;
  contract?: ResolvedToolContract;
  content: readonly ToolContentBlock[];
  details: unknown;
  isError: boolean;
  /** The active model's declared inputs; undefined = unknown. */
  modelInput?: readonly string[];
  sessionKey?: string;
}

export interface ContractOutcome {
  content: ToolContentBlock[];
  details: unknown;
  isError: boolean;
  changed: boolean;
  info: ToolContractEvent;
}

export const DEFAULT_MAX_OUTPUT_CHARS = 50_000;
export const DEFAULT_MAX_OUTPUT_LINES = 2_000;
const MIN_OUTPUT_CHARS = 1_000;
const MAX_OUTPUT_CHARS = 200_000;
const MIN_OUTPUT_LINES = 50;
const MAX_OUTPUT_LINES = 10_000;
const SNIPPET_MAX = 120;

/**
 * First-party contracts. These are consumers of the same public shape a
 * third-party manifest declares; keeping them central means the host works
 * even when the installed plugin copy of a manifest predates the field.
 */
export const CORE_CONTRACTS: Record<string, ToolContract> = {
  office_read: {
    domain: 'office',
    summary: 'Read an Office document structure (pptx slides/elements, xlsx sheets/cells, docx blocks) before editing it.',
    guidelines: [
      'Read first: the ids/addresses a later office_edit needs come from office_read.',
      'xlsx reads return a capped sample of cells; do not assume an address exists just because it is outside the sample.',
    ],
  },
  office_edit: {
    domain: 'office',
    summary: 'Apply a batch of edits to an Office document and save it; call office_read first.',
    guidelines: [
      'xlsx edits change cell values only. Inserting/copying/removing rows or columns, merging cells, and style edits are NOT supported.',
      'When a structural edit is unsupported, state the limitation; do not hand-edit OOXML with bash/python.',
      'Use dryRun to validate a batch before writing.',
    ],
    limits: { maxOutputChars: 8_000 },
    unsupported: [
      {
        operation: 'xlsx structural edits (insert/copy rows, merge cells, formatting)',
        hint: 'This tool cannot do it; report the limitation instead of falling back to raw XML.',
      },
    ],
  },
  office_guide: {
    domain: 'office',
    summary: 'Fetch the edit-op vocabulary and field tables for a document domain.',
  },
  files_open: {
    domain: 'filesystem',
    summary: "Open a file in this conversation's viewer panel.",
  },
  files_search: {
    domain: 'filesystem',
    summary: 'Find files by name/description in the workspace; returns paths for a later read/open.',
  },
  todotool: {
    domain: 'planning',
    summary: 'Replace the working checklist for the current task (working memory, not the user planner).',
    guidelines: [
      'Use it only for tasks with three or more steps or multiple files; keep exactly one item in_progress and verify before marking complete.',
    ],
  },
  asktool: {
    domain: 'interaction',
    summary: 'Ask the user one or more decision questions and wait for the answers.',
  },
  context_audit: {
    domain: 'context',
    summary: "Report the agent's standing context (system prompt, files, skills, tool schemas) and its token cost.",
  },
};

const SOURCE_PRIORITY: Record<ContractSource, number> = {
  core: 1,
  host: 2,
  manifest: 3,
};

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

function optionalString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function inferDomain(name: string): string {
  if (name.startsWith('browser_')) return 'browser';
  if (name.startsWith('office_')) return 'office';
  if (name.startsWith('files_')) return 'filesystem';
  if (name.startsWith('item_')) return 'planner';
  return 'plugin';
}

function resolveContract(
  name: string,
  contract: ToolContract | undefined,
  source: ContractSource,
): ResolvedToolContract {
  const limits = contract?.limits;
  const cursorParam = optionalString(limits?.cursorParam, 40);
  return {
    ...(contract ?? {}),
    source,
    domain: optionalString(contract?.domain, 40) ?? inferDomain(name),
    limits: {
      maxOutputChars: clampNumber(
        limits?.maxOutputChars,
        MIN_OUTPUT_CHARS,
        MAX_OUTPUT_CHARS,
        DEFAULT_MAX_OUTPUT_CHARS,
      ),
      maxOutputLines: clampNumber(
        limits?.maxOutputLines,
        MIN_OUTPUT_LINES,
        MAX_OUTPUT_LINES,
        DEFAULT_MAX_OUTPUT_LINES,
      ),
      ...(cursorParam && /^[A-Za-z0-9_.-]+$/.test(cursorParam) ? { cursorParam } : {}),
    },
  };
}

/** One line for the system prompt's Available tools section. */
export function deriveSnippet(name: string, description?: string): string {
  const firstLine = (description ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, '').trim())
    .find(Boolean);
  if (!firstLine) return `${name} tool`;
  return firstLine.length > SNIPPET_MAX
    ? `${firstLine.slice(0, SNIPPET_MAX - 1).trimEnd()}…`
    : firstLine;
}

function autoGuidelines(name: string, contract: ResolvedToolContract): string[] {
  const out: string[] = [];
  for (const entry of contract.unsupported ?? []) {
    const operation = optionalString(entry?.operation, 160);
    if (!operation) continue;
    const alternative = optionalString(entry?.alternativeTool, 80);
    const hint = optionalString(entry?.hint, 240);
    out.push(
      `Do not use ${name} for ${operation}.` +
        (alternative ? ` Use ${alternative} when it is available.` : '') +
        (hint ? ` ${hint}` : ''),
    );
  }
  if (contract.requiresModel?.input === 'image') {
    out.push(
      `Results from ${name} may include images; they are only visible when the active model accepts image input.`,
    );
  }
  return out;
}

export class ToolContractRegistry {
  private readonly entries = new Map<string, ResolvedToolContract>();

  constructor(core: Record<string, ToolContract> = CORE_CONTRACTS) {
    for (const [name, contract] of Object.entries(core)) {
      this.register(name, contract, 'core');
    }
  }

  /**
   * Register a tool's contract. An empty manifest contract must NOT overwrite a
   * core contract: most first-party plugins predate the field, and their
   * boundary guidance lives in CORE_CONTRACTS.
   */
  register(name: string, contract: ToolContract | undefined, source: ContractSource): void {
    const existing = this.entries.get(name);
    if (contract === undefined) {
      if (existing) return;
      this.entries.set(name, resolveContract(name, undefined, source));
      return;
    }
    if (existing && SOURCE_PRIORITY[existing.source] > SOURCE_PRIORITY[source]) return;
    // Merge over the stronger existing contract instead of replacing it: a
    // plugin that only adds a summary must not silently drop the core
    // boundary guidance and output limits for a tool of the same name.
    const merged: ToolContract = existing
      ? {
          ...existing,
          ...contract,
          limits: { ...existing.limits, ...(contract.limits ?? {}) },
        }
      : contract;
    this.entries.set(name, resolveContract(name, merged, source));
  }

  resolve(name: string): ResolvedToolContract | undefined {
    return this.entries.get(name);
  }

  /** The model-visible one-line trigger for a tool. */
  snippetFor(name: string, description?: string): string {
    const summary = optionalString(this.entries.get(name)?.summary, SNIPPET_MAX);
    return summary ?? deriveSnippet(name, description);
  }

  /** Extra behavior rules for a tool; undefined when there are none. */
  guidelinesFor(name: string): string[] | undefined {
    const contract = this.entries.get(name);
    if (!contract) return undefined;
    const lines = [
      ...(contract.guidelines ?? []).map((line) => optionalString(line, 240)).filter(Boolean),
      ...autoGuidelines(name, contract),
    ] as string[];
    const unique = [...new Set(lines)];
    return unique.length > 0 ? unique : undefined;
  }
}

// One registry for the process. Plugin tools are added by aggregateTools();
// host/core tools are registered by the constructor.
export const toolContracts = new ToolContractRegistry();

function textOf(block: ToolContentBlock): string {
  return typeof block.text === 'string' ? block.text : '';
}

function truncateTextContent(
  content: readonly ToolContentBlock[],
  limits: ResolvedToolContract['limits'],
): { content: ToolContentBlock[]; truncated: boolean; originalChars: number; keptChars: number } {
  let totalChars = 0;
  let totalLines = 0;
  for (const block of content) {
    if (block.type !== 'text') continue;
    const text = textOf(block);
    totalChars += text.length;
    totalLines += text.length === 0 ? 0 : text.split('\n').length;
  }
  if (totalChars <= limits.maxOutputChars && totalLines <= limits.maxOutputLines) {
    return { content: [...content], truncated: false, originalChars: totalChars, keptChars: totalChars };
  }

  let charBudget = limits.maxOutputChars;
  let lineBudget = limits.maxOutputLines;
  let keptChars = 0;
  const next: ToolContentBlock[] = [];
  for (const block of content) {
    if (block.type !== 'text') {
      next.push(block);
      continue;
    }
    if (charBudget <= 0 || lineBudget <= 0) continue;
    const lines = textOf(block).split('\n');
    const keptLines = lines.slice(0, lineBudget);
    let text = keptLines.join('\n');
    if (text.length > charBudget) text = text.slice(0, charBudget);
    lineBudget -= text.length === 0 ? 0 : text.split('\n').length;
    charBudget -= text.length;
    if (text.length > 0) {
      next.push({ ...block, text });
      keptChars += text.length;
    }
  }

  const marker =
    `\n\n[output truncated: kept ${keptChars.toLocaleString()} of ${totalChars.toLocaleString()} chars.` +
    (limits.cursorParam
      ? ` Pass \`${limits.cursorParam}\` to continue, or narrow the request.]`
      : ' Narrow the request to see more.]');
  next.push({ type: 'text', text: marker });
  return { content: next, truncated: true, originalChars: totalChars, keptChars };
}

function imageOmissionNote(content: readonly ToolContentBlock[]): boolean {
  return content.some(
    (block) =>
      block.type === 'text' &&
      /image (?:was )?omitted|does not support images|cannot receive images/i.test(textOf(block)),
  );
}

function dropImages(
  content: readonly ToolContentBlock[],
  wasTextOnly: boolean,
): { content: ToolContentBlock[]; dropped: number } {
  if (!wasTextOnly) return { content: [...content], dropped: 0 };
  const images = content.filter((block) => block.type === 'image').length;
  if (images === 0) return { content: [...content], dropped: 0 };
  const kept = content.filter((block) => block.type !== 'image');
  const next = [...kept];
  if (!imageOmissionNote(next)) {
    next.push({
      type: 'text',
      text: '[image omitted: the active model does not accept image input]',
    });
  }
  return { content: next, dropped: images };
}

function prefixError(
  content: readonly ToolContentBlock[],
  toolName: string,
): { content: ToolContentBlock[]; changed: boolean } {
  const firstText = content.findIndex((block) => block.type === 'text');
  if (firstText === -1) {
    return {
      content: [...content, { type: 'text', text: `[${toolName}] failed without a message` }],
      changed: true,
    };
  }
  const text = textOf(content[firstText]!);
  if (text.startsWith(`[${toolName}]`)) return { content: [...content], changed: false };
  const prefixed = [...content];
  prefixed[firstText] = {
    ...content[firstText]!,
    text: text.trim() ? `[${toolName}] ${text}` : `[${toolName}] failed without a message`,
  };
  return { content: prefixed, changed: true };
}

/**
 * Apply a tool's contract to an executed result.
 *
 * Pure: the gate and the tests share it. `details` is deliberately untouched —
 * plugins use it for UI/state and it is not model-facing.
 */
export function applyToolContract(input: ApplyToolContractInput): ContractOutcome {
  const contract = input.contract;
  const modelInputs = input.modelInput ? [...input.modelInput] : null;
  const modelIsTextOnly = modelInputs !== null && !modelInputs.includes('image');

  let content = [...input.content];
  let changed = false;
  let truncated = false;
  let imagesDropped = 0;
  let originalChars = 0;

  if (contract) {
    const before = content;
    const result = truncateTextContent(content, contract.limits);
    content = result.content;
    truncated = result.truncated;
    originalChars = result.originalChars;
    if (truncated) changed = true;
    if (!truncated) {
      // Still measure for the metrics line, without paying for a second pass
      // over the full content when truncation already did it.
      originalChars = before.reduce(
        (sum, block) => sum + (block.type === 'text' ? textOf(block).length : 0),
        0,
      );
    }
  } else {
    originalChars = input.content.reduce(
      (sum, block) => sum + (block.type === 'text' ? textOf(block).length : 0),
      0,
    );
  }

  const images = dropImages(content, modelIsTextOnly);
  if (images.dropped > 0) {
    content = images.content;
    imagesDropped = images.dropped;
    changed = true;
  }

  if (input.isError && contract) {
    const prefixed = prefixError(content, input.toolName);
    if (prefixed.changed) {
      content = prefixed.content;
      changed = true;
    }
  }

  return {
    content,
    details: input.details,
    isError: input.isError,
    changed,
    info: {
      tool: input.toolName,
      sessionKey: input.sessionKey ?? 'default',
      domain: contract?.domain ?? 'builtin',
      source: contract?.source ?? 'builtin',
      ok: !input.isError,
      truncated,
      imagesDropped,
      outputChars: originalChars,
      modelInput: modelInputs,
    },
  };
}

/**
 * Install the contract gate on one agent session.
 *
 * Wraps, never replaces, `afterToolCall` — the SDK may already have assigned
 * one for its extension runner. Previous overrides are merged first, then the
 * contract gets the final say on content/limits so a tool cannot opt out by
 * installing its own hook.
 */
export function installToolContractGate(
  session: AgentSession,
  sessionKey: string,
  registry: ToolContractRegistry = toolContracts,
): void {
  const prev = session.agent.afterToolCall;
  session.agent.afterToolCall = async (ctx, signal) => {
    const prevResult = prev ? await prev(ctx, signal) : undefined;
    const content = (prevResult?.content ?? ctx.result.content) as unknown as ToolContentBlock[];
    const details =
      prevResult && 'details' in prevResult ? prevResult.details : ctx.result.details;
    const isError = prevResult?.isError ?? ctx.isError;

    let outcome: ContractOutcome;
    try {
      outcome = applyToolContract({
        toolName: ctx.toolCall.name,
        contract: registry.resolve(ctx.toolCall.name),
        content,
        details,
        isError,
        modelInput:
          session.model?.input && session.model.input.length > 0
            ? session.model.input
            : undefined,
        sessionKey,
      });
    } catch (err) {
      // The contract layer must never break a tool call: log and preserve
      // whatever the execution/SDK produced.
      console.warn('[tool-contract] apply failed:', err);
      return prevResult;
    }

    console.info('[tool-contract]', JSON.stringify(outcome.info));
    if (!prevResult && !outcome.changed) return undefined;
    return {
      ...prevResult,
      content: outcome.content as never,
      details: outcome.details,
      isError: outcome.isError,
    };
  };
}
