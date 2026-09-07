/**
 * mcp-sequential-thinking：桥接官方 @modelcontextprotocol/server-sequential-thinking。
 * 唯一工具 sequentialthinking：模型用它做显式分步推理（thought 链）。
 */

import path from "node:path";
import { createMcpBridgeClass } from "../_shared/mcp-bridge.js";

const SERVER_SCRIPT = path.resolve(
  import.meta.dirname,
  "../../node_modules/@modelcontextprotocol/server-sequential-thinking/dist/index.js",
);

export default createMcpBridgeClass({
  serverId: "mcp-sequential-thinking",
  command: process.execPath,
  args: [SERVER_SCRIPT],
});
