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

  console.log("循环模式:");
  console.log("  while (i < maxIterations) {");
  console.log("    reply = LLM(messages)         // 调用 LLM");
  console.log("    messages.push(reply)          // 积累状态");
  console.log("    if (shouldStop(reply)) break   // 检查停止");
  console.log("  }");
  console.log("\n  所有 Agent 都是基于 Loop 的变体:");
  console.log("    ReAct = Loop + Tool Calling     (05-react.mjs)");
  console.log("    Plan  = Loop over Steps         (06-plan.mjs)");
  console.log("    Graph = Loop over Nodes        (07-graph.mjs)\n");

  // 1. 自省循环演示
  console.log("═══ 1. 自省循环 ═══\n");
  const agent = createLoopAgent({ config, maxIterations: 5, onToken: (t) => process.stdout.write(t) });

  const input = "解释什么是闭包，给出代码示例。";
  console.log(`用户: ${input}\n`);

  const trace = await agent.run(input);

  console.log(`  循环次数: ${trace.iterations}`);
  console.log(`  tokens: ${trace.tokens.input + trace.tokens.output}, 耗时: ${trace.durationMs}ms`);
  console.log(`  最终回答: ${trace.finalReply?.replace("[DONE]", "").slice(0, 100)}...\n`);

  // 2. 单轮循环（一次就停）
  console.log("═══ 2. 单轮循环 ═══\n");
  const trace2 = await agent.run("你好");
  console.log(`  循环次数: ${trace2.iterations}（一次就标记 [DONE]）`);
  console.log(`  回答: ${trace2.finalReply?.replace("[DONE]", "").slice(0, 60)}...\n`);

  // 3. 通用循环引擎
  console.log("═══ 3. 通用循环引擎 createLoop() ═══\n");
  console.log("  createLoop 是 05-react.mjs 的基础:");
  console.log("  ReAct 的循环 = createLoop({");
  console.log("    step: 调 LLM + 执行工具,");
  console.log("    shouldStop: 无 tool_calls 时停止");
  console.log("  })\n");

  console.log("═══ Loop 的变体 ═══\n");
  console.log("  Loop + 工具调用  = ReAct (05-react.mjs)");
  console.log("  Loop over Steps  = Plan  (06-plan.mjs)");
  console.log("  Loop over Nodes  = Graph (07-graph.mjs)");

  console.log("\n速查: createLoop({ maxIterations, step, shouldStop }).run(messages, config)");
  console.log("\n✅ 完成 — 下一步: 05-react.mjs");
}

main().catch(console.error);
