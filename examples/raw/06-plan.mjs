/**
 * 06-plan.mjs — Plan & Execute（规划与执行）引擎
 *
 * 既是案例（node 06-plan.mjs 可运行讲解），又是模块（可被 08 import）。
 *
 * Plan & Execute = 先规划，再执行
 *   1. Plan    — LLM 把任务拆成步骤列表
 *   2. Execute — 用 createLoop 循环执行步骤（执行器可插拔：可用 ReAct，也可用普通 LLM 调用）
 *   3. Join    — 汇总所有步骤的结果
 *
 * Plan & Execute 与 ReAct 的关系:
 *   两者是并列的 agent 模式，不是依赖关系：
 *   - ReAct: 走一步看一步（reactive），适合步骤不可预知的任务
 *   - Plan:  先全局规划再执行（proactive），适合能先拆解的多步任务
 *   本文件选择用 ReAct 作为 Execute 阶段的执行器，是一种常见组合，但不是必须的。
 *   Execute 阶段是可插拔的——这是 Plan & Execute 最重要的设计思想。
 *
 * 依赖: llm.mjs, 01-prompt.mjs, loop.mjs（createLoop）, 05-react.mjs（本文件用其作为执行器）
 * 被依赖: (可被 08-harness.mjs import)
 *
 * 导出: createPlanExecuteAgent
 */

import { config, chat } from "./llm.mjs";
import { buildSystemPrompt } from "./01-prompt.mjs";
import { createReActAgent, allTools } from "./05-react.mjs";
import { createLoop } from "./loop.mjs";

// ═══════════════════════════════════════════════════════════════
// 模块 API — Plan & Execute 引擎
// ═══════════════════════════════════════════════════════════════

/**
 * 创建 Plan & Execute Agent
 * @param {object} options.config - LLM 配置
 * @param {array}  options.tools - 工具列表（传给 ReAct executor）
 * @param {string} options.systemPrompt - 系统提示词
 * @param {number} options.maxSteps - 最大步骤数
 * @param {number} options.maxIterationsPerStep - 每步最大 ReAct 循环数
 * @returns {{ run: (input: string) => Promise<trace> }}
 */
export function createPlanExecuteAgent({
  config,
  tools = [],
  systemPrompt = null,
  maxSteps = 10,
  maxIterationsPerStep = 5,
  onToken = null,
}) {
  const sysPrompt = systemPrompt || buildSystemPrompt({
    role: "助手",
    rules: ["需要使用工具时调用相应工具", "用中文回答"],
  });

  // ★ 可插拔执行器 ★
  // executor 可以是 ReAct agent（本文件的选择），也可以是普通 LLM 调用：
  //   const executor = { run: (input) => simpleChat(config, input) };
  // 只要 executor 有 run(input) -> { finalReply, tokens, toolCalls, iterations } 接口即可。
  // Plan & Execute 的核心是"规划-执行-汇总"流程，执行器只是 Execute 阶段的一个可替换零件。
  const executor = createReActAgent({
    config,
    tools,
    systemPrompt: sysPrompt,
    maxIterations: maxIterationsPerStep,
    ...(onToken ? { onToken } : {}),
  });

  // ★ 用 createLoop 实现步骤循环（Plan = Loop over Steps）★
  // state = { plan, stepIndex, accumulatedContext, stepResults }，每轮推进一个步骤
  const executeLoop = createLoop({
    maxIterations: maxSteps,
    agentType: "PlanExecute",
    async step(state, cfg, loopTrace) {
      const { plan: p, stepIndex, accumulatedContext } = state;
      const currentStep = p[stepIndex];
      // ★ accumulatedContext: 步骤间的串行上下文依赖 ★
      // 把前一步的结果拼入下一步输入，让 LLM 知道之前发生了什么。
      // 这意味着步骤是串行执行的（step2 依赖 step1 的结果），不能并行。
      // 如果步骤间无依赖（如独立查询），可以去掉 accumulatedContext 实现并行执行。
      const stepInput = accumulatedContext
        ? `之前的步骤结果:\n${accumulatedContext}\n\n当前步骤: ${currentStep}`
        : currentStep;

      // 每步用 ReAct agent 执行
      const stepTrace = await executor.run(stepInput);
      // 过滤 think 标签，避免思考过程污染后续步骤和 Join 阶段
      const stepReply = (stepTrace.finalReply || "").replace(/ IMD:think[\s\S]*?<\/think>/g, "").trim();

      state.stepResults.push({
        step: currentStep,
        reply: stepReply,
        toolCalls: stepTrace.toolCalls || [],
        iterations: stepTrace.iterations,
      });
      state.accumulatedContext += `步骤 ${stepIndex + 1}: ${currentStep}\n结果: ${stepReply}\n\n`;
      state.stepIndex++;

      return {
        reply: { content: stepReply },
        usage: {
          prompt_tokens: stepTrace.tokens.input,
          completion_tokens: stepTrace.tokens.output,
        },
        done: state.stepIndex >= p.length,
      };
    },
    shouldStop(result) {
      return result.done;
    },
  });

  async function run(input) {
    const trace = {
      agentType: "PlanExecute",
      plan: [],
      stepResults: [],
      finalReply: "",
      totalIterations: 0,
      totalToolCalls: 0,
      tokens: { input: 0, output: 0 },
      durationMs: 0,
    };

    const start = Date.now();

    // ★ 阶段 1: Plan — 把任务拆成步骤 ★
    const planPrompt = buildSystemPrompt({
      role: "任务规划师",
      rules: [
        "把用户任务拆解成具体的执行步骤",
        "每步应该是可独立执行的子任务",
        `最多 ${maxSteps} 个步骤`,
        "只输出 JSON 数组，不要输出任何其他内容",
        "不要输出思考过程，不要使用 <think> 标签",
        '输出格式必须是: ["步骤1", "步骤2", ...]',
      ],
      format: `纯 JSON 数组，无任何额外文字或标签`,
    });

    const { message: planReply, usage: planUsage } = await chat({
      ...config,
      messages: [
        { role: "system", content: planPrompt },
        { role: "user", content: input },
      ],
    });

    if (planUsage) {
      trace.tokens.input += planUsage.prompt_tokens || 0;
      trace.tokens.output += planUsage.completion_tokens || 0;
    }

    // 解析计划
    let plan = [];
    try {
      const jsonStr = planReply.content
        .replace(/<think>[\s\S]*?<\/think>/g, "") // 过滤 think 标签
        .replace(/```json?\n?/g, "")
        .replace(/```/g, "")
        .trim();
      plan = JSON.parse(jsonStr);
    } catch {
      plan = [planReply.content];
    }
    trace.plan = plan;

    // ★ 阶段 2: Execute — 用 createLoop 循环执行步骤 ★
    const loopTrace = await executeLoop(
      { plan, stepIndex: 0, accumulatedContext: "", stepResults: [] },
      config
    );

    // 合并 Execute 阶段数据
    // token 三层传递链: ReAct step -> createLoop trace -> PlanExecute trace
    //   每步: stepTrace.tokens（ReAct 内部 chat 的 token）
    //   循环: loopTrace.tokens（createLoop 累加所有 step 的 usage）
    //   最终: trace.tokens（PlanExecute 累加 Plan + Execute + Join 三阶段）
    trace.stepResults = loopTrace.state.stepResults;
    trace.totalIterations = loopTrace.iterations;
    trace.totalToolCalls = loopTrace.state.stepResults.reduce(
      (sum, sr) => sum + sr.toolCalls.length, 0
    );
    trace.tokens.input += loopTrace.tokens.input;
    trace.tokens.output += loopTrace.tokens.output;

    const accumulatedContext = loopTrace.state.accumulatedContext;

    // ★ 阶段 3: Join — 汇总最终答案 ★
    const { message: joinReply, usage: joinUsage } = await chat({
      ...config,
      messages: [
        {
          role: "system",
          content: `${sysPrompt}\n\n你是汇总助手。根据各步骤的执行结果，给出最终回答。`,
        },
        {
          role: "user",
          content: `用户原始问题: ${input}\n\n各步骤结果:\n${accumulatedContext}`,
        },
      ],
      ...(onToken ? { onToken } : {}),
    });

    if (joinUsage) {
      trace.tokens.input += joinUsage.prompt_tokens || 0;
      trace.tokens.output += joinUsage.completion_tokens || 0;
    }

    trace.finalReply = joinReply.content;
    trace.durationMs = Date.now() - start;

    return trace;
  }

  return { run };
}

// ═══════════════════════════════════════════════════════════════
// 演示 — node 06-plan.mjs 运行
// ═══════════════════════════════════════════════════════════════

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║  06 — Plan & Execute: 先规划再执行                       ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  console.log("流程: Plan(拆步骤) → Execute(每步用ReAct) → Join(汇总)\n");

  const agent = createPlanExecuteAgent({
    config,
    tools: allTools,
    maxSteps: 5,
    maxIterationsPerStep: 3,
    onToken: (t) => process.stdout.write(t),
  });

  const input = "帮我查北京天气，根据天气推荐穿搭，再算 200 元外套打 8 折多少钱。";

  const trace = await agent.run(input);

  console.log("\n═══ Plan ═══");
  trace.plan.forEach((step, i) => console.log(`  ${i + 1}. ${step}`));

  console.log("\n═══ Execute ═══");
  trace.stepResults.forEach((sr, i) => {
    console.log(`  步骤 ${i + 1}: ${sr.step} (轮次:${sr.iterations}, 工具:${sr.toolCalls.length})`);
  });

  const cleanReply = (trace.finalReply || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  console.log(`\n═══ Join ═══\n  ${cleanReply}\n`);

  console.log(`统计: ${trace.plan.length}步, ${trace.totalIterations}轮, ${trace.totalToolCalls}工具, ${trace.durationMs}ms`);
}

// 直接运行时才执行（被 import 时不运行）
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
