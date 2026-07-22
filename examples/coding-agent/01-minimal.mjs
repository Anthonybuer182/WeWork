/**
 * 示例 01: 最小可用示例 — 创建会话并单轮对话
 *
 * 本示例演示 @earendil-works/pi-coding-agent SDK 最简用法。
 * 与 agent-core 示例不同，SDK 层的 ModelRuntime 会自动读取
 * ~/.pi/agent/auth.json 和 ~/.pi/agent/models.json，无需手动构造 Model。
 *
 * 运行前：
 *   1. 在 ~/.pi/agent/models.json 配置 provider 与 apiKey（或设环境变量 ANTHROPIC_API_KEY）
 *   2. 确保 @earendil-works/pi-coding-agent 可从本目录解析（见文件末尾说明）
 *
 * 运行方式：
 *   node examples/coding-agent/01-minimal.mjs
 */

import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

async function main() {
  // ─── 1. 创建 ModelRuntime ───────────────────────────────────
  // ModelRuntime 统一管理模型注册表与凭证：
  //   ~/.pi/agent/models.json  → 自定义 provider/模型
  //   ~/.pi/agent/auth.json    → API key / OAuth token
  //   环境变量                  → ANTHROPIC_API_KEY 等回退
  const modelRuntime = await ModelRuntime.create();

  // ─── 2. 创建会话 ─────────────────────────────────────────────
  // SessionManager.inMemory() → 不落盘（无 .jsonl 文件），适合一次性任务/测试
  // 想要持久化用 SessionManager.create(process.cwd())（见 05-sessions）
  const { session } = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
    modelRuntime,
  });

  // ─── 3. 订阅流式文本 ─────────────────────────────────────────
  // message_update 携带 assistantMessageEvent，其中 text_delta 是增量片段
  session.subscribe((event) => {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
  });

  // ─── 4. 发送 prompt ──────────────────────────────────────────
  // prompt() 阻塞直到 Agent 完成（含工具调用与重试）
  console.log("用户: 用一句话介绍你自己。\n助手: ");
  await session.prompt("用一句话介绍你自己。");

  console.log("\n\n✅ 示例完成！");
  session.dispose();
}

main().catch(console.error);
