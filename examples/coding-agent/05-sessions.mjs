/**
 * 示例 05: 会话持久化与恢复 — SessionManager
 *
 * 与 inMemory 不同，SessionManager.create(cwd) 会把对话落盘为
 * ~/.pi/agent/sessions/<encoded-cwd>/<id>.jsonl，重启后可恢复。
 *
 * 本示例流程：
 *   1. 在临时目录创建持久化会话，记住一个数字
 *   2. 列出该 cwd 的所有会话
 *   3. 从列表里挑出刚才那个会话，用 SessionManager.open 恢复并验证记忆
 *
 * 运行方式：
 *   node examples/coding-agent/05-sessions.mjs
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

async function main() {
  const cwd = mkdtempSync(join(tmpdir(), "pi-session-demo-"));
  console.log(`工作目录: ${cwd}\n`);

  // ─── 1. 创建持久化会话，让它记住一个数字 ───────────────────
  console.log("── 第一段：创建会话 ──────────────────");
  const sm1 = SessionManager.create(cwd);
  const { session: s1 } = await createAgentSession({
    cwd,
    sessionManager: sm1,
  });
  s1.subscribe((event) => {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
  });
  await s1.prompt("请记住数字 42，只回复 OK。");
  console.log(`\n会话文件: ${s1.sessionFile}`);
  s1.dispose();

  // ─── 2. 列出该 cwd 的会话 ─────────────────────────────────
  const sessions = await SessionManager.list(cwd);
  console.log(`\n该目录的会话数: ${sessions.length}`);
  for (const s of sessions) {
    console.log(`  - ${s.name ?? "(未命名)"} | 消息数=${s.messageCount} | ${s.modified.toISOString()}`);
  }

  // ─── 3. 从列表里找到指定会话，恢复并验证记忆 ─────────────
  console.log("\n── 第二段：恢复指定会话 ──────────────");
  const target = sessions.find((s) => s.path === s1.sessionFile);
  if (!target) throw new Error("没找到刚才创建的会话");
  console.log(`找到会话: ${target.name ?? "(未命名)"} | ${target.path}`);

  const { session: s2, modelFallbackMessage } = await createAgentSession({
    cwd,
    sessionManager: SessionManager.open(target.path),
  });
  if (modelFallbackMessage) console.log(`提示: ${modelFallbackMessage}`);
  s2.subscribe((event) => {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
  });
  await s2.prompt("我之前让你记住的数字是多少？");
  s2.dispose();

  console.log("\n\n✅ 会话持久化验证完成！");
}

main().catch(console.error);
