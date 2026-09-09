/**
 * 桌面端的会话管理器：
 * - 共享一个 `AgentState` 与 `MessageQueue`，跨多轮提交保留上下文
 * - 每次 submit 后如果当前没在跑就 `new Agent(...)` + `run()`；如果正在跑则交给
 *   `agent.run()` 内部的 while 循环消化（它会 `drainFollowUps()`）
 * - 串行：当前 run 结束后 maybeStart 检查队列决定是否再起一个 Agent
 *
 * 与 CLI REPL (`src/index.ts`) 的关键差别：
 * - CLI 里 Agent 是个长寿对象，反复 `await agent.run()`；abort 后 controller 永久 aborted
 * - 这里每次都是新 Agent，所以 abort 影响范围天然限于当前轮
 *
 * 模式（mode）/ 暂停（paused）/ 端点（endpoint）/ 推理强度（reasoning）的语义：
 *  - 这些都是"会话级设置"，改了只影响下一次新建的 Agent；
 *  - 不打断当前 turn——避免 turn 中途切 mode 让上下文不一致。
 *  - plan mode 在 Agent.run() 自然结束时停在 plan review 态，需要 `planContinue()`
 *    才续跑下一轮；这与"等待用户确认继续"的语义一致。
 */

import { Agent, type AgentEvent } from "../../src/agent/agent.js";
import {
  MessageQueue,
  estimateTokens,
  maxContextTokensFor,
  modelSpecString,
  totalUsage,
  // 与本类方法名区分：磁盘读写走别名，避免 listSessions 方法名遮蔽
  deleteSession as deleteSessionOnDisk,
  listSessions as listSessionsOnDisk,
  type StoredCustomModel,
} from "../../src/context/index.js";
import type { DisplayEvent } from "../../src/connector/core/types.js";
import {
  assembleSession,
  AUTOPILOT_DONE_SENTINEL_TEXT,
  resolveModelSpec,
  type AssembleOptions,
  type AssembledSession,
  type SessionMode,
} from "../../src/session.js";
import {
  lookupContextWindow,
  lookupKnownContextWindow,
  type ResolvedModel,
} from "../../src/providers/index.js";
import type { AgentState } from "../../src/context/state.js";
import { resolveModel } from "../../src/providers/index.js";
import { BASE_URL_PRESETS } from "../../src/providers/vendors.js";
import { allTools, setAskUserHandler, type AskUserRequest } from "../../src/tools/index.js";
import type { ToolContext } from "../../src/tools/types.js";
import { walkFiles } from "../../src/tools/fs-utils.js";
import { buildApprovalDetail } from "./approval-diff.js";
import { extractLocalServers, mergeLocalServers } from "./local-services.js";
import type {
  InfoPayload,
  UsagePayload,
  SetModelResult,
  ListFilesResult,
  ListModelsResult,
  ModelInfo,
  PersistedSessionInfo,
  DeleteSessionResult,
  RunMode,
  ReasoningLevel,
  EndpointId,
  ToolsByCategory,
  ToolEntry,
  Attachment,
  LocalServerInfo,
  ContextBreakdown,
  CustomModelParams,
} from "../shared/api.js";
import { REASONING_MAX_TOKENS } from "../shared/api.js";
import type { ThinkingLevel, ModelRef, TextContent } from "../../src/types.js";

// SessionManager 内部使用 SessionMode（来自 src/session.ts），对外暴露 RunMode
// （来自 shared/api.ts，渲染层依赖）。两边字段值相同，没必要再开一遍。

/** SessionManager 的可注入依赖，便于单测时替换 push */
export interface SessionDeps {
  /**
   * 显示事件出口：AgentEvent 原始事件 + SessionSignal 会话信号。
   *
   * 消息 UI 实现不在这里——SessionManager 只决定「什么时候发生什么」，
   * 「显示成什么样」（AgentEvent → WireEvent 映射、节流、传输）由
   * connector 体系里的 DisplaySink connector（默认 desktop-display）负责。
   * desktop/main 装配时注入的是 createDisplayRoute() 的产物。
   */
  emit: (event: DisplayEvent) => void;
  /** 当前 cwd，用于 info 回传 */
  cwd: () => string;
  /**
   * listModels 用的 fetch。默认 globalThis.fetch；单测注入 fake 以覆盖
   * 缓存 / 超时 / 错误路径，不打真网络。
   */
  fetchModels?: typeof fetch;
  /**
   * Permission 支柱：审批弹窗（approvalMode 开启时，mutating 工具执行前调用）。
   * 主进程注入 Electron dialog 实现；单测注入 fake。返回 "allow"（本次允许）/
   * "always"（本会话全部允许）/ "deny"（拒绝）。注入缺失时按 deny 处理（fail-safe）。
   */
  approvalPrompt?: (req: { toolName: string; args: string }) => Promise<"allow" | "always" | "deny">;
  /**
   * 模型变更后的持久化钩子：主进程注入（写 .c-agent/config.json，与 CLI 共用同一份）。
   * 缺省 noop——单测不落盘。spec 版触发点：setModel / setEndpoint 成功后。
   */
  persistModel?: (spec: string) => void;
  /**
   * 自定义模型持久化钩子（同写 .c-agent/config.json，与 spec 互斥——最后一次的
   * 选择是唯一真相）。触发点：setCustomModel 成功后。完整参数（provider/id/
   * baseUrl/apiKey/contextWindow）自描述，重启后可直接重建 ModelRef——
   * 早期版本「自定义模型不落盘」是错的：那正是用户重启后配置全丢的原因。
   */
  persistCustomModel?: (custom: StoredCustomModel) => void;
}

// ────────────── 动态模型列表（可配置） ──────────────

/** 模型列表缓存 TTL（毫秒）。同端点 5 分钟内重复打开下拉不再打网络。 */
export const MODELS_CACHE_TTL_MS = 5 * 60 * 1000;
/** 单次 /models 请求的超时（毫秒） */
export const MODELS_FETCH_TIMEOUT_MS = 8000;

/**
 * 各端点的 baseUrl（与 providers 里 defaultModel 的取值保持一致）。
 * 注意语义差异：openai 的 baseUrl 含 /v1（openai.ts 拼 `${baseUrl}/chat/completions`），
 * anthropic 的不含（anthropic.ts 拼 `${baseUrl}/v1/messages`）——所以 models URL 推导不同。
 */
function endpointBaseUrl(endpoint: EndpointId): string | undefined {
  if (endpoint === "openai") return process.env["OPENAI_BASE_URL"] ?? "https://api.openai.com/v1";
  if (endpoint === "anthropic") {
    return process.env["ANTHROPIC_BASE_URL"] ?? "https://api.anthropic.com";
  }
  if (endpoint === "gemini") {
    return process.env["GEMINI_BASE_URL"] ?? "https://generativelanguage.googleapis.com/v1beta";
  }
  return undefined;
}

/**
 * 解析「拉取可用模型列表」的 URL。可配置优先：
 *  1. env 显式覆盖：OPENAI_MODELS_URL / ANTHROPIC_MODELS_URL（完整 URL，可指向任意
 *     OpenAI 兼容 /models 端点，例如 https://opencode.ai/zen/go/v1/models）
 *  2. 按 baseUrl 推导：openai → `${baseUrl}/models`；anthropic → `${baseUrl}/v1/models`
 *  3. mock 无 URL（返回 undefined，走固定列表）
 */
export function resolveModelsUrl(endpoint: EndpointId): string | undefined {
  if (endpoint === "openai") {
    return process.env["OPENAI_MODELS_URL"] ?? `${endpointBaseUrl("openai")}/models`;
  }
  if (endpoint === "anthropic") {
    return process.env["ANTHROPIC_MODELS_URL"] ?? `${endpointBaseUrl("anthropic")}/v1/models`;
  }
  if (endpoint === "gemini") {
    return process.env["GEMINI_MODELS_URL"] ?? `${endpointBaseUrl("gemini")}/models`;
  }
  return undefined;
}

/** 端点 /models 请求的鉴权 headers（有 key 才带）。 */
function modelsAuthHeaders(endpoint: EndpointId): Record<string, string> {
  if (endpoint === "openai") {
    const key = process.env["OPENAI_API_KEY"] ?? "";
    return key.length > 0 ? { authorization: `Bearer ${key}` } : {};
  }
  if (endpoint === "anthropic") {
    const key = process.env["ANTHROPIC_API_KEY"] ?? "";
    const out: Record<string, string> = { "anthropic-version": "2023-06-01" };
    if (key.length > 0) out["x-api-key"] = key;
    return out;
  }
  if (endpoint === "gemini") {
    const key = process.env["GEMINI_API_KEY"] ?? process.env["GOOGLE_API_KEY"] ?? "";
    return key.length > 0 ? { "x-goog-api-key": key } : {};
  }
  return {};
}

/**
 * 按协议构造 /models 请求的鉴权 headers（纯函数，key 由调用方给定）：
 *  - openai 兼容（含 responses）→ `authorization: Bearer <key>`
 *  - anthropic   → `x-api-key` + `anthropic-version`
 *  - gemini      → `x-goog-api-key`
 * key 为空（或占位 "EMPTY"）时不带鉴权字段——本地端点（ollama 等）无 key 也能拉。
 */
function authHeadersForProtocol(protocol: string, key: string): Record<string, string> {
  const hasKey = key.length > 0 && key !== "EMPTY";
  if (protocol === "anthropic") {
    const out: Record<string, string> = { "anthropic-version": "2023-06-01" };
    if (hasKey) out["x-api-key"] = key;
    return out;
  }
  if (protocol === "gemini") {
    return hasKey ? { "x-goog-api-key": key } : {};
  }
  return hasKey ? { authorization: `Bearer ${key}` } : {};
}

/**
 * 解析 /models 响应，按端点分两种格式：
 *  - openai（含各 OpenAI 兼容厂商）：`{ object: "list", data: [{ id, owned_by?, ... }] }`
 *  - gemini：`{ models: [{ name: "models/gemini-…", displayName?, inputTokenLimit? }] }`，name 剥掉 "models/" 前缀
 * contextWindow 三级来源：响应元数据（context_window / context_length /
 * inputTokenLimit）→ 内核粗表严格命中（lookupKnownContextWindow，识别的模型家族
 * 如 deepseek/kimi/claude）→ 都没有就留空（UI 不显示）——未知模型不猜，展示值
 * 宁缺毋滥；分母/预算场景另有 1M 兜底版 lookupContextWindow，不在这条链路上。
 * 宽容处理：数组不是数组 / 条目缺标识 → 报错（error 回传前端）；元数据尽力读取，没有就不填。
 */
export function parseModelsResponse(raw: unknown, endpoint: EndpointId = "openai"): ModelInfo[] {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("/models 响应不是 JSON 对象");
  }
  if (endpoint === "gemini") {
    const models = (raw as { models?: unknown })["models"];
    if (!Array.isArray(models)) throw new Error("/models 响应缺少 models 数组");
    const out: ModelInfo[] = [];
    for (const item of models) {
      if (typeof item !== "object" || item === null) continue;
      const rec = item as Record<string, unknown>;
      const rawName = rec["name"];
      if (typeof rawName !== "string" || rawName.length === 0) continue;
      const id = rawName.replace(/^models\//, "");
      if (id.length === 0) continue;
      const info: ModelInfo = { id };
      if (typeof rec["displayName"] === "string" && rec["displayName"].length > 0) {
        info.ownedBy = rec["displayName"];
      }
      const ctx = rec["inputTokenLimit"];
      if (typeof ctx === "number" && Number.isFinite(ctx) && ctx > 0) {
        info.contextWindow = Math.round(ctx);
      } else {
        const known = lookupKnownContextWindow(id);
        if (known !== undefined) info.contextWindow = known;
      }
      out.push(info);
    }
    if (out.length === 0) throw new Error("/models 响应里没有可用模型条目");
    return out;
  }
  const data = (raw as { data?: unknown })["data"];
  if (!Array.isArray(data)) {
    throw new Error("/models 响应缺少 data 数组");
  }
  const out: ModelInfo[] = [];
  for (const item of data) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const id = rec["id"];
    if (typeof id !== "string" || id.length === 0) continue;
    const info: ModelInfo = { id };
    const ownedBy = rec["owned_by"] ?? rec["ownedBy"];
    if (typeof ownedBy === "string" && ownedBy.length > 0) info.ownedBy = ownedBy;
    const ctx = rec["context_window"] ?? rec["context_length"] ?? rec["contextWindow"];
    if (typeof ctx === "number" && Number.isFinite(ctx) && ctx > 0) {
      info.contextWindow = Math.round(ctx);
    } else {
      const known = lookupKnownContextWindow(id);
      if (known !== undefined) info.contextWindow = known;
    }
    out.push(info);
  }
  if (out.length === 0) {
    throw new Error("/models 响应里没有可用模型条目");
  }
  return out;
}

function defaultCwd(): string {
  return process.cwd();
}

/**
 * 造一个「与 s 同配置的空会话」：systemPrompt / model / tools / thinkingLevel / cwd
 * 原样共享（都是只读配置），消息树清零。newSession 的归档实现用。
 */
function emptyStateLike(s: AssembledSession["state"]): AssembledSession["state"] {
  return {
    ...s,
    nodes: new Map(),
    currentNodeId: null,
    rootId: null,
    messages: [],
  };
}

/**
 * ModelRef 没 label 字段，手动拼出来给 UI。
 * 前缀用「厂商名」而不是协议 provider：baseUrl 域名推得出来就用域名
 * （如 `https://opencode.ai/zen/go/v1` → `opencode`，`api.openai.com` → `openai`），
 * 推不出来（mock / 无 baseUrl）回退 provider。
 */
function modelLabel(m: { provider: string; id: string; baseUrl?: string }): string {
  let vendor = m.provider;
  if (m.baseUrl) {
    try {
      const host = new URL(m.baseUrl).hostname.replace(/^(api|www)\./, "");
      const seg = host.split(".")[0];
      if (seg) vendor = seg;
    } catch {
      // 非法 URL 保持 provider
    }
  }
  return `${vendor}:${m.id}`;
}

/** 原始 spec（"provider:modelId"），给弹层的选中态比对用——label 前缀是厂商名，不能再当 spec 比 */
function modelSpecOf(m: { provider: string; id: string }): string {
  return `${m.provider}:${m.id}`;
}

/**
 * 解析用户输入的上下文窗口：纯数字 / k / m 后缀（大小写不限，256k → 262144）。
 * 空 → undefined（自动识别）；格式不合法 / 非正数 → throw（dispatchApi 转为
 * rejected promise，弹层里可见）。
 */
export function parseContextWindowInput(raw: string | undefined): number | undefined {
  const s = (raw ?? "").trim().toLowerCase();
  if (s.length === 0) return undefined;
  const m = s.match(/^(\d+(?:\.\d+)?)([km])?$/);
  if (m === null) {
    throw new Error(`上下文窗口格式不合法：${raw}（示例：1000000、256k、1m）`);
  }
  const n = Number(m[1]) * (m[2] === "k" ? 1_000 : m[2] === "m" ? 1_000_000 : 1);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`上下文窗口需为正数：${raw}`);
  }
  return Math.round(n);
}


/**
 * 自定义模型（带显式 baseUrl）自己的 /models URL，推导规则与 resolveModelsUrl
 * 一致，只是 base 来自模型本身而不是 env：
 *  - openai（base 填到 …/v1）→ `${base}/models`
 *  - anthropic（base 为根路径）→ `${base}/v1/models`
 *  - gemini（base 填到 …/v1beta）→ `${base}/models`
 */
function modelsUrlForBaseUrl(provider: string, baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return provider === "anthropic" ? `${base}/v1/models` : `${base}/models`;
}

/**
 * 扫描当前可用工具并按来源分组。
 * `tool` = src/tools/index.ts 的核心内置工具；`mcp` = Connector Runtime 注入的
 * extraTools（browser-use / mcp-memory 等，判定与 contextBreakdown 同口径：
 * 不在 allTools 内置表里即连接器工具）。skill / plugin / extension 仍是分组骨架。
 *
 * mode=answer_only 时 state.tools 为空，两个分组自然都空，无需特判。
 */
function listToolsByCategory(state: AgentState): ToolsByCategory {
  const out: ToolsByCategory = {
    skill: [],
    tool: [],
    mcp: [],
    plugin: [],
    extension: [],
  };
  const builtinNames = new Set(allTools.map((t) => t.name));
  for (const t of state.tools) {
    if (builtinNames.has(t.name)) {
      out.tool.push({
        name: t.name,
        description: t.description,
        category: "tool",
        source: `core:src/tools/${t.name}.ts`,
      });
    } else {
      out.mcp.push({
        name: t.name,
        description: t.description,
        category: "mcp",
        source: "connector",
      });
    }
  }
  return out;
}

function isValidMode(m: unknown): m is RunMode {
  return m === "answer_only" || m === "plan" || m === "full" || m === "autopilot";
}

/** 远行模式单次任务的连续自动续跑上限（防失控烧 token）。 */
const AUTOPILOT_MAX_ROUNDS = 20;

/** 取最后一条 assistant 消息的正文拼接（远行哨兵检测用）；没有 assistant 消息时 null。 */
function lastAssistantText(messages: AssembledSession["state"]["messages"]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (m.role !== "assistant") continue;
    return m.content
      .filter((c): c is Extract<(typeof m)["content"][number], { type: "text" }> => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  }
  return null;
}

function isValidReasoning(r: unknown): r is ReasoningLevel {
  return r === "auto" || r === "fast" || r === "balanced" || r === "ultra";
}

/** reasoning → state.thinkingLevel 基准档。auto 用 low 做动态升降的起点。 */
function thinkingLevelFor(reasoning: ReasoningLevel): ThinkingLevel {
  switch (reasoning) {
    case "auto":
    case "fast":
      return "low";
    case "balanced":
      return "medium";
    case "ultra":
      return "high";
  }
}

function isValidEndpoint(e: unknown): e is EndpointId {
  return e === "mock" || e === "openai" || e === "anthropic" || e === "gemini";
}

/** 审批请求的参数摘要已升级为 diff 预览：bash 给命令、write/edit 给 -/+ diff，见 approval-diff.ts */

/** reasoning → maxTokens。auto 不锁上限（走端点默认）；mock 跳过此值（mock provider 不读 maxTokens）。 */
function maxTokensFor(reasoning: ReasoningLevel, endpoint: EndpointId): number | undefined {
  if (endpoint === "mock" || reasoning === "auto") return undefined;
  return REASONING_MAX_TOKENS[reasoning];
}

/**
 * plan mode 下希望系统在第一轮就把"先 plan 后执行"的精神注入到 system prompt；
 * 用 src/session.assembleSession 的 mode 字段既可。RunMode 与 SessionMode 字段
 * 值完全相同，直接传即可，无需再开函数。
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _runModeIsSessionMode: Record<RunMode, SessionMode> = {
  answer_only: "answer_only",
  plan: "plan",
  full: "full",
  autopilot: "autopilot",
};
void _runModeIsSessionMode;

export class SessionManager {
  private state: AssembledSession["state"];
  private queue: MessageQueue;
  private resolved: ResolvedModel;
  private readonly deps: SessionDeps;
  private currentAgent: Agent | null = null;
  private mode: RunMode = "full";
  private reasoning: ReasoningLevel = "balanced";
  private endpoint: EndpointId = "mock";
  /** modelSpec 文本（"openai:gpt-4o-mini"），切端点时保留当前 model id 不变 */
  private modelSpecCache = "mock";
  /** plan 模式下，agent 跑完一轮是否停在 review 状态等待用户点继续 */
  private planPending = false;
  private planRound = 0;
  /**
   * 远行（autopilot）模式：本次任务已连续自动续跑的轮数。
   * 用户发新消息时清零（新指令 → 新预算）；达到上限自动停下等用户。
   */
  private autopilotRounds = 0;
  /**
   * /models 元数据缓存：key = 实际请求的 URL（端点推导 URL 与自定义模型
   * 直连 URL 各存一份）。info() 的 contextWindow 优先从这里取提供商给的值。
   */
  private modelsCache = new Map<string, { at: number; result: ListModelsResult }>();

  // ────────────── Permission：审批模式 ──────────────
  /** 审批模式开关：mutating 工具执行前逐次询问用户 */
  private approvalMode = false;
  /** 「本会话全部允许」记忆：用户在弹窗里选过一次全部允许后置 true */
  private approvalAlways = false;
  /** 审批请求自增序号（WireEvent id 用） */
  private approvalSeq = 0;

  // ────────────── ask_user：模型 → 用户提问通道 ──────────────
  /** 提问请求自增序号（WireEvent id 用） */
  private askSeq = 0;
  /** 等用户回答的提问：id → resolve。answerAsk / abort 时唤醒。 */
  private readonly pendingAsks = new Map<string, (answer: string | null) => void>();

  // ────────────── Context：自动压缩开关 ──────────────
  /** 自动 compact 开关（设置弹窗）；传给每次新建的 Agent，setter 同时打到当前 Agent */
  private autoCompact = true;

  // ────────────── 独立消息弹窗开关 ──────────────
  /**
   * 独立消息弹窗（设置弹窗）：默认不开启。只存偏好——窗口的创建/销毁在
   * index.ts 的 IPC handler 里做（SessionManager 不碰 BrowserWindow）。
   */
  private msgWindow = false;

  // ────────────── 窗口置顶 ──────────────
  /** 「窗口置顶」开关（设置弹窗）：默认不开启。只存偏好——setAlwaysOnTop 的实际
   * 调用在 index.ts 的 IPC handler 里做（SessionManager 不碰 BrowserWindow）。 */
  private alwaysOnTop = false;

  // ────────────── agent 本地服务预览 ──────────────
  /** 「agent 开启的本地服务预览」开关（设置弹窗）：默认不开启，只控制 UI 入口可见性。 */
  private localPreview = false;
  /**
   * 检测到的 agent 本地服务：bash 工具输出里出现 localhost 地址时记录。
   * 无论开关开与否都照常收集（开关只管 UI 展示），随 info() 下发。
   */
  private localServers: LocalServerInfo[] = [];

  // ────────────── 多会话（← → 切换） ──────────────
  /**
   * 会话归档：所有「活着」的会话状态按创建顺序排列。newSession 把当前 state
   * 归档（引用不变，跑着的 Agent 还能写完最后一轮）并追加一个空会话；
   * switchSession 只移动指针，不销毁任何会话。
   */
  private sessions: AssembledSession["state"][] = [];
  private sessionIdx = 0;
  /** 每个会话各自的 plan review 状态（切走再切回不丢）+ 审批「全部允许」授权 */
  private sessionMeta: Array<{ planPending: boolean; planRound: number; approvalAlways: boolean }> = [];
  /**
   * 每个会话的标题：第一条用户消息生成（截前 24 个字符），还没发过消息就是「新会话」。
   * 与 sessions / sessionMeta 平行维护；info() 下发给渲染层显示在标题栏。
   */
  private sessionTitles: string[] = ["新会话"];
  /** 每个会话是否已经用第一条用户消息生成过标题（true 后不再改） */
  private sessionTitleLocked: boolean[] = [false];

  // ────────────── pause gate ──────────────
  private paused = false;
  /**
   * 一个 resolve 函数，等 `resume()` 调用。每次 `pause()` 都新建一个 Promise
   * 并把它的 resolve 存在这里；`resume()` 时调它解开 await。
   * 注：这是 await-on-event 的最小实现；不引入 EventEmitter。
   */
  private resumeCb: (() => void) | null = null;

  constructor(assembled: AssembledSession, deps: Partial<SessionDeps> = {}) {
    this.state = assembled.state;
    // 把 reasoning 档位落到 thinkingLevel（auto/fast→low，balanced→medium，ultra→high）
    this.state.thinkingLevel = thinkingLevelFor(this.reasoning);
    this.sessions = [assembled.state];
    this.sessionMeta = [{ planPending: false, planRound: 0, approvalAlways: false }];
    this.sessionTitles = ["新会话"];
    this.sessionTitleLocked = [false];
    this.queue = assembled.queue;
    this.resolved = assembled.resolved;
    this.endpoint = inferEndpointFromProvider(assembled.resolved.model.provider);
    const cwdFn = deps.cwd ?? defaultCwd;
    this.deps = {
      emit: deps.emit ?? (() => {}),
      cwd: cwdFn,
      // fetchModels 可选注入（listModels 单测用）；不传走 globalThis.fetch
      ...(deps.fetchModels !== undefined ? { fetchModels: deps.fetchModels } : {}),
      // approvalPrompt 可选注入（审批弹窗）；不传且 approvalMode 开启时按 deny 处理
      ...(deps.approvalPrompt !== undefined ? { approvalPrompt: deps.approvalPrompt } : {}),
      // persistModel 可选注入（模型选择落盘）；不传 noop，单测不写盘
      ...(deps.persistModel !== undefined ? { persistModel: deps.persistModel } : {}),
      ...(deps.persistCustomModel !== undefined
        ? { persistCustomModel: deps.persistCustomModel }
        : {}),
    };

    // ask_user 通道：handler 是 src/tools/ask-user.ts 的模块级单例。桌面端全程
    // 只有一个 SessionManager 实例，构造时注入一次即可（所有新建 Agent 共享）。
    setAskUserHandler((req, ctx) => this.askUser(req, ctx));
  }

  get isRunning(): boolean {
    return this.currentAgent !== null;
  }

  getMode(): RunMode {
    return this.mode;
  }

  getReasoning(): ReasoningLevel {
    return this.reasoning;
  }

  isPaused(): boolean {
    return this.paused;
  }

  isPlanPending(): boolean {
    return this.planPending;
  }

  getEndpoint(): EndpointId {
    return this.endpoint;
  }

  getState(): AssembledSession["state"] {
    return this.state;
  }

  info(): InfoPayload {
    const tools = this.state.tools.map((t) => t.name);
    const out: InfoPayload = {
      cwd: this.deps.cwd(),
      model: modelLabel(this.resolved.model),
      modelSpec: modelSpecOf(this.resolved.model),
      tools,
      // 上下文窗口：优先取提供商 /models 元数据（providerContextWindow），
      // 端点没给该字段或元数据未拉到时回退内置粗表——分母永远有值
      contextWindow: this.currentContextWindow(),
      baseURL: this.resolved.model.baseUrl ?? "(未设置 base URL)",
      mode: this.mode,
      paused: this.paused,
      reasoning: this.reasoning,
      endpoint: this.endpoint,
      maxTokens: maxTokensFor(this.reasoning, this.endpoint) ?? 0,
      planPending: this.planPending,
      approvalMode: this.approvalMode,
      autoCompact: this.autoCompact,
      msgWindow: this.msgWindow,
      localPreview: this.localPreview,
      alwaysOnTop: this.alwaysOnTop,
      localServers: this.localServers.map((s) => ({ ...s })),
      sessionTitle: this.sessionTitles[this.sessionIdx] ?? "新会话",
      lastUserPrompt: this.lastUserPrompt(),
      toolsByCategory: listToolsByCategory(this.state),
      contextBreakdown: this.contextBreakdown(),
      baseUrlPresets: BASE_URL_PRESETS.map((p) => ({
        label: p.label,
        baseURL: p.baseURL,
        ...(p.defaultModel !== undefined ? { defaultModel: p.defaultModel } : {}),
        ...(p.modelHint !== undefined ? { modelHint: p.modelHint } : {}),
      })),
    };
    if (this.resolved.degraded !== undefined) {
      out.degraded = this.resolved.degraded;
    }
    return out;
  }

  /**
   * 上下文构成分项估算：模型每次请求实际吃到的输入按来源拆五段。
   * 口径与 estimateTokens 一致（字符数 / 3.5，中文再打折）——UI 参考值，非计费值。
   *
   * - 系统提示词 / 对话消息直接来自 AgentState；
   * - 工具 vs 连接器按「是否在 allTools 内置表」划分：内置 6 件的 schema 算工具，
   *   Connector Runtime 注册的 extraTools（MCP / ffmpeg 等）算连接器；
   * - 技能 v1 尚未注入上下文，恒 0（字段占位，未来 skill 落地时填）。
   */
  contextBreakdown(): ContextBreakdown {
    const builtinNames = new Set(allTools.map((t) => t.name));
    let toolChars = 0;
    let connectorChars = 0;
    for (const t of this.state.tools) {
      // schema + 描述 + 名字：provider 把整个 Tool 定义序列化进请求，这里按同范围估
      const chars =
        t.name.length + t.description.length + JSON.stringify(t.parameters).length;
      if (builtinNames.has(t.name)) toolChars += chars;
      else connectorChars += chars;
    }
    const toTok = (chars: number): number => Math.ceil(chars / 3.5);
    return {
      systemPrompt: estimateTokens([], this.state.systemPrompt),
      tools: toTok(toolChars),
      connectors: toTok(connectorChars),
      skills: 0,
      messages: estimateTokens(this.state.messages, ""),
    };
  }

  usage(): UsagePayload {
    const u = totalUsage(this.state);
    return { input: u.input, output: u.output, total: u.total };
  }

  /** 本会话最后一条用户消息原文（输入框 placeholder / 「复制提示词」按钮用）；没有则 null */
  private lastUserPrompt(): string | null {
    const msgs = this.state.messages;
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      const m = msgs[i]!;
      if (m.role !== "user") continue;
      const text = m.content.trim();
      if (text.length > 0) return text;
    }
    return null;
  }

  /**
   * 会话清单（「选择会话」popover 用）：当前位置 + 总数 + 各会话标题。
   * 标题来自 sessionTitles（首条用户消息生成，没发过消息是「新会话」）。
   */
  listSessions(): { index: number; total: number; titles: string[] } {
    return {
      index: this.sessionIdx,
      total: this.sessions.length,
      titles: this.sessionTitles.slice(),
    };
  }

  /**
   * 「活着的」会话 id 集合：本窗口所有标签页已落盘的 sessionId。
   * 这些文件每轮 agent_end 都会被自动保存覆盖——删了也会立刻重建，
   * 历史清单里要标 locked 并拒绝删除。
   */
  private liveSessionIds(): Set<string> {
    const out = new Set<string>();
    for (const s of this.sessions) {
      if (typeof s.sessionId === "string") out.add(s.sessionId);
    }
    return out;
  }

  /**
   * 磁盘上的持久化会话清单（.c-agent/sessions/，新的在前）。与内存标签页
   * （listSessions）是两个集合：这里含 CLI 与之前退出时落盘的会话。
   * 使用中（任一标签页占用）的条目标 locked，UI 禁删。
   */
  async listPersistedSessions(): Promise<PersistedSessionInfo[]> {
    const live = this.liveSessionIds();
    const list = await listSessionsOnDisk(this.deps.cwd());
    return list.map((s) => ({ id: s.id, savedAt: s.savedAt, nodeCount: s.nodeCount, locked: live.has(s.id) }));
  }

  /**
   * 删除一条持久化会话文件。使用中的会话拒绝（自动保存会重建，删了是假动作）；
   * 其余交给内核 deleteSession（id 字符集校验堵路径穿越，坏输入 ok:false 不抛错）。
   */
  async deletePersistedSession(id: string): Promise<DeleteSessionResult> {
    if (this.liveSessionIds().has(id)) {
      return { ok: false, error: "该会话正在使用中（自动保存会重建文件），请先关闭对应标签页" };
    }
    const ok = await deleteSessionOnDisk(this.deps.cwd(), id);
    return ok ? { ok: true } : { ok: false, error: "会话不存在或无法删除" };
  }

  /** 模型选择落盘（deps.persistModel 注入，缺省 noop）。spec 从 resolved.model 现算，最真实。 */
  private persistModelChoice(): void {
    this.deps.persistModel?.(modelSpecString(this.resolved.model));
  }

  /** 切换模型。下一次新建的 Agent 才生效；当前不打断。spec 格式 "provider:modelId"。 */
  setModel(spec: string): SetModelResult {
    this.modelSpecCache = spec;
    const { resolved } = resolveModelSpec(spec);
    this.resolved = applyReasoningToResolved(resolved, this.reasoning, this.endpoint);
    this.endpoint = inferEndpointFromProvider(this.resolved.model.provider);
    this.persistModelChoice();
    const out: SetModelResult = {
      model: modelLabel(this.resolved.model),
      maxTokens: this.resolved.model.maxTokens ?? 0,
    };
    if (this.resolved.degraded !== undefined) {
      out.degraded = this.resolved.degraded;
    }
    return out;
  }

  /**
   * 「自定义模型」弹窗（三要素 + 协议）→ 直接构造 ModelRef，不走 spec 解析：
   *  - openai（缺省）：baseUrl 填到版本目录（…/v1），/chat/completions 由 openai.ts 拼——尾部 / 剥掉
   *  - anthropic：baseUrl 是根路径（anthropic.ts 拼 /v1/messages）——用户手滑带 /v1 时剥掉
   *  - gemini：baseUrl 填到 /v1beta，streamGenerateContent 由 gemini.ts 拼
   *  - apiKey 留空时用 "EMPTY" 占位（本地端点约定），避免 resolveModel 降级 mock
   * 校验失败抛 Error，经 dispatchApi 转成 rejected promise 由弹窗显示。
   */
  setCustomModel(params: CustomModelParams): SetModelResult {
    const protocol = params.protocol ?? "openai";
    if (protocol !== "openai" && protocol !== "responses" && protocol !== "anthropic" && protocol !== "gemini") {
      throw new Error(`不支持的协议：${String(protocol)}`);
    }
    let baseURL = params.baseURL.trim().replace(/\/+$/, "");
    const apiKey = params.apiKey.trim();
    const modelId = params.model.trim();
    if (!/^https?:\/\//.test(baseURL)) {
      throw new Error(`接口地址不合法：${baseURL.length === 0 ? "(为空)" : baseURL}，需以 http(s):// 开头`);
    }
    if (modelId.length === 0) throw new Error("模型名称不能为空");
    const contextWindow = parseContextWindowInput(params.contextWindow);
    if (protocol === "anthropic" && /\/v1$/.test(baseURL)) {
      // anthropic.ts 拼 /v1/messages：base 必须是根路径，带 /v1 会变成 /v1/v1/messages
      baseURL = baseURL.slice(0, -3);
    }
    const ref: ModelRef = {
      provider: protocol === "responses" ? "openai-responses" : protocol,
      id: modelId,
      baseUrl: baseURL,
      apiKey: apiKey.length > 0 ? apiKey : "EMPTY",
      ...(contextWindow !== undefined ? { contextWindow } : {}),
    };
    this.modelSpecCache = modelSpecOf(ref);
    this.resolved = applyReasoningToResolved(resolveModel(ref), this.reasoning, this.endpoint);
    this.endpoint = inferEndpointFromProvider(this.resolved.model.provider);
    // 自定义模型持久化：从归一后的 ref 提取完整参数（baseUrl 已剥尾斜杠、
    // anthropic 已剥 /v1、apiKey 空已占位 EMPTY）——存真值，恢复时零转换歧义。
    // 用 ref 而非 resolved.model：后者经 resolveModel 填充了粗表兜底 contextWindow，
    // 会把「用户没填」也存成显式值；只落用户显式覆写，恢复时自动识别不受影响。
    this.deps.persistCustomModel?.({
      provider: ref.provider,
      id: ref.id,
      baseUrl: ref.baseUrl ?? "",
      apiKey: ref.apiKey ?? "EMPTY",
      ...(ref.contextWindow !== undefined ? { contextWindow: ref.contextWindow } : {}),
    });
    const out: SetModelResult = {
      model: modelLabel(this.resolved.model),
      maxTokens: this.resolved.model.maxTokens ?? 0,
    };
    if (this.resolved.degraded !== undefined) {
      out.degraded = this.resolved.degraded;
    }
    return out;
  }

  /** 切换运行模式。下一次新建的 Agent 才生效；当前不打断。 */
  setMode(mode: RunMode): void {
    if (!isValidMode(mode)) return;
    this.mode = mode;
    // plan 状态由当前 turn 自然结束触发，下一次 submit 才决定要不要把限制加到 agent。
  }

  getApprovalMode(): boolean {
    return this.approvalMode;
  }

  /**
   * 切换审批模式。关闭时清掉「全部允许」记忆（重新开启不该继承旧授权）。
   * 对正在跑的 Agent 立即生效：gate 每次调用都实时读开关。
   */
  setApprovalMode(on: boolean): void {
    this.approvalMode = on;
    if (!on) this.approvalAlways = false;
  }

  /**
   * 切换自动压缩上下文开关（设置弹窗）。对正在跑的 Agent 立即生效；
   * 之后每次新建的 Agent（每次 submit 一个）都带上这个偏好。
   */
  setAutoCompact(on: boolean): void {
    this.autoCompact = on;
    this.currentAgent?.setAutoCompact(on);
  }

  /** 独立消息弹窗开关（设置弹窗）。窗口创建/销毁在 index.ts 的 handler 里做。 */
  setMsgWindow(on: boolean): void {
    this.msgWindow = on;
  }

  /** agent 本地服务预览开关（设置弹窗，默认关闭）。只控制 UI 入口可见性。 */
  setLocalPreview(on: boolean): void {
    this.localPreview = on;
  }

  /** 窗口置顶开关（设置弹窗，默认关闭）。窗口的实际置顶在 index.ts 的 handler 里做。 */
  setAlwaysOnTop(on: boolean): void {
    this.alwaysOnTop = on;
  }

  /**
   * Permission 支柱：Agent.approvalGate 的实现。
   * approvalMode 关闭 / 用户选过「本会话全部允许」→ 直接放行；
   * 否则发 approval_request 事件并等审批弹窗（deps.approvalPrompt，缺省 deny），
   * 结果以 approval_done + notice 广播（remote-ui 等无弹窗显示端可见）。
   */
  private async approvalGate(req: {
    toolName: string;
    arguments: Record<string, unknown>;
  }): Promise<boolean> {
    if (!this.approvalMode || this.approvalAlways) return true;
    const argsText = buildApprovalDetail({ toolName: req.toolName, args: req.arguments, cwd: this.deps.cwd() });
    const id = `ap_${++this.approvalSeq}`;
    this.deps.emit({ t: "approval_request", id, toolName: req.toolName, args: argsText });

    let verdict: "allow" | "always" | "deny" = "deny";
    if (this.deps.approvalPrompt !== undefined) {
      try {
        verdict = await this.deps.approvalPrompt({ toolName: req.toolName, args: argsText });
      } catch {
        verdict = "deny"; // 弹窗失败 fail-safe：拒绝
      }
    }

    const allow = verdict !== "deny";
    if (verdict === "always") this.approvalAlways = true;
    this.deps.emit({ t: "approval_done", id, allow });
    // SessionSignal 没有 notice 变体——走 AgentEvent 形状（autopilot 收工同款）
    this.deps.emit({
      type: "notice",
      message: `[审批] ${allow ? "✓ 允许" : "✗ 拒绝"} ${req.toolName}${verdict === "always" ? "（本会话后续不再询问）" : ""}`,
    });
    return allow;
  }

  // ────────────── ask_user：模型 → 用户提问通道 ──────────────

  /**
   * ask_user 工具的后端（src/tools/ask-user.ts 模块级 handler，构造器注入）。
   * 广播 ask_user 事件让所有显示端弹问答卡，挂起等 answerAsk RPC 唤醒；
   * agent 被 abort 时借 ctx.signal 立刻以 null 收场（工具侧转 fail「提问被中断」）。
   * 返回 null = 没有得到回答；非空 = 用户答案原文。
   */
  private async askUser(req: AskUserRequest, ctx: ToolContext): Promise<string | null> {
    const id = `ask_${++this.askSeq}`;
    const done = new Promise<string | null>((resolve) => {
      this.pendingAsks.set(id, resolve);
    });
    const onAbort = (): void => this.resolveAsk(id, null);
    if (ctx.signal.aborted) onAbort();
    else ctx.signal.addEventListener("abort", onAbort, { once: true });
    this.deps.emit({
      t: "ask_user",
      id,
      question: req.question,
      ...(req.choices !== undefined ? { choices: req.choices } : {}),
    });
    const answer = await done;
    ctx.signal.removeEventListener("abort", onAbort);
    this.deps.emit(
      answer === null
        ? { t: "ask_user_done", id, aborted: true }
        : { t: "ask_user_done", id, answer },
    );
    return answer;
  }

  /** 唤醒一次提问；重复 / 迟到 / 未知 id 直接忽略（问答卡是临时 UI，不报错）。 */
  private resolveAsk(id: string, answer: string | null): void {
    const resolve = this.pendingAsks.get(id);
    if (resolve === undefined) return;
    this.pendingAsks.delete(id);
    resolve(answer);
  }

  /** 渲染层 / 独立 UI 提交的用户答案。空串 = 用户跳过（主进程视为中断）。 */
  answerAsk(id: string, answer: string): void {
    const trimmed = answer.trim();
    this.resolveAsk(id, trimmed.length > 0 ? trimmed : null);
  }

  /** 切换推理强度。下一次新建的 Agent 才生效；同时刷新 maxTokens 与 thinkingLevel。 */
  setReasoning(level: ReasoningLevel): void {
    if (!isValidReasoning(level)) {
      // fail-visible：静默拒绝会让渲染层与主进程档位脱节（只显示不生效），必须留痕
      console.warn(`[session] setReasoning 收到非法档位: ${String(level)}`);
      return;
    }
    this.reasoning = level;
    this.state.thinkingLevel = thinkingLevelFor(level);
    const max = maxTokensFor(level, this.endpoint);
    this.resolved = {
      ...this.resolved,
      // auto / mock 时 max 是 undefined：显式清掉旧档位残留的上限
      model: { ...this.resolved.model, maxTokens: max },
    };
  }

  /**
   * 切换端点：重建 ModelRef 保留当前 model.id（如果有的话）；
   * 没 model.id 时回退该 endpoint 的默认 model。
   * 下一次新建的 Agent 才生效；当前不打断。
   */
  setEndpoint(endpoint: EndpointId): SetModelResult {
    if (!isValidEndpoint(endpoint)) return { model: modelLabel(this.resolved.model) };
    this.endpoint = endpoint;
    // 解析新端点下的同一 model：依赖 resolveModelSpec 的 parseModelSpec 逻辑；
    // env 里对应端点的 API_KEY 缺失时会降级 mock。
    this.modelSpecCache = `${endpoint}:${this.resolved.model.id}`;
    const { resolved } = resolveModelSpec(this.modelSpecCache);
    this.resolved = applyReasoningToResolved(resolved, this.reasoning, endpoint);
    this.persistModelChoice();
    const out: SetModelResult = {
      model: modelLabel(this.resolved.model),
      maxTokens: this.resolved.model.maxTokens ?? 0,
    };
    if (this.resolved.degraded !== undefined) {
      out.degraded = this.resolved.degraded;
    }
    return out;
  }

  /**
   * plan mode 下点「继续」时调用：
   *  - 把 planPending 清掉
   *  - 把 mode 改成 full（从而下一轮不再注入 plan 提示词）
   *  - enqueue 一条 followUp 让 agent 真的接着按 plan 做（用 steering 通道也行，
   *    这里走 followUp：等价于一次"按计划执行"的新指令）
   *
   * 如果当前不是在 planPending 状态，调了无副作用（直接 noop）。
   */
  async planContinue(): Promise<void> {
    if (!this.planPending) return;
    this.planPending = false;
    this.mode = "full";
    this.queue.enqueueFollowUp("照刚才的 plan 继续执行。");
    await this.maybeStart();
  }

  /**
   * 暂停输出：调用后 agent 在下一个 stream 事件之前会 await。
   *
   * 实现：把 `paused=true`，保留一个未 resolve 的 Promise；`resume()` 时 resolve 它。
   * 本方法把 paused 标志广播给 UI，让按钮立刻反映状态。
   */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    // flush 信号让显示层 connector 立刻冲刷节流残留——否则 50ms 的 timer 会在
    // paused 事件之后又触发一次，用户会看到「点暂停后还溜一小段」
    this.deps.emit({ t: "flush" });
    this.deps.emit({ t: "paused" });
  }  /** 恢复：resolve 上一个 pause 时保留的 Promise 让 await 继续。 */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    const cb = this.resumeCb;
    this.resumeCb = null;
    if (cb !== null) cb();
    this.deps.emit({ t: "resumed" });
  }

  /**
   * 投递一条用户消息。Agent.run() 会自己 drainFollowUps 消费。
   * 图片附件作为多模态 images 随消息入队（openai: image_url / anthropic: base64 block）。
   */
  async submit(text: string, attachments: Attachment[] = []): Promise<void> {
    if (text.length === 0 && attachments.length === 0) return;
    this.autopilotRounds = 0; // 新指令 → 远行预算重置
    this.maybeSetTitle(text, attachments);
    // 用户输入广播：显示端（本地窗口 / 独立 UI）统一靠这条事件渲染用户消息，
    // 入口侧不做本地插入（否则多端会重复）
    const images = attachments
      .filter((a) => a.kind === "image" && a.dataUrl.length > 0)
      .map((a) => ({ dataUrl: a.dataUrl }));
    this.deps.emit({ t: "user_text", text, ...(images.length > 0 ? { images } : {}) });
    const composed = composeMessageWithAttachments(text, attachments);
    this.queue.enqueueFollowUp(composed, images.length > 0 ? images : undefined);
    await this.maybeStart();
  }

  /**
   * 本会话第一条用户消息 → 会话标题（截前 24 个字符，超长打省略号）。
   * 只在还没锁定时生效：之后无论发多少条消息标题都不变。
   */
  private maybeSetTitle(text: string, attachments: Attachment[]): void {
    if (this.sessionTitleLocked[this.sessionIdx] === true) return;
    const source =
      text.trim().length > 0
        ? text
        : (attachments.find((a) => a.name.trim().length > 0)?.name ?? "");
    if (source.trim().length === 0) return;
    const firstLine = source.trim().split("\n", 1)[0] ?? source.trim();
    const chars = Array.from(firstLine.replace(/\s+/g, " ").trim());
    this.sessionTitles[this.sessionIdx] =
      chars.length <= 24 ? chars.join("") : chars.slice(0, 24).join("") + "…";
    this.sessionTitleLocked[this.sessionIdx] = true;
  }

  /** 中途插话：仅当 Agent 正跑时有效（steering 通道），否则当 followUp */
  steer(text: string): void {
    if (text.length === 0) return;
    this.deps.emit({ t: "user_text", text });
    if (this.currentAgent === null) {
      this.queue.enqueueFollowUp(text);
      return;
    }
    this.currentAgent.steer(text);
  }

  /** 中断当前 Agent.run()。下次 submit 会自然起新 Agent */
  abort(): void {
    this.currentAgent?.abort("user_aborted");
    // 用户主动 abort → 不再视为"在 plan review"
    this.planPending = false;
  }

  /** 重新会话：当前会话归档（可 ← 切回），追加一个空会话并切过去。 */
  newSession(): void {
    this.currentAgent?.abort("user_aborted");
    this.sessionMeta[this.sessionIdx] = {
      planPending: this.planPending,
      planRound: this.planRound,
      approvalAlways: this.approvalAlways,
    };
    this.sessions.push(emptyStateLike(this.state));
    this.sessionIdx = this.sessions.length - 1;
    this.state = this.sessions[this.sessionIdx]!;
    this.sessionMeta.push({ planPending: false, planRound: 0, approvalAlways: false });
    this.sessionTitles.push("新会话");
    this.sessionTitleLocked.push(false);
    this.planPending = false;
    this.planRound = 0;
    this.approvalAlways = false; // 新会话不继承「全部允许」授权
    this.resetTransients();
  }

  /**
   * ← / → 切换会话。delta -1 上一个、+1 下一个，越界时夹在边界。
   * 返回切换后的位置（index 从 0 起）与会话总数，渲染层显示「会话 N/M」。
   * 正在跑的 Agent 直接 abort（它的残留事件不再归属当前视图）。
   */
  switchSession(delta: number): { index: number; total: number } {
    const d = typeof delta === "number" && Number.isFinite(delta) ? Math.sign(delta) : 0;
    if (d === 0) return { index: this.sessionIdx, total: this.sessions.length };
    const next = Math.min(Math.max(this.sessionIdx + d, 0), this.sessions.length - 1);
    this.activateSession(next);
    return { index: this.sessionIdx, total: this.sessions.length };
  }

  /** 「选择会话」popover 跳转到指定会话（越界夹边界；目标就是当前会话时 no-op）。 */
  switchTo(target: number): { index: number; total: number } {
    const t =
      typeof target === "number" && Number.isFinite(target)
        ? Math.round(target)
        : this.sessionIdx;
    this.activateSession(Math.min(Math.max(t, 0), this.sessions.length - 1));
    return { index: this.sessionIdx, total: this.sessions.length };
  }

  /** 切换的公共实现：保存当前 meta、abort 正在跑的 Agent、切指针、恢复 meta、清瞬态 */
  private activateSession(next: number): void {
    if (next === this.sessionIdx) return;
    this.sessionMeta[this.sessionIdx] = {
      planPending: this.planPending,
      planRound: this.planRound,
      approvalAlways: this.approvalAlways,
    };
    this.currentAgent?.abort("user_aborted");
    this.sessionIdx = next;
    this.state = this.sessions[next]!;
    const meta = this.sessionMeta[next] ?? { planPending: false, planRound: 0, approvalAlways: false };
    this.planPending = meta.planPending;
    this.planRound = meta.planRound;
    this.approvalAlways = meta.approvalAlways;
    this.resetTransients();
  }

  /** 切会话共用的瞬态清理：队列残留丢弃、暂停状态复位。 */
  private resetTransients(): void {
    this.queue.clear();
    this.paused = false;
    this.resumeCb = null;
  }

  /**
   * 列 cwd 下文件，给渲染层 @ 引用 popover 用。
   * v1 直接复用 src/tools/fs-utils.ts 的 walkFiles（已正确跳过 IGNORED_DIRS + 隐藏目录）。
   * query 非空时按 substring 不区分大小写过滤。
   */
  async listFiles(query = ""): Promise<ListFilesResult> {
    const cwd = this.deps.cwd();
    const entries = await walkFiles(cwd, { maxFiles: 200 });
    const q = query.trim().toLowerCase();
    const files = entries
      .map((e) => e.rel)
      .filter((rel) => q.length === 0 || rel.toLowerCase().includes(q));
    return { files };
  }

  /**
   * 拉取端点的可用模型列表（OpenAI 兼容 GET /models）。
   *
   * URL 与鉴权的取法（两级）：
   *  1. 当前模型是自定义模型（带显式 baseUrl）且协议归属该端点 → 直连
   *     baseUrl 推导的 /models + 模型自带的 key。桌面端 key 存 ModelRef
   *     不进 env，走 env 推导几乎必然 401（真实案例：自定义模型对话一切
   *     正常，模型菜单却打到 api.openai.com → 401）；弹层头部展示的
   *     baseURL 也是自定义模型的 baseUrl，列表与展示必须同源——与
   *     warmModelsCache / metadataTargets 的自定义模型直连同一条规则。
   *  2. 否则按端点走 env（resolveModelsUrl / modelsAuthHeaders）：
   *    OPENAI_MODELS_URL 等显式覆盖优先，缺省按 baseUrl 推导。
   *  - mock 端点不走网络，固定返回 [{ id: "mock" }]
   *
   * 缓存：同 models URL 5 分钟内直接返回缓存（refresh=true 强制刷新）。
   * 失败兜底：任何网络 / 解析错误都转成 result.error 返回（不 throw），
   * 前端拿到 error 后回退「自定义模型」手动填写——保证下拉永远可用。
   */
  async listModels(endpoint: EndpointId = this.endpoint, refresh = false): Promise<ListModelsResult> {
    if (!isValidEndpoint(endpoint)) endpoint = this.endpoint;
    // mock 不走网络：固定单条列表（模型菜单在 mock 端点下也能用）
    if (endpoint === "mock") {
      return { endpoint, url: "(mock)", models: [{ id: "mock", ownedBy: "builtin" }] };
    }
    const m = this.resolved.model;
    const customBase = m.baseUrl;
    const useCustom =
      customBase !== undefined && customBase.length > 0 && inferEndpointFromProvider(m.provider) === endpoint;
    const url = useCustom ? modelsUrlForBaseUrl(m.provider, customBase) : resolveModelsUrl(endpoint);
    if (url === undefined) {
      return { endpoint, url: "(unknown)", models: [], error: "该端点没有可用的模型列表 URL" };
    }
    const cached = this.modelsCache.get(url);
    if (!refresh && cached !== undefined && Date.now() - cached.at < MODELS_CACHE_TTL_MS) {
      return cached.result;
    }
    const result = await this.fetchModelsAt(url, {
      parseAs: endpoint,
      headers: useCustom ? this.customModelAuthHeaders() : modelsAuthHeaders(endpoint),
    });
    // 只缓存成功结果——失败下次再试（网络恢复后无需等 TTL）
    if (result.error === undefined) {
      this.modelsCache.set(url, { at: Date.now(), result });
    }
    return result;
  }

  /**
   * 「自定义模型」弹层的模型列表拉取：按用户当场填的 baseURL + apiKey +
   * protocol 直连端点 /models。与 listModels（模型菜单）的差异：
   *  - 不读 env、不落缓存——key 不同返回结果可能不同，防抖交给前端
   *    （按参数指纹去重），失败也不会污染模型菜单的缓存；
   *  - URL 由用户输入的 baseURL 推导（modelsUrlForBaseUrl），与
   *    warmModelsCache 的自定义模型直连同一套推导规则。
   * 失败一律转 result.error 返回（不 throw），前端回退手动填写。
   */
  async listCustomModels(params: {
    baseURL: string;
    apiKey?: string;
    protocol?: "openai" | "responses" | "anthropic" | "gemini";
  }): Promise<ListModelsResult> {
    const baseURL = params.baseURL.trim();
    const rawProtocol = params.protocol ?? "openai";
    // responses 的 /models 形状与 openai 完全相同（{base}/models + Bearer），归 openai 解析
    const protocol: EndpointId = rawProtocol === "responses" ? "openai" : rawProtocol;
    if (!/^https?:\/\//i.test(baseURL)) {
      return { endpoint: protocol, url: baseURL, models: [], error: "接口地址要以 http(s):// 开头" };
    }
    const url = modelsUrlForBaseUrl(protocol, baseURL);
    const headers = authHeadersForProtocol(protocol, params.apiKey ?? "");
    return this.fetchModelsAt(url, { parseAs: protocol, headers });
  }

  /**
   * 拉取并解析一个 /models URL（超时 + 错误兜底）。parseAs 决定响应格式
   * （openai 的 data[] / gemini 的 models[]）。listModels（模型菜单）与
   * warmModelsCache（自定义模型直连）共用这一份 HTTP 逻辑。
   */
  private async fetchModelsAt(
    url: string,
    opts: { parseAs: EndpointId; headers: Record<string, string> },
  ): Promise<ListModelsResult> {
    const doFetch = this.deps.fetchModels ?? globalThis.fetch.bind(globalThis);
    try {
      const response = await doFetch(url, {
        method: "GET",
        headers: { accept: "application/json", ...opts.headers },
        signal: AbortSignal.timeout(MODELS_FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        return {
          endpoint: opts.parseAs,
          url,
          models: [],
          error: `GET ${url} → HTTP ${response.status}`,
        };
      }
      const raw: unknown = await response.json();
      return { endpoint: opts.parseAs, url, models: parseModelsResponse(raw, opts.parseAs) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { endpoint: opts.parseAs, url, models: [], error: `拉取模型列表失败：${msg}` };
    }
  }

  /**
   * 当前模型的元数据可能所在的 /models URL 清单（去重）：
   *  1. 端点推导 URL（env OPENAI_BASE_URL 等 → resolveModelsUrl）
   *  2. 自定义模型的 baseUrl 直连 URL（模型菜单没用 env base 的场景）
   * providerContextWindow 按顺序查缓存；warmModelsCache 按清单逐个预热。
   */
  private metadataTargets(): Array<{ url: string; headers: Record<string, string>; parseAs: EndpointId }> {
    const targets: Array<{ url: string; headers: Record<string, string>; parseAs: EndpointId }> = [];
    if (this.endpoint !== "mock") {
      const url = resolveModelsUrl(this.endpoint);
      if (url !== undefined) {
        targets.push({ url, headers: modelsAuthHeaders(this.endpoint), parseAs: this.endpoint });
      }
    }
    const m = this.resolved.model;
    if (m.baseUrl !== undefined && m.baseUrl.length > 0) {
      const url = modelsUrlForBaseUrl(m.provider, m.baseUrl);
      if (!targets.some((t) => t.url === url)) {
        targets.push({
          url,
          headers: this.customModelAuthHeaders(),
          parseAs: inferEndpointFromProvider(m.provider),
        });
      }
    }
    return targets;
  }

  /** 自定义模型请求 /models 的鉴权 headers——key 来自模型本身，不是 env。 */
  private customModelAuthHeaders(): Record<string, string> {
    const m = this.resolved.model;
    return authHeadersForProtocol(m.provider, m.apiKey ?? "");
  }

  /**
   * 当前模型上下文窗口的最佳已知值，按可信度取：
   * 提供商 /models 元数据（真值）→ ModelRef.contextWindow（用户手动覆写，或
   * resolveModel 按粗表填充的缺省）→ 粗表现查。info() 的进度条分母与
   * Agent 裁剪预算共用这一个口径。
   */
  private currentContextWindow(): number {
    const modelId = this.resolved.model.id;
    return (
      this.providerContextWindow(modelId) ??
      this.resolved.model.contextWindow ??
      lookupContextWindow(modelId)
    );
  }

  /**
   * 从提供商 /models 元数据查当前模型的上下文窗口。
   * 按 metadataTargets 顺序查缓存，先命中先返回；缓存空或元数据没给
   * context_window 时返回 undefined——调用方回退内置粗表。
   */
  private providerContextWindow(modelId: string): number | undefined {
    for (const t of this.metadataTargets()) {
      const hit = this.modelsCache.get(t.url)?.result.models.find((m) => m.id === modelId);
      if (hit?.contextWindow !== undefined) return hit.contextWindow;
    }
    return undefined;
  }

  /**
   * 预热模型元数据并返回「当前模型的 contextWindow 是否由此变得有值 / 变了值」。
   * info() 是同步的，contextWindow 只能读已有缓存——没有这步预热，上下文
   * 使用量的分母会一直停在内置粗表值，除非用户碰巧打开过模型菜单。
   * 并发拉 metadataTargets 里的每个 URL（TTL 内跳过）；主进程拿到 true 后
   * 广播 refresh-info 让 UI 重拉 info。失败静默：粗表兜底仍然有效，绝不 throw。
   */
  async warmModelsCache(): Promise<boolean> {
    const modelId = this.resolved.model.id;
    const before = this.providerContextWindow(modelId);
    const tasks = this.metadataTargets().map(async (t) => {
      const cached = this.modelsCache.get(t.url);
      if (cached !== undefined && Date.now() - cached.at < MODELS_CACHE_TTL_MS) return;
      const result = await this.fetchModelsAt(t.url, { parseAs: t.parseAs, headers: t.headers });
      if (result.error === undefined) {
        this.modelsCache.set(t.url, { at: Date.now(), result });
      }
    });
    await Promise.all(tasks).catch(() => {});
    const after = this.providerContextWindow(modelId);
    return after !== undefined && after !== before;
  }

  /**
   * 检查是否需要启动新 Agent。
   * - 已在跑：什么都不做（agent.run() 内的 while 循环会消化 queue）
   * - 没跑且队列空：什么都不做
   * - 没跑且队列有：new Agent + 后台 run
   *
   * Agent 的 `state.tools` / `state.systemPrompt` 来自 `this.state`（assembleSession
   * 时设定）；`state.model` 在这里从 `this.resolved.model` 同步——setModel /
   * setCustomModel / setEndpoint / setReasoning 只改 resolved，改了之后下一次
   * 新建的 Agent 整体生效（新 stream + 新 ref），当前 turn 不打断。
   */
  private async maybeStart(): Promise<void> {
    if (this.currentAgent !== null) return;
    if (!this.queue.hasFollowUps()) return;

    // 模型同步（401 根因修复）：Agent.callModel 发请求用的是 state.model
    // （StreamOptions.model），而 setModel / setCustomModel / setEndpoint /
    // setReasoning 只更新 this.resolved——不同步的话，请求永远携带 bootstrap
    // 时的旧 ref（自定义模型的 baseUrl / key 全丢，打到默认端点必然 401）。
    // 在这里把 resolved.model 同步进 state.model：新 stream + 新 ref 同代生效，
    // 当前跑着的一轮不受影响（切换语义：下一次新建的 Agent 才生效，不打断）。
    this.state.model = this.resolved.model;

    // plan mode 第一轮 system 注入"先 plan 后执行"提示词；切 full 时不再有。
    // 实现：在 assembleSession 时已经按 mode 拼好了 system prompt；
    // `state.systemPrompt` 是不可变的字符串（已创建），切 mode 后下一次 start 才生效。

    const agent = new Agent({
      state: this.state,
      queue: this.queue,
      stream: this.resolved.stream,
      // Context 支柱：裁剪预算跟随当前模型的真实窗口（/models 元数据优先，
      // 粗表兜底），不再是写死的 120k——1M 窗口的模型不再提前压缩，
      // 32k 的小模型第一轮就按小预算裁剪而不是撞墙后靠降档补救。
      // Agent 每次提交都新建，预热到的新窗口值下一轮自然生效。
      transform: { maxContextTokens: maxContextTokensFor(this.currentContextWindow()) },
      // 会话持久化：agent_end 后整树落盘 <cwd>/.c-agent/sessions/<id>.json（原子写，
      // 同一会话复用同一 id）。失败只发 notice，不影响对话。
      persistSessions: true,
      // Context 支柱：自动压缩开关跟随设置弹窗的偏好
      autoCompact: this.autoCompact,
      // Model 支柱：只有 auto 档开动态推理强度（失败升档/成功回落）；固定档尊重用户选择
      dynamicThinking: this.reasoning === "auto",
      // Permission 支柱：mutating 工具走审批门（关闭时 gate 内部直接放行）
      approvalGate: (req) => this.approvalGate(req),
      // onEvent 改成 async：每次等它完成才往下走，让 pause gate 真起作用。
      onEvent: async (event: AgentEvent) => this.handleEvent(event),
    });
    this.currentAgent = agent;

    // plan mode 不再这里决定是否停在 review 状态——由 handleEvent 在 agent_end 推
    // `plan_pending` 时设。
    void this.runAgent(agent);
  }

  private async runAgent(agent: Agent): Promise<void> {
    try {
      this.deps.emit({ t: "start" });
      await agent.run();
      this.deps.emit({ t: "flush" });
      this.deps.emit({ t: "end", toolRounds: 0 });
      // 远行模式：turn 自然结束后的自动续跑判定（哨兵收工 / 上限熔断 / 继续）。
      // 放在 emit end 之后：UI 先看到一轮收尾，续跑紧跟着起新 run（start 事件会跟上）。
      await this.autopilotContinue();
    } catch (err) {
      this.deps.emit({ t: "flush" });
      const msg = err instanceof Error ? err.message : String(err);
      this.deps.emit({ t: "error", message: msg });
    } finally {
      this.currentAgent = null;
      // 队列里可能还有用户消息（比如本轮跑了两个 followUp）→ 再起一个
      void this.maybeStart();
    }
  }

  /**
   * 远行（autopilot）模式的续跑驱动。turn 自然结束后调用：
   *  1. 非远行模式 → 计数清零直接返回
   *  2. 模型最终回答含收工哨兵 `[远行完成]` → 发 notice 收工
   *  3. 连续自动轮数到上限 → 熔断停下等用户（防失控烧 token）
   *  4. 否则 enqueue 一条继续指令（emit user_text 让 UI 可见），finally 的
   *     maybeStart() 会自动起新 run
   *
   * 用户 abort 走 catch 分支不会到这里；中途切走 mode（setMode）后 mode 已变，
   * 下一次自然结束就落在分支 1 —— 都能停。
   */
  private async autopilotContinue(): Promise<void> {
    if (this.mode !== "autopilot") {
      this.autopilotRounds = 0;
      return;
    }
    const lastText = lastAssistantText(this.state.messages);
    if (lastText !== null && lastText.includes(AUTOPILOT_DONE_SENTINEL_TEXT)) {
      this.autopilotRounds = 0;
      // AgentEvent 的 notice 变体（SessionSignal 没有 notice，走 AgentEvent 形状）
      this.deps.emit({ type: "notice", message: "🎯 朝着目标：模型已宣告目标完成，停止自动推进" });
      return;
    }
    if (this.autopilotRounds >= AUTOPILOT_MAX_ROUNDS) {
      this.autopilotRounds = 0;
      this.deps.emit({
        type: "notice",
        message: `🛑 朝着目标已连续自动推进 ${AUTOPILOT_MAX_ROUNDS} 轮，熔断等待你的指示`,
      });
      return;
    }
    this.autopilotRounds += 1;
    const instruction = `[朝着目标 ${this.autopilotRounds}/${AUTOPILOT_MAX_ROUNDS}] 任务尚未完成，继续推进；全部完成后单独一行输出 ${AUTOPILOT_DONE_SENTINEL_TEXT}`;
    this.deps.emit({ t: "user_text", text: instruction });
    this.queue.enqueueFollowUp(instruction);
  }

  /**
   * 暂停门：每次在推 stream wire event 之前 await 一次。
   *
   * 正常流程：
   *  - `pause()` 把 paused=true
   *  - 下一次进 pauseGate() 时发现 paused=true，new Promise 把 resolve 存进 resumeCb
   *  - 调用者在 await 处挂起
   *  - `resume()` 把 paused=false，调 resumeCb() 把 Promise resolve 掉，await 继续
   *
   * Race 兜底：
   *  - `resume()` 在 `pauseGate` 同步部分之前调：paused 已 false，pauseGate
   *    第一行就 return，立即放行；resumeCb 当时还是 null，但没人等，没事。
   *  - `pauseGate` 在 await 之后调 `resume`：paused=false，下次进 pauseGate
   *    又直接 return；当前 await 已经在第一个 resumeCb 上解开，OK。
   */
  private pauseGate(): Promise<void> {
    if (!this.paused) return Promise.resolve();
    return new Promise<void>((resolve) => {
      // 万一 resumeCb 已被 set 过（理论不该发生），先替回——保证只有一个 resolve 在飞。
      if (this.resumeCb !== null) this.resumeCb();
      this.resumeCb = resolve;
    });
  }

  /**
   * 事件处理已瘦身为「pause gate + 原样转发」：
   *  - AgentEvent 原样交给显示通道——AgentEvent → WireEvent 的映射与节流
   *    全部在 desktop-display connector（DisplaySink）里实现
   *  - 需要会话层状态的信号（turn_usage / plan_pending / 生命周期）在这里合成
   */
  private async handleEvent(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case "agent_start":
      case "turn_start":
      case "steering":
        // 桌面端不需要这些细粒度信号
        return;
      case "stream":
      case "tool_start":
      case "context_pruned":
      case "notice": {
        await this.pauseGate();
        this.deps.emit(event);
        return;
      }
      case "tool_end": {
        await this.pauseGate();
        // 本地服务检测：bash 输出里的 localhost 线索记进 localServers（见 local-services.ts）
        this.trackLocalServers(event);
        this.deps.emit(event);
        return;
      }
      case "turn_end": {
        await this.pauseGate();
        const u = this.usage();
        this.deps.emit({ t: "turn_usage", input: u.input, output: u.output, total: u.total });
        return;
      }
      case "agent_end":
        await this.pauseGate();
        // turn 全部完成：
        //  - plan mode + 还在 plan 状态且没被 continue：标记 planPending 让 UI 出"继续"
        //  - 其余情况清掉 planPending
        if (this.mode === "plan") {
          this.planPending = true;
          this.planRound += 1;
          this.deps.emit({ t: "plan_pending", round: this.planRound });
        } else {
          this.planPending = false;
        }
        // 不发 end：runAgent 的收尾已经推过 end 信号
        return;
      default:
        return;
    }
  }

  /**
   * agent 本地服务检测：bash 工具的输出里出现 localhost 地址 / 监听语句时记录。
   * 无论预览开关开与否都收集（开关只管 UI 展示）；渲染层在 bash 的 tool_end /
   * end 事件到达时重拉 info，无需主进程额外广播。
   */
  private trackLocalServers(event: Extract<AgentEvent, { type: "tool_end" }>): void {
    if (event.toolCall.name !== "bash") return;
    const text = event.result.content
      .filter((c): c is TextContent => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    if (text.length === 0) return;
    mergeLocalServers(this.localServers, extractLocalServers(text), Date.now());
  }
}

/**
 * 把 ResolvedModel 套上 reasoning 决定的 maxTokens。
 * mock 跳过此值（mock provider 不读 maxTokens，节省 token）。
 */
function applyReasoningToResolved(
  resolved: ResolvedModel,
  reasoning: ReasoningLevel,
  endpoint: EndpointId,
): ResolvedModel {
  const max = maxTokensFor(reasoning, endpoint);
  if (max === undefined) {
    return {
      ...resolved,
      model: { ...resolved.model, maxTokens: undefined },
    };
  }
  return {
    ...resolved,
    model: { ...resolved.model, maxTokens: max },
  };
}

/** 从 provider id 推断 endpoint（兼容 "mock"/"openai"/"anthropic"） */
function inferEndpointFromProvider(provider: string): EndpointId {
  if (provider === "mock") return "mock";
  // openai-responses 的 /models 形状与 openai 相同（{base}/models + Bearer），归 openai 端点
  if (provider === "openai" || provider === "openai-responses") return "openai";
  if (provider === "anthropic") return "anthropic";
  if (provider === "gemini") return "gemini";
  return "openai";
}

/**
 * 把图片附件塞进文本（占位实现，等 agent 真正支持多模态时换掉）。
 * 用 `:` 引导的元数据行让 agent 知道有图，便于后续真接多模态时不用改协议。
 */
function composeMessageWithAttachments(text: string, attachments: Attachment[]): string {
  if (attachments.length === 0) return text;
  const lines: string[] = [];
  for (const a of attachments) {
    lines.push(`[附件: ${a.name} (${a.kind}, ${Math.round(a.size / 1024)} KB)]`);
  }
  if (text.length > 0) lines.push(text);
  return lines.join("\n");
}

/**
 * 工厂：从 assembleOptions 一气呵成初始化 SessionManager。
 * 注意：`mode` 这里通过 AssembleOptions.mode 传进去，save 到 state。
 */
export async function createSession(opts?: Partial<AssembleOptions>): Promise<SessionManager> {
  const assembled = await assembleSession({
    cwd: opts?.cwd ?? process.cwd(),
    ...(opts?.modelSpec !== undefined ? { modelSpec: opts.modelSpec } : {}),
    ...(opts?.mode !== undefined ? { mode: opts.mode } : {}),
    ...(opts?.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
  });
  return new SessionManager(assembled);
}

// 给 a hack check 占个位，避免 ToolEntry 那个 export 报 unused；ALL_CATEGORIES 实际上是文档用途
const _ToolEntry_used: ToolEntry | undefined = undefined;
void _ToolEntry_used;
