/**
 * Derived values for the context panel.
 *
 * Kept out of the component file because none of it is React: these are the
 * shapes and documents the panel renders, and they are easier to reason about
 * (and to test) without a render tree around it.
 */

import {
  budgetRows,
  budgetTotal,
  formatCount,
  formatTokens,
  promptFileStatus,
} from '@pi/sdk-wrapper';
import type { AgentContextConfig, ContextFileScope, PromptFileInfo } from '@pi/types';
import { t, type MessageKey } from '@/i18n';

export interface SectionSpec {
  label: string;
  chars: number;
  /**
   * False for the prompt section. Its files' characters are already counted in
   * the sections below — a SYSTEM.md *is* the base prompt, and an
   * APPEND_SYSTEM.md is one of the appended segments — so showing them here as
   * well would count the same text twice and make the total meaningless.
   */
  budget: boolean;
}

/**
 * `@pi/sdk-wrapper` labels these for the agent-facing audit report, so they
 * arrive as Chinese strings; map them back to keys here rather than duplicating
 * the rows. Unknown labels (a future section) fall through unchanged.
 */
const BUDGET_LABEL: Record<string, MessageKey> = {
  基础系统提示词: '基础系统提示词',
  追加段: '追加段',
  上下文文件: '上下文文件',
  技能索引: '技能索引',
  工具定义: '工具定义',
};

const PROMPT_KIND_LABEL: Record<PromptFileInfo['kind'], MessageKey> = {
  system: '替换系统提示词',
  append: '追加到系统提示词',
};

const PROMPT_STATUS_LABEL = {
  active: '生效中',
  shadowed: '被遮住',
  missing: '未创建',
} as const satisfies Record<ReturnType<typeof promptFileStatus>, MessageKey>;

export function promptKindLabel(kind: PromptFileInfo['kind']): string {
  return t(PROMPT_KIND_LABEL[kind]);
}

export function promptStatusLabel(status: ReturnType<typeof promptFileStatus>): string {
  return t(PROMPT_STATUS_LABEL[status]);
}

export function scopeLabel(scope: ContextFileScope | 'project'): string {
  if (scope === 'global') return t('全局');
  // Prompt files call the workspace scope "project"; context files call it
  // "workspace". Both mean the same place to a person.
  if (scope === 'workspace' || scope === 'project') return t('工作区');
  return t('上级目录');
}

export function sectionSpecs(config: AgentContextConfig): Record<string, SectionSpec> {
  const { sections } = config;
  return {
    prompt: { label: t('全局提示词'), chars: 0, budget: false },
    base: { label: t('基础系统提示词'), chars: sections.base.chars ?? 0, budget: true },
    appended: {
      label: t('追加段'),
      chars: sections.appended.reduce((n, s) => n + s.chars, 0),
      budget: true,
    },
    contextFiles: {
      label: t('上下文文件'),
      chars: sections.contextFiles.reduce((n, f) => n + f.chars, 0),
      budget: true,
    },
    skills: { label: t('技能'), chars: sections.skills.chars, budget: true },
    tools: {
      label: t('工具'),
      chars: sections.tools.reduce((n, tool) => n + tool.schemaBytes, 0),
      budget: true,
    },
  };
}

/** The export a user can paste elsewhere — a report, an issue, a colleague. */
export function buildMarkdown(config: AgentContextConfig): string {
  const lines: string[] = [];
  lines.push(t('# Agent 常驻上下文'));
  lines.push('');
  lines.push(t('- 工作区：`{path}`', { path: config.workspace.path }));
  lines.push(
    t('- 合计：{chars} 字符，{tokens} tokens（估算）', {
      chars: formatCount(config.totals.chars),
      tokens: formatTokens(config.totals.tokensEst),
    }),
  );
  if (config.totals.windowTokens) {
    lines.push(
      t('- 模型窗口：{tokens}（约 {pct}%）', {
        tokens: formatCount(config.totals.windowTokens),
        pct: Math.round((config.totals.share ?? 0) * 100),
      }),
    );
  }
  lines.push('');

  lines.push(t('## 分段开销'));
  lines.push('');
  lines.push(t('| 分段 | 字符数 | 占比 |'));
  lines.push('| --- | ---: | ---: |');
  const total = budgetTotal(config) || 1;
  for (const row of budgetRows(config)) {
    const key = BUDGET_LABEL[row.label];
    const label = key ? t(key) : row.label;
    lines.push(`| ${label} | ${formatCount(row.chars)} | ${Math.round((row.chars / total) * 100)}% |`);
  }
  lines.push('');

  lines.push(t('## 提示词文件'));
  lines.push('');
  lines.push(t('| 文件 | 作用 | 状态 | 字符数 |'));
  lines.push('| --- | --- | --- | ---: |');
  for (const file of config.promptFiles) {
    lines.push(
      `| \`${file.path}\` | ${promptKindLabel(file.kind)} | ${promptStatusLabel(promptFileStatus(file))} | ${
        file.exists ? formatCount(file.chars) : '—'
      } |`,
    );
  }
  lines.push('');

  if (config.sections.base.text !== null) {
    lines.push(t('## 基础系统提示词'));
    lines.push('');
    lines.push('```text');
    lines.push(config.sections.base.text);
    lines.push('```');
    lines.push('');
  }

  for (const segment of config.sections.appended) {
    lines.push(t('## 追加段 · {label}', { label: segment.label }));
    lines.push('');
    lines.push('```text');
    lines.push(segment.text);
    lines.push('```');
    lines.push('');
  }

  for (const file of config.sections.contextFiles) {
    lines.push(t('## 上下文文件 · {scope}', { scope: scopeLabel(file.scope) }));
    lines.push('');
    lines.push(`\`${file.path}\``);
    lines.push('');
    lines.push('```markdown');
    lines.push(file.content);
    lines.push('```');
    lines.push('');
  }

  if (config.pluginDocs.length > 0) {
    lines.push(t('## 插件索引开销'));
    lines.push('');
    lines.push(t('| 插件 | 字符数 |'));
    lines.push('| --- | ---: |');
    for (const doc of [...config.pluginDocs].sort((a, b) => b.chars - a.chars)) {
      lines.push(`| ${doc.name} (\`${doc.pluginId}\`) | ${formatCount(doc.chars)} |`);
    }
    lines.push('');
  }

  lines.push(t('## 工具'));
  lines.push('');
  lines.push(t('| 工具 | 来源 | schema 字符数 |'));
  lines.push('| --- | --- | ---: |');
  for (const tool of config.sections.tools) {
    lines.push(`| \`${tool.name}\` | ${tool.source} | ${formatCount(tool.schemaBytes)} |`);
  }
  lines.push('');

  return lines.join('\n');
}
