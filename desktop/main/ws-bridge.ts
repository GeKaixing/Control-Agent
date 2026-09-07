/**
 * WsDisplayBridge：独立 UI 的 WebSocket 接入桥（connector 形态）。
 *
 * 数据面（下行）：DisplayEvent → 内部 DesktopDisplayConnector（映射 + 节流）
 *   → transport = WS 广播 → 所有已连接的独立 UI。
 *   复用 desktop-display 的映射/节流实现，两条显示通路行为完全一致。
 *
 * 控制面（上行）：UI 发 RPC 请求（与 DesktopApi 方法一一对应）
 *   → dispatchApi（与本地 IPC 共用同一实现）→ SessionManager。
 *
 * 生命周期：作为 connector 被 desktop/main 的 displayRuntime adopt + start/stop，
 * 与「默认连接」的 desktop-display（Electron IPC）并存——本地窗口与独立 UI
 * 同时收到相同的事件流。
 */

import { WebSocketServer, WebSocket } from "ws";

import type { Connector, ConnectorContext, DisplayEvent, DisplaySink } from "../../src/connector/core/types.js";
import type { Tool, ToolResult } from "../../src/tools/types.js";
import { fail } from "../../src/tools/types.js";
import DesktopDisplayConnector from "../../src/connector/connectors/desktop-display/index.js";
import type { InfoPayload, WireEvent } from "../shared/api.js";
import { decodeWsClientFrame, encodeWsFrame, type WsServerMessage } from "../shared/ws-protocol.js";

export interface WsBridgeOptions {
  /** 监听端口 */
  port: number;
  /** 监听地址，默认 127.0.0.1（不对外网开放） */
  host?: string;
  /**
   * 上行 RPC 派发。desktop/main 注入 `(method, args) => dispatchApi(session, …)`；
   * 测试注入 stub。抛错会被包装成 rpc_result ok:false。
   */
  dispatch: (method: string, args: readonly unknown[]) => Promise<unknown>;
  /** hello 帧用的会话快照 */
  getInfo: () => InfoPayload;
  onLog?: (message: string) => void;
}

export default class WsDisplayBridge implements Connector, DisplaySink {
  readonly id = "ws-display";

  private readonly options: WsBridgeOptions;
  /** 复用 desktop-display 的 AgentEvent→WireEvent 映射与节流 */
  private readonly mapper: DesktopDisplayConnector;
  private wss: WebSocketServer | null = null;
  private readonly log: (message: string) => void;

  constructor(options: WsBridgeOptions) {
    this.options = options;
    this.log = options.onLog ?? (() => {});
    this.mapper = new DesktopDisplayConnector({ transport: (wire) => this.broadcastWire(wire) });
  }

  // ── Connector 生命周期 ──

  async start(_ctx: ConnectorContext): Promise<void> {
    void _ctx;
    if (this.wss !== null) return; // 幂等
    await this.mapper.start(_ctx);
    await new Promise<void>((resolve, reject) => {
      const wss = new WebSocketServer({
        port: this.options.port,
        host: this.options.host ?? "127.0.0.1",
      });
      wss.on("listening", () => {
        this.wss = wss;
        this.log(`ws-display listening on ${this.options.host ?? "127.0.0.1"}:${this.options.port}`);
        resolve();
      });
      wss.on("error", (err) => reject(err));
      wss.on("connection", (socket) => this.handleConnection(socket));
    });
  }

  async stop(): Promise<void> {
    await this.mapper.stop();
    const wss = this.wss;
    this.wss = null;
    if (wss === null) return;
    await new Promise<void>((resolve) => {
      for (const client of wss.clients) client.terminate();
      wss.close(() => resolve());
    });
    this.log("ws-display stopped");
  }

  getTools(): Tool[] {
    return [];
  }

  async execute(toolName: string): Promise<ToolResult> {
    return fail(`ws-display 不暴露工具（收到 ${toolName}）`);
  }

  // ── DisplaySink：事件入口（同步、不 throw） ──

  emit(event: DisplayEvent): void {
    // 映射 / 节流全部委托给 inner；它同步、不 throw
    this.mapper.emit(event);
  }

  /** 实际绑定的端口（start 前或 port=0 时系统分配后可用）；未启动返回 null */
  get boundPort(): number | null {
    const wss = this.wss;
    if (wss === null) return null;
    const addr = wss.address();
    if (typeof addr === "object" && addr !== null) return addr.port;
    return null;
  }

  // ── 内部 ──

  /** 把一条 WireEvent 广播给所有客户端（来自 inner 的 transport） */
  private broadcastWire(wire: WireEvent): void {
    this.broadcast({ kind: "event", event: wire });
  }

  private broadcast(msg: WsServerMessage): void {
    const wss = this.wss;
    if (wss === null) return;
    const frame = encodeWsFrame(msg);
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      try {
        client.send(frame);
      } catch (err) {
        this.log(`send failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private handleConnection(socket: WebSocket): void {
    // 连接建立：先推 hello（会话快照），之后进入正常事件流
    let info: InfoPayload;
    try {
      info = this.options.getInfo();
    } catch (err) {
      this.log(`getInfo failed: ${err instanceof Error ? err.message : String(err)}`);
      info = {
        cwd: "",
        model: "unknown",
        modelSpec: "unknown",
        tools: [],
        contextWindow: 128000,
        baseURL: "",
        mode: "full",
        paused: false,
        reasoning: "balanced",
        endpoint: "mock",
        maxTokens: 0,
        planPending: false,
        approvalMode: false,
        autoCompact: true,
        msgWindow: false,
        sessionTitle: "新会话",
        contextBreakdown: { systemPrompt: 0, tools: 0, connectors: 0, skills: 0, messages: 0 },
        lastUserPrompt: null,
        toolsByCategory: { skill: [], tool: [], mcp: [], plugin: [], extension: [] },
        baseUrlPresets: [],
      };
    }
    socket.send(encodeWsFrame({ kind: "hello", info }));

    socket.on("message", (data) => {
      void this.handleMessage(socket, data.toString()).catch((err) => {
        this.log(`rpc dispatch crashed: ${err instanceof Error ? err.message : String(err)}`);
      });
    });
    socket.on("error", (err) => {
      this.log(`client error: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  private async handleMessage(socket: WebSocket, line: string): Promise<void> {
    const decoded = decodeWsClientFrame(line);
    if ("error" in decoded) {
      // 无法关联回 id —— 协议级错误直接断开，客户端重连后从 hello 重新同步
      this.log(`bad frame (${decoded.error}), closing client`);
      socket.close(4000, decoded.error);
      return;
    }
    const { id, method, args } = decoded.msg;
    try {
      const result = await this.options.dispatch(method, args);
      this.sendTo(socket, { kind: "rpc_result", id, ok: true, result });
    } catch (err) {
      this.sendTo(socket, {
        kind: "rpc_result",
        id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private sendTo(socket: WebSocket, msg: WsServerMessage): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(encodeWsFrame(msg));
    } catch (err) {
      this.log(`send failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
