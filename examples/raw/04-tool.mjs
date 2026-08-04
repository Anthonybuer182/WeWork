/**
 * 04-tool.mjs — Tool Calling（工具调用）
 *
 * Tool Calling = LLM 不只是说话，还能调用函数
 *   1. 定义工具: name + description + parameters + execute
 *   2. 发送: messages + tools 一起传给 LLM
 *   3. LLM 返回 tool_calls → 本地执行 execute
 *   4. 结果以 role:"tool" 回传 → LLM 给出最终回答
 *
 * ReAct (05) = Loop + Tool Calling
 *
 * 依赖: llm.mjs
 * 导出: calculator
 */

import { config, chat } from "./llm.mjs";

/** 计算器工具 */
export const calculator = {
  name: "calculator",
  description: "执行数学计算。支持加减乘除。",
  parameters: {
    type: "object",
    properties: { expression: { type: "string", description: "数学表达式" } },
    required: ["expression"],
  },
  execute: (args) => {
    const expr = args.expression.replace(/[^0-9+\-*/().\s]/g, "");
    return `${args.expression} = ${Function(`"use strict";return (${expr})`)()}`;
  },
};

// ── 演示: 一轮工具调用 ──

async function main() {
  const messages = [
    { role: "system", content: "你是助手。需要计算时调用 calculator 工具。用中文回答。" },
    { role: "user", content: "帮我算 25 * 4 + 10" },
  ];
  const tools = [calculator];

  // 1. 发送 → LLM 返回 tool_calls
  const { message: reply } = await chat({ ...config, messages, tools, onToken: (t) => process.stdout.write(t) });
  messages.push(reply);

  // 2. 执行工具 → 结果回传
  if (reply.tool_calls?.length) {
    for (const tc of reply.tool_calls) {
      const result = calculator.execute(JSON.parse(tc.function.arguments));
      console.log(`\nAction:  ${tc.function.name}(${tc.function.arguments})`);
      console.log(`Result:  ${result}`);
      messages.push({ role: "tool", tool_call_id: tc.id, content: result });
    }

    // 3. LLM 看到结果，给出最终回答
    process.stdout.write("\n回答: ");
    await chat({ ...config, messages, tools, onToken: (t) => process.stdout.write(t) });
  }

}

main().catch(console.error);
