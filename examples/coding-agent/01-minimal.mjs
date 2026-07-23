/**
 * 示例 01: 最小可用示例 — 创建会话并单轮对话
 *
 * 本示例演示 @earendil-works/pi-coding-agent SDK 最简用法。
 * 与 agent-core 示例不同，SDK 层会自动读取
 * ~/.pi/agent/auth.json 和 ~/.pi/agent/models.json，无需手动构造 Model。
 * 不传 modelRegistry / authStorage / settingsManager 时，createAgentSession
 * 会从 ~/.pi/agent/ 自动创建。
 *
 * 运行前：
 *   在 ~/.pi/agent/models.json 配置 provider 与 apiKey（或设环境变量 ANTHROPIC_API_KEY）
 *
 * 运行方式：
 *   node examples/coding-agent/01-minimal.mjs
 */

import {
  createAgentSession,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

async function main() {
  // ─── 1. 创建会话 ─────────────────────────────────────────────
  // SessionManager.inMemory() → 不落盘（无 .jsonl 文件），适合一次性任务/测试
  // 想要持久化用 SessionManager.create(process.cwd())（见 05-sessions）
  //
  // createAgentSession 不传 modelRegistry/authStorage 时会自动从
  // ~/.pi/agent/ 读取 models.json + auth.json，并创建 DefaultResourceLoader
  const { session, modelFallbackMessage } = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
  });

  if (modelFallbackMessage) {
    console.log("⚠️ 模型提示:", modelFallbackMessage);
  }

  // ─── 2. 订阅流式文本 ─────────────────────────────────────────
  // message_update 携带 assistantMessageEvent，其中 text_delta 是增量片段
  session.subscribe((event) => {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
  });

  // ─── 3. 发送 prompt ──────────────────────────────────────────
  // prompt() 阻塞直到 Agent 完成（含工具调用与重试）
  console.log("用户: 用一句话介绍你自己。\n助手: ");
  await session.prompt("用一句话介绍你自己。");

  console.log("\n\n✅ 示例完成！");
  session.dispose();
}

main().catch(console.error);
