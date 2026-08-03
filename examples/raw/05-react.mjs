/**
 * 05-react.mjs — ReAct (Reason + Act) 循环引擎
 *
 * 既是案例（node 05-react.mjs 可运行讲解），又是模块（可被 06/08 import）。
 *
 * ReAct = Loop + Tool Calling
 *   Thought     = assistant 的文本回复
 *   Action      = assistant 的 tool_calls
 *   Observation = tool 结果（role: "tool" 消息）
 *
 * ★ ReAct 的循环用 04-loop.mjs 的 createLoop 实现 ★
 *   step 函数    = 调 LLM + 执行工具
 *   shouldStop   = 无 tool_calls 时停止
 *
 * 依赖: llm.mjs, 01-prompt.mjs, 02-context.mjs, 04-loop.mjs
 * 被依赖: 06-plan.mjs, 08-harness.mjs
 *
 * 导出: calculator, getWeather, allTools, createReActAgent
 */

import { config, chat } from "./llm.mjs";
import { buildSystemPrompt } from "./01-prompt.mjs";
import { truncateMessages, estimateMessagesTokens } from "./02-context.mjs";
import { createLoop } from "./04-loop.mjs";

// ═══════════════════════════════════════════════════════════════
// 模块 API — 工具定义（供 06/08 import）
// ═══════════════════════════════════════════════════════════════

export const calculator = {
  name: "calculator",
  description: "执行数学计算。支持加减乘除。当需要精确计算时使用。",
  parameters: {
    type: "object",
    properties: {
      expression: { type: "string", description: "数学表达式，如 '2 + 3 * 4'" },
    },
    required: ["expression"],
  },
  execute: (args) => {
    const expr = args.expression.replace(/[^0-9+\-*/().\s]/g, "");
    try {
      const result = Function(`"use strict"; return (${expr})`)();
      return `${args.expression} = ${result}`;
    } catch {
      return `计算错误: 无法解析 "${args.expression}"`;
    }
  },
};

export const getWeather = {
  name: "get_weather",
  description: "获取指定城市的天气信息。",
  parameters: {
    type: "object",
    properties: {
      city: { type: "string", description: "城市名称" },
    },
    required: ["city"],
  },
  execute: (args) => {
    const mock = { 北京: "晴，25°C", 上海: "多云，28°C", 广州: "雷阵雨，30°C" };
    return mock[args.city] || `${args.city}: 晴天 20°C`;
  },
};

export const allTools = [calculator, getWeather];

// ═══════════════════════════════════════════════════════════════
// 模块 API — ReAct 引擎（基于 createLoop 实现）
// ═══════════════════════════════════════════════════════════════

/**
 * 创建 ReAct Agent
 * @param {object} options.config - LLM 配置 (baseUrl, apiKey, model)
 * @param {array}  options.tools - 工具列表
 * @param {string} options.systemPrompt - 系统提示词（可选）
 * @param {number} options.maxIterations - 最大循环次数
 * @param {number} options.maxContextTokens - 上下文 token 限制
 * @returns {{ run: (input: string) => Promise<trace> }}
 */
export function createReActAgent({
  config,
  tools = [],
  systemPrompt = null,
  maxIterations = 10,
  maxContextTokens = Infinity,
  onToken = null,
}) {
  const sysPrompt =
    systemPrompt ||
    buildSystemPrompt({
      role: "助手",
      rules: [
        "需要使用工具时，先说明思考过程，再调用工具",
        "根据工具返回的结果继续推理，决定下一步",
        "如果已得到答案，不需要再调用工具，直接回复用户",
        "如果问题不需要工具（如闲聊、自我介绍、常识问答等），直接回复，不要调用工具",
        "用中文回答",
      ],
    });

  const toolMap = Object.fromEntries(tools.map((t) => [t.name, t]));

  // ★ ReAct = Loop + Tool Calling ★
  // 循环引擎来自 04-loop.mjs，step 函数处理 Thought/Action/Observation
  const loop = createLoop({
    maxIterations,
    agentType: "ReAct",
    initialTrace: { toolCalls: [] },

    // step: 每轮调用 LLM + 处理工具调用
    async step(messages, cfg, trace) {
      // Context 管理：超限时截断
      let ctx = messages;
      if (estimateMessagesTokens(messages) > maxContextTokens) {
        ctx = truncateMessages(messages, maxContextTokens);
      }

      // 1. Thought + Action: 调用 LLM
      const { message: reply, usage } = await chat({ ...cfg, messages: ctx, tools, ...(onToken ? { onToken } : {}) });
      messages.push(reply);

      // 2. 检查是否有 Action（工具调用）
      const toolCalls = reply.tool_calls;
      if (!toolCalls || toolCalls.length === 0) {
        // 没有 Action -> Thought 就是最终答案
        return { reply, usage, done: true };
      }

      // 3. Observation: 执行工具，结果加入历史
      for (const tc of toolCalls) {
        const { name, arguments: argsStr } = tc.function;
        const args = JSON.parse(argsStr);
        const result = toolMap[name]
          ? toolMap[name].execute(args)
          : `工具 ${name} 不存在`;
        trace.toolCalls.push({ name, args, result });
        messages.push({ role: "tool", tool_call_id: tc.id, content: result });
      }

      // 4. 回到循环顶部 -> LLM 看到 Observation 后继续 Thought
      return { reply, usage, done: false };
    },

    shouldStop(result) {
      return result.done;
    },
  });

  return {
    async run(input) {
      const messages = [
        { role: "system", content: sysPrompt },
        { role: "user", content: input },
      ];
      return loop(messages, config);
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// 演示 — node 05-react.mjs 运行
// ═══════════════════════════════════════════════════════════════

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║  05 — ReAct: Reason + Act（基于 Loop）                 ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  console.log("ReAct = Loop + Tool Calling");
  console.log("  循环引擎: createLoop() (04-loop.mjs)");
  console.log("  step 函数: 调 LLM + 执行工具");
  console.log("  shouldStop: 无 tool_calls 时停止\n");

  console.log("ReAct 循环结构:");
  console.log("  createLoop({");
  console.log("    step: async (messages, cfg, trace) => {");
  console.log("      reply = LLM(messages, tools)    // Thought + Action");
  console.log("      if (reply.tool_calls) {         // 有 Action？");
  console.log("        results = execute(tools)      // Observation");
  console.log("        messages.push(results)        // 加入历史");
  console.log("        return { done: false }         // 继续 Thought");
  console.log("      }");
  console.log("      return { done: true }           // 最终答案");
  console.log("    },");
  console.log("    shouldStop: (r) => r.done");
  console.log("  })\n");

  const agent = createReActAgent({ config, tools: allTools, maxIterations: 10, onToken: (t) => process.stdout.write(t) });

  // 演示 1: 多轮 ReAct
  console.log("═══ 1. 多轮 ReAct ═══\n");
  const input1 = "帮我算 25 * 4 + 10，查北京天气，然后总结。";
  console.log(`用户: ${input1}\n`);

  const trace1 = await agent.run(input1);

  console.log(`\n  轮次: ${trace1.iterations}, 工具: ${trace1.toolCalls.length}次, ${trace1.durationMs}ms`);
  trace1.toolCalls.forEach((tc) => {
    console.log(`    - ${tc.name}(${JSON.stringify(tc.args)}) -> ${tc.result}`);
  });
  console.log(`  回复: ${trace1.finalReply?.slice(0, 80)}...\n`);

  // 演示 2: 单轮 ReAct
  console.log("═══ 2. 单轮 ReAct（无工具调用）═══\n");
  const trace2 = await agent.run("你好，用一句话介绍自己。");
  console.log(`  轮次: ${trace2.iterations}（一次结束）`);
  console.log(`  回复: ${trace2.finalReply?.slice(0, 80)}...\n`);

  console.log("速查: createReActAgent({ config, tools, maxIterations }).run(input) -> trace");
  console.log("\n✅ 完成 — 下一步: 06-plan.mjs");
}

main().catch(console.error);
