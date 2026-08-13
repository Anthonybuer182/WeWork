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
 *   Ralph = Loop over Contexts      (07-ralph.mjs)
 *   Graph = Loop over Nodes         (08-graph.mjs)
 *
 * 依赖: llm.mjs, 01-prompt.mjs
 * 被依赖: 05-react.mjs, 06-plan.mjs, 07-ralph.mjs — 均用 createLoop 实现循环
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
 *
 * state 是通用状态容器——ReAct 用 messages 数组，Plan & Execute 用步骤对象。
 * 各 Agent 在 step 函数中自行读写 state，createLoop 只管循环和统计。
 *
 * 为什么 step 和 shouldStop 要分离？
 *   - step 负责"做一轮"：调用 LLM、执行工具、更新 state，产出结果 + 元信息（如 done 标志）
 *   - shouldStop 负责"判断停不停"：只看 step 返回的元信息，不修改任何状态
 *   - 职责分离使得循环逻辑与业务逻辑解耦：
 *     ReAct 的 shouldStop 看 result.done（无 tool_calls 即停）
 *     Plan 的 shouldStop 也看 result.done（步骤执行完即停）
 *     两者复用同一个循环引擎，只是 done 的判定逻辑不同
 *
 * @param {object} options
 * @param {number} options.maxIterations - 最大循环次数
 * @param {function} options.step - 步骤函数 (state, config, trace) -> { reply, usage, ... }
 * @param {function} options.shouldStop - 停止判断 (result, trace) -> boolean
 * @param {string} options.agentType - trace.agentType 标识
 * @returns {function} run(initialState, config) -> trace
 */
export function createLoop({
  maxIterations = 10,
  step,
  shouldStop,
  agentType = "Loop",
}) {
  return async function run(initialState, config) {
    const trace = {
      agentType,
      iterations: 0,
      finalReply: "",
      tokens: { input: 0, output: 0 },
      durationMs: 0,
      state: initialState,
    };

    const start = Date.now();

    // ★ 核心循环 ★
    while (trace.iterations < maxIterations) {
      trace.iterations++;

      // step 函数：处理一轮迭代，state 由各 Agent 自行管理
      const result = await step(trace.state, config, trace);

      if (result.usage) {
        trace.tokens.input += result.usage.prompt_tokens || 0;
        trace.tokens.output += result.usage.completion_tokens || 0;
      }

      // shouldStop：判断是否结束循环
      if (shouldStop(result, trace)) {
        trace.finalReply = result.reply?.content || "";
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

// 直接运行时才执行（被 import 时不运行）
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
