/**
 * llm.mjs — 原生 LLM 调用工具（不依赖任何第三方框架）
 *
 * 用 Node.js 内置的 fetch 直接调用 OpenAI 兼容的 Chat Completions API。
 * 配置直接在文件内定义，无需外部配置文件。
 *
 * 核心概念：
 *   LLM API 本质上就是一个 HTTP POST 请求：
 *   - 发送 messages（对话历史）+ tools（工具定义）
 *   - 返回 assistant 消息（可能包含 tool_calls）
 *
 * 支持流式输出：传入 onToken 回调即可逐 token 接收文本。
 *
 * 没有魔法，就是 HTTP 请求。
 */

// ─── 配置（直接在此设置，无需外部配置文件）────────────────────

export const config = {
  baseUrl: "https://api.minimaxi.com/v1",
  apiKey: "",
  model: "MiniMax-M2.7",
};

// ─── 原生 LLM 调用 ─────────────────────────────────────────────
//
// 非流式: chat({ baseUrl, apiKey, model, messages, tools })
//   -> { message, finishReason, usage }
//
// 流式:   chat({ ..., onToken: (text) => void })
//   -> 同样的返回值，但 onToken 会逐块回调文本
//
// 流式原理: 请求体加 stream: true，响应变成 SSE 格式
//   data: {"choices":[{"delta":{"content":"你"}}]}
//   data: {"choices":[{"delta":{"content":"好"}}]}
//   data: [DONE]
//   每个 chunk 的 delta.content 是一小段文本，拼接起来就是完整回复

export async function chat({ baseUrl, apiKey, model, messages, tools, onToken }) {
  const url = `${baseUrl}/chat/completions`;

  const body = { model, messages };
  if (tools && tools.length > 0) {
    body.tools = tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  // ── 流式模式：onToken 回调存在时启用 ──
  if (onToken) {
    body.stream = true;
    body.stream_options = { include_usage: true };

    console.log("\n━━━ Request ━━━━━━━━━━━━━━━━");
    console.log(JSON.stringify(body, null, 2));

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`LLM API 错误 ${res.status}: ${text}`);
    }

    // 解析 SSE 流：逐行读取 data: 行，提取 delta
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let toolCalls = [];
    let finishReason = null;
    let usage = null;

    console.log("\n━━━ Response (streaming) ━━━━━━━━━");
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // 按换行分割，处理完整的行
      const lines = buffer.split("\n");
      buffer = lines.pop(); // 保留最后不完整的行

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") continue;

        const chunk = JSON.parse(data);
        const choice = chunk.choices?.[0];
        const delta = choice?.delta;

        // 文本片段 → 拼接 + 回调
        if (delta?.content) {
          content += delta.content;
          onToken(delta.content);
        }

        // 工具调用片段 → 按 index 拼接
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCalls[idx]) {
              toolCalls[idx] = {
                id: tc.id || "",
                type: "function",
                function: { name: "", arguments: "" },
              };
            }
            if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
            if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
            if (tc.id) toolCalls[idx].id = tc.id;
          }
        }

        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (chunk.usage) usage = chunk.usage;
      }
    }

    const result = {
      message: {
        role: "assistant",
        content,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
      finishReason: finishReason || "stop",
      usage,
    };
    // 流式模式下 content 已由 onToken 实时输出，这里只记录响应元数据
    console.log("\n━━━ Response metadata ━━━━━━━━━━━━");
    console.log(JSON.stringify({ finishReason: result.finishReason, usage: result.usage, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) }, null, 2));
    return result;
  }

  // ── 非流式模式（原逻辑）──
  console.log("\n━━━ Request ━━━━━━━━━━━━━━━━");
  console.log(JSON.stringify(body, null, 2));

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM API 错误 ${res.status}: ${text}`);
  }

  const data = await res.json();
  const choice = data.choices[0];

  const result = {
    message: choice.message,    // {role: "assistant", content, tool_calls?}
    finishReason: choice.finish_reason, // "stop" | "tool_calls"
    usage: data.usage,          // {prompt_tokens, completion_tokens, total_tokens}
  };
  console.log("\n━━━ Response ━━━━━━━━━━━━━━━");
  console.log(JSON.stringify(result, null, 2));
  return result;
}
