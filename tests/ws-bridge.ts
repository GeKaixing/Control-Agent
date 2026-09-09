/**
 * 独立 UI 的 WS 接入桥测试：
 *  - 协议编解码（ws-protocol 纯函数）
 *  - dispatchApi 参数校验与错误包装
 *  - WsDisplayBridge 真链路：hello / RPC / 事件广播 / 节流合并 / 坏帧断开
 */

import assert from "node:assert/strict";
import WebSocket from "ws";

import { decodeWsClientFrame, encodeWsFrame } from "../desktop/shared/ws-protocol.js";
import { dispatchApi } from "../desktop/main/api-dispatcher.js";
import WsDisplayBridge from "../desktop/main/ws-bridge.js";
import type { InfoPayload, WireEvent } from "../desktop/shared/api.js";
import type { SessionManager } from "../desktop/main/session.js";
import { test } from "./registry.js";

const FAKE_INFO: InfoPayload = {
  cwd: "/tmp/fake",
  model: "mock-1",
  modelSpec: "mock:mock-1",
  tools: ["read"],
  contextWindow: 128000,
  baseURL: "http://localhost",
  mode: "full",
  paused: false,
  reasoning: "balanced",
  endpoint: "mock",
  maxTokens: 4096,
  planPending: false,
  approvalMode: false,
  autoCompact: true,
  msgWindow: false,
  sessionTitle: "新会话",
  lastUserPrompt: null,
  contextBreakdown: { systemPrompt: 0, tools: 0, connectors: 0, skills: 0, messages: 0 },
  toolsByCategory: { skill: [], tool: [], mcp: [], plugin: [], extension: [] },
  baseUrlPresets: [],
  localPreview: false,
  alwaysOnTop: false,
  localServers: [],
};

/** 起一个桥（port 0 = 系统随机），返回 { bridge, port, dispatchLog } */
async function makeBridge(overrides: {
  dispatch?: (method: string, args: readonly unknown[]) => Promise<unknown>;
} = {}): Promise<{ bridge: WsDisplayBridge; port: number; dispatchLog: { method: string; args: unknown[] }[] }> {
  const dispatchLog: { method: string; args: unknown[] }[] = [];
  const bridge = new WsDisplayBridge({
    port: 0,
    dispatch:
      overrides.dispatch ??
      (async (method, args) => {
        dispatchLog.push({ method, args: [...args] });
        return { echoed: method };
      }),
    getInfo: () => FAKE_INFO,
  });
  await bridge.start({ cwd: "/tmp", signal: new AbortController().signal, env: {} });
  const port = bridge.boundPort;
  assert.ok(typeof port === "number" && port > 0, "bridge 应绑定到随机端口");
  return { bridge, port, dispatchLog };
}

/** 连一个客户端，收满 n 帧（带超时） */
async function collect(port: number, n: number): Promise<unknown[]> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const frames: unknown[] = [];
  socket.on("message", (data) => frames.push(JSON.parse(String(data))));
  await awaitOpen(socket);
  const deadline = Date.now() + 3000;
  while (frames.length < n) {
    if (Date.now() > deadline) throw new Error(`等待 ${n} 帧超时，只收到 ${frames.length}`);
    await new Promise((r) => setTimeout(r, 20));
  }
  socket.close();
  return frames;
}

/** ws.WebSocket 的类型与 node:events 的 once 重载不匹配，这里显式包一层 */
function awaitOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    const onOpen = (): void => {
      socket.off("error", onError);
      resolve();
    };
    const onError = (err: Error): void => {
      socket.off("open", onOpen);
      reject(err);
    };
    socket.once("open", onOpen);
    socket.once("error", onError);
  });
}

// ────────────── 协议编解码 ──────────────

test("ws-protocol: 合法 rpc 帧解码", () => {
  const line = encodeWsFrame({ kind: "rpc", id: 7, method: "info", args: [] });
  const decoded = decodeWsClientFrame(line);
  assert.ok(!("error" in decoded));
  assert.deepEqual(decoded.msg, { kind: "rpc", id: 7, method: "info", args: [] });
});

test("ws-protocol: 非法帧返回 error（脏 JSON / 错 kind / 缺字段）", () => {
  assert.ok("error" in decodeWsClientFrame("not json"));
  assert.ok("error" in decodeWsClientFrame('{"kind":"event","event":{}}'));
  assert.ok("error" in decodeWsClientFrame('{"kind":"rpc","method":"info","args":[]}'));
  assert.ok("error" in decodeWsClientFrame('{"kind":"rpc","id":1,"method":"info"}'));
});

// ────────────── dispatchApi ──────────────

function stubSession(overrides: Partial<Record<string, unknown>> = {}): SessionManager {
  const base: Record<string, unknown> = {
    info: () => FAKE_INFO,
    submit: async () => undefined,
    steer: () => undefined,
    abort: () => undefined,
    setModel: () => ({ model: "mock" }),
    setMode: () => undefined,
    setReasoning: () => undefined,
    setEndpoint: () => ({ model: "mock" }),
    planContinue: async () => undefined,
    pause: () => undefined,
    resume: () => undefined,
    usage: () => ({ input: 1, output: 2, total: 3 }),
    newSession: () => undefined,
    listFiles: () => ({ files: [] }),
    listModels: () => ({ models: [] }),
    ...overrides,
  };
  return base as unknown as SessionManager;
}

test("dispatchApi: info / getUsage / listFiles 走到对应方法", async () => {
  const session = stubSession();
  assert.deepEqual(await dispatchApi(session, "info", []), FAKE_INFO);
  assert.deepEqual(await dispatchApi(session, "getUsage", []), { input: 1, output: 2, total: 3 });
  await dispatchApi(session, "listFiles", ["abc"]);
  assert.ok(true);
});

test("dispatchApi: submit 非字符串返回 ok:false 而不抛", async () => {
  const result = (await dispatchApi(stubSession(), "submit", [42])) as { ok: boolean };
  assert.equal(result.ok, false);
});

test("dispatchApi: submit 抛错包装成 {ok:false, error}", async () => {
  const session = stubSession({
    submit: async () => {
      throw new Error("boom");
    },
  });
  const result = (await dispatchApi(session, "submit", ["hi"])) as { ok: boolean; error?: string };
  assert.equal(result.ok, false);
  assert.equal(result.error, "boom");
});

test("dispatchApi: answerAsk 转发答案；坏参数静默丢弃", async () => {
  const calls: { id: string; answer: string }[] = [];
  const session = stubSession({
    answerAsk: (id: string, answer: string) => {
      calls.push({ id, answer });
    },
  });
  await dispatchApi(session, "answerAsk", ["ask_1", "方案 B"]);
  await dispatchApi(session, "answerAsk", ["ask_2", "   "]); // 空白原样透传（trim 归 session）
  await dispatchApi(session, "answerAsk", [42, "x"]); // 非 string id → 丢弃
  await dispatchApi(session, "answerAsk", []); // 缺参 → 丢弃
  await dispatchApi(session, "answerAsk", ["ask_3", 42]); // 非 string answer → 空串
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], { id: "ask_1", answer: "方案 B" });
  assert.deepEqual(calls[1], { id: "ask_2", answer: "   " });
  assert.deepEqual(calls[2], { id: "ask_3", answer: "" });
});

test("dispatchApi: 未知方法抛错（WS 层会转成 ok:false）", async () => {
  await assert.rejects(() => dispatchApi(stubSession(), "noSuchMethod", []), /未知方法/);
});

test("dispatchApi: setAutoCompact / setCustomModel 透传可选字段", async () => {
  const calls: boolean[] = [];
  const session = stubSession({
    setAutoCompact: (on: boolean) => {
      calls.push(on);
    },
  });
  await dispatchApi(session, "setAutoCompact", [true]);
  await dispatchApi(session, "setAutoCompact", ["x"]);
  assert.deepEqual(calls, [true, false], "布尔强转：非 true 一律按 false 处理");

  // 独立消息弹窗开关：同样走布尔强转（窗口创建/销毁在 index.ts，这里只验偏好链路）
  const msgCalls: boolean[] = [];
  const msgStub = {
    setMsgWindow: (on: boolean) => {
      msgCalls.push(on);
    },
  };
  await dispatchApi(stubSession(msgStub), "setMsgWindow", [true]);
  await dispatchApi(stubSession(msgStub), "setMsgWindow", ["x"]);
  await dispatchApi(stubSession(msgStub), "setMsgWindow", [42]);
  assert.deepEqual(msgCalls, [true, false, false], "setMsgWindow 布尔强转：非 true 一律按 false 处理");

  // 自定义模型弹窗的协议与上下文窗口覆写要透传到 SessionManager（曾因派发器
  // 丢字段导致 protocol / contextWindow 永远是缺省值）
  let seen: unknown = undefined;
  const sm2 = stubSession({
    setCustomModel: (params: unknown) => {
      seen = params;
      return { model: "m" };
    },
  });
  await dispatchApi(sm2, "setCustomModel", [
    { baseURL: "https://x.io/v1", apiKey: "k", model: "m", protocol: "anthropic", contextWindow: "256k" },
  ]);
  assert.deepEqual(seen, {
    baseURL: "https://x.io/v1",
    apiKey: "k",
    model: "m",
    protocol: "anthropic",
    contextWindow: "256k",
  });
});

// ────────────── WsDisplayBridge 真链路 ──────────────

test("ws-bridge: 连接即收 hello，info RPC 走 dispatch", async () => {
  const { bridge, port } = await makeBridge();
  try {
    // 连接先收 hello
    const frames = await collect(port, 1);
    assert.equal(frames[0] && (frames[0] as { kind: string }).kind, "hello");
    const hello = frames[0] as { info: InfoPayload };
    assert.equal(hello.info.cwd, "/tmp/fake");

    // 发一条 RPC
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    await awaitOpen(socket);
    const replies: unknown[] = [];
    socket.on("message", (d) => replies.push(JSON.parse(String(d))));
    socket.send(encodeWsFrame({ kind: "rpc", id: 1, method: "setModel", args: ["mock"] }));
    const deadline = Date.now() + 3000;
    while (replies.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const rpcReply = replies.find((r) => (r as { kind: string }).kind === "rpc_result") as
      | { id: number; ok: boolean; result: { echoed: string } }
      | undefined;
    assert.ok(rpcReply !== undefined, "应收到 rpc_result");
    assert.equal(rpcReply.id, 1);
    assert.equal(rpcReply.ok, true);
    assert.equal(rpcReply.result.echoed, "setModel");
    socket.close();
  } finally {
    await bridge.stop();
  }
});

test("ws-bridge: dispatch 抛错 → rpc_result ok:false 带错误信息", async () => {
  const { bridge, port } = await makeBridge({
    dispatch: async () => {
      throw new Error("拒绝");
    },
  });
  try {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    const opened = awaitOpen(socket);
    const replies: unknown[] = [];
    socket.on("message", (d) => replies.push(JSON.parse(String(d))));
    await opened;
    socket.send(encodeWsFrame({ kind: "rpc", id: 9, method: "info", args: [] }));
    const deadline = Date.now() + 3000;
    while (replies.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const rpcReply = replies.find((r) => (r as { kind: string }).kind === "rpc_result") as
      | { id: number; ok: boolean; error?: string }
      | undefined;
    assert.ok(rpcReply !== undefined);
    assert.equal(rpcReply.ok, false);
    assert.equal(rpcReply.error, "拒绝");
    socket.close();
  } finally {
    await bridge.stop();
  }
});

test("ws-bridge: emit(start/text/end) 广播成 event 帧", async () => {
  const { bridge, port } = await makeBridge();
  try {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    const opened = awaitOpen(socket);
    const events: WireEvent[] = [];
    socket.on("message", (d) => {
      const msg = JSON.parse(String(d)) as { kind: string; event?: WireEvent };
      if (msg.kind === "event" && msg.event !== undefined) events.push(msg.event);
    });
    await opened;
    // 吃掉 hello 帧
    await new Promise((r) => setTimeout(r, 100));

    bridge.emit({ t: "start" });
    bridge.emit({ t: "end", toolRounds: 2 });
    const deadline = Date.now() + 3000;
    while (events.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.deepEqual(events[0], { t: "start" });
    assert.deepEqual(events[1], { t: "end", toolRounds: 2 });
    socket.close();
  } finally {
    await bridge.stop();
  }
});

test("ws-bridge: 高频 text_delta 经节流合并成单条 text 帧（stop 时冲刷）", async () => {
  const { bridge, port } = await makeBridge();
  try {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    const opened = awaitOpen(socket);
    const events: WireEvent[] = [];
    socket.on("message", (d) => {
      const msg = JSON.parse(String(d)) as { kind: string; event?: WireEvent };
      if (msg.kind === "event" && msg.event !== undefined) events.push(msg.event);
    });
    await opened;
    await new Promise((r) => setTimeout(r, 100));

    bridge.emit({ t: "start" });
    // 灌 100 个小 delta（共 ~500 字符，会触发字符阈值 + 时间窗口）
    for (let i = 0; i < 100; i++) {
      bridge.emit({
        type: "stream",
        event: { type: "text_delta", delta: "字".repeat(5) },
      } as Parameters<typeof bridge.emit>[0]);
    }
    bridge.emit({ t: "flush" });

    const deadline = Date.now() + 3000;
    while (!events.some((e) => e.t === "text") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const texts = events.filter((e) => e.t === "text") as { t: "text"; delta: string }[];
    assert.ok(texts.length >= 1, "至少收到一条合并后的 text 帧");
    const total = texts.reduce((acc, e) => acc + e.delta.length, 0);
    assert.equal(total, 500, "节流不丢字");
    socket.close();
  } finally {
    await bridge.stop();
  }
});

test("ws-bridge: 坏帧 → 服务端以 4000 关闭连接", async () => {
  const { bridge, port } = await makeBridge();
  try {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    await awaitOpen(socket);
    socket.send("这不是 JSON");
    const code = await new Promise<number>((resolve) =>
      socket.once("close", (c) => resolve(c)),
    );
    assert.equal(code, 4000);
  } finally {
    await bridge.stop();
  }
});
