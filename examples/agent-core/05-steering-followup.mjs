/**
 * 示例 05: 转向、追加、中断与重试
 *
 * 本示例演示 Agent 的高级控制流：
 *   1. steer()       — 转向：Agent 运行中插入指令，改变方向
 *   2. followUp()    — 追加：Agent 完成后自动执行后续任务
 *   3. abort()       — 中断：停止正在运行的 Agent
 *   4. waitForIdle() — 等待 Agent 完全空闲
 *   5. continue()    — 重试：从当前状态继续（不添加新消息）
 *
 * steer vs followUp 的区别：
 *   steer    — 在当前轮次工具调用完成后、下次 LLM 调用前注入
 *   followUp — 在 Agent 完全结束后注入，触发新一轮处理
 *
 * 运行方式：
 *   node examples/advanced/05-steering-followup.mjs
 */

import { Agent } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { loadModelFromConfig } from "../_shared.mjs";

async function main() {
  const { model, apiKey } = await loadModelFromConfig("minimax", "MiniMax-M2.7");

  // ─── 1. steer() 转向 ─────────────────────────────────────────
  console.log("═══ 1. steer() 转向 ═══\n");
  console.log("steer() 在工具调用间隙插入指令，改变 Agent 方向。\n");

  {
    // 定义一个耗时工具，让 Agent 有"转向"的机会
    const slowTool = {
      name: "slow_task",
      description: "执行一个耗时任务并返回结果",
      parameters: Type.Object({
        task: Type.String({ description: "任务描述" }),
      }),
      execute: async (_id, params) => {
        await new Promise((r) => setTimeout(r, 1000)); // 模拟耗时
        return {
          content: [{ type: "text", text: `任务完成: ${params.task}` }],
        };
      },
    };

    const agent = new Agent({
      initialState: {
        systemPrompt: "你是助手，用中文回答。",
        model,
        tools: [slowTool],
      },
      getApiKey: async () => apiKey,
    });

    agent.subscribe((event) => {
      if (event.type === "tool_execution_start") {
        console.log(`  [工具开始] ${event.toolName}`);
      } else if (event.type === "tool_execution_end") {
        console.log(`  [工具完成] ${event.toolName}`);
      } else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        process.stdout.write(event.assistantMessageEvent.delta);
      }
    });

    // 启动一个会调用工具的任务
    const promptPromise = agent.prompt("请执行 slow_task 工具，任务描述为'处理数据'。");

    // 在工具执行期间发送转向指令
    await new Promise((r) => setTimeout(r, 300));
    console.log("\n  >>> 发送转向指令 <<<");
    agent.steer({
      role: "user",
      content: "完成后请额外说一句'转向成功'。",
      timestamp: Date.now(),
    });

    await promptPromise;
    console.log("\n");
  }

  // ─── 2. followUp() 追加任务 ───────────────────────────────────
  console.log("═══ 2. followUp() 追加任务 ═══\n");
  console.log("followUp() 在 Agent 完成后自动执行后续任务。\n");

  {
    const agent = new Agent({
      initialState: {
        systemPrompt: "你是助手，用中文简洁回答。",
        model,
      },
      getApiKey: async () => apiKey,
    });

    agent.subscribe((event) => {
      if (event.type === "agent_end") {
        console.log("  [agent_end]");
      } else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        process.stdout.write(event.assistantMessageEvent.delta);
      }
    });

    // 排队一个后续任务（在 Agent 完成当前任务后执行）
    agent.followUp({
      role: "user",
      content: "再用英文重复一遍你的回答。",
      timestamp: Date.now(),
    });

    console.log("第一轮: ");
    await agent.prompt("用一句话说'你好'。");
    console.log("\n（followUp 会自动触发第二轮）");

    // 等待 followUp 完成
    await agent.waitForIdle();
    console.log("\n");
  }

  // ─── 3. abort() 中断 ──────────────────────────────────────────
  console.log("═══ 3. abort() 中断 ═══\n");
  console.log("abort() 停止正在运行的 Agent。\n");

  {
    const agent = new Agent({
      initialState: {
        systemPrompt: "你是助手，请写长篇回答。",
        model,
      },
      getApiKey: async () => apiKey,
    });

    agent.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        process.stdout.write(event.assistantMessageEvent.delta);
      } else if (event.type === "agent_end") {
        console.log("\n  [agent_end] Agent 已停止");
      }
    });

    // 启动一个会生成大量文本的任务
    const promptPromise = agent.prompt("请写一篇 1000 字的关于人工智能的文章。").catch((err) => {
      console.log(`\n  [中断] ${err.message}`);
    });

    // 500ms 后中断
    await new Promise((r) => setTimeout(r, 500));
    console.log("\n  >>> 中断 Agent <<<");
    agent.abort();

    await promptPromise;
    console.log(`  消息数: ${agent.state.messages.length}（被中断前的部分）\n`);
  }

  // ─── 4. continue() 重试 ───────────────────────────────────────
  console.log("═══ 4. continue() 重试 ═══\n");
  console.log("continue() 从当前状态继续，不添加新消息。");
  console.log("用于：错误恢复、被中断后重试。\n");

  {
    const agent = new Agent({
      initialState: {
        systemPrompt: "你是助手，用中文回答。",
        model,
      },
      getApiKey: async () => apiKey,
    });

    // 先正常发送一条消息
    await agent.prompt("你好！");
    console.log("第一轮完成。");

    // 模拟：最后一条消息是 user（手动构造错误状态）
    // 正常情况下 continue() 要求最后一条消息是 user 或 toolResult
    // 这里我们手动添加一条 user 消息，然后用 continue() 让 Agent 响应
    agent.state.messages.push({
      role: "user",
      content: "请说'重试成功'。",
      timestamp: Date.now(),
    });

    console.log("调用 continue() 重试...");
    await agent.continue();

    // 打印最后的回复
    const lastMsg = [...agent.state.messages].reverse().find((m) => m.role === "assistant");
    if (lastMsg) {
      const text = lastMsg.content?.filter((c) => c.type === "text").map((c) => c.text).join("") || "";
      console.log(`回复: ${text}\n`);
    }
  }

  // ─── 5. 队列管理 ──────────────────────────────────────────────
  console.log("═══ 5. 队列管理 ═══\n");
  console.log("Agent 维护两个队列：steering 队列和 followUp 队列。\n");
  console.log("  agent.clearSteeringQueue() — 清空转向队列");
  console.log("  agent.clearFollowUpQueue() — 清空追加队列");
  console.log("  agent.clearAllQueues()     — 清空所有队列");
  console.log("  agent.steeringMode = 'one-at-a-time' | 'all'  — 转向模式");
  console.log("  agent.followUpMode  = 'one-at-a-time' | 'all'  — 追加模式");

  console.log("\n✅ 示例完成！");
}

main().catch(console.error);
