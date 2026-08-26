/**
 * 07-ralph.mjs — Ralph Loop（自主迭代循环）
 *
 * 既是案例（node 07-ralph.mjs 可运行讲解），又是模块（可被 09 import）。
 *
 * Ralph Loop = 外部循环 + 全新上下文 + 文件系统记忆
 *   1. Read     — 从 progress 读取上次进度（模拟从文件系统读取）
 *   2. Act      — 用全新 messages 调用 LLM（不累积历史！每次都是干净上下文）
 *   3. Verify   — 检查结果中是否有完成信号 <promise>COMPLETE</promise>
 *   4. Update   — 把本次结果追加到 progress（模拟写入文件系统）
 *   5. Repeat   — 直到检测到完成信号或达到迭代上限
 *
 * 核心思想（Geoffrey Huntley 的 Ralph 模式）:
 *   "deterministically bad in an undeterministic world"
 *   — 不追求一次性完美，而是通过持续迭代、从失败中学习来达成目标
 *   命名来自《辛普森一家》的 Ralph Wiggum：天真、执着、不断重复尝试
 *
 * Ralph 与 ReAct/Plan 的根本区别:
 *   ReAct: 一个长会话，messages 不断累积，LLM 自己控制何时停
 *          → 问题：长会话导致"上下文腐烂"（context rot），LLM 注意力退化
 *   Plan:  先拆步骤再执行，步骤间通过 accumulatedContext 传递
 *          → 问题：accumulatedContext 越来越长，后面步骤的上下文质量下降
 *   Ralph: 每次迭代都是全新会话（fresh context），记忆通过 progress 持久化
 *          → 解决 context rot：每次迭代只看到 system + task + progress，干净且聚焦
 *          → 外部循环控制何时停：不信任 LLM 的"我完成了"自我判断，用完成信号验证
 *
 *   简单说: ReAct/Plan 把记忆放在 messages 里（越积越长），Ralph 把记忆放在文件里（每次重来）
 *
 * Ralph = Loop over Contexts（每次迭代换一个全新上下文窗口）
 *
 * 依赖: llm.mjs, 01-prompt.mjs, loop.mjs（createLoop）, 05-react.mjs（执行器）
 * 被依赖: (可被 09-harness.mjs import)
 *
 * 导出: createRalphAgent
 */

import { config, chat } from "./llm.mjs";
import { buildSystemPrompt } from "./01-prompt.mjs";
import { createReActAgent, allTools } from "./05-react.mjs";
import { createLoop } from "./loop.mjs";

// ═══════════════════════════════════════════════════════════════
// 模块 API — Ralph Loop 引擎
// ═══════════════════════════════════════════════════════════════

// 完成信号：LLM 在回复中包含此标签时，表示所有任务已完成
const COMPLETE_SIGNAL = "<promise>COMPLETE</promise>";

/**
 * 创建 Ralph Agent
 *
 * @param {object}  options.config - LLM 配置
 * @param {array}   options.tools - 工具列表（传给 ReAct executor）
 * @param {string}  options.systemPrompt - 系统提示词
 * @param {number}  options.maxIterations - 最大迭代次数（外部 Ralph 循环）
 * @param {number}  options.maxIterationsPerStep - 每次迭代内部 ReAct 的最大循环数
 * @param {function} options.onToken - 流式回调
 * @returns {{ run: (taskSpec: string) => Promise<trace> }}
 */
export function createRalphAgent({
  config,
  tools = [],
  systemPrompt = null,
  maxIterations = 10,
  maxIterationsPerStep = 5,
  onToken = null,
}) {
  const sysPrompt = systemPrompt || buildSystemPrompt({
    role: "自主任务执行代理（Ralph 模式：每次迭代只做一个子任务）",
    rules: [
      "【最高优先级】每次迭代严格只执行一个子任务",
      "绝对不要在一次回复中完成多个子任务，即使你知道答案",
      "未完成的子任务留给后续迭代，这是 Ralph 模式的核心",
      "执行完当前子任务后，简要记录结果即可",
      "当且仅当所有子任务都完成后，在回复末尾输出 " + COMPLETE_SIGNAL,
      "不要输出思考过程，不要使用 <think> 标签",
      "用中文回答",
    ],
  });

  // ★ 可插拔执行器：每次迭代内部用 ReAct 执行具体任务 ★
  // 与 Plan & Execute 一样，executor 可以替换为普通 LLM 调用
  const executor = createReActAgent({
    config,
    tools,
    systemPrompt: sysPrompt,
    maxIterations: maxIterationsPerStep,
  });

  // ★ 用 createLoop 实现外部 Ralph 循环 ★
  // state = { taskSpec, progress, iteration, stepResults, done }
  //
  // ★ 为什么 state 里用 progress 字符串而不是 messages 数组？★
  // ReAct/Plan 的 state 是 messages 数组，每轮往后 push，越来越长。
  // Ralph 的 state 是 progress 字符串，每轮用它构建全新 messages——
  // messages 用完即弃，progress 持久积累，这就是"文件系统记忆"的模拟。
  const ralphLoop = createLoop({
    maxIterations,
    agentType: "Ralph",
    async step(state, cfg, loopTrace) {
      const { taskSpec, progress } = state;
      const iterNum = state.iteration + 1;

      // 1. Read: 构建"全新"输入（不携带历史 messages，只携带 progress 摘要）
      //    这就是 Ralph 的核心：每次迭代 LLM 看到的上下文都是干净的
      //    — system + task + progress，而不是几十轮对话历史
      //
      //    ★ 显式指定子任务编号：防止 LLM 一次做完所有子任务 ★
      //    通过 progress 中的 [迭代 N] 标记判断已完成几个子任务，
      //    据此显式指定"本次做第 N 个子任务"，从外部强制单任务执行
      const completedCount = progress
        ? (progress.match(/\[迭代 \d+\]/g) || []).length
        : 0;
      const nextTaskNum = completedCount + 1;

      const stepInput = progress
        ? `任务规格:\n${taskSpec}\n\n已有进度:\n${progress}\n\n当前应执行第 ${nextTaskNum} 个子任务。\n⚠️ 严格只执行这一个子任务，不要做其他子任务。\n完成本子任务后简要记录结果即可。\n只有在任务规格中所有子任务都已在进度记录中完成时，才输出 ${COMPLETE_SIGNAL}。`
        : `任务规格:\n${taskSpec}\n\n当前应执行第 1 个子任务。\n⚠️ 严格只执行第 1 个子任务，不要做其他子任务。\n完成本子任务后简要记录结果即可，不要输出 ${COMPLETE_SIGNAL}。`;

      // 2. Act: 用 ReAct agent 执行（内部有自己的 messages，用完即弃）
      const stepTrace = await executor.run(stepInput);
      // 过滤 think 标签
      const stepReply = (stepTrace.finalReply || "")
        .replace(/<think>[\s\S]*?<\/think>/g, "")
        .trim();

      // 3. Verify: 检查完成信号
      const isComplete = stepReply.includes(COMPLETE_SIGNAL);

      // 4. Update: 追加进度（模拟写入文件系统）
      const cleanReply = stepReply.replace(COMPLETE_SIGNAL, "").trim();
      state.progress += `[迭代 ${iterNum}] ${cleanReply}\n\n`;
      state.iteration = iterNum;

      state.stepResults.push({
        iteration: iterNum,
        reply: cleanReply,
        toolCalls: stepTrace.toolCalls || [],
        reactIterations: stepTrace.iterations,
        progressBefore: progress, // 展示本次迭代前的 progress（证明每次是全新上下文）
      });

      // 5. 返回结果，shouldStop 根据 done 判断
      return {
        reply: { content: stepReply },
        usage: {
          prompt_tokens: stepTrace.tokens.input,
          completion_tokens: stepTrace.tokens.output,
        },
        done: isComplete,
      };
    },
    shouldStop(result) {
      return result.done;
    },
  });

  async function run(taskSpec) {
    const trace = {
      agentType: "Ralph",
      taskSpec,
      progress: "",
      stepResults: [],
      finalReply: "",
      totalIterations: 0,
      totalToolCalls: 0,
      tokens: { input: 0, output: 0 },
      durationMs: 0,
    };

    const start = Date.now();

    // ★ Ralph 循环：每次迭代都是全新上下文 ★
    const loopTrace = await ralphLoop(
      { taskSpec, progress: "", iteration: 0, stepResults: [] },
      config
    );

    // 合并数据
    trace.progress = loopTrace.state.progress;
    trace.stepResults = loopTrace.state.stepResults;
    trace.totalIterations = loopTrace.iterations;
    trace.totalToolCalls = loopTrace.state.stepResults.reduce(
      (sum, sr) => sum + sr.toolCalls.length, 0
    );
    trace.tokens.input += loopTrace.tokens.input;
    trace.tokens.output += loopTrace.tokens.output;

    // 最终回复 = 最后一次迭代的结果
    const lastStep = trace.stepResults[trace.stepResults.length - 1];
    trace.finalReply = lastStep ? lastStep.reply : "";
    trace.durationMs = Date.now() - start;

    return trace;
  }

  return { run };
}

// ═══════════════════════════════════════════════════════════════
// 演示 — node 07-ralph.mjs 运行
// ═══════════════════════════════════════════════════════════════

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║  07 — Ralph Loop: 自主迭代，全新上下文每次重来          ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  console.log("Ralph = 外部循环 + 全新上下文 + 文件系统记忆");
  console.log("  每次: Read(progress) → Act(全新messages) → Verify(完成信号) → Update(progress)");
  console.log("  vs ReAct: 一个长会话，messages 越积越长\n");

  const agent = createRalphAgent({
    config,
    tools: allTools,
    maxIterations: 5,
    maxIterationsPerStep: 3,
  });

  // 用一个多子任务规格来演示 Ralph 的迭代推进
  const taskSpec = [
    "完成以下三个子任务:",
    "1. 查询北京当前天气",
    "2. 根据天气情况推荐穿搭",
    "3. 计算 200 元外套打 8 折多少钱",
    "",
    `全部完成后输出 ${COMPLETE_SIGNAL}`,
  ].join("\n");

  console.log(`任务规格:\n${taskSpec}\n`);
  console.log("开始 Ralph 循环...\n");

  const trace = await agent.run(taskSpec);

  // 展示每次迭代的结果
  console.log("═══ 迭代过程 ═══");
  trace.stepResults.forEach((sr) => {
    console.log(`\n--- 迭代 ${sr.iteration} (ReAct轮次:${sr.reactIterations}, 工具:${sr.toolCalls.length}) ---`);
    if (sr.toolCalls.length > 0) {
      sr.toolCalls.forEach((tc) => {
        console.log(`  Action: ${tc.name}(${JSON.stringify(tc.args)}) => ${tc.result}`);
      });
    }
    console.log(`  结果: ${sr.reply.slice(0, 100)}${sr.reply.length > 100 ? "..." : ""}`);
  });

  // 展示 Ralph 的核心特性：每次迭代都是全新上下文
  console.log("\n═══ 全新上下文验证（Ralph vs ReAct 的根本区别）═══");
  console.log("每次迭代的 messages = system + task + progress（不累积历史对话）\n");
  trace.stepResults.forEach((sr) => {
    const progLen = sr.progressBefore ? sr.progressBefore.length : 0;
    console.log(`  迭代 ${sr.iteration}: progress ${progLen} 字符 → 全新 messages（无历史 tool/observation）`);
  });

  // 展示最终进度（文件系统记忆的模拟）
  console.log("\n═══ 最终进度（progress 文件记忆）═══");
  console.log(trace.progress.slice(0, 500) + (trace.progress.length > 500 ? "..." : ""));

  console.log(`\n═══ 统计 ═══`);
  console.log(`  ${trace.totalIterations}次迭代, ${trace.totalToolCalls}工具, ${trace.durationMs}ms`);
  console.log(`  tokens: ${trace.tokens.input}输入 + ${trace.tokens.output}输出`);

  console.log("\n速查: createRalphAgent({ config, tools, maxIterations }).run(taskSpec)");
  console.log("\n✅ 完成 — 下一步: 08-graph.mjs");
}

// 直接运行时才执行（被 import 时不运行）
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
