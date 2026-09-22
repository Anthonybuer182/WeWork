import { create } from 'zustand';
import type { Attachment, ContentBlock, TokenUsage, ContextUsageInfo, SessionStatsInfo, MessageTiming, ToolTiming } from '@pi/types';

interface ComposerState {
  value: string;
  cursorPosition: number;
  isStreaming: boolean;
  isDragging: boolean;
  showSlashMenu: boolean;
  showMentionMenu: boolean;
  slashQuery: string;
  mentionQuery: string;
  pendingAttachments: Attachment[];
  uploadProgress: Record<string, number>;
  streamingBlocks: ContentBlock[];
  streamingUsage: TokenUsage | null;
  contextUsage: ContextUsageInfo | null;
  sessionStats: SessionStatsInfo | null;
  messageTiming: MessageTiming | null;
  toolTimings: Map<string, number>;
  streamError: string | null;
  triggerSend: number;
  /** Editing mode: the raw entry ID being edited */
  editingEntryId: string | null;
  /** Editing mode: the UI message ID being edited (for reference) */
  editingMessageId: string | null;
  /** Editing mode: current text content of the editing textarea */
  editingContent: string;

  /** Whether to trigger a smooth scroll to bottom in Virtuoso (incremented per request) */
  scrollToBottomTrigger: number;

  /** Steering and follow-up message queues (synced from SDK queue_update events) */
  steeringQueue: string[];
  followUpQueue: string[];

  /** Remove a queued item by type and index (visual-only, SDK queue unaffected) */
  removeQueuedItem: (type: 'steer' | 'followUp', index: number) => void;

  setValue: (value: string) => void;
  setCursorPosition: (pos: number) => void;
  setIsStreaming: (streaming: boolean) => void;
  setIsDragging: (dragging: boolean) => void;
  setShowSlashMenu: (show: boolean, query?: string) => void;
  setShowMentionMenu: (show: boolean, query?: string) => void;
  addAttachment: (attachment: Attachment) => void;
  /** Update an attachment with base64 file data after FileReader completes */
  updateAttachmentData: (id: string, data: string) => void;
  removeAttachment: (id: string) => void;
  setUploadProgress: (id: string, progress: number) => void;
  clearUploadProgress: () => void;
  clearAttachments: () => void;
  addStreamingBlock: (block: ContentBlock) => void;
  updateStreamingBlock: (id: string, updates: Partial<ContentBlock>) => void;
  clearStreamingBlocks: () => void;
  setStreamingBlocks: (blocks: ContentBlock[]) => void;
  setStreamingUsage: (usage: TokenUsage | null) => void;
  setContextUsage: (ctx: ContextUsageInfo | null) => void;
  setSessionStats: (stats: SessionStatsInfo | null) => void;
  setMessageTiming: (timing: MessageTiming | null) => void;
  setToolTiming: (timing: ToolTiming) => void;
  setStreamError: (error: string | null) => void;
  setTriggerSend: (content: string) => void;
  /** Signal the chat timeline to scroll to bottom (e.g. after inserting a slash command message) */
  triggerScrollToBottom: () => void;
  /** Enter edit mode: track entry and message IDs for navigateTree on send */
  setEditingMessage: (entryId: string, messageId: string, initialContent: string) => void;
  /** Set editing content (e.g. as user types in the textarea) */
  setEditingContent: (content: string) => void;
  /** Exit edit mode: clear composer and editing state */
  clearEditingMessage: () => void;
  /** Update the steering and follow-up queue state */
  setQueues: (steering: string[], followUp: string[]) => void;
  reset: () => void;
}

export const useComposerStore = create<ComposerState>((set, get) => ({
  value: '',
  cursorPosition: 0,
  isStreaming: false,
  isDragging: false,
  showSlashMenu: false,
  showMentionMenu: false,
  slashQuery: '',
  mentionQuery: '',
  pendingAttachments: [],
  uploadProgress: {},
  streamingBlocks: [],
  streamingUsage: null,
  contextUsage: null,
  sessionStats: null,
  messageTiming: null,
  toolTimings: new Map(),
  streamError: null,
  triggerSend: 0,
  scrollToBottomTrigger: 0,
  editingEntryId: null,
  editingMessageId: null,
  editingContent: '',
  steeringQueue: [],
  followUpQueue: [],

  setSessionStats: (sessionStats) => set({ sessionStats }),
  setMessageTiming: (messageTiming) => set({ messageTiming }),
  setToolTiming: (timing) =>
    set((s) => ({
      toolTimings: new Map(s.toolTimings).set(timing.toolCallId, timing.durationMs),
    })),

  setValue: (value) => set({ value }),
  setCursorPosition: (cursorPosition) => set({ cursorPosition }),
  setIsStreaming: (isStreaming) => set({ isStreaming }),
  setIsDragging: (isDragging) => set({ isDragging }),
  setShowSlashMenu: (show, query = '') => set({ showSlashMenu: show, slashQuery: query }),
  setShowMentionMenu: (show, query = '') => set({ showMentionMenu: show, mentionQuery: query }),
  addAttachment: (attachment) =>
    set((s) => ({ pendingAttachments: [...s.pendingAttachments, attachment] })),
  updateAttachmentData: (id, data) =>
    set((s) => ({
      pendingAttachments: s.pendingAttachments.map((a) =>
        a.id === id ? { ...a, data, status: 'ready' as const } : a,
      ),
    })),
  removeAttachment: (id) =>
    set((s) => ({ pendingAttachments: s.pendingAttachments.filter((a) => a.id !== id) })),
  setUploadProgress: (id, progress) =>
    set((s) => ({ uploadProgress: { ...s.uploadProgress, [id]: progress } })),
  clearUploadProgress: () => set({ uploadProgress: {} }),
  clearAttachments: () => set({ pendingAttachments: [], uploadProgress: {} }),
  addStreamingBlock: (block) =>
    set((s) => {
      const idx = s.streamingBlocks.findIndex((b) => b.id === block.id);
      if (idx >= 0) {
        // Replace existing block with the latest snapshot (avoids duplication
        // when SDK re-sends the same block ID with accumulated content)
        const updated = [...s.streamingBlocks];
        updated[idx] = block;
        return { streamingBlocks: updated };
      }
      return { streamingBlocks: [...s.streamingBlocks, block] };
    }),
  updateStreamingBlock: (id, updates) =>
    set((s) => ({
      streamingBlocks: s.streamingBlocks.map((b) =>
        b.id === id ? { ...b, ...updates } : b,
      ),
    })),
  clearStreamingBlocks: () => set({ streamingBlocks: [] }),
  setStreamingBlocks: (streamingBlocks) => set({ streamingBlocks }),
  setStreamingUsage: (streamingUsage) => set({ streamingUsage }),
  setContextUsage: (contextUsage) => set({ contextUsage }),
  setStreamError: (streamError) => set({ streamError }),
  setTriggerSend: (content) => set((s) => ({ value: content, triggerSend: s.triggerSend + 1 })),
  triggerScrollToBottom: () => set((s) => ({ scrollToBottomTrigger: s.scrollToBottomTrigger + 1 })),
  setEditingMessage: (entryId, messageId, initialContent) =>
    set({ editingEntryId: entryId, editingMessageId: messageId, editingContent: initialContent }),
  setEditingContent: (content) => set({ editingContent: content }),
  clearEditingMessage: () =>
    set({ editingEntryId: null, editingMessageId: null, editingContent: '' }),
  setQueues: (steering, followUp) => set({ steeringQueue: steering, followUpQueue: followUp }),
  removeQueuedItem: (type, index) =>
    set((s) => {
      if (type === 'steer') {
        return { steeringQueue: s.steeringQueue.filter((_, i) => i !== index) };
      }
      return { followUpQueue: s.followUpQueue.filter((_, i) => i !== index) };
    }),
  reset: () =>
    set({
      value: '',
      cursorPosition: 0,
      isStreaming: false,
      isDragging: false,
      showSlashMenu: false,
      showMentionMenu: false,
      slashQuery: '',
      mentionQuery: '',
      pendingAttachments: [],
      uploadProgress: {},
      streamingBlocks: [],
      streamingUsage: null,
      contextUsage: null,
      sessionStats: null,
      messageTiming: null,
      toolTimings: new Map(),
      streamError: null,
      triggerSend: 0,
      editingEntryId: null,
      editingMessageId: null,
      editingContent: '',
      steeringQueue: [],
      followUpQueue: [],
    }),
}));
