/**
 * mock 适配器：不需要 API key 就能把整条链路跑通。
 * 它按关键字猜测该用什么工具，工具结果回传后给出总结并停止，
 * 因此不会陷入无限工具循环。
 *
 * 工具识别分两层：
 *  - 内置 6 个 tool（read / write / edit / bash / glob / grep）按老规矩硬编码派发
 *  - connector 暴露的 tool（如 video.probe / audio.extract）按命名空间 + 关键字派发
 *
 * 第二层让我们能用 `--model mock --connectors ./src/connector/connectors` 把整条
 * Agent → Connector → FFmpeg 链路在没 API key 的情况下也跑通。
 */

import type { ModelRef, StopReason } from "../types.js";
import { StreamAccumulator } from "./stream.js";
import type { JsonSchema, LlmMessage, LlmTool, StreamFn, StreamOptions } from "./types.js";

interface MockToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

const DEFAULT_DELAY_MS = 8;

/** mock 已硬编码识别的内置工具名；connector tool 不在内，靠命名空间（`xxx.yyy`）识别 */
const BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read",
  "write",
  "edit",
  "bash",
  "glob",
  "grep",
]);

function pickQuoted(text: string): string | null {
  const m = /[`"“”']([^`"“”']{1,200})[`"“”']/.exec(text);
  return m?.[1]?.trim() ?? null;
}

function pickPath(text: string): string | null {
  const quoted = pickQuoted(text);
  if (quoted !== null && /[\w./-]+/.test(quoted) && quoted.includes("/")) return quoted;
  // 优先匹配绝对路径（`/tmp/x.mp4`），再匹配相对路径（`tmp/x.mp4`），最后匹配纯文件名
  const m =
    /(\/[\w./-]+|[\w.-]+\/[\w./-]+|(?:[\w.-]+\.(?:ts|tsx|js|jsx|json|md|txt|py|go|rs|yml|yaml|toml|mp4|mp3|mov|avi|m4a|wav|flac|webm|mkv)))/.exec(
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

/**
 * 收集当前 stream 调用能看到的所有 connector tool。
 *
 * 判断规则：tool 名含 `.` 且不在内置表里。命名空间（点号前半段）通常对应 connector id。
 * 这样我们不需要在 mock 里硬编码"哪些名字是 connector"——而是读 opts.tools 自己决定。
 */
function collectConnectorTools(tools: readonly LlmTool[]): LlmTool[] {
  return tools.filter((t) => {
    if (BUILTIN_TOOL_NAMES.has(t.name)) return false;
    // connector tool 约定是 `namespace.action` 形式（如 video.probe）
    return t.name.includes(".");
  });
}

/** connector 关键字 → tool 名的派发表。
 *
 * 第一列正则命中后，按同名表查 tool 名是否在当前 connector tools 集合里，
 * 不在就跳过——这样 mock 对未来新 connector 自动降级，不会强行调不存在的 tool。
 */
const CONNECTOR_KEYWORDS: ReadonlyArray<{ pattern: RegExp; toolName: string }> = [
  // 探测元信息
  { pattern: /\bprobe\b/i, toolName: "video.probe" },
  { pattern: /(探测|看看|看一下).{0,12}(信息|元数据|metadata|时长|码率)/i, toolName: "video.probe" },
  { pattern: /(元数据|metadata|视频信息|文件信息)/i, toolName: "video.probe" },
  // 剪切/截取
  { pattern: /\b(cut|trim)\b/i, toolName: "video.cut" },
  { pattern: /(剪切|截取)/i, toolName: "video.cut" },
  // 提取音频
  { pattern: /\bextract\s+audio\b/i, toolName: "audio.extract" },
  { pattern: /(提取|抽|分离|剥离).{0,40}?(音频|音轨|声音)/i, toolName: "audio.extract" },
  // 转封装 / 转码
  { pattern: /\bconvert\b/i, toolName: "video.convert" },
  { pattern: /(转码|转换|转封装|转成|换成)/i, toolName: "video.convert" },
];

/**
 * 从用户文本里挑出符合 connector tool schema 的参数。
 * 提取顺序按 schema.required 走，确保必填项都先填上。
 */
function pickArgsForConnector(
  tool: LlmTool,
  userText: string,
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const schema: JsonSchema = tool.parameters;
  const required = schema.required ?? [];

  for (const key of Object.keys(schema.properties)) {
    const prop = schema.properties[key];
    if (prop === undefined) continue;

    if (key === "input") {
      // input 是源文件路径，从用户文本里挑
      const p = pickPath(userText);
      if (p !== null) args[key] = p;
    } else if (key === "output") {
      // 多种用户写法都接受：输出到 / 存为 / 写到 / 转成 / 直接 "到 path"
      const patterns: RegExp[] = [
        /(?:输出到|存为|存到|保存为|输出为|写到|输出文件|目标|转成|变成|换成|output\s*[:：=]?\s*)([`"“”']?)([^`"\n，,。]{1,200})\1/,
        /(?:到|至)\s+(\/[\w./-]+|[^\s，,。`"“”']{1,200})/,
        /(?:as|to)\s+(\/[\w./-]+|[^\s，,。`"“”']{1,200})/i,
      ];
      for (const p of patterns) {
        const m = p.exec(userText);
        if (m !== null) {
          const captured = m[2] ?? m[1];
          if (typeof captured === "string" && captured.length > 0) {
            args[key] = captured.trim();
            break;
          }
        }
      }
      if (args[key] === undefined && required.includes(key)) {
        // 必填但用户没说——给个同目录的合理猜测
        const input = args["input"];
        if (typeof input === "string") {
          const dot = input.lastIndexOf(".");
          args[key] =
            dot > 0 ? `${input.slice(0, dot)}-out${input.slice(dot)}` : `${input}.out`;
        }
      }
    } else if (key === "start") {
      const m = /(?:从|from)\s*([0-9:.]+)/i.exec(userText);
      if (m?.[1] !== undefined) args[key] = m[1];
    } else if (key === "end") {
      const m = /(?:到|到|to)\s*([0-9:.]+)/i.exec(userText);
      if (m?.[1] !== undefined) args[key] = m[1];
    } else if (key === "codec") {
      const m = /(?:用|编码|encoder|codec)[:：]?\s*([a-z0-9_-]+)/i.exec(userText);
      if (m?.[1] !== undefined) args[key] = m[1];
    } else if (key === "audioCodec") {
      const m = /(?:音频编码|audio\s*codec)[:：]?\s*([a-z0-9_-]+)/i.exec(userText);
      if (m?.[1] !== undefined) args[key] = m[1];
    }
  }

  return args;
}

/**
 * 决定这一轮要不要调 connector tool，以及调哪一个。
 *
 * 返回 `null` 表示「让其它分支处理」（比如应该走内置 read / bash）。
 */
function dispatchConnector(
  userText: string,
  connectorTools: readonly LlmTool[],
): MockToolCall | null {
  if (connectorTools.length === 0) return null;

  // 用「最具体优先」的反向匹配：先扫表里所有命中的，挑 description 最短的（最不特异）
  // 实际更稳的做法：让关键字表的顺序就是优先级。表已经按"特异→泛"排好。
  const byName = new Map<string, LlmTool>(connectorTools.map((t) => [t.name, t]));

  for (const { pattern, toolName } of CONNECTOR_KEYWORDS) {
    if (!pattern.test(userText)) continue;
    const tool = byName.get(toolName);
    if (tool === undefined) continue; // 当前没装这个 connector
    const args = pickArgsForConnector(tool, userText);

    // input 是几乎所有 connector tool 的必填项；缺它就让 mock 不要强行调
    const schema: JsonSchema = tool.parameters;
    const required = schema.required ?? [];
    if (required.includes("input") && args["input"] === undefined) return null;

    return { name: toolName, arguments: args };
  }

  return null;
}

/** 决定这一轮要做什么：直接回答，还是调用工具 */
function decide(
  options: StreamOptions,
): {
  thinking: string;
  text: string;
  calls: MockToolCall[];
} {
  const messages = options.messages;
  const userText = lastUserText(messages).trim();
  const results = lastToolResults(messages);
  const connectorTools = collectConnectorTools(options.tools);

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

  // 1) 先问 connector tool——它们命名空间明确，且经常命中 user 关键字
  const connectorCall = dispatchConnector(userText, connectorTools);
  if (connectorCall !== null) {
    return {
      thinking: `用户提到 ${connectorCall.name} 相关意图，调 connector 暴露的 tool。`,
      text: "",
      calls: [connectorCall],
    };
  }

  if (/(列出|有哪些|列一下|找一下所有|目录里有什么)/i.test(userText)) {
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

  // 提示 connector 是否可用
  const toolNames = options.tools.map((t) => t.name);
  const hasConnectors = toolNames.some((n) => n.includes(".") && !BUILTIN_TOOL_NAMES.has(n));

  return {
    thinking: "这是一个普通问题，直接回答。",
    text: [
      `已收到你的请求：${userText || "（空）"}`,
      "",
      "当前运行在 **mock 模型**下，它只能按关键字猜测意图。",
      "想让代理真正干活，请配置 OPENAI_API_KEY 或 ANTHROPIC_API_KEY，",
      "或用 `--model openai:你的模型` 指定。",
      "",
      `可用工具：${toolNames.join(", ")}`,
      ...(hasConnectors
        ? [
            "",
            "（看到 connector tool 了吗？用「探测 / 剪切 / 提取音频 / 转码」等关键字，",
            "mock 会自动派发到对应的 connector tool。）",
          ]
        : []),
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

// ============ 导出仅供测试用 ============

/** 给单测访问内部派发逻辑；测试时直接构造 StreamOptions 调用 */
export function decideForTest(options: StreamOptions): {
  thinking: string;
  text: string;
  calls: MockToolCall[];
} {
  return decide(options);
}

export { collectConnectorTools };
