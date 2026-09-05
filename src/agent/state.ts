/** 代理状态：流程图「代理状态」节点的具体形态 */

import type { Tool } from "../tools/types.js";
import type { AgentMessage, ModelRef, ThinkingLevel } from "../types.js";

export interface AgentState {
  systemPrompt: string;
  model: ModelRef;
  messages: AgentMessage[];
  tools: Tool[];
  thinkingLevel: ThinkingLevel;
  cwd: string;
}

export function buildSystemPrompt(cwd: string, toolNames: string[]): string {
  return [
    "你是一个在终端里工作的编码代理。",
    `当前工作目录：${cwd}`,
    `运行时：${process.platform} / Node ${process.version}`,
    "",
    "工作方式：",
    "1. 先用 read / glob / grep 把上下文看清楚，再动手改。",
    "2. 修改文件优先用 edit 做精确替换；只有大段重写时才用 write。",
    "3. 运行命令用 bash，优先选择只读、可重复的命令验证改动。",
    "4. 回答用简体中文，简洁直接，不要复述已经很明显的内容。",
    "",
    `可用工具：${toolNames.join(", ")}`,
  ].join("\n");
}

export function createInitialState(options: {
  cwd: string;
  model: ModelRef;
  tools: Tool[];
  thinkingLevel?: ThinkingLevel;
  systemPrompt?: string;
}): AgentState {
  return {
    systemPrompt:
      options.systemPrompt ??
      buildSystemPrompt(options.cwd, options.tools.map((t) => t.name)),
    model: options.model,
    messages: [],
    tools: options.tools,
    thinkingLevel: options.thinkingLevel ?? "low",
    cwd: options.cwd,
  };
}

/** 粗略估算 token 数：中文按 1.5 字符/token，其余按 4 字符/token */
export function estimateTokens(messages: AgentMessage[], systemPrompt: string): number {
  let chars = systemPrompt.length;
  for (const m of messages) {
    if (m.role === "user") chars += m.content.length;
    else if (m.role === "assistant") {
      for (const c of m.content) {
        if (c.type === "text") chars += c.text.length;
        else if (c.type === "thinking") chars += c.thinking.length;
        else chars += JSON.stringify(c.arguments).length + c.name.length;
      }
    } else {
      for (const c of m.content) chars += c.text.length;
    }
  }
  return Math.ceil(chars / 3.5);
}

export function lastMessage(state: AgentState): AgentMessage | undefined {
  return state.messages[state.messages.length - 1];
}

export function totalUsage(state: AgentState): {
  input: number;
  output: number;
  total: number;
} {
  let input = 0;
  let output = 0;
  for (const m of state.messages) {
    if (m.role !== "assistant") continue;
    input += m.usage.input;
    output += m.usage.output;
  }
  return { input, output, total: input + output };
}
