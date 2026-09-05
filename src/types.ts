/**
 * 代理内部消息格式（与具体模型厂商无关）。
 * 对应流程图「代理状态 → 消息记录」以及「大模型返回的消息 AssistantMessage」。
 */

export interface TextContent {
  type: "text";
  text: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
}

export interface ToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type AssistantContent = TextContent | ThinkingContent | ToolCallContent;

export type StopReason = "stop" | "length" | "toolUse" | "aborted" | "error";

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

export interface AssistantMessage {
  role: "assistant";
  content: AssistantContent[];
  model: string;
  stopReason: StopReason;
  errorMessage?: string;
  usage: Usage;
  timestamp: number;
}

export interface UserMessage {
  role: "user";
  content: string;
  timestamp: number;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: TextContent[];
  isError: boolean;
  timestamp: number;
}

export type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage;

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high";

export type ProviderId = "openai" | "anthropic" | "mock";

export interface ModelRef {
  provider: ProviderId;
  id: string;
  baseUrl?: string;
  apiKey?: string;
  maxTokens?: number;
}

export function isToolCallContent(c: AssistantContent): c is ToolCallContent {
  return c.type === "toolCall";
}

export function isTextContent(c: AssistantContent): c is TextContent {
  return c.type === "text";
}

export function assistantText(m: AssistantMessage): string {
  return m.content
    .filter(isTextContent)
    .map((c) => c.text)
    .join("");
}

export function assistantToolCalls(m: AssistantMessage): ToolCallContent[] {
  return m.content.filter(isToolCallContent);
}
