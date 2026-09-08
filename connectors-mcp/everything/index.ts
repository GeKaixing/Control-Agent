/**
 * mcp-everything：桥接官方 MCP 测试服务器 @modelcontextprotocol/server-everything。
 * 该 server 的工具集随版本变化（echo/add/longRunningOperation/printEnv/…），
 * manifest capabilities 留空，实际工具以运行时 tools/list 为准。
 *
 * 路径解析用 projectRoot() 而非 import.meta：本文件会被 tsx（ESM 源码）与桌面
 * 主进程（tsc CJS emit，import.meta 编译报错）两种运行时加载。
 */

import path from "node:path";
import { createMcpBridgeClass } from "../_shared/mcp-bridge.js";
import { projectRoot } from "../_shared/project-root.js";

const SERVER_SCRIPT = path.join(
  projectRoot(),
  "node_modules/@modelcontextprotocol/server-everything/dist/index.js",
);

export default createMcpBridgeClass({
  serverId: "mcp-everything",
  command: process.execPath,
  args: [SERVER_SCRIPT],
});
