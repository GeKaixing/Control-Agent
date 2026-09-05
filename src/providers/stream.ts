/**
 * 流式事件累积器：把各家厂商的增量事件统一累积成 AssistantMessage。
 * 各家适配器只负责「翻译事件」，不负责维护消息状态。
 */

import type {
  AssistantContent,
  AssistantMessage,
  StopReason,
  Usage,
} from "../types.js";
import { emptyUsage } from "../types.js";
import type { ToolCallSummary } from "./types.js";

interface PendingToolCall {
  index: number;
  id: string;
  name: string;
  buffer: string;
}

export class StreamAccumulator {
  private readonly model: string;
  private readonly timestamp: number;
  private content: AssistantContent[] = [];
  private usage: Usage = emptyUsage();
  private pending: PendingToolCall | null = null;
  private textIndex = -1;
  private thinkingIndex = -1;

  constructor(model: string) {
    this.model = model;
    this.timestamp = Date.now();
  }

  /** 当前快照（浅拷贝，避免上层拿到可变引用） */
  get partial(): AssistantMessage {
    return {
      role: "assistant",
      content: this.content.map((c) => ({ ...c })),
      model: this.model,
      stopReason: "stop",
      usage: { ...this.usage },
      timestamp: this.timestamp,
    };
  }

  pushText(delta: string): void {
    if (delta.length === 0) return;
    this.flushPendingToolCall();
    if (this.textIndex < 0 || this.content[this.textIndex]?.type !== "text") {
      this.content.push({ type: "text", text: "" });
      this.textIndex = this.content.length - 1;
    }
    const block = this.content[this.textIndex] as { type: "text"; text: string };
    block.text += delta;
  }

  pushThinking(delta: string): void {
    if (delta.length === 0) return;
    this.flushPendingToolCall();
    if (
      this.thinkingIndex < 0 ||
      this.content[this.thinkingIndex]?.type !== "thinking"
    ) {
      this.content.push({ type: "thinking", thinking: "" });
      this.thinkingIndex = this.content.length - 1;
    }
    const block = this.content[this.thinkingIndex] as {
      type: "thinking";
      thinking: string;
    };
    block.thinking += delta;
  }

  openToolCall(id: string, name: string): void {
    this.flushPendingToolCall();
    this.content.push({ type: "toolCall", id, name, arguments: {} });
    this.pending = { index: this.content.length - 1, id, name, buffer: "" };
  }

  pushToolCallDelta(delta: string): void {
    if (this.pending === null) return;
    this.pending.buffer += delta;
  }

  /** 关闭当前工具调用并返回解析结果；参数 JSON 非法时降级为空对象 */
  closeToolCall(): ToolCallSummary | null {
    const pending = this.pending;
    if (pending === null) return null;
    this.pending = null;

    const block = this.content[pending.index] as {
      type: "toolCall";
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    };
    let parsed: unknown = {};
    try {
      parsed = pending.buffer.trim().length > 0 ? JSON.parse(pending.buffer) : {};
    } catch {
      parsed = {};
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      parsed = {};
    }
    block.arguments = parsed as Record<string, unknown>;
    return { id: pending.id, name: pending.name, arguments: block.arguments };
  }

  addUsage(patch: Partial<Usage>): void {
    this.usage = {
      input: patch.input ?? this.usage.input,
      output: patch.output ?? this.usage.output,
      cacheRead: patch.cacheRead ?? this.usage.cacheRead,
      cacheWrite: patch.cacheWrite ?? this.usage.cacheWrite,
      total: patch.total ?? this.usage.total,
    };
  }

  finish(reason: StopReason, errorMessage?: string): AssistantMessage {
    this.flushPendingToolCall();
    return {
      role: "assistant",
      content: this.content.map((c) => ({ ...c })),
      model: this.model,
      stopReason: reason,
      ...(errorMessage === undefined ? {} : { errorMessage }),
      usage: { ...this.usage, total: this.usage.input + this.usage.output },
      timestamp: this.timestamp,
    };
  }

  private flushPendingToolCall(): void {
    if (this.pending !== null) this.closeToolCall();
  }
}

/** SSE 解析：把 ReadableStream<Uint8Array> 切成完整的 `data:` 行 */
export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<Record<string, unknown>, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const line of raw.split("\n")) {
          const trimmed = line.trim();
          if (trimmed.length === 0 || !trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === "[DONE]") return;
          try {
            yield JSON.parse(payload) as Record<string, unknown>;
          } catch {
            continue;
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export class StreamError extends Error {
  readonly status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = "StreamError";
    this.status = status;
  }
}
