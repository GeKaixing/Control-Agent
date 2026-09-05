/**
 * transformContext()：在把上下文交给模型之前，对它做修改 / 裁剪 / 重组。
 * 三步走：清理孤儿工具结果 → 压缩旧轮次 → 按 token 预算丢弃最早的整轮。
 */

import type { Tool } from "../tools/types.js";
import { truncateText } from "../tools/fs-utils.js";
import type { AgentMessage, ToolResultMessage } from "../types.js";
import { estimateTokens, activeBranch } from "./state.js";
import type { AgentState } from "./state.js";

export interface TransformOptions {
  /** 模型上下文上限 */
  maxContextTokens: number;
  /** 为回复预留的 token */
  reservedTokens: number;
  /** 无论如何都要保住的最近轮数 */
  keepRecentTurns: number;
  /** 旧工具结果的截断长度 */
  maxToolResultChars: number;
}

export const defaultTransformOptions: TransformOptions = {
  maxContextTokens: 120_000,
  reservedTokens: 8_000,
  keepRecentTurns: 2,
  maxToolResultChars: 4_000,
};

export interface TransformedContext {
  systemPrompt: string;
  messages: AgentMessage[];
  tools: Tool[];
  droppedMessages: number;
  prunedToolResults: number;
}

/** 丢掉没有对应 toolCall 的孤儿工具结果 */
function dropOrphanToolResults(messages: AgentMessage[]): {
  messages: AgentMessage[];
  dropped: number;
} {
  const knownIds = new Set<string>();
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const c of m.content) {
      if (c.type === "toolCall") knownIds.add(c.id);
    }
  }
  const kept = messages.filter(
    (m) => m.role !== "toolResult" || knownIds.has(m.toolCallId),
  );
  return { messages: kept, dropped: messages.length - kept.length };
}

function turnStartIndices(messages: AgentMessage[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === "user") out.push(i);
  }
  return out;
}

/** 压缩较早的轮次：抹掉思考过程、截断冗长的工具结果 */
function pruneOldTurns(
  messages: AgentMessage[],
  options: TransformOptions,
): { messages: AgentMessage[]; pruned: number } {
  const starts = turnStartIndices(messages);
  const keepFrom =
    starts.length > options.keepRecentTurns
      ? (starts[starts.length - options.keepRecentTurns] as number)
      : 0;

  let pruned = 0;
  const out: AgentMessage[] = [];

  for (let index = 0; index < messages.length; index++) {
    const m = messages[index];
    if (m === undefined) continue;
    if (index >= keepFrom) {
      out.push(m);
      continue;
    }

    if (m.role === "assistant") {
      const hadThinking = m.content.some((c) => c.type === "thinking");
      const content = m.content.filter((c) => c.type !== "thinking");
      if (hadThinking) pruned += 1;
      if (content.length === 0) {
        // 只剩思考过程的空消息，补一个占位文本，避免 API 拒收
        out.push({ ...m, content: [{ type: "text", text: "（内容已裁剪）" }] });
      } else {
        out.push({ ...m, content });
      }
      continue;
    }

    if (m.role === "toolResult") {
      const text = m.content.map((c) => c.text).join("\n");
      if (text.length > options.maxToolResultChars) {
        pruned += 1;
        const trimmed: ToolResultMessage = {
          ...m,
          content: [
            { type: "text", text: truncateText(text, options.maxToolResultChars) },
          ],
        };
        out.push(trimmed);
        continue;
      }
    }

    out.push(m);
  }

  return { messages: out, pruned };
}

/** 按 token 预算整轮丢弃，保证上下文结构完整（不会拆散 assistant + toolResult） */
function trimToBudget(
  messages: AgentMessage[],
  systemPrompt: string,
  options: TransformOptions,
): { messages: AgentMessage[]; dropped: number } {
  let current = messages;
  let dropped = 0;
  const budget = options.maxContextTokens - options.reservedTokens;

  while (estimateTokens(current, systemPrompt) > budget) {
    const starts = turnStartIndices(current);
    // 至少保留最后一轮
    if (starts.length <= 1) break;
    const first = starts[0] as number;
    const next = starts[1] as number;
    current = [...current.slice(0, first), ...current.slice(next)];
    dropped += next - first;
  }

  return { messages: current, dropped };
}

export function transformContext(
  state: AgentState,
  overrides?: Partial<TransformOptions>,
): TransformedContext {
  const options = { ...defaultTransformOptions, ...overrides };

  // 输入不再是扁平数组，而是 ★ Current Node 反向遍历得到的线性序列
  // ——这正是 AGENTS.md「概念视图：会话是一棵树」一节描述的 LLM 上下文边界
  // ★ 缺失时（老测试直接给 messages 赋值的兼容路径）fallback 到 messages
  const linear = activeBranch(state);
  const cleaned = dropOrphanToolResults(linear);
  const pruned = pruneOldTurns(cleaned.messages, options);
  const trimmed = trimToBudget(pruned.messages, state.systemPrompt, options);

  return {
    systemPrompt: state.systemPrompt,
    messages: trimmed.messages,
    tools: state.tools,
    droppedMessages: cleaned.dropped + trimmed.dropped,
    prunedToolResults: pruned.pruned,
  };
}
