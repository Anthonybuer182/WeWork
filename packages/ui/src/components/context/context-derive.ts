/**
 * Derived values for the context panel.
 *
 * Kept out of the component file because none of it is React: these are the
 * shapes and documents the panel renders, and they are easier to reason about
 * (and to test) without a render tree around them.
 */

import {
  budgetRows,
  budgetTotal,
  formatCount,
  formatTokens,
  promptFileStatus,
  promptStatusLabel,
  PROMPT_KIND_LABEL,
  scopeLabel,
} from '@pi/sdk-wrapper';
import type { AgentContextConfig } from '@pi/types';

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

export function sectionSpecs(config: AgentContextConfig): Record<string, SectionSpec> {
  const { sections } = config;
  return {
    prompt: { label: '全局提示词', chars: 0, budget: false },
    base: { label: '基础系统提示词', chars: sections.base.chars ?? 0, budget: true },
    appended: {
      label: '追加段',
      chars: sections.appended.reduce((n, s) => n + s.chars, 0),
      budget: true,
    },
    contextFiles: {
      label: '上下文文件',
      chars: sections.contextFiles.reduce((n, f) => n + f.chars, 0),
      budget: true,
    },
    skills: { label: '技能', chars: sections.skills.chars, budget: true },
    tools: {
      label: '工具',
      chars: sections.tools.reduce((n, t) => n + t.schemaBytes, 0),
      budget: true,
    },
  };
}

/** The export a user can paste elsewhere — a report, an issue, a colleague. */
export function buildMarkdown(config: AgentContextConfig): string {
  const lines: string[] = [];
  lines.push('# Agent 常驻上下文');
  lines.push('');
  lines.push(`- 工作区：\`${config.workspace.path}\``);
  lines.push(
    `- 合计：${formatCount(config.totals.chars)} 字符，${formatTokens(config.totals.tokensEst)} tokens（估算）`,
  );
  if (config.totals.windowTokens) {
    lines.push(
      `- 模型窗口：${formatCount(config.totals.windowTokens)}（约 ${Math.round((config.totals.share ?? 0) * 100)}%）`,
    );
  }
  lines.push('');

  lines.push('## 分段开销');
  lines.push('');
  lines.push('| 分段 | 字符数 | 占比 |');
  lines.push('| --- | ---: | ---: |');
  const total = budgetTotal(config) || 1;
  for (const row of budgetRows(config)) {
    lines.push(`| ${row.label} | ${formatCount(row.chars)} | ${Math.round((row.chars / total) * 100)}% |`);
  }
  lines.push('');

  lines.push('## 提示词文件');
  lines.push('');
  lines.push('| 文件 | 作用 | 状态 | 字符数 |');
  lines.push('| --- | --- | --- | ---: |');
  for (const file of config.promptFiles) {
    lines.push(
      `| \`${file.path}\` | ${PROMPT_KIND_LABEL[file.kind]} | ${promptStatusLabel(promptFileStatus(file))} | ${
        file.exists ? formatCount(file.chars) : '—'
      } |`,
    );
  }
  lines.push('');

  if (config.sections.base.text !== null) {
    lines.push('## 基础系统提示词');
    lines.push('');
    lines.push('```text');
    lines.push(config.sections.base.text);
    lines.push('```');
    lines.push('');
  }

  for (const segment of config.sections.appended) {
    lines.push(`## 追加段 · ${segment.label}`);
    lines.push('');
    lines.push('```text');
    lines.push(segment.text);
    lines.push('```');
    lines.push('');
  }

  for (const file of config.sections.contextFiles) {
    lines.push(`## 上下文文件 · ${scopeLabel(file.scope)}`);
    lines.push('');
    lines.push(`\`${file.path}\``);
    lines.push('');
    lines.push('```markdown');
    lines.push(file.content);
    lines.push('```');
    lines.push('');
  }

  if (config.pluginDocs.length > 0) {
    lines.push('## 插件索引开销');
    lines.push('');
    lines.push('| 插件 | 字符数 |');
    lines.push('| --- | ---: |');
    for (const doc of [...config.pluginDocs].sort((a, b) => b.chars - a.chars)) {
      lines.push(`| ${doc.name} (\`${doc.pluginId}\`) | ${formatCount(doc.chars)} |`);
    }
    lines.push('');
  }

  lines.push('## 工具');
  lines.push('');
  lines.push('| 工具 | 来源 | schema 字符数 |');
  lines.push('| --- | --- | ---: |');
  for (const tool of config.sections.tools) {
    lines.push(`| \`${tool.name}\` | ${tool.source} | ${formatCount(tool.schemaBytes)} |`);
  }
  lines.push('');

  return lines.join('\n');
}
