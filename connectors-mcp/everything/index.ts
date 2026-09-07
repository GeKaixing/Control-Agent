/**
 * mcp-everything：桥接官方 MCP 测试服务器 @modelcontextprotocol/server-everything。
 * 该 server 的工具集随版本变化（echo/add/longRunningOperation/printEnv/…），
 * manifest capabilities 留空，实际工具以运行时 tools/list 为准。
 */

import path from "node:path";
import { createMcpBridgeClass } from "../_shared/mcp-bridge.js";

const SERVER_SCRIPT = path.resolve(
  import.meta.dirname,
  "../../node_modules/@modelcontextprotocol/server-everything/dist/index.js",
);

export default createMcpBridgeClass({
  serverId: "mcp-everything",
  command: process.execPath,
  args: [SERVER_SCRIPT],
});
