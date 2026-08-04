/**
 * 03-memory.mjs — Memory Engineering（记忆工程）
 *
 * 既是案例（node 03-memory.mjs 可运行讲解），又是模块（可被其他 agent import）。
 *
 * Memory = 把对话存下来，下次会话还能拿出来
 *   短期记忆 = 当前对话的 messages（Context Engineering 管理，进程结束即消失）
 *   长期记忆 = 跨会话持久化的对话历史（写文件，下次启动还能加载回来）
 *
 * 核心能力:
 *   save — 存储：把一个对话回合（role + content）追加到 JSONL 文件
 *   load — 加载：读回全部回合，作为 messages 数组喂给 LLM
 *
 * Memory vs Context:
 *   Context: 管理 LLM 当前这一次调用看到的内容（截断、压缩）
 *   Memory:  跨进程/会话持久化，下次启动把历史对话加载回来
 *
 * 依赖: llm.mjs
 * 导出: createMemoryStore
 */

import { existsSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config, chat } from "./llm.mjs";

// 脚本所在目录：让 memory.jsonl 始终在 03-memory.mjs 旁边，
// 无论从哪个 cwd 运行都写到同一处
const __dirname = dirname(fileURLToPath(import.meta.url));

// ═══════════════════════════════════════════════════════════════
// 模块 API — 记忆存储
// ═══════════════════════════════════════════════════════════════

/**
 * 创建一个记忆存储（本地 JSONL 文件持久化）
 * 每个对话回合以 {"role","content"} 一行存储，追加写入、随时加载。
 * 生产环境可替换为 Redis / 数据库。
 */
export function createMemoryStore(filePath = "./memory.jsonl") {
  // 从 JSONL 读回全部对话回合 → [{role, content}, ...]（可直接作为 messages）
  const load = () => {
    if (!existsSync(filePath)) return [];
    const turns = [];
    for (const line of readFileSync(filePath, "utf-8").split("\n").filter(Boolean)) {
      try {
        turns.push(JSON.parse(line));
      } catch {
        /* 跳过损坏的行 */
      }
    }
    return turns;
  };

  return {
    save(role, content) {
      appendFileSync(filePath, JSON.stringify({ role, content }) + "\n");
      return this;
    },
    load,
    get size() {
      return load().length;
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// 演示 — node 03-memory.mjs 运行
// ═══════════════════════════════════════════════════════════════

async function main() {

  const MEMORY_FILE = join(__dirname, "memory.jsonl");

  // 每次演示重置文件，保证结果一致、可复现（仅演示用；模块本身仍持久化）
  writeFileSync(MEMORY_FILE, "");

  // ─── 第一幕 · 记忆形成（对话 1）──────────────────────────
  // 对话 1：用户自我介绍 → LLM 回复 → 把这一问一答存进 memory.jsonl
  console.log("━ 第一幕 · 记忆形成（对话 1）━━━━━━━━━━━━━━━━━━");
  const store = createMemoryStore(MEMORY_FILE);

  const intro = "我叫小红，是数据科学家，我主要用 Python 做机器学习";

  const { message } = await chat({
    ...config,
    messages: [{ role: "system", content: "你是友好的助手。" }, { role: "user", content: intro }],
  });
  // 去掉模型的思考过程，只保留正式回复
  const reply = message.content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

  // 存原始对话回合
  store.save("user", intro);
  store.save("assistant", reply);

  // ─── 第二幕 · 记忆回忆（对话 2）──────────────────────────
  // 对话 2：全新会话，对话 1 的回合已不在内存里。
  // 用全新 store 只从 memory.jsonl 加载 —— 证明记忆来自文件，而非内存
  console.log("━ 第二幕 · 记忆回忆（对话 2）━━━━━━━━━━━━━━━━━━");
  const store2 = createMemoryStore(MEMORY_FILE);
  const history = store2.load();

  const question = "我叫什么？做什么工作？用什么语言？";
  await chat({
    ...config,
    messages: [
      { role: "system", content: "你是助手。根据已知信息回答。" },
      ...history,
      { role: "user", content: question },
    ],
    onToken: (t) => process.stdout.write(t),
  });
}

// 直接运行时才执行（被 import 时不运行）
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
