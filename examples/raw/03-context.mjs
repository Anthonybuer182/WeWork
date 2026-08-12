/**
 * 03-context.mjs — Context Engineering（上下文工程）
 *
 * ┌─ 什么是 Context ─────────────────────────────────────────┐
 * │ Context = LLM 一次调用时"看到"的全部内容：              │
 * │   ① System Prompt — 角色设定、规则、知识               │
 * │   ② 对话历史 — 之前的 user/assistant 消息               │
 * │   ③ 工具结果 — 工具调用返回的内容                      │
 * │                                                        │
 * │ LLM 没有记忆，每次调用都是"无状态"的。                  │
 * │ 你以为它"记得"之前说过的话，其实是你每次都把历史       │
 * │ 重新喂给它。这就是 Context。                            │
 * └────────────────────────────────────────────────────────┘
 *
 * ┌─ 为什么需要 Context Engineering ────────────────────────┐
 * │ ① Token 有上限：模型窗口有限（4K~200K），超了就报错    │
 * │ ② 太多 context 会稀释注意力：LLM 会"忘记"关键信息      │
 * │ ③ 需要注入外部知识：LLM 的训练数据有截止日期           │
 * └────────────────────────────────────────────────────────┘
 *
 * ┌─ 核心操作 ──────────────────────────────────────────────┐
 * │ estimateTokens / estimateMessagesTokens                 │
 * │   估算上下文占多少 token（截断/压缩的前提）           │
 * │                                                        │
 * │ truncateMessages                                        │
 * │   超限时丢弃旧消息（快，但丢失信息）                  │
 * │                                                        │
 * │ compactMessages  (async)                                │
 * │   把旧对话压成摘要（慢，但保留信息）                  │
 * │                                                        │
 * │ injectKnowledge                                         │
 * │   把外部知识注入 system prompt（RAG 的最简形式）       │
 * └────────────────────────────────────────────────────────┘
 *
 * 依赖: llm.mjs
 *
 * 导出: estimateTokens, estimateMessagesTokens, truncateMessages,
 *       injectKnowledge, compactMessages
 */

import { config, chat } from "./llm.mjs";


// ═══════════════════════════════════════════════════════════════
// Token 估算
// ═══════════════════════════════════════════════════════════════
// 真正的 token 化需要 tiktoken 等专用库。这里用字符数粗略估算：
// 中文 1 字 ≈ 1~2 token，英文 1 token ≈ 4 字符，混合取折中 ≈ 字符数/3。
// 精度不高，但够用来判断"快超限了吗"，这是工程上的常用做法。

/** 估算一段文本的 token 数 */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 3);
}

/** 估算 messages 数组的总 token 数（含每条消息的结构开销） */
export function estimateMessagesTokens(messages) {
  let total = 3; // 消息列表的基础框架开销
  for (const msg of messages) {
    total += 4; // role 标记 + 分隔符
    if (msg.content) total += estimateTokens(msg.content);
  }
  return total;
}


// ═══════════════════════════════════════════════════════════════
// 截断 — 超限时丢弃旧消息
// ═══════════════════════════════════════════════════════════════
// 策略：system 消息始终保留（角色/规则不能丢），
//       对话消息从最近往前保留，直到累计 token 接近 maxTokens。
// 优点：快，无需 LLM 调用
// 缺点：直接丢弃，旧信息丢失

export function truncateMessages(messages, maxTokens) {
  const systemMsgs = messages.filter((m) => m.role === "system");
  const dialogMsgs = messages.filter((m) => m.role !== "system");

  // system 消息占的 token（始终保留）
  let usedTokens = estimateMessagesTokens(systemMsgs);
  const kept = [];

  // 从最近的对话往前保留
  for (let i = dialogMsgs.length - 1; i >= 0; i--) {
    const msgTokens = estimateMessagesTokens([dialogMsgs[i]]);
    if (usedTokens + msgTokens > maxTokens) break;
    kept.unshift(dialogMsgs[i]);
    usedTokens += msgTokens;
  }

  return [...systemMsgs, ...kept];
}


// ═══════════════════════════════════════════════════════════════
// 摘要压缩 — 把旧对话压成摘要（async，需调 LLM）
// ═══════════════════════════════════════════════════════════════
// 策略：保留最近 keepRecent 条对话原样，
//       更早的对话喂给 LLM 压缩成一条摘要 system 消息。
// 优点：保留关键信息，上下文更紧凑
// 缺点：需要一次额外 LLM 调用，有延迟

export async function compactMessages(messages, { config, keepRecent = 2 }) {
  const systemMsgs = messages.filter((m) => m.role === "system");
  const dialogMsgs = messages.filter((m) => m.role !== "system");

  // 保留最近 keepRecent 条对话
  const recent = dialogMsgs.slice(-keepRecent);
  const old = dialogMsgs.slice(0, -keepRecent);

  if (old.length === 0) return messages; // 没有旧消息可压缩

  // 把旧对话格式化成文本
  const dialogText = old
    .map((m) => `${m.role === "user" ? "用户" : "助手"}: ${m.content}`)
    .join("\n");

  // 让 LLM 把旧对话压成摘要
  const summaryPrompt =
    "把以下对话压缩成关键信息摘要，保留重要的事实、需求和结论，丢弃寒暄和重复内容。只输出摘要正文：\n\n" +
    dialogText;

  const result = await chat({
    ...config,
    silent: true,
    messages: [{ role: "user", content: summaryPrompt }],
  });

  // 返回：原 system + 摘要 system + 保留的最近对话
  return [
    ...systemMsgs,
    { role: "system", content: `【历史对话摘要】\n${result.message.content}` },
    ...recent,
  ];
}


// ═══════════════════════════════════════════════════════════════
// RAG 知识注入 — 把外部知识塞进 system prompt
// ═══════════════════════════════════════════════════════════════
// LLM 的知识有截止日期，且可能不知道私有数据。
// RAG = Retrieval-Augmented Generation：先检索相关知识，再注入 context。
// 这里是最简形式：直接把知识拼到 system prompt 末尾。

export function injectKnowledge(systemPrompt, knowledge) {
  return `${systemPrompt}\n\n【知识库】\n${knowledge}`;
}


// ═══════════════════════════════════════════════════════════════
// 演示 — node 03-context.mjs 运行
// ═══════════════════════════════════════════════════════════════

async function main() {
  console.log("═══════════════════════════════════════════════════");
  console.log("  Context Engineering 演示");
  console.log("  估算 → 截断 → 压缩 → RAG 注入");
  console.log("═══════════════════════════════════════════════════\n");

  // ── ① 构造一段对话，估算它占多少 token ──────────────────
  console.log("【1】Token 估算 — 这段对话占多少 context？");
  const dialog = [
    { role: "system", content: "你是一个编程助手，回答简洁。" },
    { role: "user", content: "什么是闭包？" },
    { role: "assistant", content: "闭包是函数与其词法环境的组合，让内部函数能访问外部变量。" },
    { role: "user", content: "能给个例子吗？" },
    { role: "assistant", content: "function counter() { let n = 0; return () => ++n; }" },
    { role: "user", content: "它和 class 有什么区别？" },
    { role: "assistant", content: "闭包基于函数环境，class 基于原型链；闭包更适合封装私有状态。" },
  ];
  const beforeTokens = estimateMessagesTokens(dialog);
  console.log(`  ${dialog.length} 条消息 ≈ ${beforeTokens} tokens\n`);

  // ── ② 截断：只保留 system + 最近 2 条对话 ─────────────────
  console.log("【2】截断 — 丢弃旧消息，只保留最近的");
  const truncated = truncateMessages(dialog, 40);
  console.log(`  截断后 ${truncated.length} 条 ≈ ${estimateMessagesTokens(truncated)} tokens`);
  console.log(`  结构: ${truncated.map((m) => m.role).join(" → ")}`);
  console.log(`  ⚠ 旧对话被直接丢弃，信息丢失\n`);

  // ── ③ 压缩：旧对话 → LLM 摘要 ──────────────────────────
  console.log("【3】摘要压缩 — 旧对话压成摘要，保留关键信息");
  const compacted = await compactMessages(dialog, { config, keepRecent: 2 });
  console.log(`  压缩后 ${compacted.length} 条 ≈ ${estimateMessagesTokens(compacted)} tokens`);
  console.log(`  结构: ${compacted.map((m) => m.role).join(" → ")}`);
  const summary = compacted.find((m) => m.content?.startsWith("【历史对话摘要】"));
  if (summary) console.log(`  摘要内容: ${summary.content.slice(0, 80)}...\n`);
  console.log(`  ※ 注意：压缩后 token 反而比原来多——因为对话太短，摘要比原文还长。`);
  console.log(`    只有对话很长（几十轮）时，压缩才真正省 token。这就是截断 vs 压缩的取舍。\n`);

  // ── ④ RAG 注入：让 LLM "看到"它不知道的知识 ──────────────
  console.log("【4】RAG 知识注入 — 注入 LLM 训练数据里没有的信息");
  const knowledge = "Pi Agent 定价: 社区版免费, 专业版 $20/月";
  const basePrompt = "你是助手。根据知识库回答，不知道就说不知道。";
  const question = "Pi Agent 价格？";

  console.log("\n  ▶ 无知识库:");
  process.stdout.write("  ");
  await chat({
    ...config,
    silent: true,
    messages: [{ role: "system", content: basePrompt }, { role: "user", content: question }],
    onToken: (t) => process.stdout.write(t),
  });
  console.log("\n");

  console.log("  ▶ 注入知识库后:");
  process.stdout.write("  ");
  await chat({
    ...config,
    silent: true,
    messages: [{ role: "system", content: injectKnowledge(basePrompt, knowledge) }, { role: "user", content: question }],
    onToken: (t) => process.stdout.write(t),
  });
  console.log("\n");
}

main().catch(console.error);
