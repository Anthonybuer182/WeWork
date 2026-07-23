/**
 * 示例 03: 自定义工具 — 用 defineTool 让 Agent 调用你自己的逻辑
 *
 * pi-coding-agent 内置 read/bash/edit/write/grep/find/ls 工具。
 * 通过 customTools 可注入任意自定义工具，LLM 会按需调用。
 *
 * 运行方式：
 *   node examples/coding-agent/03-custom-tools.mjs
 */

import { Type } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  defineTool,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

async function main() {
  // ─── 1. 定义自定义工具 ─────────────────────────────────────
  // defineTool() 的 parameters 用 TypeBox schema，SDK 自动校验 LLM 生成参数
  const uptimeTool = defineTool({
    name: "get_uptime",
    label: "Uptime",
    description: "返回当前进程已运行秒数，不需要参数。",
    parameters: Type.Object({}),
    execute: async () => ({
      content: [
        { type: "text", text: `进程已运行 ${process.uptime().toFixed(1)} 秒` },
      ],
      details: { uptime: process.uptime() },
    }),
  });

  const echoTool = defineTool({
    name: "echo",
    label: "Echo",
    description: "原样返回传入的文本。",
    parameters: Type.Object({
      text: Type.String({ description: "要回显的内容" }),
    }),
    execute: async (_toolCallId, params) => ({
      content: [{ type: "text", text: `echo: ${params.text}` }],
      details: {},
    }),
  });

  // ─── 2. 注入自定义工具 ─────────────────────────────────────
  // customTools 与内置工具合并；如需限制可用工具，用 tools 白名单
  const { session } = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
    customTools: [uptimeTool, echoTool],
    // tools: ["read", "bash", "get_uptime"],  // 白名单（含自定义工具名）
  });

  session.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      console.log(`🔧 调用工具: ${event.toolName}`);
    }
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
  });

  // ─── 3. 让 Agent 调用自定义工具 ─────────────────────────────
  await session.prompt("请先用 get_uptime 查运行时间，再用 echo 回显 'hello pi'，最后总结。");

  session.dispose();
}

main().catch(console.error);
