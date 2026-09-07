/**
 * 统一大模型接口层：屏蔽 OpenAI / Anthropic / mock 之间的差异。
 * 对应流程图中「统一大模型接口」与「流式响应事件」。
 */

import type {
  AssistantContent,
  AssistantMessage,
  ModelRef,
  StopReason,
  TextContent,
  ThinkingContent,
  ThinkingLevel,
  ToolCallContent,
} from "../types.js";

/** 精简的 JSON Schema 描述，用于工具参数声明与校验 */
export interface JsonSchemaProperty {
  type: "string" | "number" | "integer" | "boolean" | "array" | "object";
  description?: string;
  enum?: readonly string[];
  items?: { type: JsonSchemaProperty["type"] };
  properties?: Record<string, JsonSchemaProperty>;
  required?: readonly string[];
}

export interface JsonSchema {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required?: readonly string[];
  additionalProperties?: boolean;
}

export interface LlmTool {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ToolResultContent {
  type: "toolResult";
  toolCallId: string;
  toolName: string;
  content: TextContent[];
  isError: boolean;
}

/** 用户消息里的图片块（data URL 形态，各适配器自行转成厂商格式） */
export interface ImageBlock {
  type: "image";
  dataUrl: string;
}

export type LlmContent =
  | TextContent
  | ThinkingContent
  | ToolCallContent
  | ToolResultContent
  | ImageBlock;

export type LlmRole = "user" | "assistant" | "toolResult";

/** convertToLlm() 的产物：模型能直接理解的消息格式 */
export interface LlmMessage {
  role: LlmRole;
  content: LlmContent[];
}

export interface StreamOptions {
  model: ModelRef;
  systemPrompt: string;
  messages: LlmMessage[];
  tools: LlmTool[];
  thinkingLevel: ThinkingLevel;
  maxTokens?: number;
  signal?: AbortSignal;
  /**
   * 会话 id（同一会话内稳定、跨会话不同）。部分中继（如 opencode zen go）
   * 要求请求带 x-opencode-session 头做路由/缓存优化，缺失时直接 400 拒绝。
   */
  sessionId?: string;
}

export interface ToolCallSummary {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * 流式响应事件。partial 恒为「截止当前事件」的完整快照，
 * 便于 UI 直接渲染而不必自己累积。
 */
export type StreamEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_delta"; delta: string; partial: AssistantMessage }
  | { type: "thinking_delta"; delta: string; partial: AssistantMessage }
  | { type: "toolcall_delta"; delta: string; partial: AssistantMessage }
  | {
      type: "toolcall_end";
      toolCall: ToolCallSummary;
      partial: AssistantMessage;
    }
  | { type: "done"; reason: StopReason; message: AssistantMessage }
  | { type: "error"; reason: StopReason; error: AssistantMessage };

/** StreamFn：统一的大模型调用入口 */
export type StreamFn = (
  options: StreamOptions,
) => AsyncGenerator<StreamEvent, void, void>;

export interface Provider {
  id: ModelRef["provider"];
  stream: StreamFn;
}

export function toLlmTools(
  tools: ReadonlyArray<{ name: string; description: string; parameters: JsonSchema }>,
): LlmTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

/** 把累积好的内容块交给上层前的类型收窄 */
export function isToolCallBlock(c: AssistantContent): c is ToolCallContent {
  return c.type === "toolCall";
}
