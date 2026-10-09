/**
 * The permission gate's shared vocabulary.
 *
 * The gate itself lives in the desktop main process (it is the enforcer), and
 * the renderer renders its cards — but the MODE / DECISION types and the
 * "always allow" scope rule cross that boundary, so they live here. Defining
 * them twice meant the card's promise of what 总是允许 covers and what main
 * actually remembers could drift apart silently; now both sides read one
 * implementation.
 */

/** Session-scoped gate modes. 'full' intercepts nothing but audits every call
 * that 'default' would have held. In-memory only — a restart lands on 'default'. */
export type PermissionMode = 'default' | 'full';

/** A user's verdict on one approval card. */
export type PermissionDecision = 'once' | 'always' | 'deny';

/** main → renderer: a tool call is waiting for the user's verdict. */
export interface PermissionRequest {
  requestId: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  args?: Record<string, unknown>;
  /** One-line summary shown on the approval card (command / path / …). */
  summary: string;
}

/** Decisions the renderer may put on the wire — anything else fails closed. */
export const PERMISSION_DECISIONS: readonly PermissionDecision[] = ['once', 'always', 'deny'];

export function isPermissionDecision(value: unknown): value is PermissionDecision {
  return typeof value === 'string' && (PERMISSION_DECISIONS as readonly string[]).includes(value);
}

/**
 * The "always allow" scope, enforced by main: bash remembers its first word
 * (all `git …` commands), every other tool remembers the tool name. This is
 * the single source both the gate's memory and the card's description read.
 */
export function permissionRuleKey(toolName: string, args: Record<string, unknown> | undefined): string {
  if (toolName === 'bash' && typeof args?.command === 'string') {
    const firstWord = args.command.trim().split(/\s+/)[0] ?? '';
    if (firstWord) return `bash:${firstWord}`;
  }
  return `tool:${toolName}`;
}

/**
 * What the user is agreeing to when they click 总是允许, in the same coarse
 * units `permissionRuleKey` remembers — derived from the same rule, so the
 * card's promise can never disagree with what the gate actually records.
 */
export function permissionAlwaysScope(toolName: string, args: Record<string, unknown> | undefined): string {
  if (toolName === 'bash' && typeof args?.command === 'string') {
    const firstWord = args.command.trim().split(/\s+/)[0];
    if (firstWord) return `本会话内放行所有以 ${firstWord} 开头的命令`;
  }
  return `本会话内放行 ${toolName} 的所有调用`;
}
