/**
 * 示例 06: 工具控制 — 只读模式与排除特定工具
 *
 * 内置工具：read, bash, edit, write, grep, find, ls
 *   tools        → 白名单（只启用列出的工具）
 *   excludeTools → 黑名单（禁用指定工具，其余保留）
 *   noTools      → "all" 全禁 / "builtin" 只禁内置（保留扩展工具）
 *
 * 运行方式：
 *   node examples/coding-agent/06-read-only.mjs
 */

import {
  createAgentSession,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

async function main() {
  // ─── 只读模式：仅启用 read/grep/find/ls，禁止任何写操作 ───
  const { session } = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
    tools: ["read", "grep", "find", "ls"],
    // 等价写法：不给 tools，改用 excludeTools: ["bash", "edit", "write"]
  });

  let toolCalled = false;
  session.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      toolCalled = true;
      const a = event.args ?? {};
      const target = a.path ?? a.pattern ?? a.command ?? a.cwd ?? "";
      console.log(`🔧 使用工具: ${event.toolName}${target ? ` → ${target}` : ""}`);
    }
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
  });

  // 让 Agent 尝试操作文件，观察它只会读取、不会写入
  console.log("用户: 查看当前目录结构并说明这是什么项目。\n");
  await session.prompt("查看当前目录结构并说明这是什么项目。");

  console.log(`\n\n是否调用了工具: ${toolCalled}`);

  // ─── 查看 Agent 当前可用工具列表 ───────────────────────────
  // session.getAllTools() 返回所有已注册工具
  // session.state.tools 返回当前启用的工具（来自 pi-agent-core Agent state）
  const allTools = session.getAllTools();
  console.log(`所有已注册工具: ${allTools.map((t) => t.name).join(", ")}`);

  const activeTools = session.state.tools;
  console.log(`当前启用工具: ${activeTools.map((t) => t.name).join(", ")}`);

  session.dispose();
}

main().catch(console.error);
