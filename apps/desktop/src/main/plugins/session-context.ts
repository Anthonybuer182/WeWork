/**
 * toolCallId → sessionId correlation for plugin tool calls.
 *
 * The permission gate sees every call together with its session
 * (`beforeToolCall`), while the plugin execute closure only ever sees the
 * toolCallId. This registry is the bridge: recorded at permission-check time,
 * popped at plugin-execution time. Agent tool calls that are not plugin tools
 * are recorded too — the cap keeps them from accumulating.
 */

const pending = new Map<string, string>();

/** Bound the map: toolCallIds are unique per call, so FIFO eviction discards
 *  exactly the entries least likely to still be correlated. */
const MAX_PENDING = 500;

export function recordToolSession(toolCallId: string, sessionId: string): void {
  if (pending.size >= MAX_PENDING) {
    const oldest = pending.keys().next().value;
    if (oldest !== undefined) pending.delete(oldest);
  }
  pending.set(toolCallId, sessionId);
}

/** Pop the session for one tool call — undefined for calls that never went
 *  through a permission gate (direct invocations in tests). */
export function takeToolSession(toolCallId: string): string | undefined {
  const sessionId = pending.get(toolCallId);
  if (sessionId !== undefined) pending.delete(toolCallId);
  return sessionId;
}
