/**
 * 示例 01: Agent 基础 — 创建 Agent 并进行单轮对话
 *
 * 本示例演示 @earendil-works/pi-agent-core 最核心的用法：
 *   1. 通过 loadModelFromConfig() 从 ~/.pi/agent/models.json 读取自定义模型配置
 *   2. 创建 Agent 实例（通过 getApiKey 选项注入 API Key）
 *   3. 调用 prompt() 发送消息
 *   4. 读取 Agent 状态中的回复
 *
 * 运行前请先在 ~/.pi/agent/models.json 中配置 provider 和 apiKey。
 *
 * 运行方式：
 *   node examples/basic/01-basic-agent.mjs
 */

import { Agent } from "@earendil-works/pi-agent-core";
import { loadModelFromConfig } from "../_shared.mjs";

async function main() {
  // ─── 1. 获取模型 ──────────────────────────────────────────────
  // loadModelFromConfig() 从 ~/.pi/agent/models.json 读取配置
  // 返回 { model, apiKey } — model 是构造好的 Model 对象，apiKey 是 provider 的密钥
  //
  // 注意：pi-ai 的 getModel() 只读内置模型注册表，不会加载 models.json。
  // 要使用 models.json 里的配置，需用 loadModelFromConfig() 手动构造。
  const { model, apiKey } = await loadModelFromConfig("minimax", "MiniMax-M2.7");
  console.log(model);

  // ─── 2. 创建 Agent ────────────────────────────────────────────
  // Agent 是 pi-agent-core 的核心类
  // initialState 包含 Agent 运行所需的所有初始状态
  // getApiKey: 每次请求前调用，返回 apiKey 供 stream 函数使用
  const agent = new Agent({
    initialState: {
      systemPrompt: "你是一个简洁的助手，用中文回答问题。",
      model,
      // thinkingLevel: "medium",  // 可选: off | minimal | low | medium | high | xhigh
      // tools: [],                // 可选: 初始工具列表（示例 03 会演示）
      // messages: [],             // 可选: 预设消息历史
    },
    getApiKey: async () => apiKey,
  });

  // ─── 3. 发送消息 ──────────────────────────────────────────────
  // prompt() 是最核心的方法 — 发送用户消息，阻塞直到 Agent 完成
  // Agent 会自动处理 LLM 调用、工具执行（如果配置了工具）等
  console.log("用户: 你好！请用一句话介绍你自己。");

  await agent.prompt("你好！请用一句话介绍你自己。");

  // ─── 4. 读取回复 ──────────────────────────────────────────────
  // Agent 完成后，回复存储在 agent.state.messages 中
  // messages 数组包含所有对话历史（user + assistant 消息）
  const messages = agent.state.messages;

  // 找到最后一条 assistant 消息
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  if (lastAssistant) {
    // 检查是否有错误
    if (lastAssistant.errorMessage) {
      console.error("❌ 错误:", lastAssistant.errorMessage);
    }
    // assistant 消息的 content 是一个数组，包含 text / toolCall / thinking 等块
    const textBlocks = lastAssistant.content.filter((c) => c.type === "text");
    const replyText = textBlocks.map((b) => b.text).join("");
    console.log("助手:", replyText);
  }

  // ─── 5. 查看完整消息历史 ──────────────────────────────────────
  console.log("\n--- 消息历史 ---");
  for (const msg of messages) {
    const role = msg.role;
    if (role === "user") {
      const text = typeof msg.content === "string"
        ? msg.content
        : msg.content?.filter((c) => c.type === "text").map((c) => c.text).join("") || "";
      console.log(`  [${role}] ${text.slice(0, 80)}`);
    } else if (role === "assistant") {
      const text = msg.content?.filter((c) => c.type === "text").map((c) => c.text).join("") || "";
      console.log(`  [${role}] ${text.slice(0, 80)}`);
    }
  }

  console.log("\n✅ 示例完成！");
}

main().catch(console.error);
