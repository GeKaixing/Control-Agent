/** 工具注册表 */

import type { LlmTool } from "../providers/types.js";
import { bashTool } from "./bash.js";
import { editTool } from "./edit.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { readTool } from "./read.js";
import type { Tool } from "./types.js";
import { describeSchema } from "./validate.js";
import { writeTool } from "./write.js";

export const allTools: Tool[] = [
  readTool,
  writeTool,
  editTool,
  bashTool,
  globTool,
  grepTool,
];

export function findTool(name: string): Tool | undefined {
  return allTools.find((t) => t.name === name);
}

/** 转成模型可理解的 tool 声明，并把参数签名写进描述里以提高调用准确率 */
export function describeToolsForModel(tools: Tool[] = allTools): LlmTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: `${t.description} 参数：${describeSchema(t.parameters)}`,
    parameters: t.parameters,
  }));
}

export type { Tool, ToolContext, ToolResult } from "./types.js";
export { bashTool, editTool, globTool, grepTool, readTool, writeTool };
