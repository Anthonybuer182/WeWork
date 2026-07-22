/**
 * 示例 04: 自定义系统提示词 — DefaultResourceLoader
 *
 * createAgentSession 默认用 DefaultResourceLoader 发现 skills/extensions/prompts。
 * 传入自定义 loader 可覆盖 systemPrompt、追加指令、注入 context 文件。
 *
 * 运行方式：
 *   node examples/coding-agent/04-custom-prompt.mjs
 */

import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

async function main() {
  const modelRuntime = await ModelRuntime.create();

  // ─── 1. 自定义 ResourceLoader ─────────────────────────────
  // systemPromptOverride: 完全替换默认系统提示词
  // appendSystemPrompt:   追加到默认提示词之后（更安全的增量定制）
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    systemPromptOverride: () =>
      "你是一个只读代码审查员。绝不修改文件，只读和分析。回答简洁，用中文。",
    appendSystemPrompt: [
      "额外约束：回答必须以「审查结论：」开头。",
    ],
  });
  await loader.reload();

  // ─── 2. 用只读工具子集 + 自定义 loader 创建会话 ───────────
  const { session } = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
    modelRuntime,
    resourceLoader: loader,
    tools: ["read", "grep", "find", "ls"], // 只读模式：不允许 bash/edit/write
  });

  session.subscribe((event) => {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
  });

  await session.prompt("读一下当前目录的 package.json，告诉我这是什么项目。");

  session.dispose();
}

main().catch(console.error);
