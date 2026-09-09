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

import { resolveShell } from "../tools/bash.js";
import type { Tool } from "../tools/types.js";
import type {
  AgentMessage,
  AssistantMessage,
  ModelMaturity,
  ModelRef,
  ThinkingLevel,
  UserMessage,
} from "../types.js";
import { emptyUsage } from "../types.js";

/**
 * 种子消息：在 `createInitialState` 时按顺序注入到会话树的最前面。
 * 主要服务于 CLI 的 `--user-prompt` 与 `--assistant-prompt`。
 *
 * - `role: "user"`：当作用户消息写入
 * - `role: "assistant"`：当作助手 prefill 写入（模型会从这里接续）
 */
export interface SeedMessage {
  role: "user" | "assistant";
  content: string;
}

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
  /**
   * 观测的 chars/token 比值（Context 自校准）：agent 每次真实调用模型后，
   * 用「发出去的字符量 ÷ usage.input（prompt_tokens）」做 EMA 更新
   * （见 calibrateCharsPerToken）。undefined = 尚无观测，transform 沿用 3.5。
   */
  observedCharsPerToken?: number;
  /**
   * 会话持久化 id（见 sessions.ts）：saveSession 首次落盘时分配，
   * loadSessionInto 恢复时带回。undefined = 尚未持久化过。
   */
  sessionId?: string;
}

/**
 * 默认系统提示词。两条动态轴（学 pi）：
 * - guidelines 按实际注册的工具集生成——工具不在场就不写对应规则；
 * - 行为纪律规则按模型档位生成——maturity "strong" 的模型自身对齐足够，
 *   「闲聊别调工具」这类为弱模型兜底的规则不再注入（设计哲学：模型变强，能力消失）。
 */
export function buildSystemPrompt(
  toolNames: string[],
  maturity: ModelMaturity = "budget",
): string {
  const names = new Set(toolNames);
  const strong = maturity === "strong";
  const workRules: string[] = [];

  if (!strong) {
    // 恒定第一条：闲聊/纯问答不碰工具（mimo 这档模型必须显式说，学 Cline 句式）
    workRules.push(
      "先判断请求类型：打招呼、闲聊、纯知识问答等不需要接触项目的内容，直接用文字回答，一个工具都不要调用。",
    );
  }

  if (names.has("grep") || names.has("glob")) {
    workRules.push(
      "任务涉及项目内容时，查找优先用 grep / glob 定位，避免整文件大段读入；动手改之前先把上下文看清楚。",
    );
  } else if (!strong) {
    // 兜底句同样是纪律规则，强模型不需要
    workRules.push("只有任务涉及读代码、查文件、改文件或跑命令时才动手；动手前先把上下文看清楚。");
  }
  if (names.has("edit") && names.has("write")) {
    workRules.push("修改文件优先用 edit 做精确替换；只有大段重写时才用 write。");
  }
  if (names.has("bash")) {
    workRules.push("运行命令用 bash，优先选择只读、可重复的命令验证改动。");
  }

  const numbered = workRules.map((rule, i) => `${i + 1}. ${rule}`);
  return [
    "你是一个在终端里工作的编码代理。",
    `运行时：${process.platform} / Node ${process.version}`,
    // Environment 支柱：日期与 shell 是模型最高频的两个猜测源（版本 pin、
    // 「最近」类判断、zsh/bash 语法差异）——事实给足，不写补救规则
    `当前日期：${localDateLine()}`,
    `Shell：${resolveShell().file}（bash 工具的命令按它执行）`,
    "",
    "工作方式：",
    ...numbered,
    `${numbered.length + 1}. 回答用简体中文，简洁直接，不要复述已经很明显的内容。`,
    "",
    `可用工具：${toolNames.join(", ")}`,
  ].join("\n");
}

/** 会话启动时刻的本地日期 + 星期。一次会话跨零日就让它旧着——不值得为它做动态提示词 */
function localDateLine(): string {
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const weekday = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()];
  return `${date}（${weekday}）`;
}

export function createInitialState(options: {
  cwd: string;
  model: ModelRef;
  tools: Tool[];
  thinkingLevel?: ThinkingLevel;
  /** 完整替换默认系统提示词 */
  systemPrompt?: string;
  /**
   * 追加到默认系统提示词末尾（在「可用工具」一节之后）。空字符串等同于不传。
   * 多个来源叠加时用换行 + `# 追加指令` 段拼接，模型能明显看到这是后加的。
   */
  appendSystemPrompt?: string;
  /**
   * 种子消息：按顺序注入到会话树最前面。user 角色作为初始 user 消息，
   * assistant 角色作为 prefill（模型会从这里接续）。
   */
  seedMessages?: SeedMessage[];
}): AgentState {
  const base =
    options.systemPrompt ??
    buildSystemPrompt(options.tools.map((t) => t.name), options.model.maturity);
  const append = options.appendSystemPrompt ?? "";
  const composedSystemPrompt =
    append.length > 0 ? `${base}\n\n# 追加指令\n\n${append}` : base;

  const state: AgentState = {
    systemPrompt: composedSystemPrompt,
    model: options.model,
    nodes: new Map(),
    currentNodeId: null,
    rootId: null,
    messages: [],
    tools: options.tools,
    thinkingLevel: options.thinkingLevel ?? "low",
    cwd: options.cwd,
  };

  if (options.seedMessages !== undefined) {
    for (const seed of options.seedMessages) {
      const message: AgentMessage =
        seed.role === "user"
          ? userMessage(seed.content)
          : assistantPrefill(seed.content, options.model);
      appendNode(state, message);
    }
  }

  return state;
}

/** 把字符串包成 UserMessage，timestamp 由当前时间生成 */
function userMessage(content: string): UserMessage {
  return { role: "user", content, timestamp: Date.now() };
}

/**
 * 把字符串包成 AssistantMessage，作为 prefill 注入。
 * 注意：prefill 必须跟在 user 消息后面才有意义，调用方需要保证顺序。
 */
function assistantPrefill(content: string, model: ModelRef): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: content }],
    model: `${model.provider}:${model.id}`,
    stopReason: "stop",
    usage: emptyUsage(),
    timestamp: Date.now(),
  };
}

/**
 * 单条消息的字符量缓存：消息对象按约定不可变（transform 只创建新对象，不改旧的），
 * 可以按对象身份缓存。最贵的是 toolCall 的 JSON.stringify(arguments)，
 * transformContext 每轮都会重算全量 token，缓存后重复扫描全部命中。
 */
const messageCharsCache = new WeakMap<AgentMessage, number>();

/** 单条消息的字符量（与 estimateTokens 的分项口径一致） */
export function messageChars(m: AgentMessage): number {
  const cached = messageCharsCache.get(m);
  if (cached !== undefined) return cached;

  let chars: number;
  if (m.role === "user") {
    chars = m.content.length;
    // 图片按固定 token 估值（≈1500 token/图，v1 视觉模型的常见计价量级），
    // 不按 base64 字符数算——那会把 token 估算撑爆几个数量级
    if (m.images !== undefined) chars += m.images.length * 5_250;
  } else if (m.role === "assistant") {
    chars = 0;
    for (const c of m.content) {
      if (c.type === "text") chars += c.text.length;
      else if (c.type === "thinking") chars += c.thinking.length;
      else chars += JSON.stringify(c.arguments).length + c.name.length;
    }
  } else {
    chars = 0;
    for (const c of m.content) chars += c.type === "image" ? 6000 : c.text.length;
  }

  messageCharsCache.set(m, chars);
  return chars;
}

/** 粗略估算 token 数：中文按 1.5 字符/token，其余按 4 字符/token */
export function estimateTokens(messages: AgentMessage[], systemPrompt: string): number {
  let chars = systemPrompt.length;
  for (const m of messages) chars += messageChars(m);
  return Math.ceil(chars / 3.5);
}

// ------------------------------------------------------------ token 口径自校准

/** EMA 平滑系数：新观测权重（观测抖动大，不全量采纳） */
const CALIBRATE_ALPHA = 0.3;
/** 合理比值上下界：超出视为异常 provider 口径，丢弃不污染 */
const CHARS_PER_TOKEN_MIN = 1.5;
const CHARS_PER_TOKEN_MAX = 8;

/**
 * 用真实用量反馈修正 chars/token 口径（Context 自校准）。
 * 固定的 3.5 在「中文 + 代码 + JSON arguments」混合场景偏差可达 ±30%；
 * 每次真实调用后，agent 把「发出去的字符量 ÷ usage.input」喂进来做 EMA，
 * transformContext 的预算判断就从「猜」变成「量」。
 * 分母用 usage.input（openai 口径 = prompt_tokens，已含缓存命中部分），不叠 cacheRead。
 */
export function calibrateCharsPerToken(
  state: AgentState,
  charsSent: number,
  inputTokens: number,
): void {
  if (inputTokens <= 0 || charsSent <= 0) return;
  const observed = charsSent / inputTokens;
  if (!Number.isFinite(observed) || observed < CHARS_PER_TOKEN_MIN || observed > CHARS_PER_TOKEN_MAX) {
    return;
  }
  const prior = state.observedCharsPerToken ?? observed;
  state.observedCharsPerToken = prior * (1 - CALIBRATE_ALPHA) + observed * CALIBRATE_ALPHA;
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

  // parent 为 null = 新 Root：compact 会在已有会话上建第二棵树的根，
  // rootId 必须跟着切到当前活跃分支的根，否则就名不副实了
  if (parentId === null || state.rootId === null) state.rootId = id;

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
