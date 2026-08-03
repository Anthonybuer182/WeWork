/**
 * 02-context.mjs — Context Engineering（上下文工程）
 *
 * 既是案例（node 02-context.mjs 可运行讲解），又是模块（可被 03/04/05 import）。
 *
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

// ═══════════════════════════════════════════════════════════════
// 模块 API
// ═══════════════════════════════════════════════════════════════

/** Token 估算：英文 ~4 字符/token，中文 ~2 字符/token */
export function estimateTokens(text) {
  if (!text) return 0;
  const cn = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  return Math.ceil(cn / 2 + (text.length - cn) / 4);
}

/** 估算 messages 数组总 token 数 */
export function estimateMessagesTokens(messages) {
  return messages.reduce((sum, msg) => {
    const c = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content || "");
    return sum + estimateTokens(c) + 4;
  }, 0);
}

/** 截断：保留 system + 最近 N 条消息，控制在 maxTokens 内 */
export function truncateMessages(messages, maxTokens) {
  const system = messages[0]?.role === "system" ? [messages[0]] : [];
  const convo = messages[0]?.role === "system" ? messages.slice(1) : messages;
  const kept = [];
  let tokens = estimateMessagesTokens(system);
  for (let i = convo.length - 1; i >= 0; i--) {
    const t = estimateTokens(convo[i].content) + 4;
    if (tokens + t > maxTokens) break;
    kept.unshift(convo[i]);
    tokens += t;
  }
  return [...system, ...kept];
}

/** RAG：把外部知识注入 system prompt */
export function injectKnowledge(systemPrompt, knowledge) {
  return `${systemPrompt}\n\n【知识库】\n${knowledge}`;
}

/** 摘要压缩：用 LLM 把旧对话浓缩成摘要 */
export async function compactMessages(config, messages) {
  const system = messages[0]?.role === "system" ? messages[0] : null;
  const convo = system ? messages.slice(1) : messages;
  if (convo.length <= 2) return messages;

  const { message } = await chat({
    ...config,
    messages: [
      { role: "system", content: "把以下对话浓缩成摘要，保留关键信息。100 字以内。" },
      { role: "user", content: convo.map((m) => `[${m.role}] ${m.content}`).join("\n") },
    ],
  });

  const summary = `以下是之前对话的摘要：${message.content}`;
  return system
    ? [{ ...system, content: `${system.content}\n\n${summary}` }]
    : [{ role: "system", content: summary }];
}

// ═══════════════════════════════════════════════════════════════
// 演示 — node 02-context.mjs 运行
// ═══════════════════════════════════════════════════════════════

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║  02 — Context Engineering                                ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  // 1. Context 组成
  console.log("═══ 1. Context 的组成 ═══\n");
  const messages = [
    { role: "system", content: "你是编程助手。" },
    { role: "user", content: "什么是递归？" },
    { role: "assistant", content: "递归是函数调用自身..." },
    { role: "user", content: "时间复杂度是多少？" },
  ];
  messages.forEach((m, i) => {
    console.log(`  ${i + 1}. [${m.role.padEnd(9)}] (${estimateTokens(m.content)}t) ${m.content.slice(0, 40)}`);
  });
  console.log(`  总计 ~${estimateMessagesTokens(messages)} tokens\n`);

  // 2. Token 截断
  console.log("═══ 2. Token 截断 ═══\n");
  const long = [{ role: "system", content: "你是助手。" }];
  for (let i = 1; i <= 8; i++) {
    long.push({ role: "user", content: `第 ${i} 个问题：解释概念${i}。` });
    long.push({ role: "assistant", content: `概念${i}是指一种技术方法...` });
  }
  const truncated = truncateMessages(long, 100);
  console.log(`  原始: ${long.length} 条 ~${estimateMessagesTokens(long)}t → 截断: ${truncated.length} 条 ~${estimateMessagesTokens(truncated)}t\n`);

  // 3. RAG
  console.log("═══ 3. RAG 注入 ═══\n");
  const knowledge = "Pi Agent 定价: 社区版免费, 专业版 $20/月。\n支持模型: GPT-4o, Claude 3.5, MiniMax M2。";
  const basePrompt = "你是助手。根据知识库回答，不知道就说不知道。";
  process.stdout.write("  ");
  const { message: noRag } = await chat({
    ...config,
    messages: [{ role: "system", content: basePrompt }, { role: "user", content: "Pi Agent 价格？支持哪些模型？" }],
    onToken: (t) => process.stdout.write(t),
  });
  console.log("\n");

  process.stdout.write("  ");
  const { message: withRag } = await chat({
    ...config,
    messages: [{ role: "system", content: injectKnowledge(basePrompt, knowledge) }, { role: "user", content: "Pi Agent 价格？支持哪些模型？" }],
    onToken: (t) => process.stdout.write(t),
  });
  console.log("\n");

  // 4. 摘要压缩
  console.log("═══ 4. 摘要压缩 ═══\n");
  const old = [
    { role: "system", content: "你是助手。" },
    { role: "user", content: "我叫小明，在字节跳动做前端。" },
    { role: "assistant", content: "你好小明！" },
    { role: "user", content: "我用 React，想学 Rust。" },
    { role: "assistant", content: "Rust 是系统编程语言。" },
  ];
  console.log(`  原始: ~${estimateMessagesTokens(old)}t → 压缩中...`);
  const compacted = await compactMessages(config, old);
  console.log(`  压缩后: ~${estimateMessagesTokens(compacted)}t`);
  process.stdout.write("  ");
  const { message: reply } = await chat({
    ...config,
    messages: [...compacted, { role: "user", content: "我叫什么？在哪家公司？想学什么？" }],
    onToken: (t) => process.stdout.write(t),
  });
  console.log("\n");

  console.log("速查: estimateTokens / truncateMessages / injectKnowledge / compactMessages");
  console.log("\n✅ 完成 — 下一步: 03-memory.mjs");
}

main().catch(console.error);
