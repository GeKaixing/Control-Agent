/**
 * OpenAI Chat Completions 适配器。
 * 只做「翻译」：统一消息 → OpenAI 请求，SSE 增量 → 统一流式事件。
 */

import type { ModelRef, StopReason } from "../types.js";
import { StreamAccumulator, StreamError, parseSse } from "./stream.js";
import type { JsonSchema, LlmMessage, LlmTool, StreamFn } from "./types.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

interface OpenAiTool {
  type: "function";
  function: { name: string; description: string; parameters: JsonSchema };
}

function toOpenAiMessages(systemPrompt: string, messages: LlmMessage[]): unknown[] {
  const out: unknown[] = [{ role: "system", content: systemPrompt }];

  for (const m of messages) {
    if (m.role === "user") {
      out.push({
        role: "user",
        content: m.content
          .filter((c) => c.type === "text")
          .map((c) => (c as { text: string }).text)
          .join("\n"),
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

    // toolResult：OpenAI 要求每个工具调用一条独立的 role=tool 消息
    for (const c of m.content) {
      if (c.type !== "toolResult") continue;
      const tr = c as {
        toolCallId: string;
        content: { type: string; text: string }[];
      };
      out.push({
        role: "tool",
        tool_call_id: tr.toolCallId,
        content: tr.content.map((x) => x.text).join("\n"),
      });
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

export const openaiStream: StreamFn = async function* (options) {
  const { model, systemPrompt, messages, tools, maxTokens, signal } = options;
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
  if (maxTokens !== undefined) body["max_tokens"] = maxTokens;

  const baseUrl = model.baseUrl ?? DEFAULT_BASE_URL;
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${model.apiKey ?? ""}`,
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
    const message = acc.finish(
      "error",
      `OpenAI ${response.status}: ${detail.slice(0, 500)}`,
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
