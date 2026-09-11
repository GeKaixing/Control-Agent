/**
 * TrayStatusBridge：macOS 菜单栏状态区的实时输出 connector（DisplaySink 形态）。
 *
 * 需求：窗口切到后台（甚至红绿灯关掉窗口）后，用户仍能在菜单栏看到
 * Agent 的实时输出摘要。落点是 macOS 独有的 NSStatusItem 纯文字形态：
 * Electron 里 `new Tray(nativeImage.createEmpty())` + `tray.setTitle(文字)`，
 * 文字直接显示在菜单栏右侧，可高频更新。
 *
 * 数据面：DisplayEvent（AgentEvent | SessionSignal，含听写事件）→ 内部状态机
 *   → tray.setTitle()。与 desktop-display（IPC）、ws-display（WebSocket）并存，
 *   作为第三个 DisplaySink 收到相同的事件流。
 * 控制面：Tray 菜单「显示主窗口 / 退出」——后台时点它把窗口拉回来。
 *
 * 节流策略：流式 delta 的 setTitle 至多每 updateIntervalMs 一次（默认 250ms，
 * 菜单栏文字渲染比 IPC 重，不做 50ms 级别）；状态切换（start / end / error /
 * paused / 工具边界 / plan_pending）立即刷新，不走节流。
 *
 * 平台限制：Windows/Linux 的 tray 只有图标没有「纯文字」形态，非 darwin
 * 平台 start() 直接返回（emit 变 noop），菜单栏需求仅在 macOS 生效。
 *
 * 标题旁路：onTitle 回调把每段标题同步给主进程——窗口顶部标题栏（渲染层）
 * 显示的「当前会话标题」与菜单栏是同一份状态机的输出。
 *
 * 生命周期：connector 由 displayRuntime adopt + start/stop；app 退出时
 * runtime.dispose → stop() → tray.destroy()，不残留 NSStatusItem。
 */

import { app, Menu, Tray, nativeImage } from "electron";

import type {
  Connector,
  ConnectorContext,
  DisplayEvent,
  DisplaySink,
  SessionSignal,
} from "../../src/connector/core/types.js";
import type { AgentEvent } from "../../src/agent/agent.js";
import type { Tool, ToolResult } from "../../src/tools/types.js";
import { fail } from "../../src/tools/types.js";
import type { ToolCallContent } from "../../src/types.js";

export interface TrayStatusOptions {
  /** Tray 菜单「显示主窗口」回调。主进程注入：窗口没了就重建，否则 show + focus */
  onShowWindow?: () => void;
  /** 流式 delta 的 setTitle 节流间隔（毫秒）。默认 250 */
  updateIntervalMs?: number;
  /** 状态文字里保留的流式输出尾部字符数。默认 24 */
  tailChars?: number;
  /**
   * 标题旁路：每次 setTitle 时把同一段文字回调给主进程。
   * index.ts 用它把「当前会话标题」经 IPC 推给渲染层，显示在窗口顶部标题栏
   * （Composer-only 布局的拖动条）——与 tray 同一份状态机，单一事实来源。
   */
  onTitle?: (text: string) => void;
}

/** 空闲态标题 */
const IDLE_TITLE = "✓ 空闲";

/**
 * 最终回答缓冲的字符数。完成态标题要尽量吃满窗口标题栏的剩余空间，
 * 所以这里比 tailChars（流式显示用的 24）留得长；菜单栏 tray 用短版，
 * 长版只推给渲染层（渲染层 CSS truncate 兜底）。
 */
const ANSWER_TAIL_CHARS = 160;

/** 折叠空白后取末尾 N 个 Unicode 码点（emoji / 中文安全），超长头部打省略号 */
function tailOf(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return "…" + Array.from(flat).slice(-max).join("");
}

/** 取第一个非空 string 参数（bash 的 command / read 的 file_path 之类），没有就空串 */
function firstStringArg(args: Record<string, unknown>): string {
  for (const value of Object.values(args)) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

/** token 数 → 紧凑显示（1234 → "1.2k"） */
function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** 听写事件的宽松形状（index.ts 直接 emit，不经 WireEvent 映射） */
interface DictationLike {
  kind: string;
  text: string;
}

export default class TrayStatusBridge implements Connector, DisplaySink {
  readonly id = "tray-status";

  private readonly onShowWindow?: () => void;
  private readonly updateIntervalMs: number;
  private readonly tailChars: number;
  private readonly onTitle?: (text: string) => void;

  private tray: Tray | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pendingFlush = false;
  private lastFlushAt = 0;

  // ── 状态机（一次 run 的实时摘要） ──
  private phase: "idle" | "running" = "idle";
  private paused = false;
  private dictating = false;
  private tail = "";
  /**
   * 最终回答的末尾：只攒「最后一段文本」——thinking / 工具开始都会清零重来，
   * 所以 end 时它就是最后一条 assistant 文本消息的尾部（完成态标题用）。
   */
  private answerTail = "";
  private thinking = false;
  private currentTool: { name: string; arg: string } | null = null;
  private lastToolNote = "";
  private totalTokens = 0;

  constructor(options: TrayStatusOptions = {}) {
    this.onShowWindow = options.onShowWindow;
    this.updateIntervalMs = options.updateIntervalMs ?? 250;
    this.tailChars = options.tailChars ?? 24;
    this.onTitle = options.onTitle;
  }

  // ── Connector 生命周期 ──

  async start(_ctx: ConnectorContext): Promise<void> {
    void _ctx;
    if (process.platform === "darwin") {
      this.tray = new Tray(nativeImage.createEmpty());
      this.tray.setToolTip("Control-Agent");
      this.tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: "显示主窗口", click: () => this.onShowWindow?.() },
          { type: "separator" },
          { label: "退出 Control-Agent", click: () => app.quit() },
        ]),
      );
    }
    // 非 darwin 不建 tray，但 setTitle 照走——窗口标题栏（onTitle 旁路）仍要拿到初始标题
    this.setTitle(IDLE_TITLE);
  }

  async stop(): Promise<void> {
    this.clearTimer();
    this.tray?.destroy();
    this.tray = null;
  }

  getTools(): Tool[] {
    return [];
  }

  async execute(toolName: string): Promise<ToolResult> {
    return fail(`tray-status 不暴露工具（收到 ${toolName}）`);
  }

  // ── DisplaySink：事件入口 ──

  /**
   * DisplayEvent 是 AgentEvent | SessionSignal，但 dictation 事件（{t:"dictation"}）
   * 也会从同一条 emit 通路进来（index.ts 直接发），用宽松判别接住。
   */
  emit(event: DisplayEvent): void {
    const raw = event as { t?: string; type?: string };
    if (raw.t === "dictation") {
      this.handleDictation(event as unknown as DictationLike);
      return;
    }
    if (isSessionSignal(event)) {
      this.handleSignal(event);
      return;
    }
    this.handleAgentEvent(event);
  }

  // ── 状态机 ──

  private handleSignal(signal: SessionSignal): void {
    switch (signal.t) {
      case "start":
        this.phase = "running";
        this.paused = false;
        this.tail = "";
        this.answerTail = "";
        this.thinking = false;
        this.currentTool = null;
        this.lastToolNote = "";
        this.totalTokens = 0;
        this.flushNow();
        return;
      case "end": {
        this.phase = "idle";
        this.paused = false;
        this.currentTool = null;
        // 完成态显示最终回答（窗口标题栏给长版吃满剩余空间；菜单栏 tray 保持短版，
        // 不然 NSStatusItem 会把菜单栏撑爆）。token 用量放最右边。
        const tok = this.totalTokens > 0 ? ` · ${formatTokens(this.totalTokens)} token` : "";
        const shortBody =
          this.answerTail.length > 0 ? tailOf(this.answerTail, this.tailChars) : "完成";
        this.setTitle(
          `✓ ${this.answerTail.length > 0 ? this.answerTail : "完成"}${tok}`,
          `✓ ${shortBody}${tok}`,
        );
        return;
      }
      case "error":
        this.phase = "idle";
        this.paused = false;
        this.currentTool = null;
        this.setTitle(`✗ ${tailOf(signal.message, this.tailChars)}`);
        return;
      case "paused":
        this.paused = true;
        this.flushNow();
        return;
      case "resumed":
        this.paused = false;
        this.flushNow();
        return;
      case "plan_pending":
        this.setTitle(`⏸ 等待确认计划（第 ${signal.round} 轮）`);
        return;
      case "turn_usage":
        this.totalTokens += signal.total;
        return;
      case "flush":
        this.flushNow();
        return;
    }
  }

  private handleAgentEvent(event: AgentEvent): void {
    switch (event.type) {
      case "stream": {
        const ev = event.event;
        if (ev.type === "text_delta") {
          this.thinking = false;
          this.lastToolNote = "";
          this.tail = tailOf(this.tail + ev.delta, this.tailChars);
          this.answerTail = tailOf(this.answerTail + ev.delta, ANSWER_TAIL_CHARS);
          this.schedule();
        } else if (ev.type === "thinking_delta") {
          this.thinking = true;
          this.lastToolNote = "";
          this.tail = tailOf(this.tail + ev.delta, this.tailChars);
          this.answerTail = ""; // 思考不是回答：清掉，等后面的正文重新攒
          this.schedule();
        }
        return;
      }
      case "tool_start": {
        this.currentTool = {
          name: event.toolCall.name,
          arg: firstStringArg(safeArgs(event.toolCall)),
        };
        this.answerTail = ""; // 新一轮工具调用开始：上一段的文本不再是「最终回答」
        this.flushNow();
        return;
      }
      case "tool_end": {
        this.currentTool = null;
        this.lastToolNote = `${event.result.isError ? "✗" : "✓"} ${event.toolCall.name} ${Math.round(event.durationMs)}ms`;
        this.flushNow();
        return;
      }
      default:
        return;
    }
  }

  private handleDictation(event: DictationLike): void {
    switch (event.kind) {
      case "ready":
        this.dictating = true;
        this.setTitle("🎤 听写中…");
        return;
      case "partial":
        this.dictating = true;
        // 只显示状态。转写文本的落点是输入框（desktop-display 直通 dictation
        // 事件、渲染层自己合并）；进 tray/标题栏都是错位——用户明确不要。
        this.setTitle("🎤 听写中…");
        return;
      case "final":
      case "error":
        this.dictating = false;
        this.apply();
        return;
      default:
        return;
    }
  }

  // ── 标题合成与节流 ──

  private runningTitle(): string {
    if (this.paused) return "⏸ 已暂停";
    if (this.currentTool !== null) {
      const { name, arg } = this.currentTool;
      return arg.length > 0 ? `⚙ ${name}: ${tailOf(arg, this.tailChars)}` : `⚙ ${name}…`;
    }
    if (this.lastToolNote.length > 0) return this.lastToolNote;
    const body = this.tail.length > 0 ? this.tail : "思考中…";
    return `${this.thinking ? "💭" : "⏳"} ${body}`;
  }

  private apply(): void {
    if (this.dictating) return; // 听写标题由 handleDictation 直接接管
    if (this.phase === "idle") {
      this.setTitle(IDLE_TITLE);
      return;
    }
    this.setTitle(this.runningTitle());
  }

  /** 立即刷新（状态切换用），重置节流窗口 */
  private flushNow(): void {
    this.clearTimer();
    this.pendingFlush = false;
    this.lastFlushAt = Date.now();
    this.apply();
  }

  /** 流式 delta 用的节流刷新：至多每 updateIntervalMs 一次 */
  private schedule(): void {
    if (this.pendingFlush) return;
    const wait = Math.max(0, this.updateIntervalMs - (Date.now() - this.lastFlushAt));
    this.pendingFlush = true;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pendingFlush = false;
      this.lastFlushAt = Date.now();
      this.apply();
    }, wait);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * 标题出口：tray 用短版（menu bar 空间宝贵），onTitle 旁路给渲染层的是长版
   * （窗口标题栏有 CSS truncate 兜底，能吃满剩余空间）。两者默认相同。
   */
  private setTitle(text: string, trayText: string = text): void {
    this.tray?.setTitle(trayText);
    this.onTitle?.(text);
  }
}

// ────────────── 工具函数 ──────────────

/** SessionSignal 的类型守卫（与 desktop-display 的判定保持一致） */
function isSessionSignal(event: DisplayEvent): event is SessionSignal {
  const t = (event as { t?: string }).t;
  return (
    t === "start" ||
    t === "end" ||
    t === "error" ||
    t === "paused" ||
    t === "resumed" ||
    t === "plan_pending" ||
    t === "turn_usage" ||
    t === "flush"
  );
}

/** 把 ToolCallContent.arguments 强制视为对象，避免异常形状 */
function safeArgs(tc: ToolCallContent): Record<string, unknown> {
  const raw = tc.arguments;
  if (typeof raw === "object" && raw !== null) return raw as Record<string, unknown>;
  return {};
}
