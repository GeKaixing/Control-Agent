/**
 * MCP → Connector 桥接工厂：把任意外部 MCP stdio server 包装成 c-agent 的
 * Connector（Loader 约定的默认导出类）。
 *
 * 路由与 ffmpeg connector 同构：Agent 调 Tool.execute（透传 signal），
 * Connector.execute 只做名字路由（供 runtime.execute / 外部 MCP server 用）。
 *
 * 映射规则：
 * - MCP tools/list 的 inputSchema（JSON Schema）→ c-agent Tool.parameters
 *   （项目 JsonSchema 是精简子集，这里做一次保守归一：复杂类型退化为近似基础类型）
 * - tools/call 的 content 数组 → TextContent[]（非 text 块 JSON 序列化兜底）
 * - mutating 工具名单由 manifest 配置给出（MCP 协议本身没有这个概念）
 */

import { fail, type Tool, type ToolContext, type ToolResult } from "../../src/tools/types.js";
import type { JsonSchema, JsonSchemaProperty } from "../../src/providers/types.js";
import type { Connector, ConnectorClass, ConnectorContext } from "../../src/connector/core/types.js";
import { McpStdioClient, type McpToolDef } from "./mcp-stdio-client.js";

const BASIC_TYPES = new Set(["string", "number", "integer", "boolean", "array", "object"]);

/** MCP JSON Schema → 项目精简 JsonSchema。未知形状（anyOf 等）退化为基础类型 */
function normalizeSchema(raw: Record<string, unknown> | undefined): JsonSchema {
  const out: JsonSchema = { type: "object", properties: {} };
  if (raw === undefined) return out;
  const props = raw["properties"];
  if (props !== null && typeof props === "object") {
    for (const [key, value] of Object.entries(props as Record<string, unknown>)) {
      out.properties[key] = normalizeProperty(value);
    }
  }
  const required = raw["required"];
  if (Array.isArray(required)) {
    out.required = required.filter((r): r is string => typeof r === "string");
  }
  return out;
}

function normalizeProperty(raw: unknown): JsonSchemaProperty {
  const prop = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const description = typeof prop["description"] === "string" ? prop["description"] : undefined;
  let type = prop["type"];
  if (typeof type !== "string" || !BASIC_TYPES.has(type)) {
    // anyOf / oneOf / 缺 type：从变体里找一个能表达的基础类型，最后退化 string
    const variants = ["anyOf", "oneOf", "allOf"].flatMap((k) =>
      Array.isArray(prop[k]) ? (prop[k] as unknown[]) : [],
    );
    type = "string";
    for (const v of variants) {
      const t = (v as Record<string, unknown> | null)?.["type"];
      if (typeof t === "string" && BASIC_TYPES.has(t)) {
        type = t;
        break;
      }
    }
  }
  const out: JsonSchemaProperty = { type: type as JsonSchemaProperty["type"] };
  if (description !== undefined) out.description = description;
  if (type === "string" && Array.isArray(prop["enum"])) {
    const enums = (prop["enum"] as unknown[]).filter((e): e is string => typeof e === "string");
    if (enums.length > 0) out.enum = enums;
  }
  if (type === "array" && prop["items"] !== null && typeof prop["items"] === "object") {
    const itemType = (prop["items"] as Record<string, unknown>)["type"];
    if (typeof itemType === "string" && BASIC_TYPES.has(itemType)) {
      out.items = { type: itemType as JsonSchemaProperty["type"] };
    }
  }
  return out;
}

function mcpContentToText(content: Array<{ type: string; text?: string }>): string {
  return content
    .map((c) => (c.type === "text" && typeof c.text === "string" ? c.text : JSON.stringify(c)))
    .join("\n");
}

export interface McpBridgeConfig {
  /** server 标识（connector id / 日志前缀） */
  serverId: string;
  /** 启动命令（一般是 node 可执行文件路径） */
  command: string;
  /** 命令参数（一般是 server 脚本路径） */
  args: readonly string[];
  /** 哪些 MCP 工具按 mutating 处理（走审批门） */
  mutatingToolNames?: readonly string[];
  /** connect / tools/list 每步超时毫秒，默认 30s */
  connectTimeoutMs?: number;
  /** 透传给 server 子进程的额外环境变量（进程环境已自动继承，这里只放增量） */
  env?: Record<string, string>;
}

/**
 * 生成一个 ConnectorClass。每个 MCP server 一个实例：
 * start() 时拉起子进程并握手拿 tools/list，之后 execute 直接 tools/call。
 */
export function createMcpBridgeClass(config: McpBridgeConfig): ConnectorClass {
  const mutating = new Set(config.mutatingToolNames ?? []);
  const stepTimeoutMs = config.connectTimeoutMs ?? 30_000;

  return class McpBridgeConnector implements Connector {
    readonly id = config.serverId;
    private client: McpStdioClient | null = null;
    private defs: McpToolDef[] = [];
    /** name → Tool 的执行入口缓存（getTools 每次返回同一批实例） */
    private tools: Tool[] = [];

    async start(_ctx: ConnectorContext): Promise<void> {
      void _ctx;
      this.client = new McpStdioClient(
        config.command,
        config.args,
        (msg) => console.log(`[mcp:${config.serverId}] ${msg}`),
        config.env ?? {},
      );
      await withTimeout(this.client.connect(), stepTimeoutMs, `connect ${config.serverId}`);
      this.defs = await withTimeout(
        this.client.listTools(),
        stepTimeoutMs,
        `tools/list ${config.serverId}`,
      );
      this.tools = this.defs.map((def) => this.toTool(def));
      if (this.tools.length === 0) {
        throw new Error(`MCP server "${config.serverId}" exposed no tools`);
      }
    }

    async stop(): Promise<void> {
      this.client?.shutdown();
      this.client = null;
      this.defs = [];
      this.tools = [];
    }

    getTools(): Tool[] {
      return this.tools;
    }

    async execute(
      toolName: string,
      args: Record<string, unknown>,
      ctx: ConnectorContext,
    ): Promise<ToolResult> {
      const tool = this.tools.find((t) => t.name === toolName);
      if (!tool) return fail(`unknown MCP tool on "${config.serverId}": ${toolName}`);
      try {
        return await tool.execute(args, { cwd: ctx.cwd, signal: ctx.signal });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    }

    private toTool(def: McpToolDef): Tool {
      const execute = async (args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
        if (this.client === null) return fail(`MCP server "${config.serverId}" not connected`);
        try {
          const res = await this.client.callTool(def.name, args, ctx.signal);
          return { content: [{ type: "text", text: mcpContentToText(res.content) }], isError: res.isError };
        } catch (err) {
          // abort 或管道断掉后连接不可信，就地关闭（下次 start 重建）
          this.client.shutdown();
          this.client = null;
          return fail(`MCP call failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      };
      return {
        name: def.name,
        description: def.description ?? `（MCP 工具 ${def.name}，server 未提供描述）`,
        parameters: normalizeSchema(def.inputSchema),
        isMutating: mutating.has(def.name),
        execute,
      };
    }
  };
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms: ${label}`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
