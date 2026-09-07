/**
 * convertToLlm()：把代理内部消息转换成模型能直接理解的消息格式。
 * 关键差异在这里被抹平——工具结果会被合并成一条连续的消息块，
 * 具体是「一条一调」还是「打包进一条」，由各适配器自行展开。
 */

import type { LlmContent, LlmMessage } from "../providers/types.js";
import type { AgentMessage, ImageContent } from "../types.js";

export function convertToLlm(messages: AgentMessage[]): LlmMessage[] {
  const out: LlmMessage[] = [];

  for (const m of messages) {
    if (m.role === "user") {
      const images: ImageContent[] = m.images ?? [];
      // 有图无文本也要能通过（正文用占位说明）；两者皆空才跳过
      if (m.content.trim().length === 0 && images.length === 0) continue;
      const content: LlmContent[] = [
        { type: "text", text: m.content.trim().length > 0 ? m.content : "（请看图片）" },
        ...images.map((img) => ({ type: "image" as const, dataUrl: img.dataUrl })),
      ];
      out.push({ role: "user", content });
      continue;
    }

    if (m.role === "assistant") {
      const content: LlmContent[] = [];
      for (const c of m.content) {
        if (c.type === "thinking") {
          if (c.thinking.trim().length > 0) {
            content.push({ type: "thinking", thinking: c.thinking });
          }
        } else if (c.type === "text") {
          if (c.text.length > 0) content.push({ type: "text", text: c.text });
        } else {
          content.push({
            type: "toolCall",
            id: c.id,
            name: c.name,
            arguments: c.arguments,
          });
        }
      }
      // 空消息会被多数 API 拒收
      if (content.length === 0) continue;
      out.push({ role: "assistant", content });
      continue;
    }

    const blocks: LlmContent[] = m.content.map((c) => ({
      type: "toolResult",
      toolCallId: m.toolCallId,
      toolName: m.toolName,
      content: c.text.length > 0 ? [{ type: "text", text: c.text }] : [{ type: "text", text: "（无输出）" }],
      isError: m.isError,
    }));

    const prev = out[out.length - 1];
    if (prev !== undefined && prev.role === "toolResult") {
      prev.content.push(...blocks);
    } else {
      out.push({ role: "toolResult", content: blocks });
    }
  }

  // 部分 API（如 Anthropic）要求首条消息必须是 user
  while (out.length > 0 && out[0].role !== "user") out.shift();

  return out;
}
