/**
 * 02-context.mjs — Context Engineering（上下文工程）
 * Context = System Prompt + 对话历史 + 工具结果
 * 管理 LLM 每次调用看到的内容：截断、RAG 注入、摘要压缩。
 *
 * 依赖: llm.mjs
 * 被依赖: 03-memory.mjs, 04-loop.mjs, 05-react.mjs
 *
 * 导出: estimateTokens, estimateMessagesTokens, truncateMessages,
 *       injectKnowledge, compactMessages
 */

import { config, chat } from "./llm.mjs";


/** RAG：把外部知识注入 system prompt */
export function injectKnowledge(systemPrompt, knowledge) {
  return `${systemPrompt}\n\n【知识库】\n${knowledge}`;
}

// ═══════════════════════════════════════════════════════════════
// 演示 — node 02-context.mjs 运行
// ═══════════════════════════════════════════════════════════════

async function main() {
  // 一个案例：RAG 注入 — 让 LLM "看到"它不知道的知识
  const knowledge = "Pi Agent 定价: 社区版免费, 专业版 $20/月";
  const basePrompt = "你是助手。根据知识库回答，不知道就说不知道。";
  const question = "Pi Agent 价格？";

  console.log("无知识库:");
  process.stdout.write("  ");
  await chat({
    ...config,
    messages: [{ role: "system", content: basePrompt }, { role: "user", content: question }],
    onToken: (t) => process.stdout.write(t),
  });
  console.log("\n");

  console.log("注入知识库后:");
  process.stdout.write("  ");
  await chat({
    ...config,
    messages: [{ role: "system", content: injectKnowledge(basePrompt, knowledge) }, { role: "user", content: question }],
    onToken: (t) => process.stdout.write(t),
  });

}

main().catch(console.error);
