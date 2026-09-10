/**
 * Zustand store：把 WireEvent 流折成 UI 状态。
 * 所有更新都在 store 内完成，组件只 useStore(s => s.xxx)。
 *
 * 与 mode / paused / reasoning / endpoint 的 IPC 交互：
 *  - 渲染层发起 → `setMode / setReasoning / setEndpoint / setPaused` 调 `window.api`
 *  - 主进程回写（settings_changed 事件）→ 这里同步 `info` 字段；
 *    不依赖这些事件的字段，组件首次拿值时通过 `info()` 拉一次兜底。
 *
 * 暂停状态（paused）现在源头是 store 与主进程双轨：UI 操作 → IPC → 主进程推 `paused`
 * / `resumed` 事件回来 → store 同步。这避免了我们之前担心的"renderer 改 UI 早于
 * 主进程"的 race。
 */

import { create } from "zustand";
import type {
  BrowserTabInfo,
  EndpointId,
  InfoPayload,
  ReasoningLevel,
  RunMode,
  UsagePayload,
  WireEvent,
} from "../../shared/api";

export type ToolCallState =
  | { status: "pending"; id: string; name: string; args: Record<string, unknown> }
  | { status: "done"; id: string; name: string; args: Record<string, unknown>; ok: boolean; text: string; ms: number };

export interface Turn {
  id: number;
  role: "user" | "assistant";
  text: string;
  /** 本轮累计的思考过程（thinking delta 顺序拼接），v1 隐藏、现折叠展示 */
  thinking: string;
  toolCalls: ToolCallState[];
  live: boolean;
  /** user 消息随带的图片附件（data URL），仅 user turn 有 */
  images?: { dataUrl: string }[];
}

export type Status = "idle" | "running" | "error" | "plan_pending";

/**
 * 模型经 ask_user 工具发出的待回答提问。回答/中断后主进程广播
 * ask_user_done，这里按 id 撤下。切会话 / reset 不清空——提问挂在
 * 还在跑的 agent 上，切回来还要能答。
 */
export interface PendingAsk {
  id: string;
  question: string;
  choices?: string[];
}

/**
 * macOS 听写的渲染层状态。seq 用于让 Composer 区分「新事件」
 * （partial 高频到达，靠引用比较不可靠）。
 */
export interface DictationState {
  seq: number;
  /** true = helper 已就绪且还没出 final/error */
  active: boolean;
  /** 当前识别文本（partial 增量覆盖、final 定稿） */
  draft: string;
  /** 最后一次 error 的消息（供 UI 提示；非 error 为 null） */
  errorMessage: string | null;
}

/**
 * 内部浏览器面板的渲染层状态（browser_state 事件折算）。
 * null = 尚未收到过事件（面板从未打开过或渲染层刚挂载）。
 * tabs 里包含全部标签页（含后台），activeId 指向当前显示的标签。
 */
export interface BrowserPanelState {
  open: boolean;
  activeId: string | null;
  tabs: BrowserTabInfo[];
}

/**
 * 手机镜像面板的渲染层状态（phone_state 事件折算）。
 * null = 尚未收到过事件（面板从未打开过）。帧数据不进 store——600ms 一帧的
 * base64 会让全局订阅者跟着重渲染，帧订阅由 PhonePanel 组件自己持有。
 */
export interface PhonePanelState {
  open: boolean;
  connected: boolean;
  device: string | null;
}

interface State {
  info: InfoPayload | null;
  usage: UsagePayload;
  turns: Turn[];
  status: Status;
  errorMessage: string | null;
  notice: string | null;
  dictation: DictationState | null;
  /** 当前会话标题（session_title 事件）：显示在窗口顶部标题栏。null = 尚未收到 */
  sessionTitle: string | null;
  /** 会话代数：newSession / 切会话时自增，Composer 靠它清空输入历史 */
  sessionSeq: number;
  /** 模型提问（ask_user 工具）待回答清单；有值时问答卡渲染在 Composer 上方 */
  pendingAsks: PendingAsk[];
  /** 内部浏览器面板状态（browser_state 事件） */
  browser: BrowserPanelState | null;
  /** 手机镜像面板状态（phone_state 事件） */
  phone: PhonePanelState | null;
}

interface Actions {
  handleEvent(e: WireEvent): void;
  setInfo(info: InfoPayload): void;
  appendUser(text: string): void;
  reset(): void;
  /** 切换运行模式（调 IPC 持久化到 SessionManager）。 */
  setMode(mode: RunMode): Promise<void>;
  /** 切换推理强度（同时改 max_tokens 写回）。 */
  setReasoning(level: ReasoningLevel): Promise<void>;
  /** 切换端点（mock / openai / anthropic）。 */
  setEndpoint(endpoint: EndpointId): Promise<void>;
  /** plan mode 下点"继续"。 */
  planContinue(): Promise<void>;
  /** 切换暂停。 */
  setPaused(paused: boolean): Promise<void>;
  /** ← / → 切换会话；成功后重置视图并刷新 info/usage，notice 显示「会话 N/M」。 */
  switchSession(delta: -1 | 1): Promise<void>;
  /**
   * 「选择会话」弹层子窗口里切完会话后的主窗口善后：重置视图、重拉 info/usage，
   * notice 显示「会话 N/M」（switchTo 本身发生在子窗口，主窗口靠 ui_action 通知触发）。
   */
  applyRemoteSwitch(): Promise<void>;
  /** 新会话（当前会话归档，可 ← 切回）；notice 显示「新会话 N/M」。 */
  newSession(): Promise<void>;
  /** 回答模型的 ask_user 提问；answer 空串 = 跳过（主进程视为中断）。 */
  answerAsk(id: string, answer: string): Promise<void>;
}

let turnCounter = 0;
function nextTurnId(): number {
  turnCounter += 1;
  return turnCounter;
}

function mutateLastAssistant(turns: Turn[], fn: (t: Turn) => Turn): Turn[] {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const t = turns[i];
    if (t !== undefined && t.role === "assistant" && t.live) {
      const updated = fn({ ...t });
      const out = [...turns];
      out[i] = updated;
      return out;
    }
  }
  return turns;
}

function markLastAssistantNotLive(turns: Turn[]): Turn[] {
  return turns.map((t, i, arr) => {
    if (i === arr.length - 1 && t.role === "assistant" && t.live) return { ...t, live: false };
    return t;
  });
}

export const useSessionStore = create<State & Actions>((set, get) => ({
  info: null,
  usage: { input: 0, output: 0, total: 0 },
  turns: [],
  status: "idle",
  errorMessage: null,
  notice: null,
  dictation: null,
  sessionTitle: null,
  sessionSeq: 0,
  pendingAsks: [],
  browser: null,
  phone: null,

  setInfo: (info) => set({ info }),

  appendUser: (text) =>
    set((s) => ({ turns: [...s.turns, { id: nextTurnId(), role: "user", text, thinking: "", toolCalls: [], live: false }] })),

  reset: () =>
    set({
      turns: [],
      usage: { input: 0, output: 0, total: 0 },
      status: "idle",
      errorMessage: null,
      notice: null,
      // 标题不在此清空：切会话后下一条 session_title 事件会覆盖；
      // 保留旧值能避免标题栏闪空。
    }),

  setMode: async (mode) => {
    await window.api.setMode(mode);
    const cur = get().info;
    if (cur !== null) set({ info: { ...cur, mode } });
  },

  setReasoning: async (level) => {
    await window.api.setReasoning(level);
    const cur = get().info;
    if (cur !== null) set({ info: { ...cur, reasoning: level } });
  },

  setEndpoint: async (endpoint) => {
    await window.api.setEndpoint(endpoint);
    const fresh = await window.api.info();
    set({ info: fresh });
  },

  planContinue: async () => {
    await window.api.planContinue();
  },

  setPaused: async (paused) => {
    if (paused) {
      await window.api.pause();
    } else {
      await window.api.resume();
    }
    // 主进程会推 `paused` / `resumed` 事件回来；store 同步到 info.paused。
    // 这里不再立即回写——以主进程为准。
  },

  switchSession: async (delta) => {
    try {
      const r = await window.api.switchSession(delta);
      get().reset();
      const [info, usage] = await Promise.all([window.api.info(), window.api.getUsage()]);
      set({
        info,
        usage,
        // 标题随会话走：reset 刻意保留旧标题防闪空，但切会话必须换成新会话的
        // （info.sessionTitle 空串 = 新会话还没有标题 → 置 null 让标题栏空着）
        sessionTitle: info.sessionTitle.length > 0 ? info.sessionTitle : null,
        notice: `会话 ${r.index + 1}/${r.total}`,
      });
    } catch (err) {
      // IPC 层失败（如主进程是旧版没注册 handler）也要可见，不能静默吞掉
      set({ notice: `切换失败：${err instanceof Error ? err.message : String(err)}` });
    }
  },

  applyRemoteSwitch: async () => {
    try {
      const r = await window.api.listSessions();
      get().reset();
      const [info, usage] = await Promise.all([window.api.info(), window.api.getUsage()]);
      set({
        info,
        usage,
        // 同 switchSession：标题栏不能挂着上一个会话的标题
        sessionTitle: info.sessionTitle.length > 0 ? info.sessionTitle : null,
        notice: `会话 ${r.index + 1}/${r.total}`,
      });
    } catch (err) {
      set({ notice: `切换失败：${err instanceof Error ? err.message : String(err)}` });
    }
  },

  newSession: async () => {
    try {
      const total = get().info !== null ? await window.api.switchSession(0) : null;
      await window.api.newSession();
      get().reset();
      // 重拉 info/usage：新会话的 sessionTitle / lastUserPrompt / contextBreakdown
      // 都变了，不重拉的话标题栏和输入框 placeholder 还挂着旧会话的内容。
      const [info, usage] = await Promise.all([window.api.info(), window.api.getUsage()]);
      set({
        info,
        usage,
        // tray 旁路的实时状态标题属于旧会话的尾巴；主进程 newSession 不发
        // session_title，这里显式清掉防串台
        sessionTitle: null,
        sessionSeq: get().sessionSeq + 1,
        notice: total !== null ? `新会话 ${total.total + 1}/${total.total + 1}` : "新会话",
      });
    } catch (err) {
      set({ notice: `新会话失败：${err instanceof Error ? err.message : String(err)}` });
    }
  },

  answerAsk: async (id, answer) => {
    await window.api.answerAsk(id, answer);
    // 不在这里本地撤卡——主进程广播 ask_user_done，多端统一靠事件流收尾
  },

  handleEvent: (e) =>
    set((s) => {
      switch (e.t) {
        case "start":
          return {
            status: "running",
            errorMessage: null,
            turns: [...s.turns, { id: nextTurnId(), role: "assistant", text: "", thinking: "", toolCalls: [], live: true }],
          };
        case "text":
          return { turns: mutateLastAssistant(s.turns, (t) => ({ ...t, text: t.text + e.delta })) };
        case "thinking":
          return {
            turns: mutateLastAssistant(s.turns, (t) => ({ ...t, thinking: t.thinking + e.delta })),
          };
        case "tool_start":
          return {
            turns: mutateLastAssistant(s.turns, (t) => ({
              ...t,
              toolCalls: [...t.toolCalls, { status: "pending", id: e.id, name: e.name, args: e.args }],
            })),
          };
        case "tool_end":
          return {
            turns: s.turns.map((t) => {
              if (t.role !== "assistant") return t;
              const idx = t.toolCalls.findIndex((tc) => tc.id === e.id);
              if (idx === -1) return t;
              const prev = t.toolCalls[idx];
              if (prev === undefined) return t;
              const toolCalls = [...t.toolCalls];
              toolCalls[idx] = {
                status: "done",
                id: e.id,
                name: e.name,
                args: prev.args,
                ok: e.ok,
                text: e.text,
                ms: e.ms,
              };
              return { ...t, toolCalls };
            }),
          };
        case "turn_usage":
          return { usage: { input: e.input, output: e.output, total: e.total } };
        case "notice":
          return { notice: e.message };
        case "plan_pending":
          // agent 跑完一轮进入 plan review：mark assistant not live + status=plan_pending
          return {
            status: "plan_pending",
            turns: markLastAssistantNotLive(s.turns),
            info: s.info !== null ? { ...s.info, planPending: true } : s.info,
          };
        case "paused":
          return {
            info: s.info !== null ? { ...s.info, paused: true } : s.info,
          };
        case "resumed":
          return {
            info: s.info !== null ? { ...s.info, paused: false } : s.info,
          };
        case "user_text":
          // 用户输入统一由 host 广播（submit/steer 都会发），显示端不做本地插入
          return {
            turns: [
              ...s.turns,
              {
                id: nextTurnId(),
                role: "user" as const,
                text: e.text,
                thinking: "",
                toolCalls: [],
                live: false,
                ...(e.images !== undefined && e.images.length > 0 ? { images: e.images } : {}),
              },
            ],
          };
        case "dictation":
          return {
            dictation: {
              seq: e.seq,
              active: e.kind === "ready" || e.kind === "partial",
              draft: e.kind === "error" ? "" : e.text,
              errorMessage:
                e.kind === "error"
                  ? e.text.length > 0
                    ? e.text
                    : "听写失败（helper 未给出原因，查看主进程日志）"
                  : null,
            },
          };
        case "session_title":
          return { sessionTitle: e.text };
        case "approval_request":
          // 本地主进程会同时弹原生 dialog；这条事件让 remote-ui 等纯显示端
          // 也能看到「有一个审批在等」（无按钮，仅状态可见）
          return { notice: `[等待审批] ${e.toolName}（到主窗口弹窗里放行）` };
        case "approval_done":
          return { notice: e.allow ? `[审批] 已允许` : `[审批] 已拒绝` };
        case "ask_user":
          // 模型提问：追加待答卡（Composer 上方渲染）。有选项时展示按钮，仍可自由输入。
          return {
            pendingAsks: [
              ...s.pendingAsks,
              {
                id: e.id,
                question: e.question,
                ...(e.choices !== undefined ? { choices: e.choices } : {}),
              },
            ],
          };
        case "ask_user_done":
          // 收尾广播：本地 / msg-window / remote 等所有显示端统一按 id 撤卡
          return { pendingAsks: s.pendingAsks.filter((p) => p.id !== e.id) };
        case "browser_state":
          // 内部浏览器面板状态：主进程的折算全量快照（标签页 + 活动指针）
          return {
            browser: {
              open: e.open,
              activeId: e.activeId,
              tabs: e.tabs,
            },
          };
        case "phone_state":
          // 手机镜像面板状态（帧数据由 PhonePanel 自行订阅，不进全局 store）
          return {
            phone: {
              open: e.open,
              connected: e.connected,
              device: e.device,
            },
          };
        case "end":
          return { status: "idle", turns: markLastAssistantNotLive(s.turns) };
        case "error":
          return {
            status: "error",
            errorMessage: e.message,
            turns: markLastAssistantNotLive(s.turns),
          };
        default:
          return s;
      }
    }),
}));
