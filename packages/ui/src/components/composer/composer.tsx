import { useCallback, useMemo, useState, useRef, useEffect, DragEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Square, Upload, CornerDownRight } from 'lucide-react';
import { cn, isPreviewableInRightPanel } from '@/lib/utils';
import { streamReducer, initialStreamingState } from '@/lib/stream-reducer';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { useSDK } from '@/hooks/use-sdk';
import { useUIStore } from '@/stores/ui-store';
import { useComposerStore } from '@/stores/composer-store';
import { ComposerInput } from './composer-input';
import { SendButton } from './send-button';
import { FileUploadButton } from './file-upload-button';
import { SlashCommandMenu } from './slash-command-menu';
import { MentionMenu } from './mention-menu';
import { SlashCommandDialog, type SlashCommandDialogData } from './slash-command-dialog';
import type { MentionItem } from './mention-menu';
import { AttachmentPreviewBar } from './attachment-preview-bar';
import { QueueIndicator } from './queue-indicator';
import { ModelSelector } from '../model/model-selector';
import { ThinkLevelSelector } from '../model/think-level-selector';
import { SkillSelector } from '../model/skill-selector';
import { CompactToggle } from '../model/compact-toggle';
import { DEFAULT_SLASH_COMMANDS } from '@pi/sdk-wrapper';
import type { ContentBlock, Config, Skill } from '@pi/types';
import type { Attachment } from '@pi/types';

export function Composer() {
  const sdk = useSDK();
  const queryClient = useQueryClient();
  const activeSessionId = useUIStore((s) => s.activeSessionId);
  const activeWorkspaceId = useUIStore((s) => s.activeWorkspaceId);
  const compactMode = useUIStore((s) => s.compactMode);
  const setCompactMode = useUIStore((s) => s.setCompactMode);
  const selectedSkills = useUIStore((s) => s.selectedSkills);
  const toggleSkill = useUIStore((s) => s.toggleSkill);
  const setActivePreviewFile = useUIStore((s) => s.setActivePreviewFile);
  const setMemoryPreview = useUIStore((s) => s.setMemoryPreview);
  const setActiveSession = useUIStore((s) => s.setActiveSession);
  const {
    value,
    setValue,
    isStreaming,
    isDragging,
    setIsStreaming,
    setIsDragging,
    showSlashMenu,
    slashQuery,
    setShowSlashMenu,
    showMentionMenu,
    mentionQuery,
    setShowMentionMenu,
    pendingAttachments,
    addAttachment,
    updateAttachmentData,
    removeAttachment,
    clearAttachments,
    clearStreamingBlocks,
    setStreamingBlocks,
    setStreamingUsage,
    setContextUsage,
    setSessionStats,
    setMessageTiming,
    setToolTiming,
    setStreamError,
    triggerSend,
    clearEditingMessage,
    setQueues,
    triggerScrollToBottom,
  } = useComposerStore();

  // Highlighted index for keyboard navigation in popup menus
  const [highlightedSlashIndex, setHighlightedSlashIndex] = useState(0);
  const [highlightedMentionIndex, setHighlightedMentionIndex] = useState(0);

  // Pending token insert signal for ComposerInput contentEditable
  const pendingTokenInsert = useRef<{ text: string; type: 'slash' | 'mention' } | null>(null);

  // Version counter to force ComposerInput useEffect re-run when a token is selected
  const [tokenInsertVersion, setTokenInsertVersion] = useState(0);

  // Version counter to force ComposerInput refocus after file picker closes
  const [focusVersion, setFocusVersion] = useState(0);

  // Tracks actual streaming state synchronously (avoids React state lag).
  // Used by handleSteerSubmit to fallback to a regular submit when the stream
  // has ended but React hasn't re-rendered yet.
  const isActuallyStreaming = useRef(false);

  // AbortController for clean cancellation of streaming via AbortSignal.
  // Causes the proxy to return a dummy message (not throw), so onSuccess
  // fires instead of onError, preserving the user message in the chat.
  const abortControllerRef = useRef<AbortController | null>(null);
  const [commandDialog, setCommandDialog] = useState<SlashCommandDialogData | null>(null);

  // Config for model/think level
  const { data: config } = useQuery({
    queryKey: ['config'],
    queryFn: () => sdk.config.get(),
  });

  const updateConfigMut = useMutation({
    mutationFn: (data: Partial<Config>) => sdk.config.update(data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['config'] }),
  });

  // Available models for /model slash command
  const { data: availableModels } = useQuery({
    queryKey: ['models'],
    queryFn: () => sdk.config.listModels(),
  });

  // Available skills loaded dynamically from SDK
  const { data: availableSkills } = useQuery({
    queryKey: ['skills'],
    queryFn: () => sdk.config.listSkills(),
  });

  // Filter stale skill IDs from localStorage against actual available skills
  const validSelectedSkills = useMemo(
    () => {
      if (!availableSkills) return [];
      const skillIds = new Set(availableSkills.map(s => s.id));
      return selectedSkills.filter(id => skillIds.has(id));
    },
    [selectedSkills, availableSkills],
  );

  const handleFilesSelected = useCallback(
    (files: File[]) => {
      files.forEach((file) => {
        const id = `att_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        let attType: Attachment['type'] = 'other';
        const mime = file.type || '';

        if (/^image\/(jpeg|png|gif|webp|svg\+xml)$/i.test(mime)) {
          attType = 'image';
        } else if (mime === 'application/pdf') {
          attType = 'pdf';
        } else if (
          /^application\/vnd\.openxmlformats-officedocument\./.test(mime) ||
          mime === 'application/msword'
        ) {
          attType = 'office';
        } else if (
          /^text\/(x-|plain|html|css|csv|xml|javascript|typescript)/.test(mime) ||
          mime === 'application/json' ||
          mime === 'application/javascript'
        ) {
          attType = 'code';
        } else if (/^audio\//.test(mime)) {
          attType = 'audio';
        } else if (/^video\//.test(mime)) {
          attType = 'video';
        }

        addAttachment({
          id,
          name: file.name,
          type: attType,
          size: file.size,
          mimeType: file.type || 'application/octet-stream',
          status: 'uploading',
          createdAt: new Date().toISOString(),
        });
        // Read file content as base64 for sending to vision models
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result as string;
          // Strip "data:image/png;base64," prefix to get raw base64
          const base64 = result.split(',')[1] || result;
          updateAttachmentData(id, base64);
        };
        reader.onerror = () => {
          updateAttachmentData(id, '');
        };
        reader.readAsDataURL(file);
      });
      // Restore focus to the input after the native file picker closes
      setFocusVersion((v) => v + 1);
    },
    [addAttachment, updateAttachmentData],
  );

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, [setIsDragging]);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, [setIsDragging]);

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) {
        handleFilesSelected(files);
      }
    },
    [handleFilesSelected, setIsDragging],
  );

  const handlePreviewAttachment = useCallback(
    (attachment: Attachment) => {
      if (attachment.url) {
        setActivePreviewFile(attachment.url);
      }
    },
    [setActivePreviewFile],
  );

  // Build dynamic mention items from active workspace/session context
  const { data: workspaces } = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => sdk.workspace.list(),
  });

  const { data: sessions } = useQuery({
    queryKey: ['sessions', activeWorkspaceId],
    queryFn: () => (activeWorkspaceId ? sdk.session.list(activeWorkspaceId) : []),
    enabled: !!activeWorkspaceId,
  });

  // Fetch workspace files for @ mention autocomplete
  const { data: workspaceFiles } = useQuery({
    queryKey: ['files', activeWorkspaceId, showMentionMenu],
    queryFn: () => (activeWorkspaceId ? sdk.file.list(activeWorkspaceId) : []),
    enabled: !!activeWorkspaceId && showMentionMenu,
    staleTime: 30_000,
  });

  const mentionItems = useMemo<MentionItem[]>(() => {
    const items: MentionItem[] = [];
    workspaces?.forEach((w) =>
      items.push({ id: `ws-${w.id}`, type: 'workspace', label: w.name, description: `${w.sessionCount} sessions` }),
    );
    sessions?.forEach((s) =>
      items.push({ id: `sess-${s.id}`, type: 'session', label: s.title, description: `${s.messageCount} messages` }),
    );
    // Include workspace files in autocomplete
    if (workspaceFiles && workspaceFiles.length > 0) {
      workspaceFiles.forEach((f) =>
        items.push({
          id: `file-${f.path}`,
          type: f.type === 'directory' ? 'folder' : 'file',
          label: f.name,
          description: f.type === 'directory' ? 'Directory' : f.size ? `${Math.round(f.size / 1024)} KB` : undefined,
        }),
      );
    } else {
      // Fallback placeholders when no workspace or no files loaded
      items.push(
        { id: 'file-default', type: 'file', label: 'current file', description: 'Reference current file' },
        { id: 'folder-default', type: 'folder', label: 'project root', description: 'Reference project folder' },
        { id: 'code-default', type: 'code', label: 'selection', description: 'Current code selection' },
      );
    }
    return items;
  }, [workspaces, sessions, workspaceFiles]);

  const handleStopGeneration = useCallback(() => {
    if (!activeSessionId) return;
    // Trigger clean cancellation via AbortSignal → proxy returns dummy msg → onSuccess fires
    abortControllerRef.current?.abort();
    // Fire-and-forget server-side cleanup (don't block UI)
    sdk.chat.stopGeneration(activeSessionId).catch(() => {});
    // Instant UI feedback: hide Stop button, show Send button
    setIsStreaming(false);
    isActuallyStreaming.current = false;
  }, [sdk, activeSessionId, setIsStreaming]);

  // Watch for retry trigger from ChatTimeline
  useEffect(() => {
    if (triggerSend > 0 && activeSessionId) {
      const currentValue = useComposerStore.getState().value;
      if (currentValue.trim()) {
        sendMutation.mutate(currentValue);
        setValue('');
      }
    }
  }, [triggerSend]);

  // Store last user message for potential retry
  const lastUserMessageRef = useRef<string>('');
  // Captured attachments so mutationFn can read them even after clearAttachments()
  const capturedAttachmentsRef = useRef<typeof pendingAttachments>([]);

  const sendMutation = useMutation({
    onMutate: async (content: string) => {
      abortControllerRef.current = new AbortController();
      // Capture attachments BEFORE the await, since handleSubmit calls
      // clearAttachments() synchronously after mutate(), and the await
      // in cancelQueries yields control allowing clearAttachments to run.
      const currentAttachments = useComposerStore.getState().pendingAttachments;
      capturedAttachmentsRef.current = currentAttachments;

      // Cancel outgoing refetches so they don't overwrite our optimistic update
      await queryClient.cancelQueries({ queryKey: ['session', activeSessionId] });
      const previousSession = queryClient.getQueryData(['session', activeSessionId]);

      // Build user message blocks from attachments for inline preview
      const userBlocks: ContentBlock[] = [];
      if (currentAttachments.length > 0) {
        // Text content block
        if (content) {
          userBlocks.push({
            id: `b-text-opt-${Date.now()}`,
            type: 'text',
            content,
          });
        }
        for (const att of currentAttachments) {
          if (att.type === 'image' && att.data) {
            userBlocks.push({
              id: `b-img-opt-${att.id}`,
              type: 'image',
              content: att.name,
              mimeType: att.mimeType,
              data: att.data,
            });
          } else {
            // Always create file block for non-image attachments (or
            // images without loaded data), even before base64 data
            // finishes loading. This matches the reload path
            // (stripAttachmentSections) which creates file blocks purely
            // from the [Attached: ...] placeholder text.
            userBlocks.push({
              id: `b-file-opt-${att.id}`,
              type: 'file',
              content: att.name,
              mimeType: att.mimeType,
              data: att.data || undefined,
              fileName: att.name,
              fileSize: att.size,
            });
          }
        }
      }

      // Register attachment data in memoryPreviews so file blocks remain
      // clickable even after cache invalidation removes optimistic blocks
      for (const att of currentAttachments) {
        if (att.data) {
          const virtualPath = `__memory__/${att.name}`;
          useUIStore.getState().setMemoryPreview(virtualPath, {
            fileName: att.name,
            mimeType: att.mimeType,
            data: att.data,
          });
        }
      }

      // Append text references for non-image attachments to the prompt content.
      // For text-based files, decode and include the actual file content so the
      // AI can analyze it directly.
      let promptContent = content;
      const nonImageAtts = currentAttachments.filter((a) => a.type !== 'image' && a.name);
      if (nonImageAtts.length > 0) {
        const TEXT_MIMES = new Set([
          'text/plain', 'text/html', 'text/css', 'text/csv', 'text/xml',
          'text/javascript', 'text/typescript', 'text/markdown',
          'text/x-python', 'text/x-java', 'text/x-rust', 'text/x-go',
          'text/x-c', 'text/x-c++', 'text/x-sh',
          'application/json', 'application/javascript', 'application/typescript',
          'application/xml', 'application/x-yaml',
        ]);

        const fileSections: string[] = [];
        for (const att of nonImageAtts) {
          if (att.data && TEXT_MIMES.has(att.mimeType)) {
            try {
              // atob returns a binary string; decode UTF-8 bytes properly
              const binary = atob(att.data);
              const bytes = new Uint8Array(binary.length);
              for (let j = 0; j < binary.length; j++) {
                bytes[j] = binary.charCodeAt(j);
              }
              const text = new TextDecoder().decode(bytes);
              // Wrap in markdown code fences with language hint from extension
              const ext = (att.name || '').split('.').pop() || '';
              const fenceExt = ext === 'tsx' ? 'tsx' : ext === 'jsx' ? 'jsx' : ext === 'md' ? 'md' : ext;
              fileSections.push(`File: ${att.name}\n\`\`\`${fenceExt}\n${text}\n\`\`\``);
            } catch {
              fileSections.push(`[Attached: ${att.name} (${att.type}) - could not decode]`);
            }
          } else {
            fileSections.push(`[Attached: ${att.name} (${att.type})]`);
          }
        }
        promptContent = `${content}\n\n${fileSections.join('\n\n')}`;
      }

      // Optimistically show the user message immediately
      queryClient.setQueryData(['session', activeSessionId], (old: any) => {
        if (!old) return old;
        return {
          ...old,
          messages: [
            ...(old.messages || []),
            {
              id: `optimistic-${Date.now()}`,
              sessionId: activeSessionId,
              role: 'user',
              status: 'complete',
              content,
              blocks: userBlocks.length > 0 ? userBlocks : [],
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
        };
      });

      return { previousSession, promptContent };
    },
    mutationFn: async (content: string) => {
      if (!activeSessionId) return;
      lastUserMessageRef.current = content;
      clearStreamingBlocks();
      setMessageTiming(null);
      setSessionStats(null);
      setStreamError(null);
      setIsStreaming(true);
      isActuallyStreaming.current = true;

      // If editing a message, navigate the tree first to branch from the edited entry
      const editEntryId = useComposerStore.getState().editingEntryId;
      if (editEntryId) {
        try {
          await sdk.chat.navigateTree(activeSessionId, editEntryId);
        } catch (err) {
          setStreamError(err instanceof Error ? err.message : 'Failed to navigate tree');
          setIsStreaming(false);
          isActuallyStreaming.current = false;
          throw err;
        }
      }

      // Build prompt text: decode and include text-based file contents,
      // append references for binary files
      const currentAttachments = capturedAttachmentsRef.current;
      const nonImageAtts = currentAttachments.filter((a) => a.type !== 'image' && a.name);
      let promptContent = content;
      if (nonImageAtts.length > 0) {
        const TEXT_MIMES = new Set([
          'text/plain', 'text/html', 'text/css', 'text/csv', 'text/xml',
          'text/javascript', 'text/typescript', 'text/markdown',
          'text/x-python', 'text/x-java', 'text/x-rust', 'text/x-go',
          'text/x-c', 'text/x-c++', 'text/x-sh',
          'application/json', 'application/javascript', 'application/typescript',
          'application/xml', 'application/x-yaml',
        ]);

        const fileSections: string[] = [];
        for (const att of nonImageAtts) {
          if (att.data && TEXT_MIMES.has(att.mimeType)) {
            try {
              // atob returns binary string; decode UTF-8 bytes properly
              const binary = atob(att.data);
              const bytes = new Uint8Array(binary.length);
              for (let j = 0; j < binary.length; j++) {
                bytes[j] = binary.charCodeAt(j);
              }
              const text = new TextDecoder().decode(bytes);
              const ext = (att.name || '').split('.').pop() || '';
              const fenceExt = ext === 'tsx' ? 'tsx' : ext === 'jsx' ? 'jsx' : ext === 'md' ? 'md' : ext;
              fileSections.push(`File: ${att.name}\n\`\`\`${fenceExt}\n${text}\n\`\`\``);
            } catch {
              fileSections.push(`[Attached: ${att.name} (${att.type}) - could not decode]`);
            }
          } else {
            fileSections.push(`[Attached: ${att.name} (${att.type})]`);
          }
        }
        promptContent = `${content}\n\n${fileSections.join('\n\n')}`;
      }

      // Note: the @ prefix on file mentions (e.g. @filename.pptx) is intentionally
      // preserved so that the persisted content keeps the @ and the mention badge
      // renders identically on reload. Workspace/session @mentions already keep @;
      // file mentions now match for consistency.

      // Collect image attachments with base64 data read
      const imageAttachments = currentAttachments
        .filter((a) => a.type === 'image' && a.data)
        .map((a) => ({ name: a.name, mimeType: a.mimeType, data: a.data! }));

      // Streaming state managed by reducer for consistent block ordering/dedup
      let streamState = initialStreamingState();

      // -- rAF batching for block updates --
      // Without batching, every streaming chunk triggers:
      //   setStreamingBlocks → useMemo → makeStreamingMessage
      //   → ReactMarkdown re-parse → DOM rebuild.
      // Fast models (e.g. Qwen-VL Max) can fire 50+ chunks/second, causing
      // visible flickering. rAF coalesces all chunks in a 16ms frame into
      // a single state update, capping re-renders at ~60fps.
      let pendingRaf = false;
      const rafBlocks: { current: ContentBlock[] } = { current: [] };

      function flushBlockUpdates() {
        pendingRaf = false;
        // Guard: if streaming has already ended (onSuccess ran), don't
        // re-populate streamingBlocks — this prevents a late rAF callback
        // from restoring stale blocks after clearStreamingBlocks().
        if (!useComposerStore.getState().isStreaming) return;
        setStreamingBlocks(rafBlocks.current);
      }

      function scheduleBlockFlush(blocks: ContentBlock[]) {
        rafBlocks.current = blocks;
        if (!pendingRaf) {
          pendingRaf = true;
          requestAnimationFrame(flushBlockUpdates);
        }
      }

      await sdk.chat.sendMessageStream(
        {
          sessionId: activeSessionId,
          content: promptContent,
          workspaceCwd: activeWorkspaceId ?? undefined,
          modelId: config?.defaultModelId,
          attachments: imageAttachments.length > 0 ? imageAttachments : undefined,
          skills: validSelectedSkills,
        },
        (chunk) => {
          if (chunk.type === 'message_start') {
            streamState = streamReducer(streamState, { type: 'message_start' });
            scheduleBlockFlush(streamState.blocks);
          } else if (chunk.type === 'block' && chunk.block) {
            streamState = streamReducer(streamState, { type: 'block', block: chunk.block as ContentBlock });
            scheduleBlockFlush(streamState.blocks);
          } else if (chunk.type === 'text' && chunk.content) {
            streamState = streamReducer(streamState, { type: 'text_delta', content: chunk.content });
            scheduleBlockFlush(streamState.blocks);
          } else if (chunk.type === 'usage' && chunk.usage) {
            setStreamingUsage(chunk.usage);
          } else if (chunk.type === 'context' && chunk.contextUsage) {
            setContextUsage(chunk.contextUsage);
          } else if (chunk.type === 'stats' && chunk.sessionStats) {
            setSessionStats(chunk.sessionStats);
          } else if (chunk.type === 'message_timing' && chunk.messageTiming) {
            setMessageTiming(chunk.messageTiming);
          } else if (chunk.type === 'tool_timing' && chunk.toolTiming) {
            setToolTiming(chunk.toolTiming);
          } else if (chunk.type === 'queue_update' && chunk.queueState) {
            setQueues(chunk.queueState.steering, chunk.queueState.followUp);
          } else if (chunk.type === 'error') {
            setStreamError(chunk.error || 'An unknown error occurred');
          }
        },
        abortControllerRef.current?.signal,
      );
    },
    onSuccess: () => {
      const state = useComposerStore.getState();

      // Clear editing state if in edit mode
      if (state.editingEntryId) {
        clearEditingMessage();
      }

      // Capture streaming data before clearing state.
      const blocks = state.streamingBlocks.map((b) => {
        if (b.type === 'tool_call' && b.toolCallId) {
          const ms = state.toolTimings.get(b.toolCallId);
          if (ms != null) return { ...b, durationMs: ms };
        }
        return b;
      });

      const content = blocks
        .filter((b) => b.type === 'text')
        .map((b) => b.content)
        .join('');

      const streamingUsage = state.streamingUsage;

      // Clear streaming state BEFORE writing to cache to prevent a race
      // condition where setQueryData triggers a re-render while isStreaming
      // is still true and streamingBlocks still has data, causing the
      // ChatTimeline to show both a cached message and a streaming message
      // (duplicate assistant bubble with avatar).
      clearStreamingBlocks();
      setIsStreaming(false);
      isActuallyStreaming.current = false;

      // Now promote the captured streaming data into the query cache as a
      // single assistant message. At this point isStreaming is false, so
      // ChatTimeline will only show the storedMessages (no streaming ghost).
      const now = new Date().toISOString();
      const assistantMsg = {
        id: `msg-${activeSessionId}-${Date.now()}`,
        sessionId: activeSessionId,
        role: 'assistant' as const,
        status: 'complete' as const,
        modelId: config?.defaultModelId ?? 'unknown',
        content,
        blocks,
        usage: streamingUsage ?? undefined,
        createdAt: now,
        updatedAt: now,
      };

      queryClient.setQueryData(['session', activeSessionId], (old: any) => {
        if (!old) return old;
        return {
          ...old,
          messages: [...(old.messages || []), assistantMsg],
        };
      });

      queryClient.invalidateQueries({ queryKey: ['files'] });

      // Auto-preview the last generated file in the right panel
      const fileBlocks = blocks.filter((b) => b.type === 'file');
      if (fileBlocks.length > 0) {
        const lastFile = fileBlocks[fileBlocks.length - 1];
        if (lastFile.workspacePath && isPreviewableInRightPanel(lastFile.workspacePath)) {
          setActivePreviewFile(lastFile.workspacePath);
        }
      }

      // Register user file blocks with data in memoryPreviews so they
      // can be opened in the right panel even without workspacePath
      const session = queryClient.getQueryData(['session', activeSessionId]) as any;
      if (session?.messages) {
        for (const msg of session.messages) {
          if (msg.role === 'user' && msg.blocks) {
            for (const b of msg.blocks) {
              if (b.type === 'file' && b.data && !b.workspacePath && b.fileName) {
                const virtualPath = `__memory__/${b.fileName}`;
                useUIStore.getState().setMemoryPreview(virtualPath, {
                  fileName: b.fileName,
                  mimeType: b.mimeType,
                  data: b.data,
                });
              }
            }
          }
        }
      }

      // Drain queue: removed — steer/followUp are now sent directly via
      // sdk.chat.steer()/sdk.chat.followUp() and processed by the SDK's
      // internal queue. The SDK emits queue_update events that sync the UI.
    },
    onError: (error: Error, _content: string, context: any) => {
      // User-initiated cancel via Stop button: don't rollback, don't show error
      if (error.name === 'AbortError') {
        clearStreamingBlocks();
        setIsStreaming(false);
        isActuallyStreaming.current = false;
        return;
      }
      // Rollback optimistic user message
      // Clear streaming state first to prevent the same race condition
      // as onSuccess (duplicate streaming ghost alongside rollback).
      clearStreamingBlocks();
      setIsStreaming(false);
      isActuallyStreaming.current = false;
      if (context?.previousSession) {
        queryClient.setQueryData(['session', activeSessionId], context.previousSession);
      }
      setStreamError(error.message || 'Failed to send message');
    },
    onSettled: () => {
      // Clear attachments after mutation completes (success or error),
      // so the mutationFn can read them from the store during execution.
      useComposerStore.getState().clearAttachments();
    },
  });

  /** Handle built-in slash commands locally without sending to LLM */
  const handleSlashCommand = useCallback(
    (text: string): boolean => {
      const trimmed = text.trim();
      const knownCommands = new Set(DEFAULT_SLASH_COMMANDS.map((c) => c.name));

      // Strip arguments: /bash ls -la → /bash
      const cmdName = trimmed.split(/\s+/)[0];
      if (!knownCommands.has(cmdName)) return false;

      const now = new Date().toISOString();

      if (cmdName === '/help') {
        const helpSections: Array<{ title: string; items: Array<{ name: string; desc: string }> }> = [
          {
            title: 'Available Commands',
            items: DEFAULT_SLASH_COMMANDS.map((c) => ({ name: c.name, desc: c.description })),
          },
          {
            title: 'Skills',
            items: (availableSkills ?? []).map((s) => ({
              name: s.name,
              desc: `${s.description} (${validSelectedSkills.includes(s.id) ? 'enabled' : 'disabled'})`,
            })),
          },
          {
            title: 'Keyboard Shortcuts',
            items: [
              { name: 'Enter', desc: 'Send message' },
              { name: 'Shift+Enter', desc: 'New line' },
              { name: 'Ctrl+Enter', desc: 'Steer agent during streaming' },
              { name: '/', desc: 'Open command menu for quick actions' },
              { name: '@', desc: 'Mention files, workspaces, or sessions' },
            ],
          },
          {
            title: 'Capabilities',
            items: [
              { name: 'Files', desc: 'Read, write, and edit files in your workspace' },
              { name: 'Shell', desc: 'Execute shell commands via bash tool' },
              { name: 'Search', desc: 'Search codebases with regex and glob patterns' },
              { name: 'Office', desc: 'Create and edit Office documents (.docx, .xlsx, .pptx)' },
              { name: 'Attach', desc: 'Attach images and files for AI analysis' },
            ],
          },
        ];
        setCommandDialog({ title: 'Pi Coding Agent', subtitle: 'Your AI coding assistant', sections: helpSections });
        return true;
      }

      if (cmdName === '/clear') {
        if (!activeWorkspaceId) return false;
        // Create a new session and switch to it
        sdk.session.create(activeWorkspaceId).then((session) => {
          queryClient.invalidateQueries({ queryKey: ['sessions'] });
          queryClient.invalidateQueries({ queryKey: ['workspaces'] });
          setActiveSession(session.id);
        });
        return true;
      }

      if (cmdName === '/config') {
        const skills = (availableSkills ?? [])
          .filter((s) => validSelectedSkills.includes(s.id))
          .map((s) => s.name)
          .join(', ') || 'none';
        const configSections: Array<{ title: string; items: Array<{ name: string; desc: string }> }> = [
          {
            title: 'Current Configuration',
            items: [
              { name: 'Model', desc: config?.defaultModelId ?? 'Not set' },
              { name: 'Think Level', desc: config?.defaultThinkLevel ?? 'medium' },
              { name: 'Skills', desc: skills },
              { name: 'Compact Mode', desc: compactMode ? 'On' : 'Off' },
              { name: 'Workspace', desc: activeWorkspaceId ?? 'None' },
            ],
          },
        ];
        setCommandDialog({ title: 'Configuration', subtitle: 'Current session settings', sections: configSections });
        return true;
      }

      if (cmdName === '/model') {
        const currentModelId = config?.defaultModelId ?? 'Not set';
        const modelItems: Array<{ name: string; desc: string }> = [];
        if (availableModels && availableModels.length > 0) {
          for (const m of availableModels) {
            const marker = m.id === currentModelId ? ' (current)' : '';
            const status = m.isAvailable ? '' : ' [unavailable]';
            modelItems.push({ name: m.name, desc: `${marker}${status}`.trim() });
          }
        } else {
          modelItems.push({ name: 'loading', desc: 'loading models...' });
        }
        const modelSections: Array<{ title: string; items: Array<{ name: string; desc: string }> }> = [
          { title: 'Available Models', items: modelItems },
          { title: 'Current', items: [{ name: currentModelId, desc: '' }] },
        ];
        setCommandDialog({ title: 'Models', subtitle: 'Available models', sections: modelSections });
        return true;
      }

      if (cmdName === '/compact') {
        // Insert a transient "Compacting..." message that will be replaced on completion
        const compactAckId = `compact-ack-${Date.now()}`;
        const compactMsg = {
          id: compactAckId,
          sessionId: activeSessionId,
          role: 'assistant' as const,
          status: 'complete' as const,
          modelId: 'system',
          content: [
            '## Compacting Conversation Context',
            '',
            'Summarizing conversation history to reduce token usage while preserving key context...',
          ].join('\n'),
          blocks: [],
          createdAt: now,
          updatedAt: now,
        };
        queryClient.setQueryData(['session', activeSessionId], (old: any) => {
          if (!old) return old;
          return {
            ...old,
            messages: [...(old.messages || []), compactMsg],
          };
        });
        triggerScrollToBottom();
        return true;
      }

      // Unknown slash commands pass through to the LLM as plain text
      return false;
    },
    [
      sdk,
      activeSessionId,
      activeWorkspaceId,
      config,
      availableModels,
      availableSkills,
      compactMode,
      validSelectedSkills,
      queryClient,
      setActiveSession,
      triggerScrollToBottom,
    ],
  );

  const handleSubmit = useCallback(() => {
    if ((!value.trim() && pendingAttachments.length === 0) || !activeSessionId || sendMutation.isPending) return;

    const trimmed = value.trim();

    // /compact: handle entirely client-side with SDK compaction
    if (trimmed.startsWith('/compact')) {
      // Insert user message BEFORE the acknowledgment so order is correct
      const now = new Date().toISOString();
      const userMsg = {
        id: `compact-user-${Date.now()}`,
        sessionId: activeSessionId,
        role: 'user' as const,
        status: 'complete' as const,
        content: trimmed,
        blocks: [],
        createdAt: now,
        updatedAt: now,
      };
      queryClient.setQueryData(['session', activeSessionId], (old: any) => {
        if (!old) return old;
        return { ...old, messages: [...(old.messages || []), userMsg] };
      });
      // Now insert the "Compacting..." acknowledgment (after user message)
      handleSlashCommand(value);
      setValue('');
      clearAttachments();
      triggerScrollToBottom();

      sdk.chat.compact(activeSessionId).then((result) => {
        queryClient.setQueryData(['session', activeSessionId], (old: any) => {
          if (!old) return old;
          const messages = (old.messages || []).map((m: any) => {
            if (m.id.startsWith('compact-ack-')) {
              return {
                ...m,
                content: [
                  '## Conversation Compacted',
                  '',
                  result.summary,
                  '',
                  '---',
                  `**Tokens before compaction:** ${result.tokensBefore.toLocaleString()}`,
                ].join('\n'),
              };
            }
            return m;
          });
          return { ...old, messages };
        });
      }).catch((err: Error) => {
        const msg = err.message || 'Unknown error';
        const isAlreadyCompacted = msg.toLowerCase().includes('already compacted');
        queryClient.setQueryData(['session', activeSessionId], (old: any) => {
          if (!old) return old;
          const messages = (old.messages || []).map((m: any) => {
            if (m.id.startsWith('compact-ack-')) {
              return {
                ...m,
                content: isAlreadyCompacted
                  ? '**Session already compacted.** The conversation has already been summarized. No additional compaction is needed.'
                  : `**Compaction failed:** ${msg}`,
              };
            }
            return m;
          });
          return { ...old, messages };
        });
      });
      return;
    }

    // Intercept built-in slash commands before sending to LLM
    const slashHandled = handleSlashCommand(value);
    if (slashHandled) {
      setValue('');
      clearAttachments();
      return;
    }

    sendMutation.mutate(value);
    setValue('');
    clearAttachments();
  }, [value, activeSessionId, sendMutation, setValue, handleSlashCommand, sdk, queryClient, triggerScrollToBottom]);

  /** Queue a steering message via the SDK. It will be delivered after the
   *  current assistant turn's tool calls complete, redirecting the agent.
   *  If the stream has already ended (fast model, no tool calls), fall back
   *  to a regular submit so the message isn't silently lost. */
  const handleSteerSubmit = useCallback(() => {
    if (!value.trim() || !activeSessionId) return;
    if (isActuallyStreaming.current) {
      sdk.chat.steer(activeSessionId, value).catch((err) => {
        console.error('[Steer] Failed to steer:', err);
        // If steer fails while actually streaming, fall back to regular submit
        if (!isActuallyStreaming.current) {
          useComposerStore.getState().setTriggerSend(value);
        }
      });
    } else {
      // Agent has already finished — send as a regular message
      handleSubmit();
      return;
    }
    setValue('');
  }, [value, activeSessionId, sdk, setValue, handleSubmit]);

  /** Queue a follow-up message via the SDK. It will be delivered after the
   *  agent finishes all work (all tool calls and steering messages processed).
   *  If the stream has already ended, fall back to a regular submit. */
  const handleFollowUpSubmit = useCallback(() => {
    if (!value.trim() || !activeSessionId) return;
    if (isActuallyStreaming.current) {
      sdk.chat.followUp(activeSessionId, value).catch((err) => {
        console.error('[FollowUp] Failed to follow up:', err);
        if (!isActuallyStreaming.current) {
          useComposerStore.getState().setTriggerSend(value);
        }
      });
    } else {
      handleSubmit();
      return;
    }
    setValue('');
  }, [value, activeSessionId, sdk, setValue, handleSubmit]);

  const handleSlashDetect = useCallback(
    (query: string) => {
      // Only show menu when there are actual matches; otherwise Enter key
      // gets intercepted for empty-menu selection and the message won't send.
      const hasMatch = DEFAULT_SLASH_COMMANDS.some(
        (c) => !query || c.name.toLowerCase().includes(query.toLowerCase()),
      );
      if (!hasMatch) {
        setShowSlashMenu(false);
        return;
      }
      setHighlightedSlashIndex(0);
      setShowSlashMenu(true, query);
    },
    [setShowSlashMenu],
  );

  const handleMentionDetect = useCallback(
    (query: string) => {
      // Only show menu when there are actual matches; otherwise Enter key
      // gets intercepted for empty-menu selection and the message won't send.
      const hasMatch = mentionItems.some(
        (i) => !query || i.label.toLowerCase().includes(query.toLowerCase()),
      );
      if (!hasMatch) {
        setShowMentionMenu(false);
        return;
      }
      setHighlightedMentionIndex(0);
      setShowMentionMenu(true, query);
      setShowSlashMenu(false);
    },
    [setShowMentionMenu, setShowSlashMenu, mentionItems],
  );

  const handleSlashDismiss = useCallback(() => {
    setShowSlashMenu(false);
    setHighlightedSlashIndex(0);
  }, [setShowSlashMenu]);
  const handleMentionDismiss = useCallback(() => {
    setShowMentionMenu(false);
    setHighlightedMentionIndex(0);
  }, [setShowMentionMenu]);

  // Compute total filtered items for both menus (for index clamping)
  const totalSlashItems = useMemo(() => {
    if (!showSlashMenu) return 0;
    return DEFAULT_SLASH_COMMANDS.filter(
      (c) => !slashQuery || c.name.toLowerCase().includes(slashQuery.toLowerCase()),
    ).length;
  }, [showSlashMenu, slashQuery]);

  const totalMentionItems = useMemo(() => {
    if (!showMentionMenu) return 0;
    return mentionItems.filter(
      (i) => !mentionQuery || i.label.toLowerCase().includes(mentionQuery.toLowerCase()),
    ).length;
  }, [showMentionMenu, mentionQuery, mentionItems]);

  // Keyboard navigation handlers for popup menus
  const handleSlashNavigate = useCallback(
    (direction: 'up' | 'down') => {
      setHighlightedSlashIndex((prev) => {
        if (totalSlashItems === 0) return 0;
        if (direction === 'down') return (prev + 1) % totalSlashItems;
        return (prev - 1 + totalSlashItems) % totalSlashItems;
      });
    },
    [totalSlashItems],
  );

  const handleSlashSelect = useCallback(
    (cmd?: import('@pi/types').SlashCommand) => {
      // If called without args (Enter key), select highlighted item
      if (!cmd) {
        const filtered = DEFAULT_SLASH_COMMANDS.filter(
          (c) => !slashQuery || c.name.toLowerCase().includes(slashQuery.toLowerCase()),
        );
        cmd = filtered[highlightedSlashIndex];
        if (!cmd) return;
      }
      // cmd.name already includes the / prefix (e.g. "/help")
      const tokenText = cmd.name;
      const withoutSlash = value.replace(/\/(\w*)$/, '');
      setValue(`${withoutSlash}${tokenText}\u00A0`);
      pendingTokenInsert.current = { text: tokenText, type: 'slash' };
      setShowSlashMenu(false);
      setHighlightedSlashIndex(0);
      setTokenInsertVersion((v) => v + 1);
    },
    [value, setValue, setShowSlashMenu, slashQuery, highlightedSlashIndex],
  );

  const handleMentionNavigate = useCallback(
    (direction: 'up' | 'down') => {
      setHighlightedMentionIndex((prev) => {
        if (totalMentionItems === 0) return 0;
        if (direction === 'down') return (prev + 1) % totalMentionItems;
        return (prev - 1 + totalMentionItems) % totalMentionItems;
      });
    },
    [totalMentionItems],
  );

  const handleMentionSelect = useCallback(
    (item?: MentionItem) => {
      if (!item) {
        const filtered = mentionItems.filter(
          (i) => !mentionQuery || i.label.toLowerCase().includes(mentionQuery.toLowerCase()),
        );
        item = filtered[highlightedMentionIndex];
        if (!item) return;
      }
      const withoutMention = value.replace(/@([^\s]*)$/, '');
      const tokenText = `@${item.label}`;
      setValue(`${withoutMention}${tokenText}\u00A0`);
      setShowMentionMenu(false);
      setHighlightedMentionIndex(0);
      setTokenInsertVersion((v) => v + 1);
    },
    [value, setValue, setShowMentionMenu, mentionQuery, highlightedMentionIndex, mentionItems],
  );

  // Menu navigation handler (delegates to correct menu based on which is open)
  const handleMenuNavigate = useCallback(
    (direction: 'up' | 'down') => {
      if (showSlashMenu) handleSlashNavigate(direction);
      else if (showMentionMenu) handleMentionNavigate(direction);
    },
    [showSlashMenu, showMentionMenu, handleSlashNavigate, handleMentionNavigate],
  );

  const handleMenuSelect = useCallback(() => {
    if (showSlashMenu) handleSlashSelect();
    else if (showMentionMenu) handleMentionSelect();
  }, [showSlashMenu, showMentionMenu, handleSlashSelect, handleMentionSelect]);

  if (!activeSessionId) return null;

  return (
    <div
      className={cn(
        'rounded-xl border bg-card shadow-lg mx-4 mb-4 overflow-visible',
        isDragging && 'ring-2 ring-primary/50 border-primary',
      )}
    >
      {/* Attachment previews */}
      {pendingAttachments.length > 0 && (
        <div className="px-3 pt-3">
          <AttachmentPreviewBar
            attachments={pendingAttachments}
            onRemove={removeAttachment}
            onPreview={handlePreviewAttachment}
          />
        </div>
      )}

      {/* Input area with drag-drop */}
      <div
        className="relative mx-3 mt-3"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Slash Command / Mention Menus */}
        {showSlashMenu && (
          <SlashCommandMenu
            commands={DEFAULT_SLASH_COMMANDS}
            query={slashQuery}
            highlightedIndex={highlightedSlashIndex}
            onSelect={handleSlashSelect}
          />
        )}
        {showMentionMenu && (
          <MentionMenu
            items={mentionItems}
            query={mentionQuery}
            highlightedIndex={highlightedMentionIndex}
            onSelect={handleMentionSelect}
          />
        )}

        {/* Textarea */}
        <ComposerInput
          value={value}
          onChange={setValue}
          onSubmit={handleSubmit}
          onSlashDetected={handleSlashDetect}
          onMentionDetected={handleMentionDetect}
          onSlashDismiss={handleSlashDismiss}
          onMentionDismiss={handleMentionDismiss}
          disabled={!activeSessionId}
          placeholder={isStreaming ? 'Press Enter to follow-up, or click Steer to redirect...' : undefined}
          showMenu={showSlashMenu || showMentionMenu}
          onMenuNavigate={handleMenuNavigate}
          onMenuSelect={handleMenuSelect}
          isStreaming={isStreaming}
          onSteerSubmit={handleSteerSubmit}
          onFollowUpSubmit={handleFollowUpSubmit}
          pendingTokenInsert={pendingTokenInsert}
          tokenInsertVersion={tokenInsertVersion}
          focusVersion={focusVersion}
        />

        {/* Drag overlay */}
        {isDragging && (
          <div className="absolute inset-0 flex items-center justify-center bg-primary/5 rounded-lg border-2 border-dashed border-primary/50 z-10 pointer-events-none">
            <div className="flex flex-col items-center gap-1 text-primary/70">
              <Upload className="h-6 w-6" />
              <span className="text-xs font-medium">Drop files to attach</span>
            </div>
          </div>
        )}
      </div>

      {/* Queued steer / follow-up messages indicator */}
      <QueueIndicator />

      {/* Divider */}
      <Separator className="mt-3" />

      {/* Bottom tools row */}
      <div className="flex items-center gap-1 px-3 py-2 min-w-0 flex-wrap">
        <FileUploadButton
          disabled={isStreaming}
          onFilesSelected={handleFilesSelected}
        />
        <div className="h-4 w-px bg-border mx-1 hidden sm:block" />
        <ModelSelector
          value={config?.defaultModelId ?? ''}
          onChange={(modelId) => updateConfigMut.mutate({ defaultModelId: modelId })}
        />
        <ThinkLevelSelector
          value={config?.defaultThinkLevel ?? 'medium'}
          onChange={(level) => updateConfigMut.mutate({ defaultThinkLevel: level })}
        />
        <div className="h-4 w-px bg-border mx-1 hidden sm:block" />
        <SkillSelector
          skills={availableSkills ?? []}
          selectedIds={validSelectedSkills}
          onToggle={toggleSkill}
        />
        <CompactToggle compact={compactMode} onToggle={setCompactMode} />
        <div className="flex items-center gap-1 shrink-0 ml-auto">
        {isStreaming ? (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={handleSteerSubmit}
              disabled={!value.trim()}
              className="h-8 gap-1.5 text-xs"
              aria-label="Steer (Ctrl+Enter)"
            >
              <CornerDownRight className="h-3.5 w-3.5" />
              Steer
              <kbd className="ml-0.5 text-[10px] opacity-60 hidden sm:inline">⌃↵</kbd>
            </Button>
            <Button
              size="icon"
              variant="destructive"
              onClick={handleStopGeneration}
              className="h-8 w-8 shrink-0"
              aria-label="Stop generation"
            >
              <Square className="h-3.5 w-3.5" />
            </Button>
          </>
        ) : (
          <SendButton
            onClick={handleSubmit}
            disabled={(!value.trim() && pendingAttachments.length === 0) || !activeSessionId}
            isLoading={sendMutation.isPending}
          />
        )}
        </div>
      </div>

      {/* Slash command dialog (/help, /config, /model) */}
      <SlashCommandDialog data={commandDialog} onClose={() => setCommandDialog(null)} />
    </div>
  );
}
