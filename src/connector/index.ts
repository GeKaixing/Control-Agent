/**
 * Connector Runtime 统一出口。
 *
 * 模块划分（与 src/connector/doc/README.md v0.1 对齐）：
 * - core/        接口、manifest、状态机
 * - registry/    connector 注册表（按 tool 名反查 owner）
 * - runtime/     生命周期管理 + execute 路由
 * - loader/      从本地目录扫描加载 connector
 * - protocol/    MCP stdio server
 * - connectors/  内置 connector（ffmpeg）
 *
 * 外部模块一律从这里 import；子模块文件路径不该出现在外部代码里。
 */

export * from "./core/types.js";
export { ConnectorRegistry } from "./registry/connector-registry.js";
export { ConnectorRuntime, type ConnectorRuntimeOptions } from "./runtime/connector-runtime.js";
export { ConnectorLoader } from "./loader/connector-loader.js";
export { McpServer, type McpServerOptions } from "./protocol/mcp-server.js";
