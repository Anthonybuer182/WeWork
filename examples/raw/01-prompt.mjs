/**
 * 01-prompt.mjs — Prompt Engineering（提示词工程）
 *
 * 既是案例（node 01-prompt.mjs 可运行讲解），又是模块（可被 04/05/06/07 import）。
 *
 * Prompt = 角色 + 规则 + 格式 + 示例 + 推理引导
 *
 * 依赖: llm.mjs
 * 被依赖: 04-loop.mjs, 05-react.mjs, 06-plan.mjs, 07-graph.mjs
 *
 * 导出: buildSystemPrompt, structuredPrompt, cotPrompt
 */

import { config, chat } from "./llm.mjs";

// ═══════════════════════════════════════════════════════════════
// 模块 API — 供其他文件 import
// ═══════════════════════════════════════════════════════════════

/** 构建 System Prompt：角色 + 规则 + 格式约束 */
export function buildSystemPrompt({ role, rules = [], format = null }) {
  let prompt = `你是一个${role}。\n`;
  if (rules.length) {
    prompt += `\n规则:\n${rules.map((r, i) => `${i + 1}. ${r}`).join("\n")}\n`;
  }
  if (format) {
    prompt += `\n输出格式:\n${format}\n`;
  }
  return prompt;
}

// ═══════════════════════════════════════════════════════════════
// 演示 — node 01-prompt.mjs 运行
// ═══════════════════════════════════════════════════════════════

async function main() {
  // 一个案例：角色 + 规则 = System Prompt，控制 LLM 的输出风格
  const prompt = buildSystemPrompt({
    role: "编程教师",
    rules: ["给出定义", "用代码说明", "用中文简洁回答"],
  });

  const { message } = await chat({
    ...config,
    messages: [{ role: "system", content: prompt }, { role: "user", content: "什么是闭包？" }],
    onToken: (t) => process.stdout.write(t),
  });
}

main().catch(console.error);
