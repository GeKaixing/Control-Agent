/**
 * 桌面端 IPC 契约：渲染层（preload）通过 window.api 与主进程交互。
 *
 * 渲染层只 import 这个文件，不直接 import 内核（src/），
 * 保持渲染层零耦合，便于将来替换实现。
 */

/**
 * 内置端点预设。供 UI 「端点」下拉使用，与 modelSpec 中的 provider 字段对齐。
 *  - "mock"          : 内置 mock 模型，无需 key
 *  - "openai"        : OpenAI / OpenAI 兼容端点（base URL 可被 env 覆盖）
 *  - "anthropic"     : Anthropic Messages API
 * 切端点由 SessionManager.setEndpoint() 处理：重建 provider，下次新建 Agent 生效。
 */
export type EndpointId = "mock" | "openai" | "anthropic" | "gemini";

export interface PlanPendingInfo {
  /** 第几轮触发的 plan（UI 可显示"完成第 N 轮计划"） */
  round: number;
}

export type WireEvent =
  | { t: "start" }
  | { t: "text"; delta: string }
  | { t: "thinking"; delta: string }
  | { t: "tool_start"; id: string; name: string; args: Record<string, unknown> }
  | { t: "tool_end"; id: string; name: string; ok: boolean; text: string; ms: number }
  | { t: "turn_usage"; input: number; output: number; total: number }
  | { t: "notice"; message: string }
  | { t: "end"; toolRounds: number }
  | { t: "error"; message: string }
  /** mode=plan 时 agent 跑完一个 turn 后停在 review 状态，UI 显示「继续」按钮 */
  | { t: "plan_pending"; round: number }
  /** pause/resume 状态广播，UI 同步按钮视觉态 */
  | { t: "paused" }
  | { t: "resumed" }
  /**
   * 用户提交的输入文本广播。用户输入可能来自任何入口（本地 Composer、独立
   * Composer 应用、steer 插话），显示端统一靠这条事件渲染用户消息——
   * 不要在入口侧本地插入，否则多端会重复。
   * images：随消息上传的图片附件（data URL），可缺省。
   */
  | { t: "user_text"; text: string; images?: { dataUrl: string }[] }
  /**
   * macOS 听写（SFSpeechRecognizer helper）的流式结果。
   *  - ready：麦克风+识别器就绪（UI 进入"听写中"视觉态）
   *  - partial：中间结果（UI 实时填进输入框）
   *  - final：最终结果（停止后定稿）
   *  - error：权限被拒 / 引擎失败（UI 提示 + 回到空闲态）
   */
  | { t: "dictation"; kind: "ready" | "partial" | "final" | "error"; text: string; seq: number }
  /** 主进程转发的 UI 动作（目前只有弹层子窗口 → 主窗口的「打开自定义模型 modal」） */
  | { t: "ui_action"; action: string }
  /**
   * 当前会话标题（tray-status 状态机的产物）：「⏳ 思考中… / ⚙ bash: … /
   * ✓ 完成 · N 轮 · X token / ✓ 空闲 / 🎤 听写中…」。主进程在 setTitle 时旁路推送，
   * 渲染层显示在窗口顶部标题栏（Composer-only 布局的拖动条）。
   */
  | { t: "session_title"; text: string }
  /**
   * Permission 支柱：审批模式下的 mutating 工具调用请求。主进程同时会弹
   * 原生 dialog；这条事件让 remote-ui 等没有本地 dialog 的显示端能看到
   * 「有一个审批在等」。审批结果随后以 approval_done 广播。
   */
  | { t: "approval_request"; id: string; toolName: string; args: string }
  /** 审批结果广播（allow=true 已放行）。id 与 approval_request 对应。 */
  | { t: "approval_done"; id: string; allow: boolean }
  /**
   * ask_user 工具（模型 → 用户提问）：主进程收到模型提问后广播，显示端
   * 渲染问答卡（选项按钮 + 自由输入）。答案经 answerAsk RPC 回主进程，
   * 随后以 ask_user_done 广播收尾（所有显示端据此撤下问答卡）。
   */
  | { t: "ask_user"; id: string; question: string; choices?: string[] }
  /** ask_user 收尾：answer 有值 = 用户已回答；aborted=true = 中断/跳过（无答案）。 */
  | { t: "ask_user_done"; id: string; answer?: string; aborted?: boolean }
  /**
   * 内部浏览器面板状态广播（主进程的折算全量快照）。
   * open=false = 面板被摘下（标签页仍在后台保活）；url 为空串 = 尚未导航
   * （about:blank 折算成空串，地址栏显示占位提示）。
   */
  | {
      t: "browser_state";
      open: boolean;
      activeId: string | null;
      tabs: BrowserTabInfo[];
    }
  /**
   * 手机镜像面板状态广播（与 browser_state 同模式：主进程折算全量快照）。
   * connected=false = adb 探测不到设备（MuMu 未启动 / 真机未插线），
   * 面板仍保持打开并展示提示，设备恢复后帧自动续上。
   */
  | { t: "phone_state"; open: boolean; connected: boolean; device: string | null }
  /**
   * 手机镜像的帧推送（adb screencap → nativeImage JPEG）。width/height 是
   * **本帧实测尺寸**——模拟器横竖屏翻转分辨率会变，手势换算必须按帧算。
   */
  | { t: "phone_frame"; dataUrl: string; width: number; height: number };

/** 内部浏览器面板的单个标签页快照（browser_state 事件的 tabs 元素）。 */
export interface BrowserTabInfo {
  id: string;
  title: string;
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

/** 手机镜像面板状态快照（phone_state 事件，主进程折算全量）。 */
export interface PhoneStateInfo {
  open: boolean;
  connected: boolean;
  device: string | null;
}

/** 手机镜像的帧（phone_frame 事件）。width/height 为本帧实测尺寸。 */
export interface PhoneFrameInfo {
  dataUrl: string;
  width: number;
  height: number;
}

/** 内部浏览器面板：渲染层占位区相对窗口视口（content area）的矩形（CSS px = DIP）。 */
export interface BrowserRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 菜单弹层子窗口请求：弹层渲染在独立无边框窗口里（浮在触发按钮下方），
 * 主窗口高度因此不变。x/y 是屏幕坐标（DIP，与 CSS px 同尺度），指向弹层左上角。
 */
export type PopoverId =
  | "tools"
  | "model"
  | "reasoning"
  | "usage"
  | "mode"
  | "sessions"
  | "custom-model"
  | "settings"
  | "local-services";

/**
 * agent 启动的本地服务（从 bash 工具输出里检测到的 localhost 地址）。
 * 单一事实来源在主进程 SessionManager，随 info() 下发给所有窗口。
 */
export interface LocalServerInfo {
  /** 规范化后的可访问地址（0.0.0.0 统一改写成 localhost），如 "http://localhost:5173" */
  url: string;
  /** 检测时原始出现的主机名（localhost / 127.0.0.1 / 0.0.0.0 / ::1） */
  host: string;
  /** 端口号（1-65535，已过合法性校验） */
  port: number;
  /** 最近一次在 bash 输出里出现的时间戳（Date.now()） */
  lastSeenAt: number;
  /** 累计出现次数（同一服务被多次打印时递增，排序参考） */
  hits: number;
}

export interface PopoverRequest {
  id: PopoverId;
  /** 弹层窗口左上角的屏幕 X 坐标 */
  x: number;
  /** 弹层窗口左上角的屏幕 Y 坐标（通常是触发按钮 bottom + 间距） */
  y: number;
  /** 弹层窗口宽度 */
  width: number;
  /**
   * 触发按钮顶边的屏幕 Y 坐标（可选）。主进程在下方空间放不下弹层时，
   * 据此把弹层翻转到按钮上方；缺省则退化为只向下排布（截断高度）。
   */
  triggerTop?: number;
}

/** 工具来源分组——前端「工具」面板按此分组。 */
export type ToolCategory = "skill" | "tool" | "mcp" | "plugin" | "extension";

export interface ToolEntry {
  name: string;
  description: string;
  category: ToolCategory;
  /** 例如 "core:src/tools/bash.ts" 或 "ffmpeg"；可空 */
  source?: string;
}

export type ToolsByCategory = Record<ToolCategory, ToolEntry[]>;

/**
 * 运行模式（v1 仅 UI 持久化；agent 调度层暂不消费，待下一轮真接入）。
 *  - answer_only：仅基于上下文回答，不让 agent 调任何 tool
 *  - plan：先给计划再执行
 *  - full：默认，agent 自决
 *  - autopilot：朝着目标（自动驾驶）——turn 自然结束自动续跑，模型可用 [目标完成] 收工
 */
export type RunMode = "answer_only" | "plan" | "full" | "autopilot";

/**
 * 推理强度。
 *  - auto：自动模式（推荐）——不锁 maxTokens，harness 按任务难度动态升降推理强度
 *    （连续工具失败升档重试、成功回落，agent.ts 的动态推理强度机制）
 *  - fast：快出，token 上限收紧，推理强度固定 low
 *  - balanced：默认固定档，推理强度 medium
 *  - ultra：极致，token 放开，推理强度固定 high
 *  - 固定档（fast/balanced/ultra）不参与动态升降——用户明确选了档位，harness 不擅自改
 */
export type ReasoningLevel = "auto" | "fast" | "balanced" | "ultra";

/** reasoning → 真实发给模型的 max_tokens（auto 不锁上限，走端点默认；mock 模型忽略）。 */
export const REASONING_MAX_TOKENS: Record<Exclude<ReasoningLevel, "auto">, number> = {
  fast: 1024,
  balanced: 4096,
  ultra: 8192,
};

/**
 * 「自定义模型」弹层的接口地址预设（内核 src/providers/vendors.ts BASE_URL_PRESETS
 * 的投影，随 info() 下发——渲染层不要自己抄一份，单一事实来源在内核）。
 */
export interface BaseUrlPresetInfo {
  label: string;
  baseURL: string;
  /** 请求协议；缺省 "openai"（OpenAI 兼容） */
  protocol?: "openai" | "responses" | "anthropic" | "gemini";
  /** 选中后预填的默认模型名（仅当模型名输入框为空时填入） */
  defaultModel?: string;
  /** 模型名输入框的 placeholder 提示 */
  modelHint?: string;
}

/**
 * 「自定义模型」弹窗参数：三要素 + 协议。
 * protocol="openai"（缺省）：baseURL 填到版本目录（…/v1），/chat/completions 由内核拼；
 * protocol="responses"：OpenAI 新一代 Responses API，/responses 由内核拼（baseURL 填法同 openai）；
 * protocol="anthropic"：baseURL 填根路径（不带 /v1），/v1/messages 由内核拼；
 * protocol="gemini"：baseURL 填到 /v1beta，streamGenerateContent 由内核拼。
 */
export interface CustomModelParams {
  baseURL: string;
  apiKey: string;
  /** 模型 id（如 deepseek-chat） */
  model: string;
  protocol?: "openai" | "responses" | "anthropic" | "gemini";
  /**
   * 上下文窗口手动覆写（用户原文）：纯数字（1000000）或 k/m 后缀（256k、1m）。
   * 空 / 缺省 = 自动识别（/models 元数据 → 内核粗表）。端点不给元数据时
   * （如中继 /models 403），这是让分母和裁剪预算跟上真实窗口的唯一入口。
   */
  contextWindow?: string;
}

export interface InfoPayload {
  cwd: string;
  /** 展示用 label：前缀是厂商名（baseUrl 域名推导，如 "opencode:muse-…"），非 spec */
  model: string;
  /** 原始 spec（"provider:modelId"）。「模型」弹层的选中态比对用，别拿 model label 比 */
  modelSpec: string;
  degraded?: string;
  tools: string[];
  /**
   * 当前模型的上下文窗口上限（token 数）。优先取提供商 /models 元数据给的
   * 值（context_window / context_length / inputTokenLimit）；端点没给或元数据
   * 未拉到时回退内置粗表（model id 正则匹配），表也没命中时兜底 1M——
   * 误判大只浪费安全余量，误判小会白白丢历史。
   */
  contextWindow: number;
  /** 当前 provider 的 base URL（来自 env 或默认值）。UI 只读展示。 */
  baseURL: string;
  mode: RunMode;
  paused: boolean;
  reasoning: ReasoningLevel;
  /** 当前生效的端点 id（"mock" | "openai" | "anthropic"）。 */
  endpoint: EndpointId;
  /** 当前模型用于 OpenAI / Anthropic 调用的最大 token 上限；与 reasoning 联动。 */
  maxTokens: number;
  /** plan 模式下，agent 跑完一轮后是否停在 plan review 等待用户点继续。 */
  planPending: boolean;
  /** 审批模式：mutating 工具（write/edit/bash…）执行前需要用户逐次放行。 */
  approvalMode: boolean;
  /**
   * 自动压缩上下文（compact）开关。开启时上下文越过裁剪线由模型自动摘要
   * 写新 Root；关闭后只做机械裁剪，不再让模型花 token 摘要。
   */
  autoCompact: boolean;
  /**
   * 独立消息弹窗开关（默认不开启）：开启时主进程创建一个独立无边框小窗，
   * 实时显示 agent 回复流。独立于主窗口存在（可拖到屏幕任意角落，
   * 主窗口关了仍保留）；窗口上的关闭按钮等价于把它关掉。
   */
  msgWindow: boolean;
  /**
   * agent 开启的本地服务预览开关（设置弹窗，默认不开启）。开启后状态栏出现
   * 「本地服务」入口，弹窗列出检测到的服务并支持 iframe 内嵌预览。
   */
  localPreview: boolean;
  /**
   * 窗口置顶开关（设置弹窗，默认不开启）。开启后主窗口始终浮在所有窗口
   * 之上（Windows / macOS 均为系统级 always-on-top）；偏好存 SessionManager。
   */
  alwaysOnTop: boolean;
  /** 检测到的 agent 本地服务（按最近出现排序，最多 20 条）。开关关闭时主进程照常收集。 */
  localServers: LocalServerInfo[];
  /** 当前会话的标题：取本会话第一条用户消息生成；还没有用户消息时是「新会话」。 */
  sessionTitle: string;
  /** 本会话最后一条用户消息原文；还没有用户消息时是 null。输入框 placeholder / 复制提示词用。 */
  lastUserPrompt: string | null;
  toolsByCategory: ToolsByCategory;
  /** 上下文构成分项估算（token 粗估）。「上下文」弹层的构成展示用。 */
  contextBreakdown: ContextBreakdown;
  /** 接口地址预设。「自定义模型」弹层的提供商下拉数据源。 */
  baseUrlPresets: BaseUrlPresetInfo[];
}

/**
 * 上下文构成分项：模型每次请求实际吃到的输入，按来源拆成五段粗估。
 * 与 estimateTokens 同一口径（中文 1.5 字/token、其余 4 字/token，按字符数 /3.5），
 * 是 UI 参考值不是计费值。
 */
export interface ContextBreakdown {
  /** 系统提示词（含 mode 追加段） */
  systemPrompt: number;
  /** 内置工具 schema（read/write/edit/bash/glob/grep 的 JSON Schema + 描述） */
  tools: number;
  /** 连接器工具 schema（Connector Runtime 注册的 extraTools，如 MCP / ffmpeg） */
  connectors: number;
  /** 技能注入（v1 尚未把 skill 写进上下文，恒 0，占位给未来） */
  skills: number;
  /** 对话消息（user / assistant / toolResult 全部正文与工具调用） */
  messages: number;
}

export interface ListSessionsResult {
  /** 当前会话下标（0 起） */
  index: number;
  total: number;
  /** 各会话标题（与下标一一对应） */
  titles: string[];
}

/**
 * 磁盘上的持久化会话（.c-agent/sessions/<id>.json）单条信息。
 * 「历史会话」区数据源——与内存标签页（ListSessionsResult）是两个集合：
 * 前者是落盘文件（含 CLI / 之前退出时写下的），后者是本窗口开着的标签页。
 */
export interface PersistedSessionInfo {
  id: string;
  /** 最近一次保存时间（Date.now()） */
  savedAt: number;
  /** 持久化的节点数（含 toolResult 与 compact 旧分支，大于「对话条数」） */
  nodeCount: number;
  /** true = 正被本窗口某个标签页使用：删除会在下轮自动保存时重建，UI 禁删 */
  locked: boolean;
}

export interface DeleteSessionResult {
  ok: boolean;
  /** ok=false 时的失败原因（不存在 / 使用中 / 无法删除） */
  error?: string;
}

/** chooseWorkspaceCwd 的返回：主进程目录选择对话框的结果 + 切换结果。 */
export interface ChooseWorkspaceResult {
  ok: boolean;
  /** ok=true 时用户选中的目录绝对路径 */
  path?: string;
  /** ok=false 时的失败原因（用户取消 / 任务运行中 / 目录不可创建） */
  error?: string;
}

export interface UsagePayload {
  input: number;
  output: number;
  total: number;
}

export interface SetModelResult {
  model: string;
  /** 当前推理强度下发给模型的 max_tokens；mock 时为 0 */
  maxTokens?: number;
  degraded?: string;
}

export interface SubmitResult {
  ok: boolean;
  error?: string;
}

/**
 * 附件 v1：仅支持图片（拖拽 / 粘贴 / 点选 file picker）。
 *  - id：渲染层生成的 uuid，便于移除
 *  - dataUrl：完整 data URL（data:image/png;base64,...），渲染层用 FileReader.readAsDataURL 即可
 *  - size：字节数，仅用于展示
 * 后端 v1 不消费这个字段（agent 还没接多模态），但 IPC 通道先定义好。
 */
export interface Attachment {
  id: string;
  kind: "image";
  name: string;
  /** data URL，base64 编码完整前缀；渲染层 <img src={...}> 直接渲染。 */
  dataUrl: string;
  size: number;
}

export interface ListFilesResult {
  /** 相对 cwd 的路径（POSIX 风格，统一用 / 分隔）。最多 200 条。 */
  files: string[];
}

/** 动态模型列表的单个条目（来自端点 /models 响应）。 */
export interface ModelInfo {
  /** 模型 id（如 "glm-5.3"），拼 spec 用 "provider:id" */
  id: string;
  /** 服务方（OpenAI 兼容字段 owned_by），可空 */
  ownedBy?: string;
  /** 上下文窗口 token 数；端点元数据没给就不填（UI 回退 hints 粗表） */
  contextWindow?: number;
}

/** switchSession 的返回：当前会话下标（0 起）与总会话数 */
export interface SwitchSessionResult {
  index: number;
  total: number;
}

export interface ListModelsResult {
  /** 本次拉取针对的端点 */
  endpoint: EndpointId;
  /** 实际请求的 URL；mock 端点为 "(mock)" */
  url: string;
  models: ModelInfo[];
  /** 非 undefined 表示拉取失败（网络/格式/超时），前端应回退静态预设列表 */
  error?: string;
}

export interface DesktopApi {
  submit(text: string, attachments?: Attachment[]): Promise<SubmitResult>;
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  /**
   * 回答模型的 ask_user 提问。answer 为空串 = 用户跳过（主进程视为中断，
   * 工具以 fail 收场）。id 与 ask_user 事件对应；迟到/未知 id 静默丢弃。
   */
  answerAsk(id: string, answer: string): Promise<void>;
  setModel(spec: string): Promise<SetModelResult>;
  /** 自定义模型：接口地址 + API KEY + 模型名称（OpenAI 兼容协议）。下一次新建的 Agent 生效。 */
  setCustomModel(params: CustomModelParams): Promise<SetModelResult>;
  /**
   * 「自定义模型」弹层：按用户当场填的 baseURL + apiKey + protocol 直连
   * 端点 /models 拉可用模型列表（不读 env、不落缓存）。失败时 result.error
   * 有值且 models 为空——前端回退手动填写。
   */
  listCustomModels(params: Pick<CustomModelParams, "baseURL" | "apiKey" | "protocol">): Promise<ListModelsResult>;
  setMode(mode: RunMode): Promise<void>;
  setReasoning(level: ReasoningLevel): Promise<void>;
  /** 切换端点（rebuild provider）。mock ↔ openai ↔ anthropic。 */
  setEndpoint(endpoint: EndpointId): Promise<SetModelResult>;
  /** plan 模式下点「继续」时调用，把限制移除并手动续跑。 */
  planContinue(): Promise<void>;
  /** 切换审批模式：mutating 工具执行前逐次询问（主进程弹原生 dialog）。 */
  setApprovalMode(on: boolean): Promise<void>;
  /** 切换自动压缩上下文（compact）开关；对正在跑的 Agent 立即生效。 */
  setAutoCompact(on: boolean): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  getUsage(): Promise<UsagePayload>;
  newSession(): Promise<void>;
  /**
   * ← / → 切换会话：delta -1 上一个、+1 下一个（越界夹边界）。
   * 返回切换后的位置与会话总数，UI 显示「会话 N/M」。
   */
  switchSession(delta: number): Promise<SwitchSessionResult>;
  /** 「选择会话」：跳转到指定下标的会话（越界夹边界；当前会话 no-op）。 */
  switchTo(index: number): Promise<SwitchSessionResult>;
  /** 会话清单：当前位置 + 总数 + 各会话标题（「选择会话」popover 用）。 */
  listSessions(): Promise<ListSessionsResult>;
  /**
   * 磁盘上的持久化会话清单（.c-agent/sessions/，新的在前；含 CLI 与
   * 之前退出时落盘的会话）。「历史会话」区数据源。
   */
  listPersistedSessions(): Promise<PersistedSessionInfo[]>;
  /**
   * 删除一条持久化会话文件。使用中的标签页会话拒绝删除（自动保存会重建）；
   * id 由主进程按字符集校验，坏输入返回 ok:false。
   */
  deleteSession(id: string): Promise<DeleteSessionResult>;
  /** 当前平台（darwin / win32 / linux）：StatusBar 按平台适配标题栏留位。 */
  readonly platform: "darwin" | "win32" | "linux";
  info(): Promise<InfoPayload>;
  /**
   * 列 cwd 下文件，给 @ 引用 popover 用。
   *  - query 为空时返回前 200 个文件名
   *  - query 非空时返回包含 query 子串（不区分大小写）的路径
   * 跳过 IGNORED_DIRS（node_modules、.git、dist、build、.next、.cache、coverage、vendor、.workbuddy）。
   */
  listFiles(query?: string): Promise<ListFilesResult>;
  /**
   * 拉取端点的可用模型列表（OpenAI 兼容 GET /models）。
   * URL 可配置：env `OPENAI_MODELS_URL` / `ANTHROPIC_MODELS_URL` 显式覆盖，
   * 否则按该端点 baseUrl 推导。主进程侧带 5 分钟缓存；refresh=true 强制重新拉取。
   * 拉取失败时 result.error 有值且 models 为空 —— 前端回退静态预设。
   */
  listModels(endpoint?: EndpointId, refresh?: boolean): Promise<ListModelsResult>;
  /** 开始 macOS 听写（SFSpeechRecognizer helper）；结果经 dictation WireEvent 流回。 */
  startDictation(): Promise<void>;
  /** 停止听写并拿到 final 文本（helper 优雅退出）。 */
  stopDictation(): Promise<void>;
  /**
   * 把窗口高度调整为给定内容高度（Composer-only 布局的自适应收缩）。
   * 主进程保留当前宽度，高度夹在 [120, 800]。
   */
  resizeWindow(height: number): Promise<void>;
  /**
   * 打开菜单弹层子窗口（浮在触发按钮下方，主窗口不动）。
   * 同一 id 已打开时再次调用 = 关闭（toggle）。
   */
  openPopover(req: PopoverRequest): Promise<void>;
  /** 关闭当前弹层子窗口（没有打开时是 no-op）。 */
  closePopover(): Promise<void>;
  /** 弹层子窗口内容高度上报（主进程据此 setContentSize 并首次显示）。 */
  popoverSetHeight(h: number): Promise<void>;
  /** 弹层子窗口 → 主进程 → 主窗口渲染层的 UI 动作（如 refresh-info 刷新头部信息）。 */
  uiAction(action: string): Promise<void>;
  /**
   * 独立消息弹窗开关：true 时主进程创建 ?msg-window=1 小窗，false 销毁（幂等）。
   * 偏好由主进程回写，经 info 回显到设置弹层。
   */
  setMsgWindow(on: boolean): Promise<void>;
  /**
   * agent 本地服务预览开关：开启后状态栏显示「本地服务」入口（默认关闭）。
   * 偏好由主进程回写，经 info 回显到设置弹层。
   */
  setLocalPreview(on: boolean): Promise<void>;
  /**
   * 窗口置顶开关：开启后主窗口始终浮在所有窗口之上（默认关闭）。
   * 偏好由主进程回写，经 info 回显到设置弹层。
   */
  setAlwaysOnTop(on: boolean): Promise<void>;
  /**
   * 打开系统目录选择对话框，把选中的目录设为会话工作目录（立即生效，
   * 所有会话的 state.cwd 统一改写 + 落盘 config.json）。用户取消或切换
   * 失败（任务运行中 / 目录不可创建）时 ok=false 并带 error。
   */
  chooseWorkspaceCwd(): Promise<ChooseWorkspaceResult>;
  /** 打开内部浏览器面板（已开时仅导航到 url；url 空/缺省保持当前页）。 */
  browserOpen(url?: string): Promise<void>;
  /** 关闭内部浏览器面板（标签页全部保活，重开即原样；幂等）。 */
  browserClose(): Promise<void>;
  /** 新建标签页（url 可选；缺省铺新标签页提示）。 */
  browserNewTab(url?: string): Promise<void>;
  /** 关闭标签页（真正销毁该标签；关活动标签时自动补位）。 */
  browserCloseTab(id: string): Promise<void>;
  /** 切换活动标签页。 */
  browserSwitchTab(id: string): Promise<void>;
  /** 地址栏导航：像 URL 就直开，像搜索词就走 Bing 搜索。 */
  browserNavigate(input: string): Promise<void>;
  browserBack(): Promise<void>;
  browserForward(): Promise<void>;
  browserReload(): Promise<void>;
  /** 停止当前加载（loading 态点刷新按钮位时调用）。 */
  browserStop(): Promise<void>;
  /**
   * 上报渲染层占位区的视口矩形：主进程把 WebContentsView 精确贴到这个矩形上。
   * 挂载、窗口缩放、上方内容高度变化时都由渲染层 ResizeObserver 触发上报。
   */
  browserSetRect(rect: BrowserRect): Promise<void>;
  /** 打开手机镜像面板（与浏览器面板互斥：先关浏览器再开镜像；幂等）。 */
  phoneOpen(): Promise<void>;
  /** 关闭手机镜像面板（停帧轮询；幂等）。 */
  phoneClose(): Promise<void>;
  /** 注入点击。x/y 为设备物理像素（渲染层按帧尺寸换算后传入）。 */
  phoneTap(x: number, y: number): Promise<void>;
  /** 注入滑动（按下 → 平移 → 松开）。坐标同 tap，duration 为毫秒。 */
  phoneSwipe(x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<void>;
  /** 注入按键（Android keycode：3=HOME、4=返回、187=最近任务）。 */
  phoneKey(keycode: number): Promise<void>;
  /** 手动补一帧（面板挂载 / 用户点刷新时调用）。 */
  phoneRefresh(): Promise<void>;
  onEvent(cb: (e: WireEvent) => void): () => void;
}

declare global {
  interface Window {
    api: DesktopApi;
  }
}
