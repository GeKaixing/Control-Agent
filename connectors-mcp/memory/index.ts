/**
 * mcp-memory：桥接官方 @modelcontextprotocol/server-memory（知识图谱记忆）。
 * 9 个工具全部来自 tools/list；其中改动图谱的 7 个标记 mutating 走审批门。
 */

import path from "node:path";
import { createMcpBridgeClass } from "../_shared/mcp-bridge.js";

const SERVER_SCRIPT = path.resolve(
  import.meta.dirname,
  "../../node_modules/@modelcontextprotocol/server-memory/dist/index.js",
);

export default createMcpBridgeClass({
  serverId: "mcp-memory",
  command: process.execPath,
  args: [SERVER_SCRIPT],
  mutatingToolNames: [
    "create_entities",
    "create_relations",
    "add_observations",
    "delete_entities",
    "delete_relations",
    "delete_observations",
  ],
});
