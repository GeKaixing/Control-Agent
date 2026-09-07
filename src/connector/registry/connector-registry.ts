/**
 * Connector Registry：单一真相源，记录已加载的 connector 及其暴露的 Tool。
 *
 * 设计要点：
 * - 一个 connector 可以暴露多个 Tool；Agent 调 tool 时，Registry 负责按 tool 名
 *   找到对应的 connector 与 Tool 实例——这就是"Agent 不感知软件"的核心机制。
 * - 当前实现是内存 Map；Phase 2 会加上从 ~/.connector-runtime/config.json 加载 enabled 列表。
 * - 故意不暴露 set / delete 的对外 API（只 register / unregister），避免外部直接改 map。
 */

import type { LoadedConnector } from "../core/types.js";
import type { Tool } from "../../tools/types.js";

export class ConnectorRegistry {
  private readonly connectors = new Map<string, LoadedConnector>();
  /** tool 名 → connector id 的反向索引，避免每次 getTools() 都全表扫描 */
  private readonly toolIndex = new Map<string, string>();

  /** 注册一个 connector。如果同 id 已存在则覆盖，并清理旧 tool 索引 */
  register(connector: LoadedConnector): void {
    const existing = this.connectors.get(connector.manifest.id);
    if (existing) {
      for (const t of existing.instance.getTools()) {
        if (this.toolIndex.get(t.name) === existing.manifest.id) {
          this.toolIndex.delete(t.name);
        }
      }
    }
    this.connectors.set(connector.manifest.id, connector);
    // 彻底清掉指向本 connector 的所有旧索引（工具集可能在 start 后动态变化，
    // 只按旧 getTools() 清理会漏掉已消失的工具名）
    for (const [name, cid] of this.toolIndex) {
      if (cid === connector.manifest.id) this.toolIndex.delete(name);
    }
    for (const t of connector.instance.getTools()) {
      this.toolIndex.set(t.name, connector.manifest.id);
    }
  }

  /** 注销一个 connector。返回是否真的存在并被移除 */
  unregister(id: string): boolean {
    const c = this.connectors.get(id);
    if (!c) return false;
    for (const t of c.instance.getTools()) {
      if (this.toolIndex.get(t.name) === id) {
        this.toolIndex.delete(t.name);
      }
    }
    this.connectors.delete(id);
    return true;
  }

  /** 按 id 查找 connector 记录 */
  get(id: string): LoadedConnector | undefined {
    return this.connectors.get(id);
  }

  /** 列出所有已注册的 connector */
  all(): LoadedConnector[] {
    return [...this.connectors.values()];
  }

  /** 当前注册的 connector 数量 */
  size(): number {
    return this.connectors.size;
  }

  /**
   * 按 tool 名反查 owner。Agent 调用工具时拿到 {connector, tool}，
   * 然后调 connector.execute(tool.name, args, ctx)。
   */
  findToolOwner(toolName: string): { connector: LoadedConnector; tool: Tool } | undefined {
    const connectorId = this.toolIndex.get(toolName);
    if (connectorId === undefined) return undefined;
    const connector = this.connectors.get(connectorId);
    if (!connector) return undefined;
    const tool = connector.instance.getTools().find((t) => t.name === toolName);
    if (!tool) return undefined;
    return { connector, tool };
  }

  /** 拼接所有 connector 暴露的 Tool（顺序按注册顺序），可直接喂给 Agent */
  listTools(): Tool[] {
    const out: Tool[] = [];
    for (const c of this.connectors.values()) {
      out.push(...c.instance.getTools());
    }
    return out;
  }

  /** 列出所有 tool 名（调试 / MCP server 用） */
  toolNames(): string[] {
    return [...this.toolIndex.keys()];
  }

  /** 全清空，主要给测试用 */
  clear(): void {
    this.connectors.clear();
    this.toolIndex.clear();
  }
}
