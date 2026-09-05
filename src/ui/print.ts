/**
 * 非交互（print）模式支持。
 *
 * 交互模式下代理事件会被 TerminalRenderer 流式画到终端上，那些进度输出是给人看的；
 * 到了管道/脚本场景它们就变成了噪音。这里把同一批事件收敛成「最终答案」，
 * 让 `npm start -- -p "问题"` 或 `echo "问题" | npm start -- -p` 只吐出答案本身，
 * 诊断信息一律走 stderr，不污染 stdout。
 */

import type { AgentEvent } from "../agent/agent.js";

export interface PrintOutput {
  /** 传给 Agent 的 onEvent：只收集，不写终端 */
  onEvent(event: AgentEvent): void;
  /** 模型最终输出的正文（所有 text_delta 拼起来） */
  readonly answer: string;
  /** 需要提示但不算失败的信息，如上下文裁剪、循环上限 */
  readonly warnings: string[];
  /** 真正的失败：模型报错、调用异常 */
  readonly errors: string[];
  /** 有错为 1，否则 0 */
  readonly exitCode: number;
}

export function createPrintOutput(): PrintOutput {
  const textParts: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];

  function pushError(message: string): void {
    const trimmed = message.trim();
    if (trimmed.length > 0) errors.push(trimmed);
  }

  return {
    onEvent(event: AgentEvent): void {
      switch (event.type) {
        case "stream": {
          const streamEvent = event.event;
          if (streamEvent.type === "text_delta") {
            textParts.push(streamEvent.delta);
          } else if (streamEvent.type === "error") {
            pushError(streamEvent.error.errorMessage ?? "模型返回了未知错误");
          }
          break;
        }

        case "turn_end": {
          // 中断、调用失败等情况会在消息上带 errorMessage
          if (event.message.errorMessage !== undefined) {
            pushError(event.message.errorMessage);
          }
          break;
        }

        case "notice":
          warnings.push(event.message);
          break;

        case "context_pruned":
          warnings.push(
            `上下文已裁剪：丢弃 ${event.droppedMessages} 条消息，压缩 ${event.prunedToolResults} 处工具结果`,
          );
          break;

        default:
          break;
      }
    },

    get answer(): string {
      return textParts.join("");
    },
    get warnings(): string[] {
      return warnings;
    },
    get errors(): string[] {
      return errors;
    },
    get exitCode(): number {
      return errors.length > 0 ? 1 : 0;
    },
  };
}

/** 把管道里的 stdin 全部读成字符串；没有管道时返回空串 */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
