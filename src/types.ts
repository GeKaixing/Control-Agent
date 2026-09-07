/**
 * 代理内部消息格式（与具体模型厂商无关）。
 * 对应流程图「代理状态 → 消息记录」以及「大模型返回的消息 AssistantMessage」。
 */

export interface TextContent {
  type: "text";
  text: string;
}

/** 用户消息附带的图片（多模态）。dataUrl 与桌面端 Attachment.dataUrl 同形。 */
export interface ImageContent {
  type: "image";
  dataUrl: string;
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
  /** 随消息附带的图片（可选，绝大多数消息没有；正文仍是 content 字符串） */
  images?: ImageContent[];
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

/**
 * "openai" / "anthropic" / "mock" 是协议 provider；其余是厂商预设
 * （src/providers/vendors.ts，全部走 OpenAI 兼容协议，复用 openaiStream）。
 */
export type ProviderId =
  | "openai"
  | "anthropic"
  | "gemini"
  | "mock"
  | "deepseek"
  | "moonshot"
  | "zhipu"
  | "dashscope"
  | "openrouter"
  | "ollama";

/**
 * 模型能力档位（设计哲学：模型变强后，harness 里为弱模型兜底的规则应当消失）。
 * - "budget"（默认）：系统提示词带上闲聊不调工具等行为纪律规则
 * - "strong"：模型自身对齐足够，这些规则不再注入
 */
export type ModelMaturity = "strong" | "budget";

export interface ModelRef {
  provider: ProviderId;
  id: string;
  baseUrl?: string;
  apiKey?: string;
  maxTokens?: number;
  /**
   * 模型上下文窗口（token）。resolveModel 会按内置粗表填充缺省值；
   * 桌面端拿到提供商 /models 元数据后用更准的值覆写。Agent 据此推导
   * 裁剪预算 maxContextTokens（无显式 transform 时）。
   */
  contextWindow?: number;
  /** 缺省按 "budget" 处理（宁多一条规则，不赌模型对齐） */
  maturity?: ModelMaturity;
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
