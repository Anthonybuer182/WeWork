import * as path from 'path';
import { statSync, readFileSync } from 'node:fs';
import type { ChatService, SendMessageParams, StreamChunk } from '../services/chat.js';
import type { Message, AssistantMessage, ContentBlock, ToolResultBlock, TokenUsage, ContextUsageInfo, SessionStatsInfo, MessageTiming, AgentContextConfig, AgentContextReloadResult, AgentToolInfo, AppendSegmentInfo, ContextFileInfo, ContextFileScope, PromptFileInfo } from '@pi/types';
import { createAgentSession, SessionManager, ModelRegistry, AuthStorage, DefaultResourceLoader, getAgentDir, SettingsManager, formatSkillsForPrompt } from '@earendil-works/pi-coding-agent';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { extractThinkContent } from '../utils/think-parser.js';
import { deleteFileWithMtimeGuard, writeFileWithMtimeGuard } from '../utils/safe-write.js';
import { detectWrittenFiles } from '../utils/file-detection.js';
import { migrateModelsConfig } from './config.js';

/**
 * Real chat adapter using createAgentSessionFromServices.
 *
 * Creates interactive AgentSession instances backed by the real SDK.
 * For existing sessions, opens via SessionManager and attaches to AgentSession.
 * For new sessions, creates via SessionManager.create().
 *
 * `options.customToolsProvider` supplies plugin-contributed agent tools;
 * they are snapshotted at session creation — call `invalidateSessions()`
 * (wired to the plugin system's extensions-changed hook) to rebuild.
 */
/**
 * A plugin's usage doc, as it reaches the prompt.
 *
 * `description` is the entire match surface — the agent only opens the file
 * when that line fits the task at hand.
 */
export interface PluginDoc {
  name: string;
  pluginId?: string;
  description: string;
  /** Absolute path to the plugin's PLUGIN.md. */
  location: string;
}

/**
 * The plugin index, shaped like the SDK's own `<available_skills>` block.
 *
 * Same contract as skills, and for the same reason: only name, description and
 * path go in the prompt, and the body is read on demand. A plugin's full doc
 * would be a permanent tax on every request; its one-line description is not.
 * The agent reads the file itself when that line matches.
 */
export function formatPluginDocsForPrompt(docs: PluginDoc[]): string {
  if (docs.length === 0) return '';
  const lines = [
    '',
    'The following plugins are installed. Each one ships a PLUGIN.md describing what it can do and how to drive it.',
    "Use the read tool to load a plugin's file when the task matches its description.",
    '',
    '<available_plugins>',
  ];
  for (const doc of docs) {
    lines.push('  <plugin>');
    lines.push(`    <name>${escapeXml(doc.name)}</name>`);
    lines.push(`    <description>${escapeXml(doc.description)}</description>`);
    lines.push(`    <location>${escapeXml(doc.location)}</location>`);
    lines.push('  </plugin>');
  }
  lines.push('</available_plugins>');
  return lines.join('\n');
}

const escapeXml = (str: string): string =>
  str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

/**
 * The host's own contribution to `appendSystemPrompt`, ahead of the plugin
 * index. Named so the context reader can attribute each appended segment back
 * to its origin instead of guessing from the text.
 */
export const HOST_VISION_PROMPT =
  'You are equipped with vision capabilities. When users attach images or when the read tool loads image files, analyze the visual content directly. This includes: screenshots of code/errors, UI designs, architecture diagrams, charts, photos, and any other images the user shares. Describe what you see clearly and use it to provide better coding assistance.';

/**
 * The host's own contribution to `appendSystemPrompt`, in the order the SDK
 * receives it.
 *
 * A single builder because two callers need the same list and must not drift:
 * session creation, and the context reader that reports what is in the prompt.
 * The list is supplied by *us*, not by the SDK's defaults — a bare
 * `DefaultResourceLoader` returns an empty `getAppendSystemPrompt()`, which is
 * exactly how the reader first reported these segments as costing nothing.
 */
export function buildHostAppendSystemPrompt(pluginDocs: string): string[] {
  return [HOST_VISION_PROMPT, ...(pluginDocs ? [pluginDocs] : [])];
}

/**
 * Build the loader's `appendSystemPromptOverride`.
 *
 * Deliberately NOT `appendSystemPrompt`: passing the array sets the loader's
 * `appendSystemPromptSource`, and the loader only falls back to discovering
 * `APPEND_SYSTEM.md` when that source is absent. So the direct form makes the
 * user's own append file silently inert — it exists on disk, reads fine, and
 * never reaches the prompt. The override form is handed whatever was
 * discovered and returns the final list, so both survive.
 *
 * Host segments come first and the user's file after: the vision line and the
 * plugin index are host metadata, while the append file is the user's own
 * instruction and reads as the last thing added.
 */
export function buildAppendSystemPromptOverride(
  pluginDocs: string,
): (discovered: string[]) => string[] {
  return (discovered) => [...buildHostAppendSystemPrompt(pluginDocs), ...discovered];
}

export interface RealChatServiceOptions {
  customToolsProvider?: () => unknown[];
  /** Enabled plugins' PLUGIN.md index. Read per session, so installs take effect without a restart. */
  pluginDocsProvider?: () => PluginDoc[];
}

export function createRealChatService(
  cwd: string,
  modelRegistry?: ModelRegistry,
  settingsManager?: SettingsManager,
  options?: RealChatServiceOptions,
): ChatService {
  const activeSessions = new Map<string, { session: AgentSession; unsubscribe: () => void; cwd: string; skills?: string[] }>();
  // Track last message end time per session for thinking time calculation
  const sessionTimings = new Map<string, number>();

  // Shared ModelRegistry — picks up built-in models + models from ~/.pi/agent/models.json
  const registry = modelRegistry ?? ModelRegistry.create(AuthStorage.inMemory());

  /** Find a model in the registry by its ID string.
   *  Supports "provider/modelId" format for disambiguation.
   *  When multiple models share the same ID, prefers models with configured
   *  auth (from models.json or env vars) over built-in ones without auth. */
  function findModelById(modelId: string) {
    const slashIdx = modelId.lastIndexOf('/');
    if (slashIdx > 0) {
      const provider = modelId.substring(0, slashIdx);
      const id = modelId.substring(slashIdx + 1);
      return registry.getAvailable().find((m) => m.id === id && m.provider === provider);
    }
    // Only return models that have configured auth (API key or OAuth)
    const available = registry.getAvailable();
    for (let i = available.length - 1; i >= 0; i--) {
      if (available[i].id === modelId) return available[i];
    }
    return undefined;
  }

  /** Convert SDK Usage to our TokenUsage format */
  function sdkUsageToTokenUsage(usage: any): TokenUsage {
    return {
      inputTokens: usage.input ?? 0,
      outputTokens: usage.output ?? 0,
      totalTokens: usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0),
      cacheReadTokens: usage.cacheRead ?? 0,
      cacheWriteTokens: usage.cacheWrite ?? 0,
      cost: usage.cost?.total ?? 0,
    };
  }

  // extractThinkContent is imported from ../utils/think-parser.js
  // so the streaming adapter and the session loader share one implementation.
  // detectWrittenFiles and getMimeType are imported from ../utils/file-detection.js

  async function createResourceLoader(workCwd: string, selectedSkillIds?: string[]) {
    // Read at session creation, not cached: enabling a plugin takes effect on
    // the next conversation instead of needing an app restart.
    const pluginDocs = formatPluginDocsForPrompt(options?.pluginDocsProvider?.() ?? []);
    const resourceLoader = new DefaultResourceLoader({
      cwd: workCwd,
      agentDir: getAgentDir(),
      appendSystemPromptOverride: buildAppendSystemPromptOverride(pluginDocs),
      skillsOverride: selectedSkillIds
        ? (base) => {
            const enabledNames = new Set(
              selectedSkillIds.map((id) => id.startsWith('skill-') ? id.slice(6) : id),
            );
            return {
              skills: base.skills.filter((s) => enabledNames.has(s.name)),
              diagnostics: base.diagnostics,
            };
          }
        : undefined,
    });
    await resourceLoader.reload();
    return resourceLoader;
  }

  async function getOrCreateAgentSession(
    sessionId?: string,
    workspaceCwd?: string,
    skills?: string[],
  ): Promise<AgentSession> {
    const key = sessionId || 'default';
    const workCwd = workspaceCwd || cwd;

    // If a cached session exists, return it directly unless the caller provided
    // an explicit workspaceCwd that differs from the session's cwd (e.g. user
    // switched workspaces) or skills changed. steer/followUp/navigateTree don't
    // pass workspaceCwd or skills, so they safely reuse the existing session.
    const cached = activeSessions.get(key);
    if (cached) {
      const skillsChanged = skills && !cached.skills
        ? true
        : skills && cached.skills
          ? skills.length !== cached.skills.length || !skills.every((s) => cached.skills!.includes(s))
          : false;
      if ((!workspaceCwd || cached.cwd === workspaceCwd) && !skillsChanged) {
        return cached.session;
      }
      // cwd or skills mismatch — tear down the old session and create a new one
      cached.unsubscribe();
      activeSessions.delete(key);
    }
    let sessionManager: SessionManager;

    if (sessionId) {
      // Open existing session
      sessionManager = SessionManager.open(sessionId, undefined, workCwd);
    } else {
      // Create new session
      sessionManager = SessionManager.create(workCwd);
    }

    const { session } = await createAgentSession({
      cwd: workCwd,
      sessionManager,
      modelRegistry: registry, // share registry so custom models are visible
      resourceLoader: await createResourceLoader(workCwd, skills),
      settingsManager,         // share settings so shell path is respected
      customTools: (options?.customToolsProvider?.() ?? []) as never,
    });

    const unsubscribe = session.subscribe((_event) => {
      // Events are handled at the call site level
    });

    activeSessions.set(key, { session, unsubscribe, cwd: workCwd, skills });
    return session;
  }

  // ── Standing context (plugin capability: agent.context.config.read) ──

  /**
   * Approximate token count for a block of text.
   *
   * Deliberately crude: no API attributes real token cost to a prompt section,
   * so every number derived here is an estimate and callers must present it as
   * one. ~4 chars/token is the usual rule of thumb and is close enough for the
   * question these numbers actually answer — who is eating the budget.
   */
  function estimateTextTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  function isInside(child: string, parent: string): boolean {
    const rel = path.relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  }

  function classifyContextFile(filePath: string, workspacePath: string): ContextFileScope {
    if (isInside(filePath, getAgentDir())) return 'global';
    if (isInside(filePath, workspacePath)) return 'workspace';
    return 'ancestor';
  }

  /** Shape of the SDK's ToolInfo / AgentCustomTool, narrowed to what we report. */
  type AnyTool = {
    name?: unknown;
    description?: unknown;
    parameters?: unknown;
    /** Present on plugin-contributed tools; absent on the SDK's own. */
    pluginId?: unknown;
  };

  function toToolInfo(tool: AnyTool, fallbackSource: string): AgentToolInfo {
    return {
      name: String(tool.name ?? ''),
      description: typeof tool.description === 'string' ? tool.description : undefined,
      source: fallbackSource,
      schemaBytes: JSON.stringify(tool.parameters ?? {}).length,
    };
  }

  /**
   * The SDK's built-in tool names for when no live session is available to ask.
   * `getAllTools()` is authoritative but needs a session; this is its documented
   * default set.
   */
  const DEFAULT_BUILTIN_TOOLS = ['read', 'bash', 'edit', 'write'];

  /**
   * The SDK's prompt-file discovery, mirrored.
   *
   * `discoverSystemPromptFile()` / `discoverAppendSystemPromptFile()` are
   * private on the loader, so the rule is restated here: a file under
   * `<cwd>/.pi/` shadows the global one under the agent dir, and only the
   * winner is read. Reporting the loser too is the point — a shadowed global
   * file looks like it should be in effect and silently is not.
   */
  const PROMPT_CONFIG_DIR = '.pi';

  function discoverPromptPaths(cwd: string): {
    system: { global: string; project: string };
    append: { global: string; project: string };
  } {
    const agentDir = getAgentDir();
    return {
      system: {
        global: path.join(agentDir, 'SYSTEM.md'),
        project: path.join(cwd, PROMPT_CONFIG_DIR, 'SYSTEM.md'),
      },
      append: {
        global: path.join(agentDir, 'APPEND_SYSTEM.md'),
        project: path.join(cwd, PROMPT_CONFIG_DIR, 'APPEND_SYSTEM.md'),
      },
    };
  }

  function readPromptFile(kind: 'system' | 'append', scope: 'global' | 'project', filePath: string): PromptFileInfo {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const stat = statSync(filePath);
      return {
        kind,
        scope,
        path: filePath,
        exists: true,
        active: false,
        content,
        bytes: Buffer.byteLength(content, 'utf-8'),
        chars: content.length,
        mtimeMs: stat.mtimeMs,
      };
    } catch {
      return {
        kind,
        scope,
        path: filePath,
        exists: false,
        active: false,
        content: null,
        bytes: 0,
        chars: 0,
        mtimeMs: 0,
      };
    }
  }

  /** Both scopes for both kinds, with the winner of each pair marked active. */
  function collectPromptFiles(cwd: string): PromptFileInfo[] {
    const paths = discoverPromptPaths(cwd);
    const out: PromptFileInfo[] = [];
    for (const kind of ['system', 'append'] as const) {
      const pair = [readPromptFile(kind, 'project', paths[kind].project), readPromptFile(kind, 'global', paths[kind].global)];
      const winner = pair.find((f) => f.exists);
      if (winner) winner.active = true;
      out.push(...pair);
    }
    return out;
  }

  async function readAgentContextConfig(
    workspacePath: string,
    workspaceId?: string,
  ): Promise<AgentContextConfig> {
    const resolvedWorkspace = path.resolve(workspacePath);
    // The appended segments are the host's own list, not an SDK default — a bare
    // loader reports none. Built through the same helper session creation uses,
    // so what this reports is what the model actually receives.
    const pluginDocsBlock = formatPluginDocsForPrompt(options?.pluginDocsProvider?.() ?? []);
    const hostSegments = buildHostAppendSystemPrompt(pluginDocsBlock);
    const loader = new DefaultResourceLoader({
      cwd: resolvedWorkspace,
      agentDir: getAgentDir(),
      appendSystemPromptOverride: buildAppendSystemPromptOverride(pluginDocsBlock),
    });
    await loader.reload();

    // A live session for this workspace is the only source of the assembled
    // prompt: the SDK's buildSystemPrompt is not exported, so the built-in base
    // prompt cannot be reproduced without one.
    let live: AgentSession | undefined;
    for (const cached of activeSessions.values()) {
      if (path.resolve(cached.cwd) === resolvedWorkspace) {
        live = cached.session;
        break;
      }
    }

    // ── appended segments (host vision line + plugin index + the user's own
    // APPEND_SYSTEM.md, in the order the override builds them) ──
    const promptFiles = collectPromptFiles(resolvedWorkspace);
    const appended: AppendSegmentInfo[] = loader.getAppendSystemPrompt().map((text) => {
      const hostIndex = hostSegments.indexOf(text);
      if (hostIndex === 0) return { label: '视觉能力说明', source: 'host' as const, text, chars: text.length };
      if (hostIndex > 0) return { label: '插件索引', source: 'plugin-docs' as const, text, chars: text.length };
      return { label: '追加提示词', source: 'user-append' as const, text, chars: text.length };
    });

    // ── context files (global AGENTS.md + every ancestor of the workspace) ──
    const contextFiles: ContextFileInfo[] = loader.getAgentsFiles().agentsFiles.map((file) => {
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(file.path).mtimeMs;
      } catch {
        // Vanished between discovery and here. Left at 0 so a write from the
        // panel is refused instead of silently recreating the file.
      }
      return {
        path: file.path,
        scope: classifyContextFile(file.path, resolvedWorkspace),
        bytes: Buffer.byteLength(file.content, 'utf-8'),
        chars: file.content.length,
        content: file.content,
        mtimeMs,
      };
    });

    // ── skills ──
    const skillList = loader.getSkills().skills;
    const renderedSkills = formatSkillsForPrompt(skillList);
    const skills = {
      items: skillList.map((s) => ({
        name: s.name,
        description: s.description,
        path: s.filePath,
        chars: (s.description ?? '').length,
      })),
      rendered: renderedSkills,
      chars: renderedSkills.length,
    };

    // ── tools ──
    // The SDK's own tool list carries no notion of which plugin contributed a
    // tool, so attribution comes from the aggregate: a name → plugin index built
    // once and used on both paths. Without it every plugin tool would be
    // reported as built-in, which is exactly the number this panel exists to
    // break down.
    const pluginTools = (options?.customToolsProvider?.() ?? []) as AnyTool[];
    const pluginOf = new Map<string, string>();
    for (const tool of pluginTools) {
      if (typeof tool.pluginId === 'string') pluginOf.set(String(tool.name ?? ''), tool.pluginId);
    }

    const tools: AgentToolInfo[] = [];
    if (live) {
      for (const tool of live.getAllTools()) {
        const name = String((tool as AnyTool).name ?? '');
        tools.push(toToolInfo(tool as AnyTool, pluginOf.get(name) ?? 'builtin'));
      }
    } else {
      for (const name of DEFAULT_BUILTIN_TOOLS) {
        tools.push({ name, source: 'builtin', schemaBytes: 0 });
      }
      for (const tool of pluginTools) {
        tools.push(toToolInfo(tool, typeof tool.pluginId === 'string' ? tool.pluginId : 'plugin'));
      }
    }

    // ── the assembled prompt, when a live session can hand it over ──
    const activeSystemFile = promptFiles.find((f) => f.kind === 'system' && f.active);
    let assembled: AgentContextConfig['assembled'] = null;
    // A SYSTEM.md is a file, so its text is readable with or without a session —
    // which makes the base prompt knowable in exactly the case where the user
    // replaced it. Only the SDK's own built-in text needs a session to reach.
    let baseText: string | null = activeSystemFile?.content ?? null;
    let baseNote = activeSystemFile
      ? '由你的 SYSTEM.md 提供。'
      : '尚未建立会话，读不到 SDK 内置的基础提示词正文。发一次消息后再打开本面板即可看到。';

    if (live) {
      const text = live.systemPrompt;
      assembled = { text, chars: text.length, tokensEst: estimateTextTokens(text) };
      // Anchor on the vision line: the append override places the host's segments
      // immediately after the base prompt, so everything before it is the base —
      // whether that is the SDK's built-in text or a SYSTEM.md replacing it.
      const anchor = text.indexOf(HOST_VISION_PROMPT);
      if (anchor > 0) {
        baseText = text.slice(0, anchor).trimEnd();
        baseNote = activeSystemFile
          ? '由你的 SYSTEM.md 提供，已在当前会话中生效。'
          : 'SDK 内置基础提示词。';
      } else if (!activeSystemFile) {
        baseText = null;
        baseNote = '已读到完整系统提示词，但基础段无法与追加段可靠切分，请以上方完整内容为准。';
      }
    }

    // ── plugin docs (what the appended index actually costs per plugin) ──
    const pluginDocs = (options?.pluginDocsProvider?.() ?? []).map((doc) => ({
      pluginId: doc.pluginId ?? '',
      name: doc.name,
      description: doc.description,
      path: doc.location,
      chars: doc.name.length + doc.description.length + doc.location.length,
    }));

    // ── totals ──
    const sectionChars =
      (baseText?.length ?? 0) +
      appended.reduce((n, s) => n + s.chars, 0) +
      contextFiles.reduce((n, f) => n + f.chars, 0) +
      skills.chars +
      tools.reduce((n, t) => n + t.schemaBytes, 0);
    const chars = assembled?.chars ?? sectionChars;
    const tokensEst = estimateTextTokens(
      assembled?.text ??
        [
          ...appended.map((s) => s.text),
          ...contextFiles.map((f) => f.content),
          skills.rendered,
        ].join('\n'),
    );

    const windowTokens = live?.model?.contextWindow;
    return {
      workspace: { id: workspaceId, path: resolvedWorkspace, name: path.basename(resolvedWorkspace) },
      agentDir: getAgentDir(),
      assembled,
      promptFiles,
      sections: {
        base: {
          text: baseText,
          chars: baseText?.length ?? null,
          note: baseNote,
          overridden: activeSystemFile !== undefined,
        },
        appended,
        contextFiles,
        skills,
        tools,
      },
      pluginDocs,
      totals: {
        chars,
        tokensEst,
        windowTokens,
        share: windowTokens ? Math.min(1, tokensEst / windowTokens) : undefined,
      },
    };
  }

  /**
   * Rebuild a live session's prompt from disk.
   *
   * Context files are read when a session is built, so an AGENTS.md edit is
   * otherwise invisible until the user starts a new session. `session.reload()`
   * re-reads the resource loader and rebuilds the base prompt from it, which
   * makes the edit apply to the next turn.
   *
   * Refuses while anything is streaming: `reload()` resets global API providers
   * and tears down the extension runtime, which is not something to do under a
   * request that is already in flight. The caller surfaces the refusal instead
   * of the edit silently appearing to do nothing.
   */
  async function reloadAgentContext(workspacePath: string): Promise<AgentContextReloadResult> {
    const resolvedWorkspace = path.resolve(workspacePath);
    let live: AgentSession | undefined;
    for (const cached of activeSessions.values()) {
      if (path.resolve(cached.cwd) === resolvedWorkspace) {
        live = cached.session;
        break;
      }
    }
    // No session yet: the file is read when one is created, so the edit lands
    // on its own without anything to rebuild.
    if (!live) return { applied: false, reason: 'no-session' };

    for (const cached of activeSessions.values()) {
      if (cached.session.isStreaming) return { applied: false, reason: 'busy' };
    }

    await live.reload();
    return { applied: true };
  }

  /**
   * Rebuild after a write, without letting a rebuild failure masquerade as a
   * failed write.
   *
   * By the time this runs the file is already on disk. If `reload()` throws, the
   * edit happened and only *applying* it did not — reporting the whole operation
   * as failed would send the user looking for a problem that isn't there, and
   * likely re-editing a file that is already correct.
   */
  async function reloadAfterWrite(workspacePath: string): Promise<AgentContextReloadResult> {
    try {
      return await reloadAgentContext(workspacePath);
    } catch (err) {
      return {
        applied: false,
        reason: 'error',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return {
    /** Tear down all cached sessions so the next prompt rebuilds them
     *  (used when the plugin tool/skill set changes at runtime). */
    invalidateSessions(): void {
      for (const cached of activeSessions.values()) {
        try { cached.unsubscribe(); } catch { /* best-effort */ }
      }
      activeSessions.clear();
    },

    getAgentContextConfig(workspacePath: string, workspaceId?: string): Promise<AgentContextConfig> {
      return readAgentContextConfig(workspacePath, workspaceId);
    },

    reloadAgentContext(workspacePath: string): Promise<AgentContextReloadResult> {
      return reloadAgentContext(workspacePath);
    },

    async writeContextFile({ workspacePath, path: filePath, content, expectedMtime }) {
      // Guard first: a refused write must not leave a half-applied reload.
      const file = writeFileWithMtimeGuard(filePath, content, expectedMtime);
      return { file, reload: await reloadAfterWrite(workspacePath) };
    },

    async deleteContextFile({ workspacePath, path: filePath, expectedMtime }) {
      const deleted = deleteFileWithMtimeGuard(filePath, expectedMtime);
      return { deleted, reload: await reloadAfterWrite(workspacePath) };
    },

    async sendMessage(params: SendMessageParams): Promise<Message> {
      const session = await getOrCreateAgentSession(params.sessionId, params.workspaceCwd, params.skills);

      try {
        // Auto-migrate and always refresh so the in-memory registry
        // picks up any models.json changes (e.g. manually patched multimodal models).
        migrateModelsConfig();
        registry.refresh();

        // Switch to the requested model if specified
        if (params.modelId) {
          const model = findModelById(params.modelId);
          if (!model) {
            throw new Error(`Model "${params.modelId}" not found. Please configure a valid model in Settings or set the correct API key environment variable.`);
          }
          await session.setModel(model);
        }

        const images = params.attachments?.length
          ? params.attachments
              .filter((a) => a.mimeType.startsWith('image/') && a.data)
              .map((a) => ({
                type: 'image' as const,
                data: a.data,
                mimeType: a.mimeType,
              }))
          : undefined;
        await session.prompt(params.content, images?.length ? { images } : undefined);

      // Get session stats for cost/usage on the returned message
      let totalUsage: TokenUsage | undefined;
      try {
        const stats = session.getSessionStats();
        totalUsage = {
          inputTokens: stats.tokens.input,
          outputTokens: stats.tokens.output,
          totalTokens: stats.tokens.total,
          cacheReadTokens: stats.tokens.cacheRead,
          cacheWriteTokens: stats.tokens.cacheWrite,
          cost: stats.cost,
        };
      } catch { /* stats are best-effort */ }

      const asstMsg: AssistantMessage = {
        id: `msg-${Date.now()}-asst`,
        sessionId: params.sessionId,
        role: 'assistant',
        status: 'complete',
        modelId: params.modelId ?? 'unknown',
        content: session.getLastAssistantText() || '',
        blocks: [],
        usage: totalUsage,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      return asstMsg;
      } catch (err) {
        throw new Error(err instanceof Error ? err.message : 'Failed to send message');
      }
    },

    async sendMessageStream(
      params: SendMessageParams,
      onChunk: (chunk: StreamChunk) => void,
      signal?: AbortSignal,
    ): Promise<Message> {
      const session = await getOrCreateAgentSession(params.sessionId, params.workspaceCwd, params.skills);
      const sessionKey = params.sessionId || 'default';
      const workspaceCwd = params.workspaceCwd;

      // Guard to prevent writing to a closed SSE stream
      let streamActive = true;
      const safeChunk = (chunk: StreamChunk) => {
        if (streamActive) {
          try { onChunk(chunk); } catch { /* ignore write-after-end */ }
        }
      };

      // Timing tracking
      let messageStartTime = 0;
      let messageEndTime = 0;
      let outputText = '';
      let thinkingBlockId: string | null = null; // stable ID per message turn
      let textBlockId: string | null = null; // stable ID per message turn
      const toolStartTimes = new Map<string, number>();
      const toolNames = new Map<string, string>();
  const toolArgs = new Map<string, Record<string, unknown>>();

      const unsubscribe = session.subscribe((event: any) => {
        // Skip sending chunks if stream is already closed
        if (!streamActive) return;
        switch (event.type) {
          case 'message_start': {
            messageStartTime = Date.now();
            thinkingBlockId = null; // reset for new turn
            textBlockId = null; // reset for new turn
            // Signal frontend that a new message group is starting,
            // so it creates fresh blocks instead of overwriting prior group.
            safeChunk({ type: 'message_start' });
            break;
          }
          case 'message_update': {
            const msg = event.message;
            if (msg && msg.content) {
              const content = msg.content;
              if (Array.isArray(content)) {
                for (const block of content) {
                  if (block.type === 'text' && block.text) {
                    // block.text carries the full accumulated text, not a delta.
                    outputText = block.text;

                    // Extract <think>...</think> tags from text (Minimax, DeepSeek-R1).
                    // These models return thinking content as XML tags in the text stream
                    // rather than structured reasoning_content blocks.
                    const thinkResult = extractThinkContent(block.text);

                    // Emit thinking block when think content is present
                    if (thinkResult.thinking !== null) {
                      if (!thinkingBlockId) {
                        thinkingBlockId = `b-think-${Date.now()}`;
                      }
                      safeChunk({
                        type: 'block',
                        block: {
                          id: thinkingBlockId,
                          type: 'thinking',
                          content: thinkResult.thinking,
                          thinking: thinkResult.thinking,
                        },
                      });
                    }

                    // Always emit text block with think tags stripped (may be empty during thinking phase)
                    if (!textBlockId) textBlockId = `bt-stream-${Date.now()}`;
                    safeChunk({
                      type: 'block',
                      block: {
                        id: textBlockId,
                        type: 'text',
                        content: thinkResult.text,
                      },
                    });
                  } else if (block.type === 'image') {
                    // Image blocks in streaming — send as block for display
                    safeChunk({
                      type: 'block',
                      block: {
                        id: `b-img-${Date.now()}`,
                        type: 'image',
                        content: block.data || '',
                        mimeType: block.mimeType || 'image/png',
                        data: block.data || '',
                        width: block.width,
                        height: block.height,
                      },
                    });
                  } else if (block.type === 'thinking') {
                    if (!thinkingBlockId) {
                      thinkingBlockId = `b-think-${Date.now()}`;
                    }
                    safeChunk({
                      type: 'block',
                      block: {
                        id: thinkingBlockId,
                        type: 'thinking',
                        content: block.thinking || '',
                        thinking: block.thinking,
                      },
                    });
                  } else if (block.type === 'toolCall' || block.type === 'tool_call') {
                    // Only emit tool_call from message_update if it has a toolCallId.
                    // Without an ID we can't dedup against tool_execution_start blocks,
                    // which would cause duplicate empty entries.
                    if (!block.toolCallId) continue;
                    // block.input carries tool arguments from the SDK
                    const args = (block as any).input ?? (block as any).args;
                    // Store args for file detection in tool_execution_end
                    if (block.toolCallId && args) {
                      toolArgs.set(block.toolCallId, typeof args === 'object' ? args : undefined);
                    }
                    if (block.toolCallId && block.toolName) {
                      toolNames.set(block.toolCallId, block.toolName);
                    }
                    safeChunk({
                      type: 'block',
                      block: {
                        id: `b-tc-${Date.now()}`,
                        type: 'tool_call',
                        content: block.name || 'tool',
                        toolCallId: block.toolCallId,
                        toolName: block.name || block.toolName,
                        args: typeof args === 'object' && args !== null ? args : undefined,
                      },
                    });
                  }
                }
              } else if (typeof content === 'string') {
                outputText += content;
                safeChunk({ type: 'text', content });
              }
            }
            break;
          }
          case 'tool_execution_start': {
            toolStartTimes.set(event.toolCallId, Date.now());
            toolArgs.set(event.toolCallId, (event as any).args);
            toolNames.set(event.toolCallId, event.toolName);
            safeChunk({
              type: 'block',
              block: {
                id: `b-te-${Date.now()}`,
                type: 'tool_call',
                content: event.toolName || 'tool execution',
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                args: (event as any).args ?? undefined,
              },
            });
            break;
          }
          case 'tool_execution_end': {
            const startTime = toolStartTimes.get(event.toolCallId);
            const durationMs = startTime ? Date.now() - startTime : undefined;
            const storedArgs = toolArgs.get(event.toolCallId);
            toolStartTimes.delete(event.toolCallId);
            toolArgs.delete(event.toolCallId);
            const toolName = toolNames.get(event.toolCallId) ?? undefined;
            toolNames.delete(event.toolCallId);

            // event.result is { content: Array<{type, text}>, isError: boolean }
            // Extract text from content blocks for display
            const rawResult = (event as any).result;
            // Plugin message-renderer card tree (declarative chat cards).
            const cardTree = rawResult?.details?.card ?? undefined;
            let resultText: string;
            if (rawResult && typeof rawResult === 'object' && Array.isArray(rawResult.content)) {
              resultText = rawResult.content
                .filter((c: any) => c.type === 'text')
                .map((c: any) => c.text || '')
                .join('\n');
            } else if (typeof rawResult === 'string') {
              resultText = rawResult;
            } else {
              resultText = String(rawResult ?? '');
            }

            safeChunk({
              type: 'block',
              block: {
                id: `b-ter-${Date.now()}`,
                type: 'tool_result',
                content: event.isError ? `Error: ${resultText}` : resultText || 'Done',
                toolCallId: event.toolCallId,
                toolName,
                result: resultText,
                card: cardTree,
                isError: (event as any).isError || rawResult?.isError || false,
              } as ToolResultBlock,
            });

            // Emit image blocks from tool result content
            if (rawResult && Array.isArray(rawResult.content)) {
              for (const c of rawResult.content as any[]) {
                if (c.type === 'image') {
                  safeChunk({
                    type: 'block',
                    block: {
                      id: `b-ter-img-${Date.now()}`,
                      type: 'image',
                      content: c.data || '',
                      mimeType: c.mimeType || 'image/png',
                      data: c.data || '',
                    },
                  });
                }
              }
            }

            // Emit file blocks for files written by tools
            const effectiveArgs = storedArgs || (event as any).args;
            if (!event.isError && effectiveArgs) {
              const writtenFiles = detectWrittenFiles(
                event.toolName,
                effectiveArgs,
                resultText,
                workspaceCwd,
              );
              for (const file of writtenFiles) {
                safeChunk({
                  type: 'block',
                  block: {
                    id: `b-ter-file-${file.relPath}`,
                    type: 'file',
                    content: path.basename(file.absPath),
                    mimeType: file.mimeType,
                    fileName: path.basename(file.absPath),
                    fileSize: file.size,
                    workspacePath: file.absPath,
                  },
                });
              }
            }

            // Emit tool timing
            if (durationMs !== undefined) {
              safeChunk({
                type: 'tool_timing',
                toolTiming: {
                  toolCallId: event.toolCallId,
                  toolName: event.toolName,
                  durationMs,
                },
              });
            }
            break;
          }
          case 'message_end': {
            messageEndTime = Date.now();
            // Surface API errors: the SDK records stopReason "error" +
            // errorMessage on the assistant message instead of throwing —
            // without this the UI shows an empty response with no feedback.
            const endMsg = event.message;
            if (endMsg?.stopReason === 'error') {
              safeChunk({
                type: 'error',
                error: endMsg.errorMessage || `Model request failed (${endMsg.provider ?? ''} ${endMsg.model ?? ''}). Check the provider baseUrl / API key in Settings.`,
              });
            }
            // Forward usage data from the completed message
            const msgUsage = endMsg?.usage;
            if (msgUsage) {
              const tokenUsage = sdkUsageToTokenUsage(msgUsage);
              safeChunk({ type: 'usage', usage: tokenUsage });

              // Calculate per-message timing metrics
              const prevEndTime = sessionTimings.get(sessionKey) ?? 0;
              const thinkingTimeMs = prevEndTime > 0 ? Math.max(0, messageStartTime - prevEndTime) : 0;
              const generationTimeMs = Math.max(1, messageEndTime - messageStartTime);
              const outputTokens = tokenUsage.outputTokens || 0;
              const estTokens = Math.ceil(outputText.length / 4);
              const tps = outputTokens / (generationTimeMs / 1000);

              safeChunk({
                type: 'message_timing',
                messageTiming: {
                  estTokens,
                  tps: Math.round(tps * 10) / 10,
                  thinkingTimeMs,
                  generationTimeMs,
                },
              });

              // Update last message end time for this session
              sessionTimings.set(sessionKey, messageEndTime);
            }
            break;
          }
          case 'agent_end': {
            // Agent ended (may retry or finalize)
            if (!event.willRetry) {
              // Send context usage before done
              try {
                const ctxUsage = session.getContextUsage();
                if (ctxUsage) {
                  safeChunk({
                    type: 'context',
                    contextUsage: {
                      tokens: ctxUsage.tokens,
                      contextWindow: ctxUsage.contextWindow,
                      percent: ctxUsage.percent,
                    },
                  });
                }
              } catch { /* best-effort */ }

              // Send session stats before done
              try {
                const stats = session.getSessionStats();
                const ctxUsage = stats.contextUsage ?? session.getContextUsage();
                safeChunk({
                  type: 'stats',
                  sessionStats: {
                    tokens: {
                      input: stats.tokens.input,
                      output: stats.tokens.output,
                      cacheRead: stats.tokens.cacheRead,
                      cacheWrite: stats.tokens.cacheWrite,
                      total: stats.tokens.total,
                    },
                    cost: stats.cost,
                    contextUsage: ctxUsage
                      ? { tokens: ctxUsage.tokens, contextWindow: ctxUsage.contextWindow, percent: ctxUsage.percent }
                      : undefined,
                  },
                });
              } catch { /* best-effort */ }

              safeChunk({ type: 'done' });
            }
            break;
          }
          case 'queue_update': {
            safeChunk({
              type: 'queue_update',
              queueState: {
                steering: Array.isArray(event.steering) ? event.steering : [],
                followUp: Array.isArray(event.followUp) ? event.followUp : [],
              },
            });
            break;
          }
        }
      });

      if (signal) {
        signal.addEventListener('abort', () => {
          streamActive = false;
          session.abort();
        }, { once: true });
      }

      try {
        // Auto-migrate and always refresh registry
        migrateModelsConfig();
        registry.refresh();

        // Switch to the requested model if specified
        if (params.modelId) {
          const model = findModelById(params.modelId);
          if (!model) {
            const errMsg = `Model "${params.modelId}" not found. Please configure a valid model in Settings or set the correct API key environment variable.`;
            safeChunk({ type: 'error', error: errMsg });
            throw new Error(errMsg);
          }
          await session.setModel(model);
        }

        // Build image content array for vision models
        const images = params.attachments?.length
          ? params.attachments
              .filter((a) => a.mimeType.startsWith('image/') && a.data)
              .map((a) => ({
                type: 'image' as const,
                data: a.data,
                mimeType: a.mimeType,
              }))
          : undefined;

        await session.prompt(params.content, images?.length ? { images } : undefined);

        // Build final usage for returned message
        let totalUsage: TokenUsage | undefined;
        try {
          const stats = session.getSessionStats();
          totalUsage = {
            inputTokens: stats.tokens.input,
            outputTokens: stats.tokens.output,
            totalTokens: stats.tokens.total,
            cacheReadTokens: stats.tokens.cacheRead,
            cacheWriteTokens: stats.tokens.cacheWrite,
            cost: stats.cost,
          };
        } catch { /* stats are best-effort */ }

        const asstMsg: AssistantMessage = {
          id: `msg-${Date.now()}-asst`,
          sessionId: params.sessionId,
          role: 'assistant',
          status: 'complete',
          modelId: params.modelId ?? 'unknown',
          content: session.getLastAssistantText() || '',
          blocks: [],
          usage: totalUsage,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        streamActive = false;
        return asstMsg;
      } catch (err) {
        safeChunk({ type: 'error', error: err instanceof Error ? err.message : 'Unknown error' });
        throw err;
      } finally {
        streamActive = false;
        unsubscribe();
      }
    },

    async getMessages(sessionId: string, _limit?: number, _offset?: number): Promise<Message[]> {
      if (!sessionId) return [];

      try {
        const sm = SessionManager.open(sessionId);
        const entries = sm.getEntries();
        return entries
          .filter((e) => e.type === 'message')
          .map((e) => {
            const msg = (e as any).message;
            const timestamp = msg.timestamp
              ? new Date(msg.timestamp).toISOString()
              : new Date().toISOString();
            return {
              id: `msg-${sessionId}-${e.id}`,
              sessionId,
              role: msg.role === 'assistant' ? 'assistant' : msg.role === 'user' ? 'user' : 'system',
              status: 'complete',
              content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
              blocks: [],
              createdAt: timestamp,
              updatedAt: timestamp,
            } as Message;
          });
      } catch {
        return [];
      }
    },

    async stopGeneration(sessionId?: string): Promise<void> {
      if (sessionId) {
        const entry = activeSessions.get(sessionId);
        if (entry) {
          try { await entry.session.abort(); } catch { /* ignore */ }
          entry.unsubscribe();
          activeSessions.delete(sessionId);
        }
        return;
      }
      // Abort all active sessions (backward compatibility)
      for (const [, { session }] of activeSessions) {
        try {
          await session.abort();
        } catch { /* ignore */ }
      }
      activeSessions.clear();
    },

    async steer(sessionId: string, content: string, images?: { name: string; mimeType: string; data: string }[]): Promise<void> {
      const session = await getOrCreateAgentSession(sessionId);
      await session.steer(content, images?.length ? images.map((img) => ({
        type: 'image' as const,
        data: img.data,
        mimeType: img.mimeType,
      })) : undefined);
    },

    async followUp(sessionId: string, content: string, images?: { name: string; mimeType: string; data: string }[]): Promise<void> {
      const session = await getOrCreateAgentSession(sessionId);
      await session.followUp(content, images?.length ? images.map((img) => ({
        type: 'image' as const,
        data: img.data,
        mimeType: img.mimeType,
      })) : undefined);
    },

    async navigateTree(sessionId: string, entryId: string, options?: { summarize?: boolean; customInstructions?: string; label?: string }): Promise<{ editorText?: string; cancelled: boolean }> {
      const session = await getOrCreateAgentSession(sessionId);
      const result = await session.navigateTree(entryId, options);
      return { editorText: result.editorText, cancelled: result.cancelled };
    },

    async compact(sessionId: string, customInstructions?: string) {
      const session = await getOrCreateAgentSession(sessionId);
      return session.compact(customInstructions);
    },
  };
}
