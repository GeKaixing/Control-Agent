/**
 * Anthropic Messages 适配器。
 * 消息形状与 OpenAI 差异较大（工具结果归到 user 轮次），差异全部收敛在这里。
 */

import type { ModelRef, StopReason } from "../types.js";
import { StreamAccumulator, parseSse } from "./stream.js";
import type { LlmMessage, StreamFn } from "./types.js";

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const API_VERSION = "2023-06-01";

function thinkingBudget(level: string, maxTokens: number): number | null {
  switch (level) {
    case "medium":
      return Math.min(4096, Math.floor(maxTokens / 2));
    case "high":
      return Math.min(16384, Math.floor(maxTokens * 0.8));
    default:
      return null;
  }
}

function toAnthropicMessages(messages: LlmMessage[]): unknown[] {
  const out: unknown[] = [];

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
      const blocks: unknown[] = [];
      for (const c of m.content) {
        if (c.type === "text") blocks.push({ type: "text", text: c.text });
        else if (c.type === "thinking") {
          blocks.push({ type: "thinking", thinking: c.thinking, signature: "" });
        } else if (c.type === "toolCall") {
          blocks.push({
            type: "tool_use",
            id: c.id,
            name: c.name,
            input: c.arguments ?? {},
          });
        }
      }
      if (blocks.length > 0) out.push({ role: "assistant", content: blocks });
      continue;
    }

    // toolResult：Anthropic 把工具结果放进一条 user 消息
    const results = m.content
      .filter((c) => c.type === "toolResult")
      .map((c) => {
        const tr = c as {
          toolCallId: string;
          isError: boolean;
          content: { text: string }[];
        };
        return {
          type: "tool_result",
          tool_use_id: tr.toolCallId,
          content: tr.content.map((x) => x.text).join("\n"),
          is_error: tr.isError,
        };
      });
    if (results.length > 0) out.push({ role: "user", content: results });
  }

  return out;
}

function mapStopReason(reason: unknown, hasToolCalls: boolean): StopReason {
  if (reason === "max_tokens") return "length";
  if (reason === "tool_use" || hasToolCalls) return "toolUse";
  return "stop";
}

export const anthropicStream: StreamFn = async function* (options) {
  const { model, systemPrompt, messages, tools, thinkingLevel, maxTokens, signal } =
    options;
  const acc = new StreamAccumulator(`${model.provider}:${model.id}`);
  const limit = maxTokens ?? 8192;

  const body: Record<string, unknown> = {
    model: model.id,
    max_tokens: limit,
    system: systemPrompt,
    messages: toAnthropicMessages(messages),
    stream: true,
  };
  if (tools.length > 0) {
    body["tools"] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }
  const budget = thinkingBudget(thinkingLevel, limit);
  if (budget !== null && budget >= 1024) {
    body["thinking"] = { type: "enabled", budget_tokens: budget };
  }

  let response: Response;
  try {
    response = await fetch(`${model.baseUrl ?? DEFAULT_BASE_URL}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": model.apiKey ?? "",
        "anthropic-version": API_VERSION,
      },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    if (signal?.aborted === true) {
      yield { type: "done", reason: "aborted", message: acc.finish("aborted") };
    } else {
      yield {
        type: "error",
        reason: "error",
        error: acc.finish("error", String(err)),
      };
    }
    return;
  }

  if (!response.ok || response.body === null) {
    const detail = await response.text().catch(() => "");
    const message = acc.finish(
      "error",
      `Anthropic ${response.status}: ${detail.slice(0, 500)}`,
    );
    yield { type: "error", reason: "error", error: message };
    return;
  }

  yield { type: "start", partial: acc.partial };

  let stopReason: string | null = null;

  for await (const evt of parseSse(response.body, signal)) {
    const type = evt["type"];

    if (type === "message_start") {
      const msg = evt["message"] as { usage?: Record<string, number> } | undefined;
      acc.addUsage({
        input: msg?.usage?.["input_tokens"] ?? 0,
        cacheRead: msg?.usage?.["cache_read_input_tokens"] ?? 0,
        cacheWrite: msg?.usage?.["cache_creation_input_tokens"] ?? 0,
      });
      continue;
    }

    if (type === "content_block_start") {
      const block = evt["content_block"] as Record<string, unknown> | undefined;
      if (block?.["type"] === "tool_use") {
        acc.openToolCall(
          typeof block["id"] === "string" ? block["id"] : "",
          typeof block["name"] === "string" ? block["name"] : "",
        );
      }
      continue;
    }

    if (type === "content_block_delta") {
      const delta = evt["delta"] as Record<string, unknown> | undefined;
      if (delta?.["type"] === "text_delta" && typeof delta["text"] === "string") {
        acc.pushText(delta["text"]);
        yield { type: "text_delta", delta: delta["text"], partial: acc.partial };
      } else if (
        delta?.["type"] === "thinking_delta" &&
        typeof delta["thinking"] === "string"
      ) {
        acc.pushThinking(delta["thinking"]);
        yield {
          type: "thinking_delta",
          delta: delta["thinking"],
          partial: acc.partial,
        };
      } else if (
        delta?.["type"] === "input_json_delta" &&
        typeof delta["partial_json"] === "string"
      ) {
        acc.pushToolCallDelta(delta["partial_json"]);
        yield {
          type: "toolcall_delta",
          delta: delta["partial_json"],
          partial: acc.partial,
        };
      }
      continue;
    }

    if (type === "content_block_stop") {
      const closed = acc.closeToolCall();
      if (closed !== null) {
        yield { type: "toolcall_end", toolCall: closed, partial: acc.partial };
      }
      continue;
    }

    if (type === "message_delta") {
      const delta = evt["delta"] as { stop_reason?: string } | undefined;
      if (typeof delta?.stop_reason === "string") stopReason = delta.stop_reason;
      const usage = evt["usage"] as Record<string, number> | undefined;
      if (usage !== undefined) {
        acc.addUsage({ output: usage["output_tokens"] ?? 0 });
      }
      continue;
    }

    if (type === "error") {
      const err = evt["error"] as { message?: string } | undefined;
      const message = acc.finish("error", err?.message ?? "未知错误");
      yield { type: "error", reason: "error", error: message };
      return;
    }
  }

  if (signal?.aborted) {
    yield { type: "done", reason: "aborted", message: acc.finish("aborted") };
    return;
  }

  const hasToolCalls = acc.partial.content.some((c) => c.type === "toolCall");
  const reason = mapStopReason(stopReason, hasToolCalls);
  yield { type: "done", reason, message: acc.finish(reason) };
};

export function anthropicDefaultModel(): ModelRef {
  return {
    provider: "anthropic",
    id: process.env["MODEL"] ?? "claude-3-7-sonnet-latest",
    baseUrl: process.env["ANTHROPIC_BASE_URL"] ?? DEFAULT_BASE_URL,
    apiKey: process.env["ANTHROPIC_API_KEY"],
  };
}
