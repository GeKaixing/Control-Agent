/**
 * 极简 MCP stdio 客户端：newline-delimited JSON-RPC 2.0。
 *
 * 零依赖实现 initialize / tools/list / tools/call 三步握手与调用，
 * 足够把任意外部 MCP server 桥接成 c-agent 的 Connector。
 * 不做的事：resources/prompts、sampling、roots、重连（失败 fail-fast）。
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/** MCP stdio 协议版本（2024-11-05 起 server 端普遍兼容） */
const PROTOCOL_VERSION = "2024-11-05";

/** IDE 沙箱注入的变量会干扰子进程 node（broker shim / run-as-node），spawn 前剥掉 */
const STRIP_ENV = [
  "CODEBUDDY_BROKERED_FS_HOOK_ENABLED",
  "CODEBUDDY_SAFE_DELETE_SANDBOX",
  "CODEBUDDY_SANDBOX_BROKER_IPC_ADDRESS",
  "CODEBUDDY_SANDBOX_BROKER_SESSION_ID",
  "CODEBUDDY_SANDBOX_HOST_FILE_OPERATION_COMMAND",
  "ELECTRON_RUN_AS_NODE",
  "WORKBUDDY_NODE_ENV",
  "NODE_OPTIONS",
];

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export class McpStdioError extends Error {}

export class McpStdioClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buffer = "";
  private serverInfo = "";
  private exited = false;

  constructor(
    private readonly command: string,
    private readonly args: readonly string[],
    private readonly onLog: (msg: string) => void = () => {},
    private readonly extraEnv: Record<string, string> = {},
  ) {}

  /** spawn + initialize + initialized 通知。幂等保护：已连接时直接返回 */
  async connect(): Promise<void> {
    if (this.child !== null) return;

    const env: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(process.env)) {
      env[k] = v;
    }
    for (const k of STRIP_ENV) delete env[k];
    for (const [k, v] of Object.entries(this.extraEnv)) {
      env[k] = v;
    }
    // Electron 主进程里 process.execPath 是 electron.exe——直接 spawn 会被当成
    // Electron 应用启动，弹「Unable to find Electron app at <server.js>」对话框。
    // 按 Electron 官方做法给子进程设 ELECTRON_RUN_AS_NODE=1，让它退回纯 node 行为。
    // 必须在 STRIP_ENV 剥除之后补：CLI 场景下该变量是 IDE 沙箱注入的干扰源，
    // 剥掉没错；桌面端 spawn node 子进程时需要显式置 1。command 不是当前可执行
    // 文件（如 browser-use 走 uvx）时不掺和。
    if (process.versions.electron !== undefined && this.command === process.execPath) {
      env["ELECTRON_RUN_AS_NODE"] = "1";
    }

    const child = spawn(this.command, [...this.args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: env as NodeJS.ProcessEnv,
    });
    this.child = child;
    this.exited = false;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onData(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const line = chunk.trim();
      if (line.length > 0) this.onLog(`[server:stderr] ${line.slice(0, 300)}`);
    });
    child.on("exit", (code, signal) => {
      this.exited = true;
      this.onLog(`server exited (code=${code} signal=${signal})`);
      const err = new McpStdioError(`MCP server exited unexpectedly (code=${code} signal=${signal})`);
      for (const [id, p] of this.pending) {
        p.reject(err);
        this.pending.delete(id);
      }
    });

    const init = (await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "c-agent-mcp-bridge", version: "0.1.0" },
    })) as { serverInfo?: { name?: string; version?: string } } | null;
    this.serverInfo =
      init?.serverInfo !== undefined && init.serverInfo !== null
        ? `${init.serverInfo.name ?? "?"}@${init.serverInfo.version ?? "?"}`
        : "unknown";
    // 通知无 id、无响应，发完即算
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    this.onLog(`initialized (${this.serverInfo})`);
  }

  get info(): string {
    return this.serverInfo;
  }

  async listTools(): Promise<McpToolDef[]> {
    const res = (await this.request("tools/list", {})) as { tools?: McpToolDef[] } | null;
    return Array.isArray(res?.tools) ? (res.tools as McpToolDef[]) : [];
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ content: Array<{ type: string; text?: string }>; isError: boolean }> {
    if (this.exited || this.child === null) {
      throw new McpStdioError("MCP server not connected");
    }
    const p = this.request("tools/call", { name, arguments: args }) as Promise<{
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    }>;
    if (signal === undefined) {
      const r = await p;
      return { content: r.content ?? [], isError: r.isError === true };
    }
    // 与 abort 信号竞速：abort 时 reject 并杀 server
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = (): void => {
        reject(new McpStdioError("tool call aborted"));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    const r = await Promise.race([p, aborted]);
    return { content: r.content ?? [], isError: r.isError === true };
  }

  shutdown(): void {
    if (this.child !== null) {
      this.child.kill("SIGTERM");
      this.child = null;
    }
    this.buffer = "";
  }

  // ------------------------------------------------------------ 内部

  private send(msg: Record<string, unknown>): void {
    if (this.child === null) throw new McpStdioError("not connected");
    this.child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.child === null) return Promise.reject(new McpStdioError("not connected"));
    const id = this.nextId++;
    const p = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.send({ jsonrpc: "2.0", id, method, params });
    return p;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const nl = this.buffer.indexOf("\n");
      if (nl < 0) return;
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line.length === 0) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.onLog(`non-JSON line from server: ${line.slice(0, 200)}`);
        continue;
      }
      const id = msg["id"];
      if (typeof id === "number" && this.pending.has(id)) {
        const p = this.pending.get(id)!;
        this.pending.delete(id);
        if (msg["error"] !== undefined) {
          const e = msg["error"] as { message?: string };
          p.reject(new McpStdioError(`MCP error: ${e?.message ?? JSON.stringify(msg["error"])}`));
        } else {
          p.resolve(msg["result"]);
        }
      }
      // 其余（notification / response 之外的广播）忽略
    }
  }
}
