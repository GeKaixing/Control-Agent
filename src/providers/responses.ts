/**
 * OpenAI Responses API 适配器（新一代 `/v1/responses` 端点）。
 *
 * 与 Chat Completions 的差异全部收敛在这里：
 *  - 系统提示词走 `instructions` 字段，对话历史走 `input` 数组；
 *  - 工具定义是扁平结构（{ type: "function", name, ... }），不再嵌 function 字段；
 *  - 历史里的工具调用以独立 function_call item 回放，工具结果用
 *    function_call_output item（call_id 对齐）；
 *  - 思考（reasoning）只能收到增量摘要；历史里的 reasoning item 是加密的
 *    无法伪造，回放时直接丢弃（服务端会自己重新思考）；
 *  - token 上限参数是 max_output_tokens（含 reasoning tokens）；
 *  - SSE 事件自带 type（response.*），parseSse 只读 data: 行恰好兼容；
 *  - usage 口径：input_tokens / output_tokens（output 已含 reasoning tokens，
 *    与 chat 的 completion_tokens 同口径），cacheRead 读 input_tokens_details。
 */

import type { ModelRef, StopReason } from "../types.js";
import { StreamAccumulator, parseSse } from "./stream.js";
import { reasoningEffort } from "./openai.js";
import type { JsonSchema, LlmMessage, LlmTool, StreamFn } from "./types.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/**
 * 401/403 且没有有效 key 时附中文指引。apiKey="EMPTY" 是桌面端「自定义模型」
 * 弹层留空 key 的占位约定（本地端点场景），远程端点收到必然拒——把「为什么 401」
 * 直接告诉用户，而不是让他对着一屏端点英文 JSON 猜。
 */
function missingKeyHint(model: ModelRef): string {
  const key = model.apiKey ?? "";
  if (key.length > 0 && key !== "EMPTY") return "";
  return "\n\n↳ 当前模型没有配置 API KEY：打开「自定义模型」补填后重试（仅本地端点如 ollama 可留空）";
}

interface ResponsesTool {
  type: "function";
  name: string;
  description: string;
  parameters: JsonSchema;
}

/**
 * 统一消息 → Responses input 数组（导出供测试对拍）。
 * 与 chat 版的差异：assistant 工具调用是独立 item（不挂在消息上）、
 * 工具结果是 function_call_output item、thinking 不回放。
 */
export function toResponsesInput(messages: LlmMessage[]): unknown[] {
  const out: unknown[] = [];

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
      // 多模态：input_text + input_image（Responses 的 image_url 是纯字符串，
      // data URL 直接可用——与 chat 版的 { url } 对象形状不同）
      out.push({
        role: "user",
        content: [
          ...(text.length > 0 ? [{ type: "input_text", text }] : []),
          ...images.map((c) => ({
            type: "input_image",
            image_url: (c as { dataUrl: string }).dataUrl,
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
      // thinking 不回放：reasoning item 服务端加密签发，伪造会被拒
      if (text.length > 0) {
        out.push({ role: "assistant", content: [{ type: "output_text", text }] });
      }
      for (const c of m.content) {
        if (c.type !== "toolCall") continue;
        const call = c as { id: string; name: string; arguments: unknown };
        out.push({
          type: "function_call",
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.arguments ?? {}),
        });
      }
      continue;
    }

    // toolResult → function_call_output。output 只收字符串：文本 join，
    // 截图块转占位说明（Responses 不接受在该 item 里带图）。
    for (const c of m.content) {
      if (c.type !== "toolResult") continue;
      const tr = c as {
        toolCallId: string;
        content: { type: string; text: string }[];
      };
      const text = tr.content
        .filter((x) => x.type === "text")
        .map((x) => (x as { text: string }).text)
        .join("\n");
      const images = tr.content.filter((x) => x.type === "image").length;
      out.push({
        type: "function_call_output",
        call_id: tr.toolCallId,
        output: images > 0 ? `${text}\n[附 ${images} 张图片，未在此回放]` : text,
      });
    }
  }

  return out;
}

function mapStopReason(hasToolCalls: boolean, incomplete: boolean): StopReason {
  if (hasToolCalls) return "toolUse";
  if (incomplete) return "length";
  return "stop";
}

/** Responses 的 usage 记账（response.completed / response.incomplete 共用） */
function recordUsage(acc: StreamAccumulator, response: unknown): void {
  if (typeof response !== "object" || response === null) return;
  const usage = (response as Record<string, unknown>)["usage"];
  if (typeof usage !== "object" || usage === null) return;
  const u = usage as Record<string, unknown>;
  const inputDetails = u["input_tokens_details"] as Record<string, unknown> | undefined;
  acc.addUsage({
    input: typeof u["input_tokens"] === "number" ? u["input_tokens"] : 0,
    output: typeof u["output_tokens"] === "number" ? u["output_tokens"] : 0,
    cacheRead: typeof inputDetails?.["cached_tokens"] === "number" ? inputDetails["cached_tokens"] : 0,
  });
}

export const responsesStream: StreamFn = async function* (options) {
  const { model, systemPrompt, messages, tools, thinkingLevel, maxTokens, signal, sessionId } =
    options;
  const acc = new StreamAccumulator(`${model.provider}:${model.id}`);

  const body: Record<string, unknown> = {
    model: model.id,
    stream: true,
    instructions: systemPrompt,
    input: toResponsesInput(messages),
  };
  if (tools.length > 0) {
    // 扁平结构：name/description/parameters 在顶层（chat 版嵌在 function 里）
    const mapped: ResponsesTool[] = tools.map((t: LlmTool) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
    body["tools"] = mapped;
  }
  const effort = reasoningEffort(thinkingLevel);
  if (effort !== undefined) body["reasoning"] = { effort };
  if (maxTokens !== undefined) body["max_output_tokens"] = maxTokens;

  const baseUrl = model.baseUrl ?? DEFAULT_BASE_URL;
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${model.apiKey ?? ""}`,
        // opencode zen go 中继的会话头要求对 responses 端点同样适用；其他端点忽略
        ...(sessionId !== undefined ? { "x-opencode-session": sessionId } : {}),
        "user-agent": "control-agent/0.1",
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
    const hint = response.status === 401 || response.status === 403 ? missingKeyHint(model) : "";
    const message = acc.finish(
      "error",
      `OpenAI Responses ${response.status}: ${detail.slice(0, 500)}${hint}`,
    );
    yield { type: "error", reason: "error", error: message };
    return;
  }

  yield { type: "start", partial: acc.partial };

  let incomplete = false;
  let completed = false;
  // 当前 function_call 的跟踪：added 没收到而 done 先到（异常分块）时补 open
  let currentCallId: string | null = null;
  let currentCallArgsSeen = false;
  let callSeq = 0;

  for await (const chunk of parseSse(response.body, signal)) {
    const type = chunk["type"];
    switch (type) {
      case "response.output_text.delta": {
        const delta = chunk["delta"];
        if (typeof delta === "string" && delta.length > 0) {
          acc.pushText(delta);
          yield { type: "text_delta", delta, partial: acc.partial };
        }
        break;
      }
      // 思考摘要与思考正文两种增量（不同模型/版本二选一或混发）
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta": {
        const delta = chunk["delta"];
        if (typeof delta === "string" && delta.length > 0) {
          acc.pushThinking(delta);
          yield { type: "thinking_delta", delta, partial: acc.partial };
        }
        break;
      }
      case "response.output_item.added": {
        const item = chunk["item"] as Record<string, unknown> | undefined;
        if (item?.["type"] === "function_call") {
          const id = typeof item["call_id"] === "string" ? item["call_id"] : `call_${++callSeq}`;
          const name = typeof item["name"] === "string" ? item["name"] : "";
          currentCallId = id;
          currentCallArgsSeen = false;
          acc.openToolCall(id, name);
        }
        break;
      }
      case "response.function_call_arguments.delta": {
        const delta = chunk["delta"];
        if (typeof delta === "string" && delta.length > 0) {
          currentCallArgsSeen = true;
          acc.pushToolCallDelta(delta);
          yield { type: "toolcall_delta", delta, partial: acc.partial };
        }
        break;
      }
      case "response.output_item.done": {
        const item = chunk["item"] as Record<string, unknown> | undefined;
        if (item?.["type"] === "function_call") {
          const id = typeof item["call_id"] === "string" ? item["call_id"] : `call_${++callSeq}`;
          if (currentCallId !== id) {
            // 没见过 added（异常分块）：按 done 里的完整 item 补开一个
            const name = typeof item["name"] === "string" ? item["name"] : "";
            currentCallId = id;
            currentCallArgsSeen = false;
            acc.openToolCall(id, name);
          }
          if (!currentCallArgsSeen && typeof item["arguments"] === "string" && item["arguments"].length > 0) {
            // 某些分块不发 arguments.delta，完整参数直接随 done 到达
            acc.pushToolCallDelta(item["arguments"]);
          }
          currentCallId = null;
        }
        break;
      }
      case "response.completed": {
        completed = true;
        recordUsage(acc, chunk["response"]);
        break;
      }
      case "response.incomplete": {
        incomplete = true;
        recordUsage(acc, chunk["response"]);
        break;
      }
      case "response.failed": {
        const resp = chunk["response"] as Record<string, unknown> | undefined;
        const err = resp?.["error"] as Record<string, unknown> | undefined;
        const msg = typeof err?.["message"] === "string" ? err["message"] : "Responses 流失败";
        yield { type: "error", reason: "error", error: acc.finish("error", msg) };
        return;
      }
      case "error": {
        const msg =
          typeof chunk["message"] === "string" ? chunk["message"] : JSON.stringify(chunk).slice(0, 300);
        yield { type: "error", reason: "error", error: acc.finish("error", msg) };
        return;
      }
      default:
        break; // response.created / in_progress / *_done 等通知类事件忽略
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
  const reason = mapStopReason(hasToolCalls, incomplete && !completed);
  yield { type: "done", reason, message: acc.finish(reason) };
};

export function responsesDefaultModel(): ModelRef {
  return {
    provider: "openai-responses",
    id: process.env["MODEL"] ?? "gpt-5.1",
    baseUrl: process.env["OPENAI_BASE_URL"] ?? DEFAULT_BASE_URL,
    apiKey: process.env["OPENAI_API_KEY"],
  };
}
