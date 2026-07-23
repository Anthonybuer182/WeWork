/**
 * 示例 02: 事件流详解 — 文本 / 思考 / 工具 / 轮次 / 队列
 *
 * AgentSession 的事件系统是构建实时 UI 与可观测性的核心。
 * 本示例让 Agent 调用内置工具（如 read/ls），从而触发完整事件链：
 *   agent_start → turn_start → message_start(user) → message_end(user)
 *     → message_start(assistant) → message_update(text_delta / thinking_delta)
 *     → tool_execution_start → tool_execution_end
 *     → message_end(assistant) → turn_end → ... → agent_end
 *
 * 运行方式：
 *   node examples/coding-agent/02-event-streaming.mjs
 */

import {
  createAgentSession,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

async function main() {
  const { session } = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
  });

  // ─── 订阅全部感兴趣的事件 ───────────────────────────────────
  session.subscribe((event) => {
    switch (event.type) {
      // 流式文本增量
      case "message_update": {
        const e = event.assistantMessageEvent;
        if (e.type === "text_delta") {
          process.stdout.write(e.delta);
        }
        break;
      }
      // 工具开始
      case "tool_execution_start":
        console.log(`\n🔧 工具开始: ${event.toolName}`);
        break;
      // 工具结束
      case "tool_execution_end":
        console.log(`✅ 工具结束: ${event.toolName} ${event.isError ? "(出错)" : "(成功)"}`);
        break;
      // 一轮结束（一次 LLM 调用 + 其工具调用）
      case "turn_end":
        console.log(`── 轮次结束，工具结果数: ${event.toolResults?.length ?? 0}`);
        break;
      // 队列变化（steer/followUp 排队）
      case "queue_update":
        console.log(`📬 队列: steer=${event.steering?.length ?? 0}, followUp=${event.followUp?.length ?? 0}`);
        break;
      // Agent 彻底结束（willRetry=true 表示会自动重试）
      case "agent_end":
        console.log(`🏁 Agent 结束 (willRetry=${event.willRetry})`);
        break;
    }
  });

  // 让 Agent 用工具列目录，触发完整事件链
  console.log("用户: 列出当前目录有哪些文件。\n");
  await session.prompt("列出当前目录有哪些文件，用一句话总结。");

  // ─── 读取最终状态 ───────────────────────────────────────────
  // session.messages 是完整 AgentMessage[]（含 user/assistant/toolResult）
  console.log(`\n消息总数: ${session.messages.length}`);
  console.log(`是否流式中: ${session.isStreaming}`);

  session.dispose();
}

main().catch(console.error);
