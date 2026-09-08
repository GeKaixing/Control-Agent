/**
 * mcp-memory：桥接官方 @modelcontextprotocol/server-memory（知识图谱记忆）。
 * 9 个工具全部来自 tools/list；其中改动图谱的 7 个标记 mutating 走审批门。
 *
 * 路径解析用 projectRoot() 而非 import.meta：本文件会被 tsx（ESM 源码）与桌面
 * 主进程（tsc CJS emit，import.meta 编译报错）两种运行时加载。
 */

import path from "node:path";
import { createMcpBridgeClass } from "../_shared/mcp-bridge.js";
import { projectRoot } from "../_shared/project-root.js";

const SERVER_SCRIPT = path.join(
  projectRoot(),
  "node_modules/@modelcontextprotocol/server-memory/dist/index.js",
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
