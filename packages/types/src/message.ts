import type { TokenUsage } from './usage.js';

export type MessageRole = 'user' | 'assistant' | 'system';

export type MessageStatus = 'pending' | 'streaming' | 'complete' | 'error';

export interface ContentBlock {
  id: string;
  type: 'text' | 'thinking' | 'tool_call' | 'tool_result' | 'image' | 'file' | 'quote';
  content: string;
  metadata?: Record<string, unknown>;
  // Subtype-specific optional properties
  thinking?: string;
  duration?: number;
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: string;
  isError?: boolean;
  // Image/file specific
  mimeType?: string;
  data?: string;
  width?: number;
  height?: number;
  fileName?: string;
  fileSize?: number;
  workspacePath?: string;
  durationMs?: number;
  // Quote specific
  filePath?: string;
  source?: string;
  startLine?: number;
  endLine?: number;
  pageNumber?: number;
  slideNumber?: number;
  sheetName?: string;
}

export interface ThinkingBlock extends ContentBlock {
  type: 'thinking';
  thinking: string;
  duration?: number;
}

export interface ToolCallBlock extends ContentBlock {
  type: 'tool_call';
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  durationMs?: number;
}

export interface ToolResultBlock extends ContentBlock {
  type: 'tool_result';
  toolCallId: string;
  result: string;
  isError?: boolean;
  /** Tool name (for plugin message-renderer dispatch). */
  toolName?: string;
  /** Plugin declarative card tree (messageRenderer contribution). */
  card?: import('./plugin/ui-tree.js').UiNode;
}

export interface ImageBlock {
  id: string;
  type: 'image';
  content: string;       // alt text or description
  mimeType: string;
  data: string;          // base64 encoded image data
  width?: number;
  height?: number;
}

export interface FileBlock {
  id: string;
  type: 'file';
  content: string;       // filename or description
  mimeType: string;
  data?: string;         // base64 data (for displayable files)
  fileName?: string;
  fileSize?: number;
  /** Workspace-relative path for opening file in right-panel preview */
  workspacePath?: string;
}

export interface QuoteBlock {
  id: string;
  type: 'quote';
  content: string;        // quoted text content
  fileName: string;       // source file name
  filePath: string;       // source file path
  source: string;         // QuoteSource
  startLine?: number;
  endLine?: number;
  pageNumber?: number;
  slideNumber?: number;
  sheetName?: string;
}

export interface Message {
  id: string;
  sessionId: string;
  role: MessageRole;
  status: MessageStatus;
  content: string;
  blocks: ContentBlock[];
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
  /** Raw entry ID from SessionManager, used for tree navigation (branch/edit) */
  entryId?: string;
}

export interface UserMessage extends Message {
  role: 'user';
  attachments?: string[];
}

export interface AssistantMessage extends Message {
  role: 'assistant';
  modelId: string;
  usage?: TokenUsage;
}

export interface SystemMessage extends Message {
  role: 'system';
}
