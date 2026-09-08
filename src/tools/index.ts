/** 工具注册表 */

import type { LlmTool } from "../providers/types.js";
import { bashTool, resolveShell, type ShellSpec } from "./bash.js";
import { computerTool } from "./computer.js";
import { editTool } from "./edit.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { memoryTool } from "./memory.js";
import { readTool } from "./read.js";
import { screenshotTool } from "./screenshot.js";
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
  memory: memoryTool,
  screenshot: screenshotTool,
  computer: computerTool,
} as const;

export const TOOL_REGISTRY = _registry;
export type ToolName = keyof typeof TOOL_REGISTRY;

type _AllAreTools = (typeof _registry)[ToolName] extends Tool ? true : "某个工具不 implements Tool";
const _checkAll: _AllAreTools = true;
void _checkAll;

export const allTools: Tool[] = Object.values(TOOL_REGISTRY);

/**
 * 转成模型可理解的 tool 声明，并把参数签名写进描述里以提高调用准确率。
 * describeSchema 遍历整套 JSON Schema 且每次 stringify，是每轮调模型
 * 都要走的路径 —— 工具表按引用不可变，这里按数组引用缓存结果。
 */
const describeCache = new WeakMap<Tool[], LlmTool[]>();

export function describeToolsForModel(tools: Tool[] = allTools): LlmTool[] {
  const cached = describeCache.get(tools);
  if (cached !== undefined) return cached;

  const described = tools.map((t) => ({
    name: t.name,
    description: `${t.description} 参数：${describeSchema(t.parameters)}`,
    parameters: t.parameters,
  }));
  describeCache.set(tools, described);
  return described;
}

export type { Tool, ToolContext, ToolResult } from "./types.js";
export { bashTool, computerTool, editTool, globTool, grepTool, memoryTool, readTool, screenshotTool, writeTool, resolveShell };
export { memoryPath, MEMORY_FILE } from "./memory.js";
export type { ShellSpec };