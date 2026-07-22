/**
 * 示例 04: 状态管理与多轮对话
 *
 * 本示例演示 Agent 的状态管理：
 *   1. agent.state — 读写 Agent 的运行时状态
 *   2. 多轮对话 — Agent 自动维护对话历史
 *   3. 动态修改状态 — 运行中切换模型、系统提示词、思考等级
 *   4. reset() — 重置 Agent 状态
 *   5. 切换模型 & 图片输入 — 切换到视觉模型并传入图片
 *
 * AgentState 包含：
 *   systemPrompt  — 系统提示词
 *   model         — 当前模型
 *   thinkingLevel — 思考等级 (off | minimal | low | medium | high | xhigh)
 *   tools         — 工具列表
 *   messages      — 对话历史
 *   isStreaming    — 是否正在流式输出（只读）
 *   streamingMessage — 当前流式消息（只读）
 *
 * 运行方式：
 *   node examples/basic/04-state-management.mjs
 */

import { Agent } from "@earendil-works/pi-agent-core";
import { loadModelFromConfig } from "../_shared.mjs";

async function main() {
  const { model, apiKey } = await loadModelFromConfig("minimax", "MiniMax-M2.7");

  // ─── 1. 创建 Agent ────────────────────────────────────────────
  const agent = new Agent({
    initialState: {
      systemPrompt: "你是一个编程助手，用中文简洁回答。",
      model,
      thinkingLevel: "off", // 初始不开启思考
    },
    getApiKey: async () => apiKey,
  });

  // 简单的流式输出
  const unsubscribe = agent.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
  });

  // ─── 2. 多轮对话 ──────────────────────────────────────────────
  // Agent 自动维护 messages 数组，多轮对话只需连续调用 prompt()
  console.log("=== 第一轮 ===");
  console.log("用户: 我叫小明，我最喜欢的语言是 Rust。");
  await agent.prompt("我叫小明，我最喜欢的语言是 Rust。");
  console.log("\n");

  console.log("=== 第二轮 ===");
  console.log("用户: 我叫什么名字？");
  await agent.prompt("我叫什么名字？");
  console.log("\n");

  console.log("=== 第三轮 ===");
  console.log("用户: 我最喜欢的编程语言是什么？");
  await agent.prompt("我最喜欢的编程语言是什么？");
  console.log("\n");

  // ─── 3. 查看状态 ──────────────────────────────────────────────
  console.log("--- 当前 Agent 状态 ---");
  console.log(`  模型: ${agent.state.model?.provider}/${agent.state.model?.id}`);
  console.log(`  系统提示词: ${agent.state.systemPrompt.slice(0, 50)}...`);
  console.log(`  思考等级: ${agent.state.thinkingLevel}`);
  console.log(`  消息数量: ${agent.state.messages.length}`);
  console.log(`  正在流式: ${agent.state.isStreaming}`);

  // ─── 4. 动态修改状态 ──────────────────────────────────────────
  console.log("\n=== 修改状态后继续对话 ===\n");

  // 切换系统提示词
  agent.state.systemPrompt = "你是一个助手，每次回答前加上领导称呼我，例如：领导：回复答案";
  // 切换思考等级（需要模型支持 reasoning）
  agent.state.thinkingLevel = "medium";

  console.log("用户: 用一句话介绍 Rust。");
  await agent.prompt("用一句话介绍 Rust。");
  console.log("\n");

  // ─── 5. 切换模型 & 图片输入 ─────────────────────────────────────
  // 同 provider 下可直接 agent.state.model 切换模型，对话历史自动保留
  // （跨 provider 切换时 apiKey 不同，需用闭包变量管理或重建 Agent）
  // 切换到视觉模型后，还可以用 prompt() 的第二个参数传入图片
  // 支持视觉的模型: MiniMax-M3, Claude 3.5 Sonnet, GPT-4o, Gemini, Qwen-VL 等
  console.log("=== 切换模型 & 图片输入 ===\n");
  const redPixelBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

  try {
    const { model: vlmModel } = await loadModelFromConfig("minimax", "MiniMax-M3");
    agent.state.model = vlmModel;
    console.log(`已切换到: ${vlmModel.provider}/${vlmModel.id}`);

    console.log("用户: 你是什么模型？");
    await agent.prompt("你是什么模型？");
    console.log("\n");

    // prompt() 的第二个参数是图片数组，支持 base64 图片输入
    console.log("用户: [发送了一张图片] 这张图片是什么颜色的？");
    await agent.prompt("这张图片是什么颜色的？", [
      {
        type: "image",
        data: redPixelBase64,
        mimeType: "image/png",
      },
    ]);
    console.log("\n");
  } catch (err) {
    console.log(`（跳过模型切换 & 图片输入演示：${err.message}）\n`);
  }

  // ─── 6. reset() 重置 ──────────────────────────────────────────
  console.log("=== reset() 重置 Agent ===\n");
  console.log(`重置前消息数: ${agent.state.messages.length}`);
  agent.reset();
  console.log(`重置后消息数: ${agent.state.messages.length}`);
  console.log("（系统提示词和模型保留，消息历史清空）");

  // ─── 7. 消息历史结构 ──────────────────────────────────────────
  console.log("\n--- 消息历史结构说明 ---");
  console.log("agent.state.messages 是 AgentMessage[] 数组");
  console.log("每条消息的 role 可能是: user | assistant | toolResult");
  console.log("assistant 消息的 content 是数组，可包含: text | toolCall | thinking 块");
  console.log("toolResult 消息的 content 是数组，包含工具执行结果");

  unsubscribe();
  console.log("\n✅ 示例完成！");
}

main().catch(console.error);
