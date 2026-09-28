/**
 * Stand-in for `@genoffice/agent-core`.
 *
 * Only the *type* `AgentSkill` is imported from it, by two files under `ai/`
 * that describe document skills to GenOffice's agent. The plugin runs the
 * host's agent, so nothing from this package executes — the import exists to
 * satisfy the type checker in GenOffice's own source, which we do not modify.
 */

export interface AgentSkill {
  name?: string;
  description?: string;
  [key: string]: unknown;
}

export interface AgentMessage {
  role?: string;
  content?: unknown;
  [key: string]: unknown;
}

export interface AgentToolCall {
  name?: string;
  arguments?: unknown;
  [key: string]: unknown;
}

export interface AgentToolDef {
  name?: string;
  description?: string;
  parameters?: unknown;
  [key: string]: unknown;
}

export type AgentTransport = unknown;
export type AgentImage = unknown;

/**
 * The pieces sheets' App.tsx imports at module scope.
 *
 * They belong to GenOffice's agent, which the plugin replaces — but an unused
 * import still has to resolve, so they exist and refuse to run. Constructing an
 * `AgentLoop` must fail loudly rather than silently producing an agent that
 * never calls the host.
 */
export class AgentLoop {
  /** Constructible but inert. Throwing here was wrong: sheets' App builds one
   *  during render, so a throw took the whole editor down with it — the AI
   *  panel is optional, the spreadsheet is not. Methods refuse instead. */
  run(): never {
    throw new Error('GenOffice 的 agent 未随插件分发；AI 由宿主的 agent 处理');
  }
  abort(): void {
    /* nothing to abort */
  }
  dispose(): void {
    /* nothing to dispose */
  }
}

/** GenOffice's sentinel for "the task finished by calling tools" — a literal. */
export const COMPLETED_VIA_TOOLS_TEXT = '[completed-via-tools]';

export function composeSkills(..._args: unknown[]): unknown[] {
  return [];
}
