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
