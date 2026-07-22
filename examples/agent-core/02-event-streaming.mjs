/**
 * 示例 02: 事件订阅与流式输出
 *
 * 本示例演示 Agent 的事件系统 — 这是构建实时聊天 UI 的核心机制。
 *
 * 事件流（无工具调用时）：
 *   agent_start → turn_start → message_start(user) → message_end(user)
 *                → message_start(assistant) → message_update... → message_end(assistant)
 *                → turn_end → agent_end
 *
 * 事件流（有工具调用时）：
 *   ... → message_end(assistant with toolCall)
 *        → tool_execution_start → tool_execution_end
 *        → message_start/end(toolResult)
 *        → turn_end → turn_start(下一轮) → ... → agent_end
 *
 * 运行方式：
 *   node examples/basic/02-event-streaming.mjs
 */

import { Agent } from "@earendil-works/pi-agent-core";
import { loadModelFromConfig } from "../_shared.mjs";

async function main() {
  const { model, apiKey } = await loadModelFromConfig("minimax", "MiniMax-M2.7");

  const agent = new Agent({
    initialState: {
      systemPrompt: "你是一个简洁的助手，用中文回答。",
      model,
    },
    getApiKey: async () => apiKey,
  });

  // ─── 订阅事件 ─────────────────────────────────────────────────
  // agent.subscribe(callback) 注册事件监听器
  // 返回一个 unsubscribe 函数，用于取消订阅
  //
  // 事件类型一览：
  //   agent_start          — Agent 开始处理
  //   agent_end            — Agent 完全结束（本轮所有工作完成）
  //   turn_start           — 一个新轮次开始（一次 LLM 调用 + 工具执行）
  //   turn_end             — 轮次结束，携带 assistant 消息和工具结果
  //   message_start        — 任何消息开始（user / assistant / toolResult）
  //   message_update       — 仅 assistant，流式增量更新
  //   message_end          — 消息完成
  //   tool_execution_start — 工具开始执行
  //   tool_execution_update — 工具流式进度（如果工具支持）
  //   tool_execution_end   — 工具执行完成
  const unsubscribe = agent.subscribe((event) => {
    switch (event.type) {
      case "agent_start":
        console.log("[agent_start] Agent 开始处理\n");
        break;

      case "turn_start":
        console.log("[turn_start] 新轮次开始");
        break;

      case "message_start": {
        const msg = event.message;
        if (msg.role === "user") {
          console.log(`[message_start] 用户消息`);
        } else if (msg.role === "assistant") {
          console.log(`[message_start] 助手开始回复`);
        } else if (msg.role === "toolResult") {
          console.log(`[message_start] 工具结果消息`);
        }
        break;
      }

      case "message_update": {
        // message_update 仅对 assistant 消息触发
        // event.assistantMessageEvent 包含增量信息
        const ame = event.assistantMessageEvent;

        if (ame.type === "text_delta") {
          // text_delta: 文本增量 — 最常用的事件，用于流式输出
          process.stdout.write(ame.delta);
        } else if (ame.type === "thinking_delta") {
          // thinking_delta: 思考过程增量（需要模型支持 reasoning）
          // process.stdout.write(`[思考] ${ame.delta}`);
        } else if (ame.type === "tool_call_delta") {
          // tool_call_delta: 工具调用参数增量
          // console.log(`[工具调用增量] ${JSON.stringify(ame.delta)}`);
        }
        break;
      }

      case "message_end": {
        const msg = event.message;
        if (msg.role === "assistant") {
          console.log("\n[message_end] 助手回复完成");
          // 消息完成后可以读取 usage 信息
          if (msg.usage) {
            console.log(`  输入: ${msg.usage.input ?? 0} tokens, 输出: ${msg.usage.output ?? 0} tokens`);
          }
        }
        break;
      }

      case "tool_execution_start":
        console.log(`[tool_execution_start] 工具: ${event.toolName}`);
        console.log(`  参数: ${JSON.stringify(event.args).slice(0, 200)}`);
        break;

      case "tool_execution_end": {
        const result = event.result;
        let text = "";
        if (result?.content && Array.isArray(result.content)) {
          text = result.content.filter((c) => c.type === "text").map((c) => c.text).join("");
        }
        console.log(`[tool_execution_end] 工具完成: ${event.toolName}`);
        console.log(`  结果: ${text.slice(0, 200)}`);
        break;
      }

      case "turn_end":
        console.log("[turn_end] 轮次结束");
        break;

      case "agent_end":
        console.log("[agent_end] Agent 完全结束\n");
        break;
    }
  });

  // ─── 发送消息 ─────────────────────────────────────────────────
  console.log("=== 第一轮对话 ===\n");
  await agent.prompt("请用三句话解释什么是闭包。");

  // ─── 查看最终状态 ─────────────────────────────────────────────
  console.log("--- 最终消息历史 ---");
  for (const msg of agent.state.messages) {
    console.log(`  [${msg.role}] ${msg.content?.filter((c) => c.type === "text").map((c) => c.text).join("").slice(0, 60)}`);
  }

  // 清理订阅
  unsubscribe();

  console.log("\n✅ 示例完成！");
}

main().catch(console.error);
