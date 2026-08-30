import type { Message, ContentBlock, TokenUsage, ContextUsageInfo, SessionStatsInfo, MessageTiming, ToolTiming, QueueState, StreamingBehavior } from '@pi/types';

export interface SendMessageParams {
  sessionId: string;
  content: string;
  /** Image attachments with base64 data for vision models */
  attachments?: { name: string; mimeType: string; data: string }[];
  modelId?: string;
  workspaceCwd?: string;
  /** Queue the message as a steer or follow-up while the agent is working */
  streamingBehavior?: StreamingBehavior;
  /** Skill IDs (e.g., 'skill-officecli') that should be enabled for this message. Filters skills loaded by the resource loader. */
  skills?: string[];
}

export interface StreamChunk {
  type: 'text' | 'block' | 'usage' | 'context' | 'stats' | 'message_start' | 'message_timing' | 'tool_timing' | 'queue_update' | 'done' | 'error';
  content?: string;
  block?: ContentBlock;
  error?: string;
  usage?: TokenUsage;
  contextUsage?: ContextUsageInfo;
  sessionStats?: SessionStatsInfo;
  messageTiming?: MessageTiming;
  toolTiming?: ToolTiming;
  /** Current state of the steering and follow-up queues */
  queueState?: QueueState;
}

export interface NavigateTreeOptions {
  /** If true, AI summarizes the abandoned branch before switching */
  summarize?: boolean;
  /** Custom instructions for the summary prompt */
  customInstructions?: string;
  /** Label to attach to the branch summary entry */
  label?: string;
}

export interface NavigateTreeResult {
  /** Text content of the target user message (for pre-filling editor) */
  editorText?: string;
  /** Whether the user cancelled the operation */
  cancelled: boolean;
}

/** Result of a session compaction operation */
export interface CompactResult {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: unknown;
}

export interface ChatService {
  /** Optional: tear down cached sessions so the next prompt rebuilds them
   *  (plugin tool/skill sets changing at runtime). */
  invalidateSessions?(): void;
  sendMessage(params: SendMessageParams): Promise<Message>;
  sendMessageStream(
    params: SendMessageParams,
    onChunk: (chunk: StreamChunk) => void,
    signal?: AbortSignal,
  ): Promise<Message>;
  getMessages(sessionId: string, limit?: number, offset?: number): Promise<Message[]>;
  stopGeneration(sessionId: string): Promise<void>;
  /**
   * Queue a steering message that is delivered after the current assistant turn's
   * tool calls complete, before the next LLM invocation. Use to redirect the agent.
   */
  steer(sessionId: string, content: string, images?: { name: string; mimeType: string; data: string }[]): Promise<void>;
  /**
   * Queue a follow-up message that is delivered only after the agent has finished
   * all work (all tool calls and steering messages processed). Use to append
   * additional tasks.
   */
  followUp(sessionId: string, content: string, images?: { name: string; mimeType: string; data: string }[]): Promise<void>;
  /**
   * Navigate to a different node in the session tree.
   * Moves the leaf pointer to the target entry so the next prompt creates a new branch.
   * @param sessionId - Session ID
   * @param entryId - Raw entry ID from SessionManager (the entryId field on a Message)
   * @param options - Navigation options (summarize, label, etc.)
   */
  navigateTree(sessionId: string, entryId: string, options?: NavigateTreeOptions): Promise<NavigateTreeResult>;
  /**
   * Compacts the conversation context to reduce token usage.
   * Summarizes older messages while preserving key context and decisions.
   * @param sessionId - Session ID
   * @param customInstructions - Optional custom instructions for the summary
   */
  compact(sessionId: string, customInstructions?: string): Promise<CompactResult>;
}
