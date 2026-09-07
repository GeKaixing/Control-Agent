/**
 * MCP stdio server：把 ConnectorRuntime 暴露的 Tool 集合给外部 MCP Client 调用。
 *
 * 协议：JSON-RPC 2.0 over newline-delimited stdio（与 LSP 一致，每条消息一行 JSON）。
 *
 * 最小可用方法集：
 *   - initialize            → 握手，返回 serverInfo + capabilities
 *   - tools/list            → 列出 Runtime 中所有 connector 的 Tool
 *   - tools/call            → 执行 Tool，参数透传给 Runtime.execute
 *   - notifications/cancel  → 仅日志，不返回响应（MCP 规范里无响应）
 *   - ping                  → 心跳，空响应
 *
 * 不实现：
 *   - resources/* （Phase 2）
 *   - prompts/*   （Phase 2）
 *   - sampling    （Agent 反向调用 LLM，由 MCP Client 决定是否需要）
 *
 * 错误码：JSON-RPC 标准 -32700 / -32600 / -32601 / -32602 / -32603。
 */

import { createInterface, type Interface as ReadLineInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import type { ConnectorRuntime } from "../runtime/connector-runtime.js";

const SERVER_INFO = {
  name: "c-agent-connector-runtime",
  version: "0.1.0",
} as const;

const SERVER_CAPABILITIES = {
  tools: { listChanged: false },
} as const;

export interface McpServerOptions {
  runtime: ConnectorRuntime;
  stdin?: Readable;
  stdout?: Writable;
  /** 内部日志通道，便于调试；与 MCP 协议本身无关 */
  log?: (line: string) => void;
}

export class McpServer {
  private readonly runtime: ConnectorRuntime;
  private readonly stdin: Readable;
  private readonly stdout: Writable;
  private readonly log: (line: string) => void;
  private rl: ReadLineInterface | null = null;
  private closed = false;

  constructor(opts: McpServerOptions) {
    this.runtime = opts.runtime;
    this.stdin = opts.stdin ?? process.stdin;
    this.stdout = opts.stdout ?? process.stdout;
    this.log = opts.log ?? ((s) => process.stderr.write(`[mcp] ${s}\n`));
  }

  /** 阻塞读 stdin；遇到 EOF 自动停 */
  async serve(): Promise<void> {
    if (this.rl !== null) throw new Error("McpServer.serve() already running");
    this.rl = createInterface({ input: this.stdin, crlfDelay: Infinity });
    this.log("serve() started");
    return new Promise<void>((resolve) => {
      const rl = this.rl!;
      rl.on("line", (line) => {
        if (line.length === 0) return;
        void this.handleLine(line);
      });
      rl.on("close", () => {
        this.closed = true;
        this.log("stdin closed, serve() returning");
        resolve();
      });
    });
  }

  /** 主动关闭（外部强制退出） */
  stop(): void {
    if (this.rl !== null) {
      this.rl.close();
      this.rl = null;
    }
    this.closed = true;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  // ---------- 内部：单行 JSON-RPC 处理 ----------

  private async handleLine(line: string): Promise<void> {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      this.writeRaw(rpcError(null, -32700, `parse error: ${errToMessage(err)}`));
      return;
    }
    if (!isObject(msg)) {
      this.writeRaw(rpcError(null, -32600, "invalid request: not an object"));
      return;
    }
    const id = msg["id"]; // notification 时为 undefined
    const method = msg["method"];
    if (typeof method !== "string" || method.length === 0) {
      this.writeRaw(rpcError(id ?? null, -32600, "method missing"));
      return;
    }
    const params = msg["params"];

    // notification：没有 id，不返回响应
    if (id === undefined) {
      this.handleNotification(method, params);
      return;
    }

    try {
      const result = await this.dispatch(method, params);
      this.writeRaw(rpcResult(id, result));
    } catch (err) {
      const code = isRpcErrorCode(err) ? err.code : -32603;
      const message = isRpcError(err) ? err.message : errToMessage(err);
      this.writeRaw(rpcError(id, code, message));
    }
  }

  private handleNotification(method: string, _params: unknown): void {
    void _params;
    switch (method) {
      case "notifications/cancelled":
      case "notifications/initialized":
      case "notifications/progress":
        this.log(`notification: ${method}`);
        return;
      default:
        // MCP 规范允许服务端忽略未知 notification
        this.log(`ignored unknown notification: ${method}`);
        return;
    }
  }

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "initialize":
        return this.handleInitialize(params);
      case "tools/list":
        return this.handleToolsList();
      case "tools/call":
        return await this.handleToolsCall(params);
      case "ping":
        return {};
      default:
        throw rpcErr(-32601, `method not found: ${method}`);
    }
  }

  private handleInitialize(_params: unknown): unknown {
    return {
      protocolVersion: "2024-11-05",
      serverInfo: SERVER_INFO,
      capabilities: SERVER_CAPABILITIES,
    };
  }

  private handleToolsList(): unknown {
    const tools = this.runtime.extraTools().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.parameters,
    }));
    return { tools };
  }

  private async handleToolsCall(params: unknown): Promise<unknown> {
    if (!isObject(params)) throw rpcErr(-32602, "params must be an object");
    const name = params["name"];
    const args = params["arguments"];
    if (typeof name !== "string") throw rpcErr(-32602, "params.name must be a string");
    const safeArgs = isObject(args) ? args : {};
    const result = await this.runtime.execute(name, safeArgs);
    return {
      content: result.content,
      isError: result.isError,
    };
  }

  private writeRaw(payload: object): void {
    if (this.closed) return;
    this.stdout.write(JSON.stringify(payload) + "\n");
  }
}

// ---------- 协议小工具 ----------

interface RpcError extends Error {
  code: number;
}

function rpcErr(code: number, message: string): RpcError {
  const e = new Error(message) as RpcError;
  e.code = code;
  return e;
}

function isRpcError(err: unknown): err is RpcError {
  return err instanceof Error && typeof (err as RpcError).code === "number";
}

function isRpcErrorCode(err: unknown): err is RpcError {
  return isRpcError(err);
}

function rpcResult(id: unknown, result: unknown): object {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: unknown, code: number, message: string): object {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function errToMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
