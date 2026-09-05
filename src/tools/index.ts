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

/**
 * 单一真相源：所有可用工具的注册表。
 * - `as const` 保留每个 key 的字面量类型，便于派生 ToolName 联合
 * - 编译期验证：每个值都 implements Tool（_AllAreTools）
 *
 * 注意：工具自身的 `name` 字段仍是 `string`，靠测试兜底（tests/run.ts
 * 里有「工具名匹配」的端到端用例）。把 Tool.name 收紧成字面量联合
 * 会导致 types.ts ↔ index.ts 循环依赖，性价比不高。
 */
const _registry = {
  read: readTool,
  write: writeTool,
  edit: editTool,
  bash: bashTool,
  glob: globTool,
  grep: grepTool,
} as const;

export const TOOL_REGISTRY = _registry;
export type ToolName = keyof typeof TOOL_REGISTRY;

type _AllAreTools = (typeof _registry)[ToolName] extends Tool ? true : "某个工具不 implements Tool";
const _checkAll: _AllAreTools = true;
void _checkAll;

export const allTools: Tool[] = Object.values(TOOL_REGISTRY);

/** 按名字查找工具。参数必须是合法工具名（拼错编译期会报错）。 */
export function findTool(name: ToolName): Tool | undefined {
  return TOOL_REGISTRY[name];
}

/** 列出所有可用工具的名字，按注册顺序 */
export function toolNames(): ToolName[] {
  return Object.keys(TOOL_REGISTRY) as ToolName[];
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