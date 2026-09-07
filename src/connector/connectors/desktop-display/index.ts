/**
 * DesktopDisplayConnector：消息显示 UI 的 connector 实现（「默认连接」）。
 *
 * 职责（从 desktop/main/session.ts + ipc.ts 迁移而来）：
 * 1. 消费 SessionManager 发出的 DisplayEvent（AgentEvent | SessionSignal）
 * 2. AgentEvent → WireEvent 的全部映射逻辑（含 TextFlusher 对高频 text/thinking
 *    delta 的节流合并）都在这里——「消息显示成什么样」的实现细节
 * 3. WireEvent 交给注入的 transport 推送。desktop/main 装配时 transport =
 *    `webContents.send(IPC.PUSH, e)`（Electron IPC）；未来远程 UI 可以注入
 *    websocket transport 而不用改渲染层。
 *
 * 与其他 connector 的差别：
 * - 方向相反：execute 是 Agent → connector；这里是 事件流 → 显示端
 * - 不暴露任何 tool（getTools() 返回 []），manifest.capabilities 为空
 * - emit 必须同步、不 throw：显示是 best-effort，失败只影响本 sink
 */

import type {
  Connector,
  ConnectorContext,
  DisplayEvent,
  DisplaySink,
  SessionSignal,
} from "../../core/types.js";
import type { Tool, ToolResult } from "../../../tools/types.js";
import { fail } from "../../../tools/types.js";
import type { ToolCallContent } from "../../../types.js";
import type { AgentEvent } from "../../../agent/agent.js";
import type { WireEvent } from "../../../../desktop/shared/api.js";

// ────────────── 节流（自 desktop/main/ipc.ts 迁移） ──────────────

/** 节流：相邻两次 text_delta 推送合并的最大延迟（毫秒） */
export const TEXT_FLUSH_MS = 50;

/** 节流：累积 buffer 超过这个字符数时立即刷新，避免分片过大 */
export const TEXT_FLUSH_CHARS = 256;

/**
 * 把高频 text/thinking delta 合并成单次推送。
 *
 * 设计要点（与原 TextFlusher 一致）：
 * - 不能用简单的 `setTimeout(flush, N)`：连续 delta 持续到来时永远不会刷新
 * - 同时持有「时间窗口」和「字符阈值」，任一到达就 flush
 */
class TextFlusher {
  private buffer: { delta: string; thinking: string } = { delta: "", thinking: "" };
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly push: (wire: { delta: string; thinking: string }) => void) {}

  append(delta: string, thinking: string): void {
    if (delta.length > 0) this.buffer.delta += delta;
    if (thinking.length > 0) this.buffer.thinking += thinking;
    const accumulated = this.buffer.delta.length + this.buffer.thinking.length;
    if (accumulated >= TEXT_FLUSH_CHARS) {
      this.flushNow();
      return;
    }
    if (this.timer === null) {
      this.timer = setTimeout(() => this.flushNow(), TEXT_FLUSH_MS);
    }
  }

  flushNow(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer.delta.length === 0 && this.buffer.thinking.length === 0) return;
    this.push({ delta: this.buffer.delta, thinking: this.buffer.thinking });
    this.buffer = { delta: "", thinking: "" };
  }
}

// ────────────── connector 本体 ──────────────

export interface DesktopDisplayOptions {
  /**
   * 传输层：WireEvent 的出口。desktop/main 装配时注入 Electron IPC；
   * 测试注入数组收集器。必须不 throw（connector 内部也不额外兜底）。
   */
  transport: (wire: WireEvent) => void;
}

export default class DesktopDisplayConnector implements Connector, DisplaySink {
  readonly id = "desktop-display";
  private readonly transport: (wire: WireEvent) => void;
  /** 当前 run 的节流器。start 信号时创建，end/error 时冲刷并丢弃 */
  private flusher: TextFlusher | null = null;

  constructor(options: DesktopDisplayOptions) {
    this.transport = options.transport;
  }

  // ── Connector 生命周期（无外部资源，全部幂等 noop） ──

  async start(_ctx: ConnectorContext): Promise<void> {
    void _ctx;
  }

  async stop(): Promise<void> {
    // 冲刷残留，避免 stop 后 buffer 里还有未发送的 delta
    this.flusher?.flushNow();
    this.flusher = null;
  }

  getTools(): Tool[] {
    return [];
  }

  async execute(toolName: string): Promise<ToolResult> {
    return fail(`desktop-display 不暴露工具（收到 ${toolName}）`);
  }

  // ── DisplaySink：事件入口 ──

  /**
   * 接收 DisplayEvent 并转换推送。
   * AgentEvent → 映射成 WireEvent（节流的 delta 走 flusher）；
   * SessionSignal → 直接透传成对应 WireEvent（flush 触发冲刷）。
   */
  emit(event: DisplayEvent): void {
    if (isSessionSignal(event)) {
      this.handleSignal(event);
      return;
    }
    // AgentEvent 必有 type；到这里既非 SessionSignal 也无 type 的是「旁路直通事件」
    // （dictation 等）——不经映射/节流，原样透传。此前它们落进 handleAgentEvent 的
    // default 被静默丢弃，主窗口永远收不到听写事件（转写只出现在 tray/标题栏）。
    if ((event as { type?: string }).type === undefined) {
      this.pushWire(event as unknown as WireEvent);
      return;
    }
    this.handleAgentEvent(event);
  }

  private handleSignal(signal: SessionSignal): void {
    switch (signal.t) {
      case "start":
        this.flusher = new TextFlusher((wire) => {
          if (wire.delta.length > 0) this.pushWire({ t: "text", delta: wire.delta });
          if (wire.thinking.length > 0) this.pushWire({ t: "thinking", delta: wire.thinking });
        });
        this.pushWire({ t: "start" });
        return;
      case "end":
        this.flusher?.flushNow();
        this.flusher = null;
        this.pushWire({ t: "end", toolRounds: signal.toolRounds });
        return;
      case "error":
        this.flusher?.flushNow();
        this.flusher = null;
        this.pushWire({ t: "error", message: signal.message });
        return;
      case "paused":
        this.pushWire({ t: "paused" });
        return;
      case "resumed":
        this.pushWire({ t: "resumed" });
        return;
      case "user_text":
        this.pushWire({ t: "user_text", text: signal.text });
        return;
      case "plan_pending":
        this.pushWire({ t: "plan_pending", round: signal.round });
        return;
      case "turn_usage":
        this.pushWire({
          t: "turn_usage",
          input: signal.input,
          output: signal.output,
          total: signal.total,
        });
        return;
      case "flush":
        this.flusher?.flushNow();
        return;
    }
  }

  private handleAgentEvent(event: AgentEvent): void {
    switch (event.type) {
      case "agent_start":
      case "turn_start":
      case "steering":
        // 桌面端不需要这些细粒度信号
        return;
      case "stream": {
        const ev = event.event;
        if (ev.type === "text_delta") {
          this.flusher?.append(ev.delta, "");
        } else if (ev.type === "thinking_delta") {
          this.flusher?.append("", ev.delta);
        } else if (ev.type === "error" && ev.reason !== "aborted") {
          // 模型流最终失败（重试耗尽 / 不可重试）：必须把错误透给 UI。
          // abort 是用户主动中断，不算错误，不产生噪音。
          this.flusher?.flushNow();
          this.pushWire({
            t: "error",
            message: ev.error.errorMessage ?? "模型流失败（无错误详情）",
          });
        }
        return;
      }
      case "tool_start": {
        const tc = event.toolCall;
        this.pushWire({ t: "tool_start", id: tc.id, name: tc.name, args: safeArgs(tc) });
        return;
      }
      case "tool_end": {
        const tc = event.toolCall;
        const text = event.result.content
          .map((c) => (c.type === "text" ? c.text : ""))
          .join("\n");
        this.pushWire({
          t: "tool_end",
          id: tc.id,
          name: tc.name,
          ok: !event.result.isError,
          text,
          ms: Math.round(event.durationMs),
        });
        return;
      }
      case "turn_end": {
        // turn_usage 由 SessionManager 计算后作为信号发——这里不重复算
        return;
      }
      case "context_pruned": {
        this.pushWire({
          t: "notice",
          message: `上下文已裁剪：丢弃 ${event.droppedMessages} 条，压缩 ${event.prunedToolResults} 处`,
        });
        return;
      }
      case "notice": {
        this.pushWire({ t: "notice", message: event.message });
        return;
      }
      case "agent_end":
        // end 由 SessionManager 的 {t:"end"} 信号触发（它还要处理 plan 逻辑）
        return;
      default:
        return;
    }
  }

  private pushWire(wire: WireEvent): void {
    this.transport(wire);
  }
}

// ────────────── 工厂 + 工具函数 ──────────────

/** SessionSignal 的类型守卫（AgentEvent 的 t 字段不存在，靠 t 值域区分） */
function isSessionSignal(event: DisplayEvent): event is SessionSignal {
  const t = (event as { t?: string }).t;
  return (
    t === "start" ||
    t === "end" ||
    t === "error" ||
    t === "paused" ||
    t === "resumed" ||
    t === "user_text" ||
    t === "plan_pending" ||
    t === "turn_usage" ||
    t === "flush"
  );
}

/** 把 ToolCallContent.arguments 强制视为对象，避免 IPC 序列化异常 */
function safeArgs(tc: ToolCallContent): Record<string, unknown> {
  const raw = tc.arguments;
  if (typeof raw === "object" && raw !== null) return raw as Record<string, unknown>;
  return {};
}
