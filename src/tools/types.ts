import type { JsonSchema } from "../providers/types.js";
import type { TextContent } from "../types.js";

export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
}

export interface ToolResult {
  content: TextContent[];
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

export function fail(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
