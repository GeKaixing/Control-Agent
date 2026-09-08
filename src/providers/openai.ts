/**
 * OpenAI Chat Completions 适配器。
 * 只做「翻译」：统一消息 → OpenAI 请求，SSE 增量 → 统一流式事件。
 */

import type { ModelRef, StopReason, ThinkingLevel } from "../types.js";
import { StreamAccumulator, StreamError, parseSse } from "./stream.js";
import type { JsonSchema, LlmMessage, LlmTool, StreamFn } from "./types.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/**
 * 401/403 且没有有效 key 时附中文指引。apiKey="EMPTY" 是桌面端「自定义模型」
 * 弹层留空 key 的占位约定（本地端点如 ollama 场景），远程端点收到必然拒——
 * 把「为什么 401」直接告诉用户，而不是让他对着一屏端点英文 JSON 猜。
 */
function missingKeyHint(model: ModelRef): string {
  const key = model.apiKey ?? "";
  if (key.length > 0 && key !== "EMPTY") return "";
  return "\n\n↳ 当前模型没有配置 API KEY：打开「自定义模型」补填后重试（仅本地端点如 ollama 可留空）";
}

/**
 * 协议错配识别：openai 适配器发出的请求，响应体却是 Anthropic 协议专属信封
 * （{"type":"error","error":{...}}，OpenAI 家族的错误体是 {"error":{...}}，
 * 没有顶层 type 字段）——说明 baseUrl 指向 Anthropic 协议上游但协议留了默认
 * openai（POST /chat/completions 打到没有该路由的端点，很多中继回 500 而非 404）。
 * 全量 detail 才解析（展示仍截断），解析失败一律不提示，避免误伤。
 */
function protocolMismatchHint(detail: string): string {
  try {
    const parsed = JSON.parse(detail) as { type?: unknown; error?: unknown };
    if (parsed?.type === "error" && typeof parsed.error === "object" && parsed.error !== null) {
      return "\n\n↳ 响应体是 Anthropic 协议的错误格式，但请求走的是 OpenAI（chat-completions）协议——接口地址与协议不匹配：打开「自定义模型」把协议切到 anthropic（接口地址填根路径、不带 /v1），或换成该端点 chat-completions 家族的模型；若本来就是 anthropic 上游中继，也可能是上游暂时故障，可稍后重试";
    }
  } catch {
    // 非 JSON 响应体（HTML 错误页等）不做判断
  }
  return "";
}

interface OpenAiTool {
  type: "function";
  function: { name: string; description: string; parameters: JsonSchema };
}

/** 导出供测试对拍：统一消息 → OpenAI 请求消息 */
export function toOpenAiMessages(systemPrompt: string, messages: LlmMessage[]): unknown[] {
  const out: unknown[] = [{ role: "system", content: systemPrompt }];

  for (const m of messages) {
    if (m.role === "user") {
      const text = m.content
        .filter((c) => c.type === "text")
        .map((c) => (c as { text: string }).text)
        .join("\n");
      const images = m.content.filter((c) => c.type === "image");
      if (images.length === 0) {
        out.push({ role: "user", content: text });
        continue;
      }
      // 多模态：text + image_url（data URL 直接可用，无需拆 base64）
      out.push({
        role: "user",
        content: [
          ...(text.length > 0 ? [{ type: "text", text }] : []),
          ...images.map((c) => ({
            type: "image_url",
            image_url: { url: (c as { dataUrl: string }).dataUrl },
          })),
        ],
      });
      continue;
    }

    if (m.role === "assistant") {
      const text = m.content
        .filter((c) => c.type === "text")
        .map((c) => (c as { text: string }).text)
        .join("");
      const calls = m.content.filter((c) => c.type === "toolCall");
      const item: Record<string, unknown> = { role: "assistant" };
      if (text.length > 0) item["content"] = text;
      if (calls.length > 0) {
        item["tool_calls"] = calls.map((c) => {
          const call = c as { id: string; name: string; arguments: unknown };
          return {
            id: call.id,
            type: "function",
            function: {
              name: call.name,
              arguments: JSON.stringify(call.arguments ?? {}),
            },
          };
        });
      }
      out.push(item);
      continue;
    }

    // toolResult：OpenAI 要求每个工具调用一条独立的 role=tool 消息。
    // 图片块不能放进 role=tool：官方 API 不支持，且多数兼容上游直接 400
    // （实测 opencode zen 的 mimo-v2.5：tool 带图 → "Upstream request failed:
    // [400]"；同图放 user 消息 → 200）。降级策略：图片提取出来，紧随该 tool
    // 消息之后以 user 消息承载；tool 消息只留文本。
    for (const c of m.content) {
      if (c.type !== "toolResult") continue;
      const tr = c as {
        toolCallId: string;
        content: { type: string; text: string; dataUrl?: string }[];
      };
      const textParts: unknown[] = [];
      const imageParts: unknown[] = [];
      for (const x of tr.content) {
        if (x.type === "image" && typeof x.dataUrl === "string") {
          imageParts.push({ type: "image_url", image_url: { url: x.dataUrl } });
        } else if (x.type === "text") {
          textParts.push({ type: "text", text: x.text });
        }
      }
      const content =
        textParts.length === 1 && (textParts[0] as { type: string }).type === "text"
          ? (textParts[0] as { text: string }).text
          : textParts;
      out.push({
        role: "tool",
        tool_call_id: tr.toolCallId,
        content,
      });
      if (imageParts.length > 0) {
        out.push({
          role: "user",
          content: [
            { type: "text", text: "（上一条工具结果附带的截图，坐标以图片左上角为原点）" },
            ...imageParts,
          ],
        });
      }
    }
  }

  return out;
}

function mapFinishReason(reason: unknown, hasToolCalls: boolean): StopReason {
  if (reason === "length") return "length";
  if (reason === "tool_calls" || hasToolCalls) return "toolUse";
  if (reason === "content_filter") return "error";
  return "stop";
}

/**
 * ThinkingLevel → OpenAI reasoning_effort。
 * off → undefined（不发字段，走端点默认）；minimal/low → low；medium/high 原样。
 * （o 系列不认 minimal；用 low 保持保守）
 */
export function reasoningEffort(level: ThinkingLevel): "low" | "medium" | "high" | undefined {
  switch (level) {
    case "off":
      return undefined;
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
  }
}

export const openaiStream: StreamFn = async function* (options) {
  const { model, systemPrompt, messages, tools, maxTokens, thinkingLevel, signal } = options;
  const acc = new StreamAccumulator(`${model.provider}:${model.id}`);

  const body: Record<string, unknown> = {
    model: model.id,
    stream: true,
    stream_options: { include_usage: true },
    messages: toOpenAiMessages(systemPrompt, messages),
  };
  if (tools.length > 0) {
    const mapped: OpenAiTool[] = tools.map((t: LlmTool) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
    body["tools"] = mapped;
    body["tool_choice"] = "auto";
  }

  // 推理强度（Model 支柱）：off 不发（走端点默认），其余映射 reasoning_effort。
  // 注意 o 系列与 gpt-5 系列的 token 上限参数是 max_completion_tokens，
  // 其余 OpenAI 兼容端点（mimo / vLLM 等）仍只认 max_tokens。
  const effort = reasoningEffort(thinkingLevel);
  if (effort !== undefined) body["reasoning_effort"] = effort;
  const newTokenParam = /^(o\d|gpt-5)/i.test(model.id);
  if (maxTokens !== undefined) {
    body[newTokenParam ? "max_completion_tokens" : "max_tokens"] = maxTokens;
  }

  const baseUrl = model.baseUrl ?? DEFAULT_BASE_URL;
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${model.apiKey ?? ""}`,
        // opencode zen go 中继要求：稳定会话 id（缺失 400 MissingSessionID）+
        // 自定义 UA（文档禁止 generic SDK/HTTP 库默认名）。其他端点忽略这两头。
        ...(options.sessionId !== undefined ? { "x-opencode-session": options.sessionId } : {}),
        "user-agent": "c-agent/0.1",
      },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    if (signal?.aborted) {
      yield { type: "done", reason: "aborted", message: acc.finish("aborted") };
      return;
    }
    yield {
      type: "error",
      reason: "error",
      error: acc.finish("error", String(err)),
    };
    return;
  }

  if (!response.ok || response.body === null) {
    const detail = await response.text().catch(() => "");
    const hint =
      response.status === 401 || response.status === 403
        ? missingKeyHint(model)
        : protocolMismatchHint(detail);
    const message = acc.finish(
      "error",
      `OpenAI ${response.status}: ${detail.slice(0, 500)}${hint}`,
    );
    yield { type: "error", reason: "error", error: message };
    return;
  }

  yield { type: "start", partial: acc.partial };

  let finishReason: string | null = null;

  for await (const chunk of parseSse(response.body, signal)) {
    const usage = chunk["usage"] as
      | Record<string, number | undefined>
      | undefined;
    if (usage !== undefined) {
      acc.addUsage({
        input: usage["prompt_tokens"] ?? 0,
        output: usage["completion_tokens"] ?? 0,
        cacheRead: usage["prompt_tokens_details"] !== undefined ? 0 : 0,
      });
    }

    const choices = chunk["choices"] as
      | Array<Record<string, unknown>>
      | undefined;
    const delta = (choices?.[0] as { delta?: Record<string, unknown> } | undefined)
      ?.delta;
    const reason = (choices?.[0] as { finish_reason?: string } | undefined)
      ?.finish_reason;
    if (typeof reason === "string") finishReason = reason;
    if (delta === undefined) continue;

    if (typeof delta["content"] === "string") {
      acc.pushText(delta["content"]);
      yield { type: "text_delta", delta: delta["content"], partial: acc.partial };
    }

    // o 系列与部分兼容端点使用 reasoning_content
    if (typeof delta["reasoning_content"] === "string") {
      acc.pushThinking(delta["reasoning_content"]);
      yield {
        type: "thinking_delta",
        delta: delta["reasoning_content"],
        partial: acc.partial,
      };
    }

    const toolDeltas = delta["tool_calls"] as
      | Array<Record<string, unknown>>
      | undefined;
    if (Array.isArray(toolDeltas)) {
      for (const td of toolDeltas) {
        if (typeof td["id"] === "string" && typeof td["function"] === "object") {
          const fn = td["function"] as { name?: unknown };
          acc.openToolCall(td["id"], typeof fn.name === "string" ? fn.name : "");
        }
        const fn = td["function"] as { arguments?: unknown } | undefined;
        if (typeof fn?.arguments === "string") {
          acc.pushToolCallDelta(fn.arguments);
          yield {
            type: "toolcall_delta",
            delta: fn.arguments,
            partial: acc.partial,
          };
        }
      }
    }
  }

  if (signal?.aborted) {
    yield { type: "done", reason: "aborted", message: acc.finish("aborted") };
    return;
  }

  let closed = acc.closeToolCall();
  while (closed !== null) {
    yield { type: "toolcall_end", toolCall: closed, partial: acc.partial };
    closed = acc.closeToolCall();
  }

  const hasToolCalls = acc.partial.content.some((c) => c.type === "toolCall");
  const reason = mapFinishReason(finishReason, hasToolCalls);
  yield { type: "done", reason, message: acc.finish(reason) };
};

export function openaiDefaultModel(): ModelRef {
  return {
    provider: "openai",
    id: process.env["MODEL"] ?? "gpt-4o-mini",
    baseUrl: process.env["OPENAI_BASE_URL"] ?? DEFAULT_BASE_URL,
    apiKey: process.env["OPENAI_API_KEY"],
  };
}

export { StreamError };
