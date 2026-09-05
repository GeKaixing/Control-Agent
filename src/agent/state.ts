/**
 * 代理状态：流程图「代理状态」节点的具体形态。
 *
 * 概念视图：会话是一棵树，每条消息是带 parent 指针的节点；★ Current Node
 * 是「LLM 下次接手写的位置」。模型真正看到的上下文 = 从 ★ 反向遍历到 Root
 * 的线性序列（见 AGENTS.md「概念视图：会话是一棵树」一节）。
 *
 * 为保持向后兼容，`state.messages: AgentMessage[]` 仍存在，由 appendNode
 * 同步维护，作为「当前活跃分支的线性视图」。老测试 / index.ts 的
 * `state.messages.length = 0` 复位写法不破坏。
 */

import type { Tool } from "../tools/types.js";
import type { AgentMessage, ModelRef, ThinkingLevel } from "../types.js";

/** 单条消息在树中的位置：每个节点携带 parent 指针指向其上游节点 */
export interface MessageNode {
  id: string;
  /** 上游节点的 id；Root 节点为 null */
  parent: string | null;
  /** 下游节点的 id（按追加顺序）；分支场景下长度 > 1 */
  children: string[];
  message: AgentMessage;
}

export interface AgentState {
  systemPrompt: string;
  model: ModelRef;
  /** 树状存储：每条消息作为节点，parent 指向上一个节点 */
  nodes: Map<string, MessageNode>;
  /** ★ Current Node：LLM 下次接手写的位置；空状态为 null */
  currentNodeId: string | null;
  /** Root 节点 id：会话起点；为空状态为 null */
  rootId: string | null;
  /**
   兼容字段：当前活跃分支的线性视图（★ → Root 反转后的消息列表）。
   appendNode 会同时维护这个数组与 nodes，保证 index.ts / 老测试不破坏。
   *不要直接读这个数组判断上下文*，应该用 `activeBranch(state)`，
   后者在 `currentNodeId === null` 时 fallback 到 messages 数组。
   */
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
    nodes: new Map(),
    currentNodeId: null,
    rootId: null,
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
  // 优先用 ★ Current Node 上的消息；★ 缺失时取 messages 数组末位
  const current = currentNode(state);
  if (current !== undefined) return current.message;
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

// ------------------------------------------------------------ 树状操作

let _idCounter = 0;
/** 生成节点 id：默认用 crypto.randomUUID，失败时回退到自增 */
function newNodeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    try {
      return crypto.randomUUID();
    } catch {
      // 老的 Node 版本或受限环境：fall through
    }
  }
  _idCounter += 1;
  return `n_${Date.now().toString(36)}_${_idCounter}`;
}

/** 取出 ★ Current Node（无则 undefined） */
export function currentNode(state: AgentState): MessageNode | undefined {
  if (state.currentNodeId === null) return undefined;
  return state.nodes.get(state.currentNodeId);
}

/** 从某节点反向遍历到 Root，返回 `[node, parent, ..., root]`；id 非法或空则返回 [] */
export function pathToRoot(state: AgentState, nodeId: string | null): MessageNode[] {
  const out: MessageNode[] = [];
  let id = nodeId;
  const visited = new Set<string>();
  while (id !== null) {
    if (visited.has(id)) break; // 安全：环检测
    visited.add(id);
    const node = state.nodes.get(id);
    if (node === undefined) break;
    out.push(node);
    id = node.parent;
  }
  return out;
}

/**
 * 当前活跃分支的线性序列 = ★ → Root 的反转。
 * ★ 缺失时 fallback 到 `state.messages`（老测试兼容路径）。
 */
export function activeBranch(state: AgentState): AgentMessage[] {
  if (state.currentNodeId === null) return state.messages;
  return pathToRoot(state, state.currentNodeId)
    .reverse()
    .map((n) => n.message);
}

/**
 * 在 ★ Current Node 下追加一条消息，按 AGENTS.md「★ 推进规则」：
 * - 用户消息 / 模型输出 / 工具结果回填都推进到新节点
 * - parent 默认是 ★ 自身
 */
export function appendNode(state: AgentState, message: AgentMessage): MessageNode {
  return addNodeAt(state, state.currentNodeId, message);
}

/**
 * 在指定 parent 下追加一条消息；parent 为 null 时该节点成为新 Root。
 * 调用后 ★ 自动推进到新节点。
 */
export function addNodeAt(
  state: AgentState,
  parentId: string | null,
  message: AgentMessage,
): MessageNode {
  const id = newNodeId();
  const node: MessageNode = {
    id,
    parent: parentId,
    children: [],
    message,
  };
  state.nodes.set(id, node);

  if (parentId !== null) {
    const parent = state.nodes.get(parentId);
    if (parent !== undefined) parent.children.push(id);
  }

  if (state.rootId === null) state.rootId = id;

  // ★ 推进到新节点（这是 AGENTS.md 表格里所有写场景的共同点）
  state.currentNodeId = id;

  // 兼容字段同步：state.messages 始终反映 ★ 所在分支的线性视图。
  // ★ 缺失时（fallback 模式）state.messages 已被外部直接赋值，不动。
  if (parentId !== null) state.messages.push(message);
  else {
    // 新 Root：messages 数组重置为只含这条新消息
    state.messages.length = 0;
    state.messages.push(message);
  }

  return node;
}

/**
 * 切换 ★ Current Node 到指定节点（用于分支切换 / 回放）。
 * 不修改树结构，只是移动 ★；调用方负责把 state.messages 同步到目标分支的线性视图。
 */
export function switchTo(state: AgentState, nodeId: string): MessageNode | undefined {
  const node = state.nodes.get(nodeId);
  if (node === undefined) return undefined;
  state.currentNodeId = nodeId;
  state.messages = activeBranch(state);
  return node;
}
