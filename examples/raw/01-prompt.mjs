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
 * 导出: buildSystemPrompt, fewShotMessages, structuredPrompt, cotPrompt
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

/** Few-shot：用示例构建完整 messages 数组 */
export function fewShotMessages(systemPrompt, examples, query) {
  const msgs = [{ role: "system", content: systemPrompt }];
  for (const ex of examples) {
    msgs.push({ role: "user", content: ex.input });
    msgs.push({ role: "assistant", content: ex.output });
  }
  msgs.push({ role: "user", content: query });
  return msgs;
}

/** 结构化输出 prompt：让 LLM 输出 JSON */
export function structuredPrompt(schema, query) {
  return {
    system: `从用户输入中提取信息，只输出 JSON，不要输出其他内容。\n\n输出格式:\n${JSON.stringify(schema, null, 2)}`,
    user: query,
  };
}

/** Chain of Thought prompt：引导逐步推理 */
export function cotPrompt(systemPrompt, steps, query) {
  const stepStr = steps.map((s, i) => `${i + 1}. ${s}`).join("\n");
  return {
    system: `${systemPrompt}\n\n解决问题时，请按以下步骤：\n${stepStr}\n\n这样能让推理过程清晰，减少错误。`,
    user: query,
  };
}

// ═══════════════════════════════════════════════════════════════
// 演示 — node 01-prompt.mjs 运行
// ═══════════════════════════════════════════════════════════════

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║  01 — Prompt Engineering                                  ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  // 1. System Prompt — 角色设定
  console.log("═══ 1. System Prompt ═══\n");
  for (const [label, prompt] of [
    ["简洁助手", buildSystemPrompt({ role: "简洁助手", rules: ["回答不超过 30 字"] })],
    ["编程教师", buildSystemPrompt({ role: "编程教师", rules: ["给出定义", "用代码说明"] })],
  ]) {
    console.log(`角色: ${label}`);
    process.stdout.write("  ");
    const { message } = await chat({
      ...config,
      messages: [{ role: "system", content: prompt }, { role: "user", content: "什么是闭包？" }],
      onToken: (t) => process.stdout.write(t),
    });
    console.log("\n");
  }

  // 2. Few-shot — 示例引导
  console.log("═══ 2. Few-shot ═══\n");
  const examples = [
    { input: "分析：天气真好！", output: '情感: 正面\n置信度: 0.95' },
    { input: "分析：太慢了。", output: '情感: 负面\n置信度: 0.88' },
  ];
  process.stdout.write("  ");
  const { message: shot } = await chat({
    ...config,
    messages: fewShotMessages(
      buildSystemPrompt({ role: "情感分析助手", rules: ["按示例格式输出"] }),
      examples,
      "分析：这个产品太垃圾了！"
    ),
    onToken: (t) => process.stdout.write(t),
  });
  console.log("\n");

  // 3. 结构化输出
  console.log("═══ 3. 结构化输出 (JSON) ═══\n");
  const { system, user } = structuredPrompt(
    { name: "人名", age: "年龄", city: "城市", skills: ["技能"] },
    "我叫张三，28岁，住上海，会 Python 和 JavaScript。"
  );
  process.stdout.write("  ");
  const { message: json } = await chat({
    ...config,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    onToken: (t) => process.stdout.write(t),
  });
  console.log();
  try {
    const data = JSON.parse(json.content.replace(/```json?\n?/g, "").replace(/```/g, "").trim());
    console.log("  解析:", data);
  } catch { console.log("  原始:", json.content.slice(0, 80)); }
  console.log();

  // 4. Chain of Thought
  console.log("═══ 4. Chain of Thought ═══\n");
  const { system: cotSys, user: cotUser } = cotPrompt(
    "你是数学助手",
    ["列出已知条件", "逐步计算", "给出答案"],
    "买 3 件 80 元商品，打 8 折，满 200 减 30。最终花多少？"
  );
  process.stdout.write("  ");
  const { message: cot } = await chat({
    ...config,
    messages: [{ role: "system", content: cotSys }, { role: "user", content: cotUser }],
    onToken: (t) => process.stdout.write(t),
  });
  console.log("\n");

  console.log("速查: buildSystemPrompt / fewShotMessages / structuredPrompt / cotPrompt");
  console.log("\n✅ 完成 — 下一步: 02-context.mjs");
}

main().catch(console.error);
