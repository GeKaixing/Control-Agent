/**
 * 上下文模块统一出口。
 *
 * 这里放着「模型真正看到的那份上下文」的全部实现：
 * - `state.ts`：会话状态（系统提示词、模型、工具、cwd）与会话树（节点 / ★ / 分支）
 * - `transform.ts`：`transformContext` 三步后处理（清理孤儿 → 压缩旧轮 → 按预算裁剪）
 * - `queue.ts`：消息进入上下文前的两条通道（中途插入 steering / 后续指令 followUp）
 * - `sessions.ts`：.c-agent/ 的落盘出口（会话树 + 用户配置），唯一持久化实现
 *
 * 以后新增的上下文相关代码都放本目录，并在这里导出，引用方只认本文件。
 */

export {
  activeBranch,
  addNodeAt,
  appendNode,
  buildSystemPrompt,
  calibrateCharsPerToken,
  createInitialState,
  currentNode,
  estimateTokens,
  messageChars,
  pathToRoot,
  switchTo,
  totalUsage,
} from "./state.js";
export type { AgentState, MessageNode, SeedMessage } from "./state.js";

export {
  defaultTransformOptions,
  maxContextTokensFor,
  shouldAutoCompact,
  transformContext,
} from "./transform.js";
export type { TransformOptions, TransformedContext } from "./transform.js";

export { MessageQueue } from "./queue.js";

export {
  configPath,
  deleteSession,
  latestSessionId,
  listSessions,
  loadSessionInto,
  modelSpecString,
  readSavedCustomModel,
  readSavedModelSpec,
  readSavedWorkspaceCwd,
  saveCustomModel,
  saveModelSpec,
  saveSession,
  saveWorkspaceCwd,
  sessionFileExists,
  sessionsDir,
  type StoredCustomModel,
  type SessionSummary,
} from "./sessions.js";
