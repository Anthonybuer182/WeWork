/**
 * 示例 03: 自定义工具 — 让 Agent 执行实际操作
 *
 * 本示例演示 AgentTool 的定义与使用，这是 Agent 能"动手做事"的关键。
 *
 * AgentTool 的核心字段：
 *   name        — 工具名称（LLM 通过此名称调用工具）
 *   description — 工具描述（LLM 据此决定是否使用该工具）
 *   parameters  — 参数 schema（用 TypeBox 定义，自动校验）
 *   execute     — 执行函数，返回工具结果
 *
 * 工具执行模式：
 *   parallel   — 多个工具并发执行（默认）
 *   sequential — 逐个执行
 *
 * 运行方式：
 *   node examples/basic/03-custom-tools.mjs
 */

import { Agent } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { loadModelFromConfig } from "../_shared.mjs";
import { readFileSync, writeFileSync } from "fs";

async function main() {
  const { model, apiKey } = await loadModelFromConfig("minimax", "MiniMax-M2.7");

  // ─── 1. 定义工具 ──────────────────────────────────────────────
  // TypeBox 的 Type.Object() 定义参数 schema
  // Agent 会自动校验 LLM 生成的参数，校验通过后才调用 execute

  // 工具 A: 读取文件
  const readFileTool = {
    name: "read_file",
    description: "读取指定文件的内容。参数为文件路径。",
    parameters: Type.Object({
      path: Type.String({ description: "要读取的文件路径（相对路径或绝对路径）" }),
    }),
    execute: async (_toolCallId, params) => {
      const content = readFileSync(params.path, "utf-8");
      return {
        content: [{ type: "text", text: content }],
        details: { path: params.path, size: content.length },
      };
    },
  };

  // 工具 B: 写入文件
  const writeFileTool = {
    name: "write_file",
    description: "将内容写入指定文件。如果文件已存在则覆盖。",
    parameters: Type.Object({
      path: Type.String({ description: "要写入的文件路径" }),
      content: Type.String({ description: "要写入的文件内容" }),
    }),
    execute: async (_toolCallId, params) => {
      writeFileSync(params.path, params.content, "utf-8");
      return {
        content: [{ type: "text", text: `文件已写入: ${params.path} (${params.content.length} 字符)` }],
        details: { path: params.path },
      };
    },
  };

  // ─── 2. 创建 Agent ────────────────────────────────────────────
  const agent = new Agent({
    initialState: {
      systemPrompt: "你是一个文件操作助手。当用户请求文件操作时，请使用提供的工具完成任务。用中文回答。",
      model,
      tools: [readFileTool, writeFileTool],
    },
    getApiKey: async () => apiKey,
    // toolExecution: "sequential", // 可选: "parallel" (默认) 或 "sequential"
  });

  // ─── 3. 订阅事件（只关注工具执行）────────────────────────────
  const unsubscribe = agent.subscribe((event) => {
    switch (event.type) {
      case "tool_execution_start":
        console.log(`  [工具开始] ${event.toolName}(${JSON.stringify(event.args).slice(0, 100)})`);
        break;
      case "tool_execution_end": {
        const result = event.result;
        const text = result?.content
          ?.filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("")
          .slice(0, 150) || "";
        console.log(`  [工具完成] ${event.toolName}: ${text}`);
        break;
      }
      case "message_update":
        if (event.assistantMessageEvent.type === "text_delta") {
          process.stdout.write(event.assistantMessageEvent.delta);
        }
        break;
    }
  });

  // ─── 4. 让 Agent 执行任务 ─────────────────────────────────────
  console.log("=== 任务: 写入文件并读出内容 ===\n");
  await agent.prompt("请创建一个 hello.txt 文件，内容写上「你好，世界！」，然后再读取这个文件的内容给我看。");
  unsubscribe();
  console.log("\n✅ 示例完成！");
}

main().catch(console.error);
