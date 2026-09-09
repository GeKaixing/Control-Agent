/**
 * Connector Runtime 核心类型。
 *
 * 设计要点（与 `src/connector/doc/README.md` v0.1 对齐）：
 * - Agent 不感知底层软件：永远只调 `connector.execute(toolName, args)`，
 *   Runtime 自己把名字路由到具体 connector。
 * - Connector 是插件：每个 connector 一个目录 + `connector.json` 清单 + 默认导出类。
 * - Connector 暴露的 `getTools()` 直接复用项目内 `Tool` 接口（见 `src/tools/types.ts`），
 *   这样 Runtime 拿到的 Tool 数组可以直接喂给 Agent，无需再做形状转换。
 */

import type { JsonSchema } from "../../providers/types.js";
import type { Tool } from "../../tools/types.js";

/** 连接器支持的类型，决定 Loader 与 Runtime 用哪种适配器加载 */
export type ConnectorType = "api" | "cli" | "python" | "gui" | "desktop";

/** Connector 生命周期状态（对应 README §7） */
export type ConnectorState =
  | "installed" // 找到 manifest、还没实例化
  | "loaded" // 实例化完成、start() 还没跑
  | "ready" // start() 成功、可接收 execute
  | "running" // 正在处理 execute 调用（瞬态，调试用）
  | "stopped" // stop() 主动停掉
  | "error"; // 加载或运行过程中出错；errorMessage 给出原因

/** 静态能力声明，写在 connector.json 的 capabilities 字段 */
export interface ToolCapability {
  /** 模型调用的工具名，命名空间风格，如 "video.probe"、"document.create" */
  name: string;
  description: string;
  /** 可选：声明性参数 schema。若与运行时 Tool.parameters 不一致以运行时为准 */
  parameters?: JsonSchema;
  /** 只读 / 会改外部状态。运行时 Tool.isMutating 是权威 */
  mutating?: boolean;
}

/** Connector manifest = connector.json 反序列化的形状 */
export interface ConnectorManifest {
  id: string;
  version: string;
  type: ConnectorType;
  description?: string;
  /** 权限声明。Phase 2 才做真正的权限审批，Phase 1 仅记录 */
  permissions?: readonly string[];
  capabilities: ToolCapability[];
  /** 入口文件相对 connector 目录的路径，默认 "index.ts" */
  entry?: string;
}

/** 运行时传给 connector.execute 的上下文 */
export interface ConnectorContext {
  cwd: string;
  signal: AbortSignal;
  /** 环境变量透传，由 Runtime 注入 */
  env: Record<string, string | undefined>;
}

/** 单条 connector 实现的接口。Loader 用默认导出的类 `new ConnectorClass()` 实例化 */
export interface Connector {
  /** 与 manifest.id 保持一致 */
  readonly id: string;
  /** 启动 connector（连 CLI、起 socket、加载资源等）。幂等。 */
  start(ctx: ConnectorContext): Promise<void>;
  /** 关闭 connector。失败不抛，外层 try/catch 兜底 */
  stop(): Promise<void>;
  /** 列出本 connector 暴露给 Agent 的全部 Tool */
  getTools(): Tool[];
  /**
   * 同步执行工具。
   * - 不得 throw；错误用 `fail(text)` 返回（与项目其他 Tool 保持一致）
   * - 超时与取消靠 ctx.signal，connector 内部应透传到子进程
   */
  execute(toolName: string, args: Record<string, unknown>, ctx: ConnectorContext): Promise<{
    content: Array<import("../../types.js").TextContent | import("../../types.js").ImageContent>;
    isError: boolean;
  }>;
}

/** 默认导出必须是可 new 的类（无参或参数可省略） */
export type ConnectorClass = new () => Connector;

/**
 * 显示 / 出口类 connector 的可选能力——与 `execute` 的「Agent → connector」方向相反：
 * 实现它的 connector 接收事件流并转发给外部订阅者（桌面 UI、远程 web、日志等）。
 *
 * 典型用途：desktop 端的消息显示通路。装配代码通过 `asDisplaySink()` 在 Registry
 * 里发现所有实现了该能力的 connector，把 WireEvent 交给它们广播；「默认连接」的
 * 内置实现（如 Electron IPC）与未来新增的实现（如 websocket 远程 UI）可以并存。
 */
export interface DisplaySink {
  /**
   * 把一条事件交给 connector 转发。connector 自行决定传输方式。
   * 必须同步返回、不得 throw——显示是尽力而为（best-effort），失败只记日志。
   */
  emit(event: unknown): void;
}

/** 鸭子判定：一个 connector 实例是否实现了 DisplaySink 能力 */
export function asDisplaySink(c: Connector): DisplaySink | null {
  const candidate = c as unknown as Partial<DisplaySink>;
  return typeof candidate.emit === "function" ? (c as unknown as DisplaySink) : null;
}

/**
 * 会话生命周期信号：SessionManager 在 Agent 事件流之外发出的控制/状态信号。
 *
 * 设计意图：SessionManager 只负责「什么时候发生什么」，不负责「显示成什么样」——
 * 后者是消息 UI connector（DisplaySink）的职责。因此 SessionManager 的唯一出口是
 * `emit(event: AgentEvent | SessionSignal)`，由 display 路由交给 connector 消费。
 *
 * flush 是给节流缓冲用的：pause()/resume() 时会话层要求显示层立刻冲刷残留，
 * 避免节流 timer 在状态切换之后又触发一次（UI 会看到"暂停后还溜一小段"）。
 */
export type SessionSignal =
  | { t: "start" }
  | { t: "end"; toolRounds: number }
  | { t: "error"; message: string }
  | { t: "paused" }
  | { t: "resumed" }
  /** 用户提交的输入文本（submit / steer），显示端统一靠它渲染用户消息 */
  | { t: "user_text"; text: string }
  | { t: "plan_pending"; round: number }
  /** 每轮 turn 结束的 token 用量（SessionManager 算好后交给显示层） */
  | { t: "turn_usage"; input: number; output: number; total: number }
  | { t: "flush" }
  /**
   * Permission 支柱：审批模式下的 mutating 工具调用请求。主进程同时弹
   * 原生 dialog；无弹窗的显示端（remote-ui）据此显示「有一个审批在等」。
   * 结果随后以 approval_done 广播（id 对应）。
   */
  | { t: "approval_request"; id: string; toolName: string; args: string }
  | { t: "approval_done"; id: string; allow: boolean }
  /**
   * ask_user 工具（模型 → 用户提问）：主进程收到模型提问后广播，显示端
   * 弹问答卡；随后以 ask_user_done 广播收尾（所有显示端据此撤下问答卡）。
   * 形状与 shared/api.ts 的 WireEvent 对应变体保持一致。
   */
  | { t: "ask_user"; id: string; question: string; choices?: string[] }
  /** ask_user 收尾：answer 有值 = 用户已回答；aborted=true = 中断/跳过（无答案）。 */
  | { t: "ask_user_done"; id: string; answer?: string; aborted?: boolean };

/** SessionManager 发给显示通道的事件：原始 Agent 事件或会话信号 */
export type DisplayEvent = import("../../agent/agent.js").AgentEvent | SessionSignal;

/** Loader 加载后的 connector 记录 */
export interface LoadedConnector {
  manifest: ConnectorManifest;
  instance: Connector;
  state: ConnectorState;
  errorMessage?: string;
  /** connector 目录的绝对路径，便于排查 */
  rootDir: string;
}

/** 内存日志条目，Runtime 可选择落盘（README §13） */
export interface ConnectorLogEntry {
  timestamp: number;
  connectorId: string;
  level: "info" | "warn" | "error";
  message: string;
}

/** Loader 扫描结果 */
export interface LoaderResult {
  loaded: LoadedConnector[];
  /** 扫描目录里发现但加载失败的 connector，附带原因 */
  failed: Array<{ rootDir: string; manifest?: ConnectorManifest; error: string }>;
}

/** Loader 配置项 */
export interface LoaderOptions {
  /** 要扫描的目录列表，目录不存在会静默跳过 */
  paths: readonly string[];
  /** 允许的 connector id 白名单；undefined 表示不限制 */
  only?: readonly string[];
}
