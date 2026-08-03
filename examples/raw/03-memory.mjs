/**
 * 03-memory.mjs — Memory Engineering（记忆工程）
 *
 * 既是案例（node 03-memory.mjs 可运行讲解），又是模块（可被其他 agent import）。
 *
 * Memory = 存储 + 检索 + 注入 + 固化
 *   短期记忆 = 当前对话的 messages（Context Engineering 管理）
 *   长期记忆 = 跨会话持久化的事实存储
 *
 * 核心能力:
 *   save     — 存储：将关键事实存入记忆库
 *   recall   — 检索：根据当前输入找到相关记忆
 *   inject   — 注入：把记忆注入 system prompt（用 02-context 的 injectKnowledge）
 *   memorize — 固化：用 LLM 从对话中提取并存储事实
 *
 * Memory vs Context:
 *   Context: 管理 LLM 当前看到的内容（截断、压缩）
 *   Memory:  跨会话持久化信息（存储、检索、注入）
 *
 * 依赖: llm.mjs, 02-context.mjs
 * 被依赖: (可被任何 agent import 使用记忆能力)
 *
 * 导出: createMemoryStore, saveFact, recallFacts, recallToContext, memorize
 */

import { config, chat } from "./llm.mjs";
import { injectKnowledge } from "./02-context.mjs";

// ═══════════════════════════════════════════════════════════════
// 模块 API — 记忆存储
// ═══════════════════════════════════════════════════════════════

/**
 * 创建一个记忆存储（内存 Map 实现）
 * 生产环境可替换为 Redis / 向量数据库
 */
export function createMemoryStore() {
  const store = new Map();

  return {
    /** 保存一条记忆 */
    save(key, value) {
      store.set(key, value);
      return this;
    },

    /** 获取一条记忆 */
    get(key) {
      return store.get(key);
    },

    /** 获取所有记忆 */
    all() {
      return Object.fromEntries(store);
    },

    /** 记忆数量 */
    get size() {
      return store.size;
    },

    /**
     * 检索：根据 query 关键词匹配相关记忆
     * 生产环境可替换为向量相似度搜索
     */
    recall(query) {
      const results = [];
      const queryLower = query.toLowerCase();

      for (const [key, value] of store) {
        const keyLower = key.toLowerCase();
        const keywords = keyLower.split(/[\s,，、]+/).filter((w) => w.length > 1);
        const hit =
          queryLower.includes(keyLower) ||
          keywords.some((w) => queryLower.includes(w)) ||
          String(value).toLowerCase().includes(queryLower.slice(0, 4));

        if (hit) {
          results.push({ key, value });
        }
      }
      return results;
    },
  };
}

/** 快捷方法：保存一条事实 */
export function saveFact(store, key, value) {
  store.save(key, value);
  return store;
}

/** 快捷方法：检索相关记忆 */
export function recallFacts(store, query) {
  return store.recall(query);
}

/** 把检索到的记忆注入 system prompt（RAG 模式） */
export function recallToContext(store, systemPrompt, query) {
  const facts = store.recall(query);
  if (facts.length === 0) return systemPrompt;
  const knowledge = facts.map((f) => `${f.key}: ${f.value}`).join("\n");
  return injectKnowledge(systemPrompt, knowledge);
}

/**
 * 记忆固化：从对话中提取关键事实并存储
 * @param {object} config - LLM 配置
 * @param {object} store - 记忆存储
 * @param {array} messages - 对话历史
 * @returns {Promise<object>} 提取的事实
 */
export async function memorize(config, store, messages) {
  const { message } = await chat({
    ...config,
    messages: [
      {
        role: "system",
        content:
          '从对话中提取关键事实（用户偏好、重要信息、决策等），输出 JSON 对象 {"key": "value"}。只提取事实，不要臆测。',
      },
      {
        role: "user",
        content: messages
          .filter((m) => m.role !== "system")
          .map((m) => `[${m.role}] ${m.content}`)
          .join("\n"),
      },
    ],
  });

  let facts = {};
  try {
    const jsonStr = message.content
      .replace(/```json?\n?/g, "")
      .replace(/```/g, "")
      .trim();
    facts = JSON.parse(jsonStr);
  } catch {
    facts = { summary: message.content.slice(0, 100) };
  }

  for (const [k, v] of Object.entries(facts)) {
    store.save(k, String(v));
  }

  return facts;
}

// ═══════════════════════════════════════════════════════════════
// 演示 — node 03-memory.mjs 运行
// ═══════════════════════════════════════════════════════════════

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║  03 — Memory Engineering                                ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  // 1. 创建记忆存储 + 手动存入事实
  console.log("═══ 1. 记忆存储 ═══\n");
  const store = createMemoryStore();
  saveFact(store, "用户姓名", "小明");
  saveFact(store, "用户职业", "前端工程师");
  saveFact(store, "用户城市", "上海");
  saveFact(store, "Pi Agent定价", "社区版免费, 专业版 $20/月");

  console.log(`  已存储 ${store.size} 条记忆:`);
  for (const [k, v] of Object.entries(store.all())) {
    console.log(`    ${k} -> ${v}`);
  }
  console.log();

  // 2. 记忆检索
  console.log("═══ 2. 记忆检索 ═══\n");
  const query1 = "我住哪个城市？";
  const results1 = recallFacts(store, query1);
  console.log(`  查询: "${query1}"`);
  console.log(`  命中: ${results1.map((r) => r.key).join(", ") || "无"}\n`);

  const query2 = "Pi Agent 多少钱？";
  const results2 = recallFacts(store, query2);
  console.log(`  查询: "${query2}"`);
  console.log(`  命中: ${results2.map((r) => r.key).join(", ") || "无"}\n`);

  // 3. 记忆注入 — 把记忆注入到新的对话中
  console.log("═══ 3. 记忆注入 (RAG) ═══\n");
  const basePrompt = "你是助手。根据已知信息回答。";
  const enrichedPrompt = recallToContext(store, basePrompt, "我叫什么名字？住哪里？");
  console.log(`  原始 prompt: ${basePrompt}`);
  console.log(`  注入后 prompt:\n${enrichedPrompt.slice(0, 120)}...\n`);

  // 对比：有记忆 vs 无记忆
  const testInput = "我叫什么名字？住哪里？";
  process.stdout.write("  ");
  const { message: noMemory } = await chat({
    ...config,
    messages: [
      { role: "system", content: basePrompt },
      { role: "user", content: testInput },
    ],
    onToken: (t) => process.stdout.write(t),
  });
  console.log("\n");

  process.stdout.write("  ");
  const { message: withMemory } = await chat({
    ...config,
    messages: [
      { role: "system", content: enrichedPrompt },
      { role: "user", content: testInput },
    ],
    onToken: (t) => process.stdout.write(t),
  });
  console.log("\n");

  // 4. 记忆固化 — 从对话中提取事实
  console.log("═══ 4. 记忆固化 ═══\n");
  const conversation = [
    { role: "user", content: "我叫小红，是数据科学家" },
    { role: "assistant", content: "你好小红！数据科学是个很好的领域。" },
    { role: "user", content: "我主要用 Python 做机器学习" },
    { role: "assistant", content: "Python 是数据科学的标准工具。" },
  ];

  console.log("  从对话中提取记忆...");
  const facts = await memorize(config, store, conversation);
  console.log(`  提取到 ${Object.keys(facts).length} 条:`);
  for (const [k, v] of Object.entries(facts)) {
    console.log(`    ${k} -> ${v}`);
  }
  console.log(`  记忆库现有 ${store.size} 条\n`);

  console.log("═══ Memory vs Context ═══\n");
  console.log("  Context: 管理 LLM 当前看到的内容（截断、压缩）");
  console.log("  Memory:  跨会话持久化信息（存储、检索、注入）");
  console.log("  Memory 的 recallToContext 用 Context 的 injectKnowledge 实现。\n");

  console.log("速查: createMemoryStore / saveFact / recallFacts / recallToContext / memorize");
  console.log("\n✅ 完成 — 下一步: 04-loop.mjs");
}

main().catch(console.error);
