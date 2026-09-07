/**
 * 消息显示 connector 化的测试：
 * - display-route：事件 → DisplaySink 广播 / 无 sink 时 fallback
 * - DesktopDisplayConnector：AgentEvent | SessionSignal → WireEvent 映射（含节流）
 *
 * 这条链路是 desktop 消息显示 UI 的数据来源；Composer（超级输入框）不走这里。
 */

import assert from "node:assert/strict";
import { test } from "./registry.js";
import DesktopDisplayConnector, {
  TEXT_FLUSH_MS,
} from "../src/connector/connectors/desktop-display/index.js";
import { createDisplayRoute } from "../src/connector/runtime/display-route.js";
import { ConnectorRegistry } from "../src/connector/registry/connector-registry.js";
import type { DisplayEvent, SessionSignal } from "../src/connector/core/types.js";
import type { Connector } from "../src/connector/core/types.js";
import type { Tool, ToolResult } from "../src/tools/types.js";
import { fail } from "../src/tools/types.js";
import type { AgentEvent } from "../src/agent/agent.js";
import type { WireEvent } from "../desktop/shared/api.js";
import { sleep } from "./registry.js";

// ────────────── 测试辅助 ──────────────

function makeDisplay(): { connector: DesktopDisplayConnector; wires: WireEvent[] } {
  const wires: WireEvent[] = [];
  const connector = new DesktopDisplayConnector({ transport: (w) => wires.push(w) });
  return { connector, wires };
}

/** 最小 Connector 实现（不带 emit）——用来验证 asDisplaySink 排除它 */
class PlainConnector implements Connector {
  readonly id = "plain";
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): Tool[] {
    return [];
  }
  async execute(toolName: string): Promise<ToolResult> {
    return fail(`no tool: ${toolName}`);
  }
}

/** 构造一条 stream text_delta AgentEvent（partial 内容 connector 不读，给最小合法形状） */
function textDelta(delta: string): AgentEvent {
  const partial = {
    role: "assistant" as const,
    content: [],
    model: "mock:mock-1",
    stopReason: "stop" as const,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    timestamp: Date.now(),
  };
  return {
    type: "stream",
    event: { type: "text_delta", delta, partial },
  };
}

// ────────────── display-route ──────────────

test("display-route: 有 DisplaySink connector 时广播给它，不走 fallback", () => {
  const { connector, wires } = makeDisplay();
  const registry = new ConnectorRegistry();
  registry.register({
    manifest: { id: "desktop-display", version: "0", type: "desktop", capabilities: [] },
    instance: connector,
    state: "ready",
    rootDir: "/t",
  });
  const fallbackCalls: unknown[] = [];
  const route = createDisplayRoute({ registry }, (e) => fallbackCalls.push(e));

  const signal: SessionSignal = { t: "start" };
  route(signal);

  assert.equal(wires.length, 1, "sink 应收到事件");
  assert.deepEqual(wires[0], { t: "start" });
  assert.equal(fallbackCalls.length, 0, "fallback 不应被调用");
});

test("display-route: 无 DisplaySink 时走 fallback（直连保底）", () => {
  const registry = new ConnectorRegistry();
  registry.register({
    manifest: { id: "plain", version: "0", type: "cli", capabilities: [] },
    instance: new PlainConnector(),
    state: "ready",
    rootDir: "/t",
  });
  const fallbackCalls: unknown[] = [];
  const route = createDisplayRoute({ registry }, (e) => fallbackCalls.push(e));

  route({ t: "paused" });
  assert.deepEqual(fallbackCalls, [{ t: "paused" }]);
});

test("display-route: 多个 sink 并存时全部广播（默认连接 + 未来新增的 sink）", () => {
  const a: WireEvent[] = [];
  const b: WireEvent[] = [];
  const displayA = new DesktopDisplayConnector({ transport: (w) => a.push(w) });
  const displayB = new DesktopDisplayConnector({ transport: (w) => b.push(w) });
  const registry = new ConnectorRegistry();
  registry.register({
    manifest: { id: "display-a", version: "0", type: "desktop", capabilities: [] },
    instance: displayA,
    state: "ready",
    rootDir: "/a",
  });
  registry.register({
    manifest: { id: "display-b", version: "0", type: "desktop", capabilities: [] },
    instance: displayB,
    state: "ready",
    rootDir: "/b",
  });
  const route = createDisplayRoute({ registry }, () => {});

  route({ t: "resumed" });
  assert.deepEqual(a, [{ t: "resumed" }]);
  assert.deepEqual(b, [{ t: "resumed" }], "第二个 sink 也要收到（并存广播）");
});

test("display-route: 单个 sink throw 不影响其他 sink 与主流程", () => {
  const ok: WireEvent[] = [];
  const bad = new DesktopDisplayConnector({
    transport: () => {
      throw new Error("transport down");
    },
  });
  const good = new DesktopDisplayConnector({ transport: (w) => ok.push(w) });
  const registry = new ConnectorRegistry();
  registry.register({
    manifest: { id: "bad", version: "0", type: "desktop", capabilities: [] },
    instance: bad,
    state: "ready",
    rootDir: "/bad",
  });
  registry.register({
    manifest: { id: "good", version: "0", type: "desktop", capabilities: [] },
    instance: good,
    state: "ready",
    rootDir: "/good",
  });
  const route = createDisplayRoute({ registry }, () => {});

  assert.doesNotThrow(() => route({ t: "paused" }));
  assert.deepEqual(ok, [{ t: "paused" }], "坏 sink 之后的好 sink 仍要收到事件");
});

// ────────────── DesktopDisplayConnector 映射 ──────────────

test("display connector: SessionSignal 直接映射成 WireEvent", () => {
  const { connector, wires } = makeDisplay();

  connector.emit({ t: "start" });
  connector.emit({ t: "paused" });
  connector.emit({ t: "resumed" });
  connector.emit({ t: "plan_pending", round: 2 });
  connector.emit({ t: "turn_usage", input: 10, output: 5, total: 15 });
  connector.emit({ t: "end", toolRounds: 3 });
  connector.emit({ t: "error", message: "boom" });

  assert.deepEqual(wires, [
    { t: "start" },
    { t: "paused" },
    { t: "resumed" },
    { t: "plan_pending", round: 2 },
    { t: "turn_usage", input: 10, output: 5, total: 15 },
    { t: "end", toolRounds: 3 },
    { t: "error", message: "boom" },
  ]);
});

test("display connector: text_delta 经节流后合并成 text wire 事件", async () => {
  const { connector, wires } = makeDisplay();
  connector.emit({ t: "start" });

  connector.emit(textDelta("he"));
  connector.emit(textDelta("llo"));
  // 节流窗口内不 flush—— wires 此时应只有 start
  assert.equal(wires.length, 1);

  await sleep(TEXT_FLUSH_MS + 30);
  assert.equal(wires.length, 2, "节流窗口过后应 flush 一次");
  assert.deepEqual(wires[1], { t: "text", delta: "hello" }, "两段 delta 应合并成一段");
});

test("display connector: flush 信号立即冲刷节流缓冲（pause 不溜字）", () => {
  const { connector, wires } = makeDisplay();
  connector.emit({ t: "start" });
  connector.emit(textDelta("pending"));
  connector.emit({ t: "flush" });
  connector.emit({ t: "paused" });

  const flushedIdx = wires.findIndex((w) => w.t === "text" && w.delta === "pending");
  const pausedIdx = wires.findIndex((w) => w.t === "paused");
  assert.ok(flushedIdx !== -1, "flush 后残留 text 必须立刻出来");
  assert.ok(pausedIdx !== -1 && flushedIdx < pausedIdx, "text 冲刷发生在 paused 之前");
});

test("display connector: end 信号先冲刷缓冲再发 end（不留尾巴）", async () => {
  const { connector, wires } = makeDisplay();
  connector.emit({ t: "start" });
  connector.emit(textDelta("tail"));
  connector.emit({ t: "end", toolRounds: 1 });

  assert.equal(wires.some((w) => w.t === "text" && w.delta === "tail"), true, "end 前 text 已冲刷");
  assert.equal(wires[wires.length - 1]?.t, "end", "end 是最后一个事件");

  // 等 50ms 确认没有延迟 flush 再溜出来一条
  await sleep(TEXT_FLUSH_MS + 30);
  assert.equal(wires.filter((w) => w.t === "text").length, 1, "不应有重复/迟到的 text");
});

test("display connector: notice / context_pruned 映射为 notice wire", () => {
  const { connector, wires } = makeDisplay();

  connector.emit({ type: "notice", message: "工具连续失败" } as AgentEvent);
  connector.emit({
    type: "context_pruned",
    droppedMessages: 3,
    prunedToolResults: 2,
  } as AgentEvent);

  assert.deepEqual(wires, [
    { t: "notice", message: "工具连续失败" },
    { t: "notice", message: "上下文已裁剪：丢弃 3 条，压缩 2 处" },
  ]);
});

test("display connector: stream error 透传为 error wire（abort 不算错误）", () => {
  const { connector, wires } = makeDisplay();
  connector.emit({ t: "start" });
  connector.emit(textDelta("半截输出"));

  const errMessage = (errorMessage: string, stopReason: "error" | "aborted") => ({
    role: "assistant" as const,
    content: [],
    model: "mock:mock-1",
    stopReason,
    errorMessage,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    timestamp: Date.now(),
  });
  // 重试耗尽的最终失败 → 必须透传给 UI（此前被静默吞掉，用户不知道出了什么错）
  connector.emit({
    type: "stream",
    event: { type: "error", reason: "error", error: errMessage("HTTP 400 MissingSessionID", "error") },
  } as AgentEvent);
  // 用户主动中断 → 不是错误，不产生 error wire
  connector.emit({
    type: "stream",
    event: { type: "error", reason: "aborted", error: errMessage("已中断", "aborted") },
  } as AgentEvent);

  const errs = wires.filter((w) => w.t === "error");
  assert.equal(errs.length, 1, "只有 reason=error 透传，abort 静默");
  assert.deepEqual(errs[0], { t: "error", message: "HTTP 400 MissingSessionID" });
  // 半截输出先冲刷，再报错（flushNow 在 error 之前）
  const textIdx = wires.findIndex((w) => w.t === "text");
  const errIdx = wires.findIndex((w) => w.t === "error");
  assert.ok(textIdx !== -1 && textIdx < errIdx, "残留 text 先于 error 冲刷");
});

test("display connector: dictation 等旁路事件（有 t 无 type）原样直通", () => {
  const { connector, wires } = makeDisplay();

  // 有 t、无 type、也不是 SessionSignal → 必须透传给 transport。
  // 此前这类事件落进 handleAgentEvent 的 default 被静默丢弃，
  // 主窗口永远收不到 dictation（听写文字只出现在 tray/标题栏的根因）。
  connector.emit({ t: "dictation", kind: "ready", text: "", seq: 1 } as unknown as DisplayEvent);
  connector.emit({
    t: "dictation",
    kind: "partial",
    text: "你好世界",
    seq: 2,
  } as unknown as DisplayEvent);

  assert.deepEqual(wires, [
    { t: "dictation", kind: "ready", text: "", seq: 1 },
    { t: "dictation", kind: "partial", text: "你好世界", seq: 2 },
  ]);
});

test("display connector: tool_start / tool_end 映射，args 非对象兜底 {}", () => {
  const { connector, wires } = makeDisplay();

  connector.emit({
    type: "tool_start",
    toolCall: { id: "c1", name: "bash", arguments: { command: "ls" } },
    parallel: false,
  } as unknown as AgentEvent);
  connector.emit({
    type: "tool_end",
    toolCall: { id: "c1", name: "bash", arguments: "corrupted" },
    result: { content: [{ type: "text", text: "out" }], isError: false },
    durationMs: 12.6,
  } as unknown as AgentEvent);

  assert.deepEqual(wires, [
    { t: "tool_start", id: "c1", name: "bash", args: { command: "ls" } },
    { t: "tool_end", id: "c1", name: "bash", ok: true, text: "out", ms: 13 },
  ]);
});

test("display connector: agent_start / turn_start / steering / agent_end 不产生 wire", () => {
  const { connector, wires } = makeDisplay();

  connector.emit({ type: "agent_start" } as AgentEvent);
  connector.emit({ type: "turn_start", pendingFollowUps: 0 } as AgentEvent);
  connector.emit({ type: "steering", texts: ["x"] } as AgentEvent);
  connector.emit({ type: "agent_end", toolRounds: 1 } as AgentEvent);

  assert.equal(wires.length, 0, "细粒度信号桌面端不需要");
});

test("display connector: stop() 冲刷残留 buffer", async () => {
  const { connector, wires } = makeDisplay();
  connector.emit({ t: "start" });
  connector.emit(textDelta("last words"));
  await connector.stop();

  assert.equal(wires.some((w) => w.t === "text" && w.delta === "last words"), true);
});

test("display connector: user_text 信号透传（用户输入广播）", () => {
  const { connector, wires } = makeDisplay();

  connector.emit({ t: "user_text", text: "探测这个视频" });
  // 与 turn 事件混排也不串线
  connector.emit({ t: "start" });

  assert.deepEqual(wires[0], { t: "user_text", text: "探测这个视频" });
  assert.equal(wires[1]?.t, "start");
});

test("display connector: flush 信号在 pause 前发出（SessionManager 契约）", () => {
  // 直接验证事件序列约定：pause() 会先 emit flush 再 emit paused。
  // 这里用 connector 的视角验证两条信号按序产生正确的 wire。
  const { connector, wires } = makeDisplay();
  connector.emit({ t: "start" });
  connector.emit(textDelta("w"));
  connector.emit({ t: "flush" }); // pause() 第一发
  connector.emit({ t: "paused" }); // pause() 第二发

  const flushed = wires.find((w) => w.t === "text");
  const pausedIdx = wires.findIndex((w) => w.t === "paused");
  const flushedIdx = wires.findIndex((w) => w === flushed);
  assert.ok(flushedIdx !== -1 && pausedIdx !== -1 && flushedIdx < pausedIdx);
});

test("display connector: DisplayEvent 类型守卫——混合流不串线", () => {
  const { connector, wires } = makeDisplay();
  const events: DisplayEvent[] = [
    { t: "start" },
    textDelta("a"),
    { t: "flush" },
    { type: "notice", message: "n" } as AgentEvent,
  ];
  for (const e of events) connector.emit(e);

  assert.deepEqual(
    wires.map((w) => w.t),
    ["start", "text", "notice"],
  );
});
