/**
 * 07-graph.mjs — Graph Engineering（图引擎）
 *
 * 既是案例（node 07-graph.mjs 可运行讲解），又是模块（可被 08 import）。
 *
 * Graph = 节点 (Node) + 边 (Edge) + 状态 (State)
 *   节点: 处理函数 (state, config) -> newState
 *   边:   节点间转移，可带条件 condition(state) -> bool
 *   状态: 在节点间流转的数据
 *
 * 与 ReAct/Plan 的区别:
 *   ReAct/Plan: LLM 隐式控制流程
 *   Graph:     开发者显式定义流程，更可控、可审计
 *
 * 依赖: llm.mjs, 01-prompt.mjs
 * 被依赖: (可被 08-harness.mjs import)
 *
 * 导出: createGraph
 */

import { config, chat } from "./llm.mjs";
import { buildSystemPrompt } from "./01-prompt.mjs";

// ═══════════════════════════════════════════════════════════════
// 模块 API — 图引擎
// ═══════════════════════════════════════════════════════════════

/**
 * 创建一个 Agent Graph
 * @param {string} startNode - 起始节点名
 * @returns {{ addNode, addEdge, run }}
 */
export function createGraph(startNode) {
  const nodes = new Map();
  const edges = new Map();

  return {
    /** 注册节点: fn(state, config) -> newState */
    addNode(name, fn) {
      nodes.set(name, fn);
      return this;
    },

    /** 注册边（可带条件） */
    addEdge(from, to, condition = null) {
      if (!edges.has(from)) edges.set(from, []);
      edges.get(from).push({ to, condition });
      return this;
    },

    /** 设置结束节点 */
    addEnd(name) {
      if (!edges.has(name)) edges.set(name, []);
      edges.get(name).push({ to: "END", condition: null });
      return this;
    },

    /** 运行图: 从 startNode 流转 state，直到 END */
    async run(initialState, config) {
      let state = { ...initialState };
      let current = startNode;
      let steps = 0;
      const trace = [];

      while (current !== "END") {
        steps++;
        if (steps > 30) throw new Error("图执行超过 30 步，可能存在循环");

        // 1. 执行当前节点
        const fn = nodes.get(current);
        if (!fn) throw new Error(`节点 "${current}" 未定义`);
        state = await fn(state, config);
        trace.push({ node: current });

        // 2. 边路由: 找第一个满足条件的出边
        const outEdges = edges.get(current) || [];
        let next = null;
        for (const edge of outEdges) {
          if (!edge.condition || edge.condition(state)) {
            next = edge.to;
            break;
          }
        }
        if (!next) throw new Error(`节点 "${current}" 没有可走的边`);

        console.log(`  [${current}] -> ${next}`);
        current = next;
      }

      return { state, trace, steps };
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// 演示 — node 07-graph.mjs 运行
// ═══════════════════════════════════════════════════════════════

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║  07 — Graph Engineering: 用图定义执行流程                ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  console.log("图: research → draft → review →(PASS)→ END / (FAIL)→ revise → review\n");

  const MAX_REVISE = 2;
  const graph = createGraph("research");

  graph.addNode("research", async (state, cfg) => {
    console.log(`  [research] 调研: ${state.topic}`);
    process.stdout.write("    ");
    const { message } = await chat({
      ...cfg,
      messages: [
        { role: "system", content: buildSystemPrompt({ role: "调研助手", rules: ["简洁回答"] }) },
        { role: "user", content: `列出关于"${state.topic}"的 3 个要点。` },
      ],
      onToken: (t) => process.stdout.write(t),
    });
    console.log();
    return { ...state, research: message.content, reviseCount: 0 };
  });

  graph.addNode("draft", async (state, cfg) => {
    console.log("  [draft] 起草");
    process.stdout.write("    ");
    const { message } = await chat({
      ...cfg,
      messages: [
        { role: "system", content: "你是写作助手。" },
        { role: "user", content: `根据要点写 100 字短文:\n${state.research}` },
      ],
      onToken: (t) => process.stdout.write(t),
    });
    console.log();
    return { ...state, draft: message.content };
  });

  graph.addNode("review", async (state, cfg) => {
    console.log(`  [review] 审查（第 ${state.reviseCount + 1} 次）`);
    const { message } = await chat({
      ...cfg,
      messages: [
        { role: "system", content: "你是审查员。只回答 'PASS' 或 'FAIL'，后接理由。" },
        { role: "user", content: `审查:\n${state.draft}` },
      ],
    });
    const passed = message.content.toUpperCase().startsWith("PASS");
    console.log(`  [review] ${passed ? "PASS" : "FAIL"}`);
    return { ...state, reviewPassed: passed, reviewComment: message.content };
  });

  graph.addNode("revise", async (state, cfg) => {
    console.log(`  [revise] 修改（第 ${state.reviseCount + 1} 次）`);
    process.stdout.write("    ");
    const { message } = await chat({
      ...cfg,
      messages: [
        { role: "system", content: "你是写作助手。" },
        { role: "user", content: `根据意见修改:\n${state.reviewComment}\n\n原文:\n${state.draft}` },
      ],
      onToken: (t) => process.stdout.write(t),
    });
    console.log();
    return { ...state, draft: message.content, reviseCount: state.reviseCount + 1 };
  });

  graph.addEdge("research", "draft");
  graph.addEdge("draft", "review");
  graph.addEdge("review", "END", (s) => s.reviewPassed);
  graph.addEdge("review", "revise", (s) => !s.reviewPassed && s.reviseCount < MAX_REVISE);
  graph.addEdge("review", "END", (s) => !s.reviewPassed && s.reviseCount >= MAX_REVISE);
  graph.addEdge("revise", "review");

  console.log("开始执行图...\n");
  const { state, steps } = await graph.run({ topic: "人工智能对教育的影响" }, config);

  console.log(`\n  总步数: ${steps}, 修改次数: ${state.reviseCount}`);
  console.log("\n速查: createGraph(start).addNode().addEdge().run(initialState, config)");
  console.log("\n✅ 完成 — 下一步: 08-harness.mjs");
}

main().catch(console.error);
