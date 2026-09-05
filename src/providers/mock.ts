/**
 * mock 适配器：不需要 API key 就能把整条链路跑通。
 * 它按关键字猜测该用什么工具，工具结果回传后给出总结并停止，
 * 因此不会陷入无限工具循环。
 */

import type { ModelRef, StopReason } from "../types.js";
import { StreamAccumulator } from "./stream.js";
import type { LlmMessage, StreamFn, StreamOptions } from "./types.js";

interface MockToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

const DEFAULT_DELAY_MS = 8;

function pickQuoted(text: string): string | null {
  const m = /[`"“”']([^`"“”']{1,200})[`"“”']/.exec(text);
  return m?.[1]?.trim() ?? null;
}

function pickPath(text: string): string | null {
  const quoted = pickQuoted(text);
  if (quoted !== null && /[\w.-]+[./][\w.-]+/.test(quoted)) return quoted;
  const m = /([\w.-]+\/[\w./-]+|(?:[\w.-]+\.(?:ts|tsx|js|jsx|json|md|txt|py|go|rs|yml|yaml|toml)))/.exec(
    text,
  );
  return m?.[1] ?? null;
}

function pickCommand(text: string): string {
  const quoted = pickQuoted(text);
  if (quoted !== null) return quoted;
  const afterKeyword = /(?:命令|command)[:：]?\s*(.+)/i.exec(text);
  if (afterKeyword?.[1] !== undefined) return afterKeyword[1].trim();
  const afterVerb = /(?:运行|执行|跑一下|跑|run)[:：]?\s*(.+)/i.exec(text);
  if (afterVerb?.[1] !== undefined) return afterVerb[1].trim();
  return "ls -la";
}

function pickPattern(text: string): string {
  const quoted = pickQuoted(text);
  if (quoted !== null) return quoted;
  const afterKeyword =
    /(?:搜索|查找|查一下|grep|包含|寻找)[:：]?\s*([^\s，,。]{1,40})/.exec(text);
  return afterKeyword?.[1]?.trim() ?? "TODO";
}

function lastUserText(messages: LlmMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m !== undefined && m.role === "user") {
      return m.content
        .filter((c) => c.type === "text")
        .map((c) => (c as { text: string }).text)
        .join("\n");
    }
  }
  return "";
}

function lastToolResults(messages: LlmMessage[]): string[] {
  const last = messages[messages.length - 1];
  if (last === undefined || last.role !== "toolResult") return [];
  return last.content
    .filter((c) => c.type === "toolResult")
    .map((c) => {
      const tr = c as {
        toolName: string;
        isError: boolean;
        content: { text: string }[];
      };
      const body = tr.content.map((x) => x.text).join("\n");
      return `${tr.toolName}${tr.isError ? " (失败)" : ""}: ${body.slice(0, 400)}`;
    });
}

/** 决定这一轮要做什么：直接回答，还是调用工具 */
function decide(options: StreamOptions): {
  thinking: string;
  text: string;
  calls: MockToolCall[];
} {
  const messages = options.messages;
  const userText = lastUserText(messages).trim();
  const results = lastToolResults(messages);

  if (results.length > 0) {
    return {
      thinking: "工具结果已经拿到，整理成一段人话回答即可。",
      text: [
        "已完成。工具返回如下：",
        "",
        ...results.map((r) => `- ${r}`),
        "",
        "_（mock 模型：接入真实模型后，这里会由大模型基于工具结果生成总结。）_",
      ].join("\n"),
      calls: [],
    };
  }

  if (/(列出|有哪些|列一下|找一下所有|目录里有什么|ls\b)/i.test(userText)) {
    const ext = /\.(ts|tsx|js|jsx|json|md|txt|py|go|rs|yml|yaml)/.exec(userText);
    return {
      thinking: "用户在问目录里有什么文件，用 glob 列一下。",
      text: "",
      calls: [{ name: "glob", arguments: { pattern: ext?.[1] ? `**/*.${ext[1]}` : "**/*" } }],
    };
  }

  if (/(搜索|查找|查一下|grep|包含|哪里用到|找一下)/i.test(userText)) {
    return {
      thinking: "用户在找一段文本，用 grep 搜索。",
      text: "",
      calls: [{ name: "grep", arguments: { pattern: pickPattern(userText) } }],
    };
  }

  if (
    /(创建|新建|写入|写个|生成一个?文件|建一个?文件)/i.test(userText) &&
    pickPath(userText) !== null
  ) {
    const path = pickPath(userText) as string;
    return {
      thinking: `用户要创建文件 ${path}，先写入一份初始内容。`,
      text: "",
      calls: [
        {
          name: "write",
          arguments: {
            path,
            content: `# ${path}\n\n由 mock 模型创建。\n\n原始请求：${userText}\n`,
          },
        },
      ],
    };
  }

  if (/(运行|执行|跑一下|跑|run\b)/i.test(userText)) {
    return {
      thinking: "用户要执行一条命令，交给 bash。",
      text: "",
      calls: [{ name: "bash", arguments: { command: pickCommand(userText) } }],
    };
  }

  const readPath = pickPath(userText);
  if (/(读取|查看|打开|看一下|读一下|cat\b|show\b)/i.test(userText) && readPath !== null) {
    return {
      thinking: `用户想看 ${readPath} 的内容，用 read 读取。`,
      text: "",
      calls: [{ name: "read", arguments: { path: readPath } }],
    };
  }

  return {
    thinking: "这是一个普通问题，直接回答。",
    text: [
      `已收到你的请求：${userText || "（空）"}`,
      "",
      "当前运行在 **mock 模型**下，它只能按关键字猜测意图。",
      "想让代理真正干活，请配置 OPENAI_API_KEY 或 ANTHROPIC_API_KEY，",
      "或用 `--model openai:你的模型` 指定。可用工具：read / write / edit / bash / glob / grep。",
    ].join("\n"),
    calls: [],
  };
}

function chunk(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length > 0 ? out : [text];
}

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();

export function createMockStream(options?: { delayMs?: number }): StreamFn {
  const delay = options?.delayMs ?? DEFAULT_DELAY_MS;

  return async function* (opts: StreamOptions) {
    const model: ModelRef = opts.model;
    const acc = new StreamAccumulator(`${model.provider}:${model.id}`);
    const plan = decide(opts);

    yield { type: "start", partial: acc.partial };

    if (opts.thinkingLevel !== "off") {
      for (const piece of chunk(plan.thinking, 6)) {
        if (opts.signal?.aborted) break;
        acc.pushThinking(piece);
        yield { type: "thinking_delta", delta: piece, partial: acc.partial };
        await sleep(delay);
      }
    }

    if (opts.signal?.aborted) {
      yield {
        type: "done",
        reason: "aborted" as StopReason,
        message: acc.finish("aborted"),
      };
      return;
    }

    let counter = 0;
    for (const call of plan.calls) {
      counter += 1;
      const id = `call_${Date.now().toString(36)}_${counter}`;
      acc.openToolCall(id, call.name);
      const payload = JSON.stringify(call.arguments);
      for (const piece of chunk(payload, 12)) {
        acc.pushToolCallDelta(piece);
        yield { type: "toolcall_delta", delta: piece, partial: acc.partial };
        await sleep(delay);
      }
      const closed = acc.closeToolCall();
      if (closed !== null) {
        yield { type: "toolcall_end", toolCall: closed, partial: acc.partial };
      }
    }

    for (const piece of chunk(plan.text, 10)) {
      if (opts.signal?.aborted) break;
      acc.pushText(piece);
      yield { type: "text_delta", delta: piece, partial: acc.partial };
      await sleep(delay);
    }

    if (opts.signal?.aborted) {
      yield {
        type: "done",
        reason: "aborted" as StopReason,
        message: acc.finish("aborted"),
      };
      return;
    }

    const outputChars = plan.text.length + plan.thinking.length;
    acc.addUsage({
      input: Math.ceil(JSON.stringify(opts.messages).length / 4),
      output: Math.ceil(outputChars / 4),
    });

    const reason: StopReason = plan.calls.length > 0 ? "toolUse" : "stop";
    yield { type: "done", reason, message: acc.finish(reason) };
  };
}

export const mockStream: StreamFn = createMockStream();

export function mockDefaultModel(): ModelRef {
  return { provider: "mock", id: "mock-1" };
}
