/**
 * 06-plan.mjs — Plan & Execute（规划与执行）
 *
 * Plan & Execute = 先规划再执行
 *   1. Plan    — LLM 把任务拆成步骤列表
 *   2. Execute — 用 createLoop 循环执行步骤（执行器可插拔，这里用 ReAct）
 *   3. Join    — 汇总所有步骤的结果
 *
 * 依赖: llm.mjs, 01-prompt.mjs, loop.mjs, 05-react.mjs
 * 导出: createPlanExecuteAgent
 */

import { config, chat } from "./llm.mjs";
import { buildSystemPrompt } from "./01-prompt.mjs";
import { createReActAgent, allTools } from "./05-react.mjs";
import { createLoop } from "./loop.mjs";

/**
 * 创建 Plan & Execute Agent
 * @param {object} options.config - LLM 配置
 * @param {array}  options.tools - 工具列表（传给 ReAct executor）
 * @param {number} options.maxSteps - 最大步骤数
 * @param {number} options.maxIterationsPerStep - 每步最大 ReAct 循环数
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

  // 可插拔执行器：只要有 run(input) -> trace 接口即可，这里用 ReAct
  const executor = createReActAgent({
    config,
    tools,
    systemPrompt: sysPrompt,
    maxIterations: maxIterationsPerStep,
    ...(onToken ? { onToken } : {}),
  });

  // 用 createLoop 实现步骤循环，步骤间通过 accumulatedContext 串行传递上下文
  const executeLoop = createLoop({
    maxIterations: maxSteps,
    agentType: "PlanExecute",
    async step(state) {
      const { plan: p, stepIndex, accumulatedContext } = state;
      const currentStep = p[stepIndex];
      // 把前一步结果拼入当前步骤输入（串行依赖）
      const stepInput = accumulatedContext
        ? `之前的步骤结果:\n${accumulatedContext}\n\n当前步骤: ${currentStep}`
        : currentStep;

      const stepTrace = await executor.run(stepInput);
      const stepReply = (stepTrace.finalReply || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();

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

    // 阶段 1: Plan — 把任务拆成步骤
    const planPrompt = buildSystemPrompt({
      role: "任务规划师",
      rules: [
        "把用户任务拆解成具体的执行步骤",
        "每步应该是可独立执行的子任务",
        `最多 ${maxSteps} 个步骤`,
        "只输出 JSON 数组，不要输出任何其他内容",
        "不要输出思考过程",
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

    // 解析计划（容错：解析失败则把原始回复当作单步计划）
    let plan = [];
    try {
      const jsonStr = planReply.content
        .replace(/<think>[\s\S]*?<\/think>/g, "")
        .replace(/```json?\n?/g, "")
        .replace(/```/g, "")
        .trim();
      plan = JSON.parse(jsonStr);
    } catch {
      plan = [planReply.content];
    }
    trace.plan = plan;

    // 阶段 2: Execute — 循环执行每个步骤
    const loopTrace = await executeLoop(
      { plan, stepIndex: 0, accumulatedContext: "", stepResults: [] },
      config
    );

    trace.stepResults = loopTrace.state.stepResults;
    trace.totalIterations = loopTrace.iterations;
    trace.totalToolCalls = loopTrace.state.stepResults.reduce(
      (sum, sr) => sum + sr.toolCalls.length, 0
    );
    trace.tokens.input += loopTrace.tokens.input;
    trace.tokens.output += loopTrace.tokens.output;

    // 阶段 3: Join — 汇总最终答案
    const { message: joinReply, usage: joinUsage } = await chat({
      ...config,
      messages: [
        {
          role: "system",
          content: `${sysPrompt}\n\n你是汇总助手。根据各步骤的执行结果，给出最终回答。`,
        },
        {
          role: "user",
          content: `用户原始问题: ${input}\n\n各步骤结果:\n${loopTrace.state.accumulatedContext}`,
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
