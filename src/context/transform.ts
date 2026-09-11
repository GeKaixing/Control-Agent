/**
 * transformContext()：在把上下文交给模型之前，对它做修改 / 裁剪 / 重组。
 * 三步走：清理孤儿工具结果 → 压缩旧轮次 → 按 token 预算迟滞裁剪整轮。
 */

import type { Tool } from "../tools/types.js";
import { truncateText } from "../tools/fs-utils.js";
import type { AgentMessage, ToolResultMessage } from "../types.js";
import { messageChars, activeBranch, DEFAULT_CHARS_PER_TOKEN } from "./state.js";
import type { AgentState } from "./state.js";

export interface TransformOptions {
  /** 模型上下文上限 */
  maxContextTokens: number;
  /** 为回复预留的 token */
  reservedTokens: number;
  /** 无论如何都要保住的最近轮数 */
  keepRecentTurns: number;
  /**
   * 旧轮次工具结果的省略阈值：超过该字符数的结果做压缩处理——
   * 成功结果整体替换成一行占位指针（省一个量级 token，且保留「怎么拿回来」的线索），
   * error 结果保留内容只做头尾截断（通常短而关键）。
   */
  maxToolResultChars: number;
  /**
   * 迟滞裁剪触发线（0~1）：总字符量超过 预算 × ratio 才开始丢整轮。
   * 低于触发线绝不裁剪——两次裁剪之间前缀字节级稳定，provider 的
   * 前缀缓存（按前缀匹配计价）不会因「每轮贴线就丢一轮」而反复全灭。
   */
  trimTriggerRatio: number;
  /** 迟滞裁剪目标线（0~1）：一旦触发，一次丢到 预算 × ratio 为止，而不是裁到刚好贴线 */
  trimTargetRatio: number;
}

export const defaultTransformOptions: TransformOptions = {
  maxContextTokens: 120_000,
  reservedTokens: 8_000,
  keepRecentTurns: 2,
  maxToolResultChars: 4_000,
  trimTriggerRatio: 0.85,
  trimTargetRatio: 0.7,
};

/**
 * 由模型的上下文窗口推导 harness 的裁剪预算 maxContextTokens。
 *
 * 0.9 系数给估算误差留余量（charsPerToken 自校准生效前，字符÷token 的
 * 偏差可达 ±30%）；与迟滞触发线 0.85 叠加后，实际触发点 ≈ 窗口的 0.77，
 * 仍低于真限，正常情况不会撞到模型报 context overflow。
 * 下限保护：再小的窗口也不低于 reservedTokens 的两倍——预算公式是
 * (maxContextTokens − reservedTokens) × charsPerToken，不设下限会算出负预算。
 */
export function maxContextTokensFor(contextWindow: number): number {
  const min = defaultTransformOptions.reservedTokens * 2;
  return Math.max(min, Math.floor(contextWindow * 0.9));
}

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
      // 旧轮截图直接抹掉：图片 token 成本高，历史轮的图没有重看价值
      // （需要时重新调用 screenshot 即可），只留一行线索。
      const hasImage = m.content.some((c) => c.type === "image");
      const text = m.content
        .filter((c): c is Extract<(typeof m.content)[number], { type: "text" }> => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      if (hasImage) {
        pruned += 1;
        out.push({
          ...m,
          content: [
            {
              type: "text",
              text:
                `[${m.toolName} 返回的截图已省略；需要时重新调用 ${m.toolName}]` +
                (text.length > 0 ? `\n${truncateText(text, options.maxToolResultChars)}` : ""),
            },
          ],
        });
        continue;
      }
      if (text.length > options.maxToolResultChars) {
        pruned += 1;
        if (m.isError) {
          // error 结果保留内容，只做头尾截断（老行为）
          const trimmed: ToolResultMessage = {
            ...m,
            content: [
              { type: "text", text: truncateText(text, options.maxToolResultChars) },
            ],
          };
          out.push(trimmed);
        } else {
          // 成功结果整条替换成占位指针：省一个量级的 token，且给模型
          // 「怎么拿回来」的线索——原始调用与参数就在紧邻的 assistant
          // toolCall 消息里（thinking 被抹但 toolCall 保留），重新调用即可。
          out.push({
            ...m,
            content: [
              {
                type: "text",
                text: `[工具结果已省略：${m.toolName}，原 ${text.length} 字符；需要完整输出时重新调用该工具]`,
              },
            ],
          });
        }
        continue;
      }
    }

    out.push(m);
  }

  return { messages: out, pruned };
}

/**
 * 按 token 预算迟滞裁剪整轮，保证上下文结构完整（不会拆散 assistant + toolResult）。
 *
 * 迟滞（prompt-cache 亲和）：总字符量超过 触发线（预算 × trimTriggerRatio）才开始
 * 丢整轮，一次丢到 目标线（预算 × trimTargetRatio）为止。两次裁剪之间消息前缀
 * 字节级稳定——OpenAI 兼容端点的前缀缓存按前缀匹配计价，若裁到刚好贴线，
 * 下一轮很容易又超、又从头丢一轮，整段前缀缓存反复全灭；迟滞让裁剪变成
 * 低频事件，两次裁剪之间每一轮都全量命中缓存。
 *
 * 增量实现：预计算一次全量字符量，每丢一轮只减去被丢消息的字符量，
 * 不再每轮全量重扫 estimateTokens（那是 O(n²)）。
 */
function trimToBudget(
  messages: AgentMessage[],
  systemPrompt: string,
  options: TransformOptions,
  charsPerToken: number,
): { messages: AgentMessage[]; dropped: number } {
  const charBudget =
    (options.maxContextTokens - options.reservedTokens) * charsPerToken;
  const triggerChars = charBudget * options.trimTriggerRatio;
  const targetChars = charBudget * options.trimTargetRatio;

  let total = systemPrompt.length;
  for (const m of messages) total += messageChars(m);

  let current = messages;
  let dropped = 0;

  // 迟滞语义：超触发线才进入；进入后中途不再检查触发线，
  // 一次裁到目标线以下（或只剩最后一轮）为止。
  if (total > triggerChars) {
    for (;;) {
      const starts = turnStartIndices(current);
      // 至少保留最后一轮
      if (starts.length <= 1) break;
      const first = starts[0] as number;
      const next = starts[1] as number;
      for (let i = first; i < next; i++) {
        const m = current[i];
        if (m !== undefined) total -= messageChars(m);
      }
      current = [...current.slice(0, first), ...current.slice(next)];
      dropped += next - first;
      // 已到目标线就收手；继续丢只会白扔缓存
      if (total <= targetChars) break;
    }
  }

  return { messages: current, dropped };
}

/**
 * 自动 compact 的触发判定：估算当前活跃分支的字符量是否越过迟滞触发线。
 *
 * 与 trimToBudget 用同一套预算 / charsPerToken 口径 / 触发线——compact 的触发点
 * 在 transformContext 之前（agent 的内层循环顶部），于是越线时「模型摘要」先于
 * 「丢整轮」执行：摘要保得住要点与结论，机械裁剪做不到。compact 失败时调用方
 * 照旧落入 transformContext，机械裁剪兜底，判定本身不影响正确性。
 */
export function shouldAutoCompact(
  state: AgentState,
  overrides?: Partial<TransformOptions>,
): boolean {
  const options = { ...defaultTransformOptions, ...overrides };
  const charsPerToken = state.observedCharsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
  const charBudget =
    (options.maxContextTokens - options.reservedTokens) * charsPerToken;
  let total = state.systemPrompt.length;
  for (const m of activeBranch(state)) total += messageChars(m);
  return total > charBudget * options.trimTriggerRatio;
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
  const charsPerToken = state.observedCharsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
  const trimmed = trimToBudget(
    pruned.messages,
    state.systemPrompt,
    options,
    charsPerToken,
  );

  return {
    systemPrompt: state.systemPrompt,
    messages: trimmed.messages,
    tools: state.tools,
    droppedMessages: cleaned.dropped + trimmed.dropped,
    prunedToolResults: pruned.pruned,
  };
}
