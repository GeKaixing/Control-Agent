/**
 * ConnectorRuntime：负责 connector 的生命周期管理与 execute 路由。
 *
 * 与 Registry 的边界：
 * - Registry 是静态数据（"哪些 connector 注册了、各自有什么 tool"），无副作用
 * - Runtime 是有状态实例（"connector 是不是已 start、executor 调用转给谁、日志往哪发"）
 *
 * 路由流程：Agent / MCP server 拿到 toolName → runtime.execute(toolName, args)
 *   → registry.findToolOwner(toolName) → connector.instance.execute(toolName, args, ctx)
 *   → 返回 ToolResult 或 fail()
 *
 * 失败兜底：
 * - connector.execute 不得 throw（接口契约），万一 throw 也会被这里捕获转 fail
 * - tool 名找不到 / connector 在 error 状态 → 直接 fail，不抛
 */

import type {
  ConnectorContext,
  ConnectorLogEntry,
  LoadedConnector,
} from "../core/types.js";
import type { Tool, ToolResult } from "../../tools/types.js";
import { fail } from "../../tools/types.js";
import { ConnectorRegistry } from "../registry/connector-registry.js";

const MAX_LOG_ENTRIES = 500;

export interface ConnectorRuntimeOptions {
  registry?: ConnectorRegistry;
  cwd?: string;
  env?: Record<string, string | undefined>;
  onLog?: (entry: ConnectorLogEntry) => void;
  /** 单次 execute 默认超时（毫秒）；0 表示不限。Phase 1 默认 120s */
  executeTimeoutMs?: number;
}

export class ConnectorRuntime {
  readonly registry: ConnectorRegistry;
  private readonly cwd: string;
  private readonly env: Record<string, string | undefined>;
  private readonly onLog: (entry: ConnectorLogEntry) => void;
  private readonly executeTimeoutMs: number;
  private readonly logs: ConnectorLogEntry[] = [];
  /** 顶层 AbortController：runtime.dispose() 时 reject 所有未结束 execute */
  private readonly topAbort = new AbortController();

  constructor(options: ConnectorRuntimeOptions = {}) {
    this.registry = options.registry ?? new ConnectorRegistry();
    this.cwd = options.cwd ?? process.cwd();
    this.env = options.env ?? snapshotEnv();
    this.onLog = options.onLog ?? (() => {});
    this.executeTimeoutMs = options.executeTimeoutMs ?? 120_000;
  }

  /** 当前 cwd。execute 时构造 ConnectorContext 用 */
  get workingDir(): string {
    return this.cwd;
  }

  /** 注册到 Runtime 的 connector 数量（含 error/stopped 状态） */
  size(): number {
    return this.registry.size();
  }

  /** 构造一个 ConnectorContext。可被子类或测试覆盖 signal */
  createContext(signal?: AbortSignal): ConnectorContext {
    const composed =
      signal !== undefined
        ? AbortSignal.any([this.topAbort.signal, signal])
        : this.topAbort.signal;
    return {
      cwd: this.cwd,
      signal: composed,
      env: this.env,
    };
  }

  /** 把一个 LoadedConnector 纳入 Registry；不自动 start，需显式调 start() */
  adopt(loaded: LoadedConnector): void {
    this.registry.register(loaded);
    this.log(loaded.manifest.id, "info", `registered (state=${loaded.state})`);
  }

  /**
   * 启动 connector：未传 id 启动全部；返回失败的 connector id 列表。
   * 已经在 running/ready 状态的 connector 视为成功，跳过重复 start。
   */
  async start(id?: string): Promise<string[]> {
    const failed: string[] = [];
    const targets = id !== undefined ? [this.registry.get(id)].filter(Boolean) : this.registry.all();
    for (const loaded of targets as LoadedConnector[]) {
      const cid = loaded.manifest.id;
      if (loaded.state === "ready" || loaded.state === "running") {
        this.log(cid, "info", `start() skipped: already ${loaded.state}`);
        continue;
      }
      try {
        const ctx = this.createContext();
        await loaded.instance.start(ctx);
        loaded.state = "ready";
        loaded.errorMessage = undefined;
        // 动态工具集的 connector（如 MCP 桥接）start 后才知道暴露哪些 tool，
        // 重新 register 刷新 registry 的 tool 反向索引
        this.registry.register(loaded);
        this.log(cid, "info", "started");
      } catch (err) {
        loaded.state = "error";
        loaded.errorMessage = errToMessage(err);
        this.log(cid, "error", `start failed: ${loaded.errorMessage}`);
        if (id !== undefined) failed.push(cid);
      }
    }
    if (id === undefined) {
      // 全量启动模式：汇总所有 error 的 id
      for (const c of this.registry.all()) {
        if (c.state === "error") failed.push(c.manifest.id);
      }
    }
    return failed;
  }

  /**
   * 关闭 connector：未传 id 关全部；失败不抛，记日志。
   */
  async stop(id?: string): Promise<void> {
    const targets = id !== undefined ? [this.registry.get(id)].filter(Boolean) : this.registry.all();
    for (const loaded of targets as LoadedConnector[]) {
      const cid = loaded.manifest.id;
      if (loaded.state === "stopped" || loaded.state === "installed" || loaded.state === "loaded") {
        continue;
      }
      try {
        await loaded.instance.stop();
        loaded.state = "stopped";
        this.log(cid, "info", "stopped");
      } catch (err) {
        loaded.state = "error";
        loaded.errorMessage = errToMessage(err);
        this.log(cid, "warn", `stop failed: ${loaded.errorMessage}`);
      }
    }
  }

  /** 释放所有资源：topAbort + 停全部 connector。多次调用幂等 */
  async dispose(): Promise<void> {
    if (!this.topAbort.signal.aborted) {
      this.topAbort.abort();
    }
    await this.stop();
  }

  /** 路由 execute 调用。失败一律返回 ToolResult，不抛 */
  async execute(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    const owner = this.registry.findToolOwner(toolName);
    if (!owner) {
      return fail(`tool not found: ${toolName}`);
    }
    if (owner.connector.state !== "ready" && owner.connector.state !== "running") {
      return fail(`connector "${owner.connector.manifest.id}" not ready (state=${owner.connector.state})`);
    }
    const previous = owner.connector.state;
    owner.connector.state = "running";
    const ctx = this.createContext(this.executeTimeoutMs > 0
      ? AbortSignal.timeout(this.executeTimeoutMs)
      : undefined);
    try {
      const result = await owner.connector.instance.execute(toolName, args, ctx);
      // 验证返回值形状，防止 connector 实现违规
      if (!result || !Array.isArray(result.content) || typeof result.isError !== "boolean") {
        owner.connector.state = previous;
        this.log(owner.connector.manifest.id, "error", `connector.execute returned invalid ToolResult shape`);
        return fail(`connector "${owner.connector.manifest.id}" returned invalid result`);
      }
      owner.connector.state = "ready";
      return { content: result.content, isError: result.isError };
    } catch (err) {
      owner.connector.state = previous;
      const msg = errToMessage(err);
      this.log(owner.connector.manifest.id, "error", `execute(${toolName}) threw: ${msg}`);
      return fail(`connector execute failed: ${msg}`);
    }
  }

  /** 所有 connector 暴露的 Tool。Agent 可与内置 tool 合并使用 */
  extraTools(): Tool[] {
    return this.registry.listTools();
  }

  /** 最近的日志条目（仅 in-memory，最多 MAX_LOG_ENTRIES 条） */
  recentLogs(): ConnectorLogEntry[] {
    return [...this.logs];
  }

  private log(connectorId: string, level: ConnectorLogEntry["level"], message: string): void {
    const entry: ConnectorLogEntry = {
      timestamp: Date.now(),
      connectorId,
      level,
      message,
    };
    this.logs.push(entry);
    if (this.logs.length > MAX_LOG_ENTRIES) this.logs.shift();
    this.onLog(entry);
  }
}

/** process.env 的可序列化快照，避免后续 mutation 影响 connector */
function snapshotEnv(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) {
    out[k] = v;
  }
  return out;
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
