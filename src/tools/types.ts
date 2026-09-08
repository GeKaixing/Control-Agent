import type { JsonSchema } from "../providers/types.js";
import type { ImageContent, TextContent } from "../types.js";

export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
}

export interface ToolResult {
  /** 文本块与图片块混排（screenshot 工具返回截图） */
  content: (TextContent | ImageContent)[];
  isError: boolean;
}

export interface Tool {
  name: string;
  description: string;
  parameters: JsonSchema;
  /** 是否会改动文件系统或外部状态。只读工具可安全并行执行 */
  isMutating: boolean;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: false };
}

/** 带图片的成功结果：文本说明 + 截图（Computer Use 通道） */
export function okImage(dataUrl: string, text: string): ToolResult {
  return { content: [{ type: "text", text }, { type: "image", dataUrl }], isError: false };
}

export function fail(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
