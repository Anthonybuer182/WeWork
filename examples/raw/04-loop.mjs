/**
 * 04-loop.mjs — Loop Engineering（循环引擎）
 *
 * 既是案例（node 04-loop.mjs 可运行讲解），又是模块（可被 05-react import）。
 *
 * Loop = Agent 的元模式：把 LLM 放在 while 循环里
 *   while (未达上限 && 未满足停止条件) {
 *     reply = LLM(messages)        // 调用 LLM
 *     messages.push(reply)          // 积累状态
 *     if (shouldStop(reply)) break  // 检查停止
 *   }
 *
 * Loop 是所有 Agent 的元模式:
 *   ReAct = Loop + Tool Calling     (05-react.mjs)
 *   Plan  = Loop over Steps         (06-plan.mjs)
 *   Graph = Loop over Nodes         (07-graph.mjs)
 *
 * 依赖: llm.mjs, 01-prompt.mjs
 * 被依赖: 05-react.mjs（ReAct 用 createLoop 实现循环）
 *
 * 导出: createLoop, createLoopAgent
 */

import { config, chat } from "./llm.mjs";
import { buildSystemPrompt } from "./01-prompt.mjs";

// ═══════════════════════════════════════════════════════════════
// 模块 API — 通用循环引擎（05-react.mjs 依赖此函数）
// ═══════════════════════════════════════════════════════════════

/**
 * 创建通用循环引擎
 * @param {object} options
 * @param {number} options.maxIterations - 最大循环次数
 * @param {function} options.step - 步骤函数 (messages, config, trace) -> { reply, usage, ... }
 * @param {function} options.shouldStop - 停止判断 (result, trace) -> boolean
 * @param {string} options.agentType - trace.agentType 标识
 * @param {object} options.initialTrace - 额外 trace 字段
 * @returns {function} run(messages, config) -> trace
 */
export function createLoop({
  maxIterations = 10,
  step,
  shouldStop,
  agentType = "Loop",
  initialTrace = {},
}) {
  return async function run(messages, config) {
    const trace = {
      agentType,
      iterations: 0,
      finalReply: "",
      tokens: { input: 0, output: 0 },
      durationMs: 0,
      messages: [...messages],
      ...initialTrace,
    };

    const start = Date.now();

    // ★ 核心循环 ★
    while (trace.iterations < maxIterations) {
      trace.iterations++;

      // step 函数：调用 LLM，处理结果
      const result = await step(trace.messages, config, trace);

      if (result.usage) {
        trace.tokens.input += result.usage.prompt_tokens || 0;
        trace.tokens.output += result.usage.completion_tokens || 0;
      }

      // shouldStop：判断是否结束循环
      if (shouldStop(result, trace)) {
        trace.finalReply =
          result.reply?.content ||
          trace.messages[trace.messages.length - 1]?.content ||
          "";
        break;
      }
    }

    trace.durationMs = Date.now() - start;
    return trace;
  };
}

// ═══════════════════════════════════════════════════════════════
// 模块 API — 自省循环 Agent（演示用）
// ═══════════════════════════════════════════════════════════════

/**
 * 创建自省循环 Agent
 * 流程: 生成回答 -> 自我评估 -> 满意则标记 [DONE] 停止 -> 不满意则改进 -> 循环
 *
 * @param {object} options.config - LLM 配置
 * @param {string} options.systemPrompt - 系统提示词
 * @param {number} options.maxIterations - 最大循环次数
 * @returns {{ run: (input: string) => Promise<trace> }}
 */
export function createLoopAgent({
  config,
  systemPrompt = null,
  maxIterations = 5,
  onToken = null,
}) {
  const sysPrompt =
    systemPrompt ||
    buildSystemPrompt({
      role: "助手",
      rules: [
        "认真回答用户问题",
        "回答后自我评估：如果满意，在回答末尾加上 [DONE]",
        "如果不满意，重新给出更好的回答并加上 [DONE]",
        "用中文回答",
      ],
    });

  // ★ 用 createLoop 实现自省循环 ★
  const loop = createLoop({
    maxIterations,
    agentType: "Loop",
    async step(messages, cfg) {
      const { message: reply, usage } = await chat({ ...cfg, messages, onToken });
      messages.push(reply);
      return { reply, usage };
    },
    shouldStop(result) {
      const content = result.reply?.content || "";
      return content.includes("[DONE]");
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
// 演示 — node 04-loop.mjs 运行
// ═══════════════════════════════════════════════════════════════

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║  04 — Loop Engineering: Agent 的元模式                  ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  console.log("Loop = 把 LLM 放在 while 循环里");
  console.log("  ReAct = Loop + Tool Calling  (05)");
  console.log("  Plan  = Loop over Steps     (06)");
  console.log("  Graph = Loop over Nodes     (07)\n");

  // 一个案例：自省循环 — LLM 自我评估，满意才停
  const agent = createLoopAgent({ config, maxIterations: 5, onToken: (t) => process.stdout.write(t) });
  const input = "解释什么是闭包，给出代码示例。";
  console.log(`用户: ${input}\n`);

  const trace = await agent.run(input);

  console.log(`\n  循环 ${trace.iterations} 次, ${trace.durationMs}ms`);
  console.log("\n速查: createLoop({ maxIterations, step, shouldStop })");
  console.log("\n✅ 完成 — 下一步: 05-react.mjs");
}

main().catch(console.error);
