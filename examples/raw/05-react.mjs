/**
 * 05-react.mjs — ReAct (Reason + Act) 循环引擎
 *
 * 依赖: llm.mjs (config, chat), loop.mjs (createLoop)
 * 被依赖: 06-plan.mjs
 *
 * ReAct = Loop + Tool Calling
 *   Thought     = assistant 的文本回复（推理过程）
 *   Action      = assistant 的 tool_calls（调用工具）
 *   Observation = tool 结果（role: "tool" 消息）
 *
 * 导出: getWeather, allTools, createReActAgent
 */

import { config, chat } from "./llm.mjs";
import { createLoop } from "./loop.mjs";
import { buildSystemPrompt } from "./01-prompt.mjs";

// ═══════════════════════════════════════════════════════════════
// 工具定义（供 06/08 import）
// ═══════════════════════════════════════════════════════════════

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

export const allTools = [getWeather];

// ═══════════════════════════════════════════════════════════════
// ReAct 引擎（基于 createLoop）
// ═══════════════════════════════════════════════════════════════

const DEFAULT_SYSTEM_PROMPT = buildSystemPrompt({
  role: "助手",
  rules: [
    "需要使用工具时，先说明思考过程，再调用工具",
    "根据工具返回的结果继续推理，决定下一步",
    "如果已得到答案，不需要再调用工具，直接回复用户",
    "如果问题不需要工具（如闲聊、自我介绍、常识问答等），直接回复，不要调用工具",
    "用中文回答",
  ],
});

/**
 * 创建 ReAct Agent
 * @param {object}   options.config - LLM 配置 (baseUrl, apiKey, model)
 * @param {array}    options.tools - 工具列表
 * @param {string}   options.systemPrompt - 系统提示词（可选）
 * @param {number}   options.maxIterations - 最大循环次数
 * @param {function} options.onStep - 流程回调 ({ phase, iteration, ...data })
 * @returns {{ run: (input: string) => Promise<trace> }}
 */
export function createReActAgent({
  config,
  tools = [],
  systemPrompt = null,
  maxIterations = 10,
  onStep = null,
  silent = false,
}) {
  const sysPrompt = systemPrompt || DEFAULT_SYSTEM_PROMPT;
  const toolMap = Object.fromEntries(tools.map((t) => [t.name, t]));

  const loop = createLoop({
    maxIterations,
    agentType: "ReAct",

    async step(messages, cfg, trace) {
      // 1. 调用 LLM → 同一次响应里返回 Thought(content) + Action 意图(tool_calls)
      const { message: reply, usage } = await chat({ ...cfg, messages, tools, silent });
      messages.push(reply);

      const toolCalls = reply.tool_calls;

      // 2. 无 Action → Thought 即最终答案，结束循环
      if (!toolCalls || toolCalls.length === 0) {
        if (onStep) onStep({ phase: "answer", iteration: trace.iterations, thought: reply.content });
        return { reply, usage, done: true };
      }

      // 3. Thought: LLM 的推理过程
      if (onStep) onStep({ phase: "thought", iteration: trace.iterations, thought: reply.content });

      // 4. Action: LLM 决定调用工具（tool_calls 即调用意图）
      if (onStep) onStep({ phase: "act", iteration: trace.iterations, toolCalls });

      // 5. Observation: 执行工具，结果加入历史
      for (const tc of toolCalls) {
        const { name, arguments: argsStr } = tc.function;
        const args = JSON.parse(argsStr);
        const result = toolMap[name] ? toolMap[name].execute(args) : `工具 ${name} 不存在`;
        trace.toolCalls ??= [];
        trace.toolCalls.push({ name, args, result });
        messages.push({ role: "tool", tool_call_id: tc.id, content: result });
        if (onStep) onStep({ phase: "observe", iteration: trace.iterations, name, args, result });
      }

      // 6. 回到循环顶部 → LLM 看到 Observation 后继续 Thought
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
// 演示 — node 05-react.mjs
// 用一个多步推理案例展示 ReAct 循环：查两地天气 → 比较 → 总结
// ═══════════════════════════════════════════════════════════════

// 去掉模型返回中的 <think>...</think> 推理标签，保持演示输出干净
const cleanThought = (s) => (s || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim() || "(推理中)";

// 把 ReAct 每一步打印成可读流程
function prettyStep({ phase, iteration, thought, toolCalls, name, args, result }) {
  if (phase === "thought") {
    console.log(`\n[轮 ${iteration}]`);
    console.log(`  Thought     | ${cleanThought(thought).slice(0, 80)}`);
  } else if (phase === "act") {
    const actions = toolCalls.map((tc) => `${tc.function.name}(${tc.function.arguments})`).join(" + ");
    console.log(`  Action      | ${actions}`);
  } else if (phase === "observe") {
    console.log(`  Observation | ${name}(${JSON.stringify(args)}) => ${result}`);
  } else if (phase === "answer") {
    console.log(`\n[轮 ${iteration}] (无需工具，直接回复)`);
    console.log(`  Answer      | ${cleanThought(thought).slice(0, 120)}`);
  }
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║  05 — ReAct: Reason + Act                               ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");
  console.log("ReAct = Thought（思考）→ Action（行动）→ Observation（观察）→ 循环\n");

  const agent = createReActAgent({
    config,
    tools: allTools,
    maxIterations: 10,
    onStep: prettyStep,
    silent: false,
  });

  const q = "北京和上海哪个温度更高？先查两地天气再比较";
  const t = await agent.run(q);

}

// 直接运行时才执行（被 import 时不运行）
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
