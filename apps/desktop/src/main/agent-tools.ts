/**
 * Agent tools the host contributes itself.
 *
 * Until now every agent tool came from a plugin, because plugins were the only
 * contributor. The context audit is different: it reports on the agent's own
 * kernel state, and routing it through the plugin trust boundary would mean
 * inventing a capability, a permission and a late-bound bridge so that
 * first-party code could read first-party state. The host may contribute tools
 * directly instead.
 *
 * `pluginId` is absent on these, which is deliberate: in the tool listing they
 * read as built-in, because that is what they are.
 */

import {
  ASK_TOOL_NAME,
  MAX_ASK_QUESTIONS,
  MAX_ASK_QUESTION_CHARS,
  MAX_TODO_ITEMS,
  TODO_PRIORITIES,
  TODO_STATUSES,
  TODO_TOOL_NAME,
  type AgentContextConfig,
  type AskAnswers,
  type AskOption,
  type AskQuestion,
  type TodoSnapshot,
  type TodoStatus,
} from '@pi/types';
import { formatAuditText } from '@pi/sdk-wrapper';
import type { AskService } from './asks';
import { takeToolSession } from './plugins/session-context';
import { countTodos, type TodoService } from './todos';
import { toolContracts } from './tools/contracts';

/** Agent tool definition shape expected by createAgentSession({ customTools }). */
export interface AgentCustomTool {
  name: string;
  label: string;
  /** The plugin that contributed this tool. Absent for host-contributed tools. */
  pluginId?: string;
  description: string;
  parameters: unknown;
  /** From the manifest contribution — true = the tool only observes state. */
  readOnly?: boolean;
  /**
   * One-line trigger for the SDK's "Available tools" section. Custom tools
   * without this are omitted from that section entirely — only the schema
   * reaches the model — so the host fills it from the tool's contract or
   * description.
   */
  promptSnippet?: string;
  /** Extra behavior rules appended to the system prompt's Guidelines section. */
  promptGuidelines?: string[];
  /**
   * Passed through to the SDK's tool registry. A blocking tool asks for
   * 'sequential' so two calls in one assistant message cannot both paint a
   * question card at once.
   */
  executionMode?: 'sequential' | 'parallel';
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<{
    content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType?: string }>;
    details: unknown;
  }>;
}

export interface HostAgentToolDeps {
  readContextConfig: (
    workspacePath: string,
    workspaceId?: string,
    sessionId?: string,
  ) => Promise<AgentContextConfig>;
  todoService: TodoService;
  askService: AskService;
  /**
   * The workspace the calling conversation is shown in. With several windows
   * there is no single "active workspace" any more: each window has its own,
   * so the answer is resolved from the session (or the focused window).
   */
  resolveWorkspace?: (sessionId: string | undefined) => { id: string; path: string } | null;
}

/**
 * The conversation a tool call belongs to.
 *
 * The SDK's custom-tool closure only receives the toolCallId; the permission
 * gate is the one place that sees both the call and its session, so it records
 * the pair on the way through. A miss means the tool ran outside a session
 * (direct invocation in a test) — 'default' is the SDK's own keyless bucket.
 */
function sessionForToolCall(toolCallId: string): string {
  return takeToolSession(toolCallId) ?? 'default';
}

export function createHostAgentTools(deps: HostAgentToolDeps): AgentCustomTool[] {
  const tools: AgentCustomTool[] = [
    createTodoTool(deps.todoService),
    createAskTool(deps.askService),
    {
      name: 'context_audit',
      label: 'context_audit',
      description:
        "Report the agent's standing context — the instruction block sent on every request, before any conversation. " +
        'Returns each part (system prompt, prompt files, context files, plugin docs, skills, tool schemas) with its ' +
        "character cost and the total against the model's context window. Use it when the user asks why the context " +
        'is filling up, what is costing tokens, or which installed plugin is expensive.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async (toolCallId, params) => {
        const explicit = typeof params.workspacePath === 'string' ? params.workspacePath.trim() : '';
        // Pin the report to the calling conversation; otherwise a neighbouring
        // session in the same workspace can supply the tool list.
        const sessionId = takeToolSession(toolCallId);
        const workspace = explicit ? null : (deps.resolveWorkspace?.(sessionId) ?? null);
        const target = explicit || workspace?.path;
        if (!target) {
          throw new Error(
            'context_audit: no active workspace — open a workspace in the app, or pass workspacePath',
          );
        }
        const config = await deps.readContextConfig(
          target,
          explicit ? undefined : workspace?.id,
          explicit ? undefined : sessionId,
        );
        return {
          content: [{ type: 'text' as const, text: formatAuditText(config) }],
          details: {
            workspace: config.workspace.path,
            totals: config.totals,
            bySection: {
              base: config.sections.base.chars,
              appended: config.sections.appended.reduce((n, s) => n + s.chars, 0),
              contextFiles: config.sections.contextFiles.reduce((n, f) => n + f.chars, 0),
              skills: config.sections.skills.chars,
              tools: config.sections.tools.reduce((n, t) => n + t.schemaBytes, 0),
            },
            pluginDocs: config.pluginDocs,
          },
        };
      },
    },
  ];
  for (const tool of tools) {
    tool.promptSnippet = toolContracts.snippetFor(tool.name, tool.description);
    const guidelines = toolContracts.guidelinesFor(tool.name);
    if (guidelines) tool.promptGuidelines = guidelines;
  }
  return tools;
}

// ── todotool ───────────────────────────────────────────────────────────

const TODO_STATUS_LABEL: Record<TodoStatus, string> = {
  pending: '待办',
  in_progress: '进行中',
  completed: '已完成',
  cancelled: '已取消',
};

function createTodoTool(todoService: TodoService): AgentCustomTool {
  return {
    name: TODO_TOOL_NAME,
    label: TODO_TOOL_NAME,
    readOnly: true,
    description:
      'Replace the working checklist for the current task. Use it when a task needs three or more distinct steps, ' +
      'or spans multiple files — write the list before the first step, then keep it current as you go. ' +
      'Do NOT use it for a single-step task, a question, or mere reading. ' +
      'Keep exactly one item in_progress at a time, and mark an item completed only after you have verified ' +
      'its result. Before you finish, leave no item pending or in_progress. ' +
      'This checklist is YOUR working memory for this task. It is not the user\'s planner: when the user asks ' +
      'you to remember, schedule, or be reminded of something, use the planner/reminder tool a plugin provides ' +
      '(if one is available), not this tool.',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'The complete list. Every call replaces the previous list wholesale.',
          maxItems: MAX_TODO_ITEMS,
          items: {
            type: 'object',
            properties: {
              content: {
                type: 'string',
                description: 'What the step is, in one short line.',
              },
              status: {
                type: 'string',
                enum: [...TODO_STATUSES],
                description: 'pending | in_progress | completed | cancelled. At most one in_progress.',
              },
              priority: {
                type: 'string',
                enum: [...TODO_PRIORITIES],
                description: 'Optional. low | medium | high.',
              },
            },
            required: ['content', 'status'],
            additionalProperties: false,
          },
        },
      },
      required: ['todos'],
      additionalProperties: false,
    },
    execute: async (toolCallId, params) => {
      const sessionId = sessionForToolCall(toolCallId);
      const { snapshot, warnings } = todoService.apply(sessionId, params.todos, toolCallId);
      return {
        content: [{ type: 'text' as const, text: formatTodoResult(snapshot, warnings) }],
        details: {
          sessionId,
          todos: snapshot.todos,
          revision: snapshot.revision,
          updatedAt: snapshot.updatedAt,
          warnings,
        },
      };
    },
  };
}

function formatTodoResult(snapshot: TodoSnapshot, warnings: string[]): string {
  const { todos } = snapshot;
  if (todos.length === 0) {
    return warnings.length > 0 ? `任务清单已清空。\n\n注意：${warnings.join('；')}` : '任务清单已清空。';
  }
  const counts = countTodos(todos);
  const summary = [
    counts.in_progress ? `进行中 ${counts.in_progress}` : '',
    counts.pending ? `待办 ${counts.pending}` : '',
    counts.completed ? `已完成 ${counts.completed}` : '',
    counts.cancelled ? `已取消 ${counts.cancelled}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const lines = todos.map(
    (todo) => `- [${TODO_STATUS_LABEL[todo.status]}] ${todo.content}`,
  );
  let text = `任务清单已更新：${todos.length} 项（${summary}）\n${lines.join('\n')}`;
  if (warnings.length > 0) text += `\n\n注意：${warnings.join('；')}`;
  return text;
}

// ── asktool ────────────────────────────────────────────────────────────

function createAskTool(askService: AskService): AgentCustomTool {
  return {
    name: ASK_TOOL_NAME,
    label: ASK_TOOL_NAME,
    readOnly: true,
    // Two asks in one batch must not overlap: the renderer shows one card at
    // a time, and the second would otherwise queue invisibly.
    executionMode: 'sequential',
    description:
      'Ask the user one or more questions and wait for the answer. ' +
      'Use it only when a decision you cannot make blocks progress — an ambiguous requirement, a choice between ' +
      'approaches the user has not stated, or a preference that changes the result. Do not use it to confirm ' +
      'something you are already sure of, and do not ask for information you can obtain with your own tools. ' +
      'Ask everything you need in ONE call; four questions is usually the practical maximum even though the ' +
      'schema allows more. Every question must offer at least one option; a free-text "other" answer is always ' +
      'available to the user. If a question is skipped (the answer is blank), continue the task with a sensible ' +
      'default — do not re-ask it in the same turn.',
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_ASK_QUESTIONS,
          items: {
            type: 'object',
            properties: {
              question: {
                type: 'string',
                maxLength: MAX_ASK_QUESTION_CHARS,
                description: 'The question, one short sentence.',
              },
              options: {
                type: 'array',
                minItems: 1,
                description: 'The choices. A plain string is a label with no description.',
                items: {
                  anyOf: [
                    { type: 'string' },
                    {
                      type: 'object',
                      properties: {
                        label: { type: 'string' },
                        description: { type: 'string' },
                      },
                      required: ['label'],
                      additionalProperties: false,
                    },
                  ],
                },
              },
              multiSelect: {
                type: 'boolean',
                description: 'True for checkboxes (several answers allowed); default is a single choice.',
              },
            },
            required: ['question', 'options'],
            additionalProperties: false,
          },
        },
      },
      required: ['questions'],
      additionalProperties: false,
    },
    execute: async (toolCallId, params, signal) => {
      const questions = normalizeAskQuestions(params.questions);
      const sessionId = sessionForToolCall(toolCallId);
      const outcome = await askService.ask({ sessionId, toolCallId, questions, signal });
      return {
        content: [
          {
            type: 'text' as const,
            text: formatAskResult(questions, outcome.answers, outcome.cancelled),
          },
        ],
        details: {
          requestId: outcome.requestId,
          sessionId,
          questions,
          answers: outcome.answers,
          cancelled: outcome.cancelled,
        },
      };
    },
  };
}

/**
 * Validate before anything reaches the renderer.
 *
 * A malformed call must fail as a tool error (`isError`) rather than paint a
 * half-broken card: the model can see the error and fix its arguments, while
 * a user staring at a card with no options cannot. Throwing is the SDK's
 * error path for host tools.
 */
function normalizeAskQuestions(raw: unknown): AskQuestion[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`asktool: questions 必须是 1..${MAX_ASK_QUESTIONS} 项的数组`);
  }
  if (raw.length > MAX_ASK_QUESTIONS) {
    throw new Error(`asktool: 一次最多问 ${MAX_ASK_QUESTIONS} 个问题（收到 ${raw.length} 个）`);
  }

  return raw.map((entry, index) => {
    const n = index + 1;
    if (!entry || typeof entry !== 'object') {
      throw new Error(`asktool: 第 ${n} 题必须是对象`);
    }
    const q = entry as Record<string, unknown>;
    const question = typeof q.question === 'string' ? q.question.trim() : '';
    if (!question) throw new Error(`asktool: 第 ${n} 题缺少 question`);
    if (question.length > MAX_ASK_QUESTION_CHARS) {
      throw new Error(
        `asktool: 第 ${n} 题的 question 超过 ${MAX_ASK_QUESTION_CHARS} 字（${question.length} 字）`,
      );
    }

    if (!Array.isArray(q.options) || q.options.length === 0) {
      throw new Error(`asktool: 第 ${n} 题至少要有一个 option`);
    }
    const seen = new Set<string>();
    const options: AskOption[] = q.options.map((option, optionIndex) => {
      const normalized = normalizeAskOption(option, n, optionIndex + 1);
      if (seen.has(normalized.label)) {
        throw new Error(`asktool: 第 ${n} 题的选项「${normalized.label}」重复`);
      }
      seen.add(normalized.label);
      return normalized;
    });

    if (q.multiSelect != null && typeof q.multiSelect !== 'boolean') {
      throw new Error(`asktool: 第 ${n} 题的 multiSelect 必须是布尔值`);
    }

    return { question, options, multiSelect: q.multiSelect === true };
  });
}

function normalizeAskOption(raw: unknown, questionNo: number, optionNo: number): AskOption {
  if (typeof raw === 'string') {
    const label = raw.trim();
    if (!label) throw new Error(`asktool: 第 ${questionNo} 题的第 ${optionNo} 个选项是空字符串`);
    return { label };
  }
  if (!raw || typeof raw !== 'object') {
    throw new Error(`asktool: 第 ${questionNo} 题的第 ${optionNo} 个选项必须是字符串或 {label, description}`);
  }
  const option = raw as Record<string, unknown>;
  const label = typeof option.label === 'string' ? option.label.trim() : '';
  if (!label) {
    throw new Error(`asktool: 第 ${questionNo} 题的第 ${optionNo} 个选项缺少 label`);
  }
  const description =
    typeof option.description === 'string' && option.description.trim()
      ? option.description.trim()
      : undefined;
  return { label, ...(description ? { description } : {}) };
}

/**
 * The deterministic text the model sees.
 *
 * One line per question, null answers left blank exactly as the contract says.
 * The trailing note exists because a blank line is ambiguous on its own — the
 * model must read it as "skipped", not "answered with nothing".
 */
function formatAskResult(questions: AskQuestion[], answers: AskAnswers, cancelled: boolean): string {
  if (cancelled) return '用户中止了本轮，所有问题都没有回答。';

  const lines = questions.map((q, i) => {
    const answer = answers[i];
    return `${q.question}：${answer && answer.length > 0 ? answer.join('、') : ''}`;
  });
  const text = lines.join('\n---\n');
  const anyBlank = answers.some((answer) => !answer || answer.length === 0);
  return anyBlank ? `${text}\n\n（留空的题目表示用户跳过了。）` : text;
}
