/**
 * 08-harness.mjs — Harness Engineering（测试框架）
 *
 * 既是案例（node 08-harness.mjs 可运行讲解），又是模块（顶层消费者，汇聚全部模块）。
 *
 * Harness = 测试 Agent 行为质量的框架
 *   TestCase  — 输入 + 预期行为
 *   Runner    — 运行 Agent，捕获 trace
 *   Evaluator — 评估 trace（关键词/工具检查/LLM 裁判）
 *   Report    — 量化指标汇总
 *
 * ★ 这是整个模块化架构的顶层消费者 ★
 * 被测 Agent = ReAct agent (05-react.mjs)
 *   <- 04-loop.mjs (createLoop) + 01-prompt.mjs + 02-context.mjs + tools
 * 评估器 LLM 裁判 = llm.mjs
 *
 * 依赖: llm.mjs, 05-react.mjs
 *
 * 导出: evaluators, testCase, runHarness, report
 */

import { config, chat } from "./llm.mjs";
import { createReActAgent, allTools } from "./05-react.mjs";

// ═══════════════════════════════════════════════════════════════
// 模块 API — Evaluator 评估策略集合
// 每个评估器: (trace, ...params) -> { pass, score, detail }
// score ∈ [0, 1]
// ═══════════════════════════════════════════════════════════════

export const evaluators = {
  // 关键词匹配：回复是否包含关键词
  contains: (trace, keywords) => {
    const reply = trace.finalReply || "";
    const missing = keywords.filter((k) => !reply.includes(k));
    return {
      pass: missing.length === 0,
      score: (keywords.length - missing.length) / keywords.length,
      detail: missing.length ? `缺少: ${missing.join(", ")}` : "关键词全部命中",
    };
  },

  // 工具调用检查：是否调用了指定工具
  toolUsed: (trace, toolName) => {
    const calls = trace.toolCalls || [];
    const used = calls.some((tc) => tc.name === toolName);
    return {
      pass: used,
      score: used ? 1 : 0,
      detail: used ? `调用了 ${toolName}` : `未调用 ${toolName}`,
    };
  },

  // 工具结果正确性（检查所有同名工具调用）
  toolResultContains: (trace, toolName, expected) => {
    const calls = trace.toolCalls || [];
    const matching = calls.filter((t) => t.name === toolName);
    if (matching.length === 0) return { pass: false, score: 0, detail: `未调用 ${toolName}` };
    const ok = matching.some((tc) => tc.result.includes(expected));
    return {
      pass: ok,
      score: ok ? 1 : 0,
      detail: ok ? "结果正确" : `结果不包含 "${expected}"`,
    };
  },

  // 行为约束：不应调用工具时是否没调
  noToolUsed: (trace) => {
    const count = (trace.toolCalls || []).length;
    return {
      pass: count === 0,
      score: count === 0 ? 1 : 0,
      detail: count === 0 ? "未调用工具（正确）" : `调用了 ${count} 次（不该调）`,
    };
  },

  // LLM 裁判：让另一个 LLM 打分
  llmJudge: async (trace, criteria, config) => {
    const { message } = await chat({
      ...config,
      messages: [
        { role: "system", content: "你是评估员。给回答打分 1-5 分。只输出数字和简短理由，不要输出思考过程。" },
        { role: "user", content: `评估标准: ${criteria}\n\n被评估回答: ${trace.finalReply}` },
      ],
    });
    // 过滤 think 标签后提取评分
    const cleanContent = message.content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    const score = parseInt(cleanContent.match(/(\d)/)?.[1] || "0");
    return {
      pass: score >= 4,
      score: score / 5,
      detail: `${score}/5 - ${cleanContent.slice(0, 60)}`,
    };
  },
};

// ═══════════════════════════════════════════════════════════════
// 模块 API — TestCase + Runner + Report
// ═══════════════════════════════════════════════════════════════

/** 定义测试用例 */
export function testCase(name, input, expectations) {
  return { name, input, expectations };
}

/**
 * 运行 Harness
 * @param {object} config - LLM 配置
 * @param {array} cases - 测试用例列表
 * @param {function} agentFn - 被测 Agent 函数 (input) -> trace
 * @param {object} options - { verbose: true }
 */
export async function runHarness(config, cases, agentFn, options = {}) {
  const { verbose = true } = options;
  const results = [];

  for (const tc of cases) {
    if (verbose) console.log(`\n  ▸ 测试: ${tc.name}\n    输入: "${tc.input}"`);

    // 1. Runner: 运行被测 Agent
    const trace = await agentFn(tc.input);

    if (verbose) {
      console.log(`    轮次: ${trace.iterations || "?"}, 工具: ${(trace.toolCalls || []).length}, ${trace.durationMs}ms`);
    }

    // 2. Evaluator: 逐个运行评估
    const evals = [];
    for (const exp of tc.expectations) {
      const result = await exp.check(trace, evaluators, config);
      evals.push({ name: exp.name, ...result });
      if (verbose) console.log(`    ${result.pass ? "✅" : "❌"} ${exp.name}: ${result.detail}`);
    }

    // 3. 汇总
    const passed = evals.every((e) => e.pass);
    results.push({
      name: tc.name,
      passed,
      evals,
      metrics: {
        iterations: trace.iterations || 0,
        toolCalls: (trace.toolCalls || []).length,
        tokens: trace.tokens || { input: 0, output: 0 },
        durationMs: trace.durationMs || 0,
        reply: trace.finalReply || "",
      },
    });

    if (verbose) console.log(`    -> ${passed ? "✅ PASS" : "❌ FAIL"}`);
  }

  return results;
}

/** 生成测试报告 */
export function report(results) {
  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const totalTime = results.reduce((s, r) => s + r.metrics.durationMs, 0);
  const totalTokens = results.reduce(
    (s, r) => s + r.metrics.tokens.input + r.metrics.tokens.output, 0
  );

  console.log("\n╔════════════════════════════════════════════════════════════╗");
  console.log("║              Harness 测试报告                              ║");
  console.log("╠════════════════════════════════════════════════════════════╣");
  console.log(`║  通过率: ${passed}/${total} (${Math.round((passed / total) * 100)}%)  耗时: ${totalTime}ms  tokens: ${totalTokens}`);
  console.log("╠════════════════════════════════════════════════════════════╣");

  for (const r of results) {
    const icon = r.passed ? "✅" : "❌";
    const tokens = r.metrics.tokens.input + r.metrics.tokens.output;
    console.log(`║  ${icon} ${r.name.padEnd(30)} ${r.metrics.durationMs}ms / ${tokens} tokens`);
    r.evals.filter((e) => !e.pass).forEach((e) => {
      console.log(`║       └ ${e.name}: ${e.detail.slice(0, 50)}`);
    });
  }

  console.log("╚════════════════════════════════════════════════════════════╝");
}

// ═══════════════════════════════════════════════════════════════
// 演示 — node 08-harness.mjs 运行
// ═══════════════════════════════════════════════════════════════

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║  08 — Harness: 测试和评估 Agent                          ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  console.log("Harness = TestCase + Runner + Evaluator + Report\n");

  const agent = createReActAgent({ config, tools: allTools, maxIterations: 5 });
  const agentUnderTest = (input) => agent.run(input);

  const cases = [
    testCase("计算器测试", "计算 25 * 4 + 10", [
      { name: "调用了 calculator", check: (t, e) => e.toolUsed(t, "calculator") },
      { name: "结果包含 110", check: (t, e) => e.toolResultContains(t, "calculator", "= 110") },
      { name: "回复包含 110", check: (t, e) => e.contains(t, ["110"]) },
    ]),
  ];

  console.log(`共 ${cases.length} 个测试用例，开始运行...\n`);

  const results = await runHarness(config, cases, agentUnderTest);
  report(results);

  console.log("\n速查: testCase(name, input, expectations) + runHarness(config, cases, agentFn)");
  console.log("\n✅ 全部示例完成！");
}

// 直接运行时才执行（被 import 时不运行）
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
