/**
 * mcp-sequential-thinking：桥接官方 @modelcontextprotocol/server-sequential-thinking。
 * 唯一工具 sequentialthinking：模型用它做显式分步推理（thought 链）。
 *
 * 路径解析用 projectRoot() 而非 import.meta：本文件会被 tsx（ESM 源码）与桌面
 * 主进程（tsc CJS emit，import.meta 编译报错）两种运行时加载。
 */

import path from "node:path";
import { createMcpBridgeClass } from "../_shared/mcp-bridge.js";
import { projectRoot } from "../_shared/project-root.js";

const SERVER_SCRIPT = path.join(
  projectRoot(),
  "node_modules/@modelcontextprotocol/server-sequential-thinking/dist/index.js",
);

export default createMcpBridgeClass({
  serverId: "mcp-sequential-thinking",
  command: process.execPath,
  args: [SERVER_SCRIPT],
});
