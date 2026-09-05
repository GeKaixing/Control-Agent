/** 终端渲染：把代理事件流式地画出来。 */

import type { AgentEvent } from "../agent/agent.js";
import type { StreamEvent } from "../providers/types.js";
import { createMarkdownStream, type MarkdownStream } from "./markdown.js";

const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

const RESULT_LINES = 12;
const RESULT_LINE_CHARS = 160;

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function formatArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return "";
  return entries
    .map(([k, v]) => {
      const raw = typeof v === "string" ? v : JSON.stringify(v);
      const clipped = raw !== undefined && raw.length > 80 ? `${raw.slice(0, 80)}…` : raw;
      return `${k}=${clipped}`;
    })
    .join(", ");
}

export interface RendererOptions {
  verbose: boolean;
  /**
   * 是否把模型输出的 Markdown 渲染成带样式的终端文本。
   * 默认 true；`--no-markdown` 或输出不是 TTY 时应关掉（转义序列会污染管道）。
   */
  markdown?: boolean;
}

export class TerminalRenderer {
  private verbose: boolean;
  private pendingNewline = false;
  /** 流式 Markdown 渲染：按行攒，避免跨 delta 的标记被切坏 */
  private md: MarkdownStream;

  constructor(options: RendererOptions) {
    this.verbose = options.verbose;
    this.md = createMarkdownStream({ enabled: options.markdown ?? true });
  }

  /** 运行时切换是否显示思考过程（对应 /verbose 命令） */
  setVerbose(verbose: boolean): void {
    this.verbose = verbose;
  }

  handle(event: AgentEvent): void {
    // 任何非文本事件之前，先把行缓冲里没吐完的半行 Markdown 冲出去，
    // 否则工具调用行、用量行会插在一行文字中间
    if (event.type !== "stream") this.flushText();

    switch (event.type) {
      case "agent_start":
        break;

      case "turn_start":
        process.stdout.write("\n");
        this.pendingNewline = false;
        break;

      case "steering":
        for (const text of event.texts) {
          process.stdout.write(`${DIM}↳ 收到中途指令：${text}${RESET}\n`);
        }
        break;

      case "stream":
        this.handleStream(event.event);
        break;

      case "tool_end": {
        const text = event.result.content.map((c) => c.text).join("\n");
        const lines = text.split("\n").slice(0, RESULT_LINES);
        const more = text.split("\n").length > RESULT_LINES ? "\n  …" : "";
        const body = lines
          .map((l) => `  ${l.slice(0, RESULT_LINE_CHARS)}`)
          .join("\n");
        const mark = event.result.isError ? `${RED}✗${RESET}` : `${DIM}✓${RESET}`;
        const tail = event.result.isError ? "" : ` ${DIM}${event.durationMs}ms${RESET}`;
        process.stdout.write(
          `${mark} ${CYAN}${event.toolCall.name}${RESET}${tail}\n${DIM}${body}${more}${RESET}\n`,
        );
        this.pendingNewline = false;
        break;
      }

      case "turn_end": {
        const m = event.message;
        if (m.errorMessage !== undefined && m.errorMessage.length > 0) {
          process.stdout.write(`${RED}模型出错：${m.errorMessage}${RESET}\n`);
        }
        // 中间轮次（还会继续调工具）不打印用量，等最终回答时再给
        const hasToolCalls = m.content.some((c) => c.type === "toolCall");
        if (m.usage.total > 0 && !hasToolCalls) {
          process.stdout.write(
            `${DIM}tokens: ${formatTokens(m.usage.input)} in / ${formatTokens(m.usage.output)} out${RESET}\n`,
          );
        }
        this.pendingNewline = false;
        break;
      }

      case "context_pruned":
        process.stdout.write(
          `${YELLOW}上下文已裁剪：丢弃 ${event.droppedMessages} 条消息，压缩 ${event.prunedToolResults} 处工具结果${RESET}\n`,
        );
        break;

      case "notice":
        process.stdout.write(`${YELLOW}${event.message}${RESET}\n`);
        break;

      case "agent_end":
        if (this.pendingNewline) process.stdout.write("\n");
        break;

      case "tool_start":
        break;
    }
  }

  /** 把流式 Markdown 缓冲里剩下的内容写完（收尾时调用） */
  private flushText(): void {
    const rest = this.md.end();
    if (rest.length === 0) return;
    process.stdout.write(rest);
    this.pendingNewline = !rest.endsWith("\n");
  }

  private handleStream(event: StreamEvent): void {
    switch (event.type) {
      case "text_delta": {
        const out = this.md.push(event.delta);
        if (out.length === 0) {
          // 一整行还没攒满，先不输出，但要知道「有文字在屏上」
          this.pendingNewline = true;
          break;
        }
        process.stdout.write(out);
        this.pendingNewline = !out.endsWith("\n");
        break;
      }

      case "thinking_delta":
        if (this.verbose) {
          process.stdout.write(`${DIM}${event.delta}${RESET}`);
          this.pendingNewline = true;
        }
        break;

      case "toolcall_end": {
        if (this.pendingNewline) process.stdout.write("\n");
        const args = formatArgs(event.toolCall.arguments);
        process.stdout.write(
          `${CYAN}→ ${event.toolCall.name}${RESET}(${DIM}${args}${RESET})\n`,
        );
        this.pendingNewline = false;
        break;
      }

      case "error":
        process.stdout.write(
          `${RED}流错误：${event.error.errorMessage ?? "未知错误"}${RESET}\n`,
        );
        break;

      default:
        break;
    }
  }
}
