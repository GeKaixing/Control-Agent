/**
 * Gemini 原生 REST 适配器（generateContent / streamGenerateContent?alt=sse）。
 *
 * 与 OpenAI 兼容层的差异全部收敛在这里：
 *  - thinking 是带 thought:true 标记的 text part；
 *  - functionCall 无增量 JSON，一次整包到达，且没有 id（自造 call_N）；
 *  - 工具结果以 functionResponse part 放回 user 轮（按 function name 对齐，
 *    ToolResultContent.toolName 直接可用）；
 *  - thinkingConfig.thinkingBudget：off 关思考 / low·minimal 固定小预算 /
 *    medium 固定中预算 / high 动态（-1）。
 */

import type { ModelRef, StopReason, ThinkingLevel } from "../types.js";
import { StreamAccumulator, parseSse } from "./stream.js";
import type { LlmMessage, LlmTool, StreamFn } from "./types.js";

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/**
 * 401/403 且没有有效 key 时附中文指引。apiKey="EMPTY" 是桌面端「自定义模型」
 * 弹层留空 key 的占位约定（本地端点场景），远程端点收到必然拒——把「为什么 401」
 * 直接告诉用户，而不是让他对着一屏端点英文 JSON 猜。
 */
function missingKeyHint(model: ModelRef): string {
  const key = model.apiKey ?? "";
  if (key.length > 0 && key !== "EMPTY") return "";
  return "\n\n↳ 当前模型没有配置 API KEY：打开「自定义模型」补填后重试（仅本地端点可留空）";
}

interface GeminiPart {
  text?: string;
  thought?: boolean;
  functionCall?: { name?: string; args?: Record<string, unknown> };
  functionResponse?: { name?: string; response?: Record<string, unknown> };
  inlineData?: { mimeType?: string; data?: string };
}

/** 拆 data URL → { mimeType, base64 }；非 data:base64 形态返回 null */
function parseDataUrl(dataUrl: string): { mimeType: string; base64: string } | null {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl);
  if (m === null) return null;
  return { mimeType: m[1] ?? "", base64: m[2] ?? "" };
}

function toGeminiContents(messages: LlmMessage[]): unknown[] {
  const out: unknown[] = [];

  for (const m of messages) {
    if (m.role === "user") {
      const parts: GeminiPart[] = [];
      for (const c of m.content) {
        if (c.type === "text") {
          parts.push({ text: c.text });
        } else if (c.type === "image") {
          const parsed = parseDataUrl(c.dataUrl);
          if (parsed !== null) {
            parts.push({ inlineData: { mimeType: parsed.mimeType, data: parsed.base64 } });
          }
        }
      }
      if (parts.length > 0) out.push({ role: "user", parts });
      continue;
    }

    if (m.role === "assistant") {
      const parts: GeminiPart[] = [];
      for (const c of m.content) {
        if (c.type === "text") parts.push({ text: c.text });
        else if (c.type === "thinking") parts.push({ text: c.thinking, thought: true });
        else if (c.type === "toolCall") {
          parts.push({ functionCall: { name: c.name, args: c.arguments ?? {} } });
        }
      }
      if (parts.length > 0) out.push({ role: "model", parts });
      continue;
    }

    // toolResult：Gemini 用 user 轮的 functionResponse part 承载（按 name 对齐）
    const parts: GeminiPart[] = [];
    for (const c of m.content) {
      if (c.type !== "toolResult") continue;
      const text = c.content
        .filter((x) => x.type === "text")
        .map((x) => x.text)
        .join("\n");
      parts.push({
        functionResponse: {
          name: c.toolName,
          response: c.isError ? { error: text } : { result: text },
        },
      });
    }
    if (parts.length > 0) out.push({ role: "user", parts });
  }

  return out;
}

/**
 * JsonSchema → Gemini functionDeclarations 用的 OpenAPI 子集：
 * 递归剥掉 additionalProperties（Gemini 显式不支持该字段，会整包 400）。
 */
function toOpenApiSchema(schema: unknown): Record<string, unknown> {
  if (typeof schema !== "object" || schema === null) return {};
  const rec = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (rec["type"] !== undefined) out["type"] = rec["type"];
  if (typeof rec["description"] === "string") out["description"] = rec["description"];
  if (Array.isArray(rec["enum"])) out["enum"] = rec["enum"];
  if (rec["items"] !== undefined) out["items"] = toOpenApiSchema(rec["items"]);
  if (typeof rec["properties"] === "object" && rec["properties"] !== null) {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec["properties"] as Record<string, unknown>)) {
      props[k] = toOpenApiSchema(v);
    }
    out["properties"] = props;
  }
  if (Array.isArray(rec["required"])) out["required"] = rec["required"];
  return out;
}

function toGeminiTools(tools: LlmTool[]): unknown[] {
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: toOpenApiSchema(t.parameters),
      })),
    },
  ];
}

/** thinkingLevel → thinkingBudget。off 关思考；high 动态（-1）；其余固定预算。 */
function thinkingBudget(level: ThinkingLevel): number {
  switch (level) {
    case "off":
      return 0;
    case "minimal":
      return 512;
    case "low":
      return 2048;
    case "medium":
      return 8192;
    case "high":
      return -1;
  }
}

function mapStopReason(finish: string | null, hasToolCalls: boolean): StopReason {
  if (hasToolCalls) return "toolUse";
  if (finish === "MAX_TOKENS") return "length";
  return "stop";
}

export const geminiStream: StreamFn = async function* (options) {
  const { model, systemPrompt, messages, tools, thinkingLevel, maxTokens, signal } = options;
  const acc = new StreamAccumulator(`${model.provider}:${model.id}`);

  const body: Record<string, unknown> = {
    contents: toGeminiContents(messages),
  };
  if (systemPrompt.trim().length > 0) {
    body["systemInstruction"] = { parts: [{ text: systemPrompt }] };
  }
  if (tools.length > 0) body["tools"] = toGeminiTools(tools);
  const genConfig: Record<string, unknown> = { thinkingConfig: { thinkingBudget: thinkingBudget(thinkingLevel) } };
  if (maxTokens !== undefined) genConfig["maxOutputTokens"] = maxTokens;
  body["generationConfig"] = genConfig;

  const url = `${model.baseUrl ?? DEFAULT_BASE_URL}/models/${encodeURIComponent(model.id)}:streamGenerateContent?alt=sse`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": model.apiKey ?? "",
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
    const hint = response.status === 401 || response.status === 403 ? missingKeyHint(model) : "";
    const message = acc.finish(
      "error",
      `Gemini ${response.status}: ${detail.slice(0, 500)}${hint}`,
    );
    yield { type: "error", reason: "error", error: message };
    return;
  }

  yield { type: "start", partial: acc.partial };

  let finishReason: string | null = null;
  let toolSeq = 0;

  for await (const evt of parseSse(response.body, signal)) {
    // 流中途报错：{ error: { code, message, status } }
    const errObj = evt["error"];
    if (typeof errObj === "object" && errObj !== null) {
      const message = (errObj as { message?: unknown }).message;
      yield {
        type: "error",
        reason: "error",
        error: acc.finish("error", typeof message === "string" ? message : "未知错误"),
      };
      return;
    }

    const candidate = (evt["candidates"] as Array<Record<string, unknown>> | undefined)?.[0];
    const parts =
      (candidate?.["content"] as { parts?: GeminiPart[] } | undefined)?.parts ?? [];

    for (const part of parts) {
      if (part.functionCall !== undefined && typeof part.functionCall.name === "string") {
        // 无增量 JSON：一次性整包 open→push→close
        acc.openToolCall(`call_${++toolSeq}`, part.functionCall.name);
        acc.pushToolCallDelta(JSON.stringify(part.functionCall.args ?? {}));
        const closed = acc.closeToolCall();
        if (closed !== null) {
          yield { type: "toolcall_end", toolCall: closed, partial: acc.partial };
        }
        continue;
      }
      if (typeof part.text === "string" && part.text.length > 0) {
        if (part.thought === true) {
          acc.pushThinking(part.text);
          yield { type: "thinking_delta", delta: part.text, partial: acc.partial };
        } else {
          acc.pushText(part.text);
          yield { type: "text_delta", delta: part.text, partial: acc.partial };
        }
      }
    }

    const usage = evt["usageMetadata"] as Record<string, number> | undefined;
    if (usage !== undefined) {
      acc.addUsage({
        input: usage["promptTokenCount"] ?? 0,
        output: (usage["candidatesTokenCount"] ?? 0) + (usage["thoughtsTokenCount"] ?? 0),
      });
    }

    const finish = candidate?.["finishReason"];
    if (typeof finish === "string") finishReason = finish;
  }

  if (signal?.aborted) {
    yield { type: "done", reason: "aborted", message: acc.finish("aborted") };
    return;
  }

  const hasToolCalls = acc.partial.content.some((c) => c.type === "toolCall");
  const reason = mapStopReason(finishReason, hasToolCalls);
  yield { type: "done", reason, message: acc.finish(reason) };
};

export function geminiDefaultModel(): ModelRef {
  return {
    provider: "gemini",
    id: process.env["MODEL"] ?? "gemini-2.5-flash",
    baseUrl: process.env["GEMINI_BASE_URL"] ?? DEFAULT_BASE_URL,
    apiKey: process.env["GEMINI_API_KEY"] ?? process.env["GOOGLE_API_KEY"],
  };
}
