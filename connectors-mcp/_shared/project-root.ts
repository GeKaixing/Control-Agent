/**
 * 项目根定位（双端通用，不碰 import.meta）：
 *
 * connectors-mcp 的入口文件会被两种运行时加载——
 * - CLI / 冒烟脚本：tsx 跑 .ts 源码（ESM）；
 * - 桌面主进程：tsc 以 CommonJS emit 后由 Electron 加载（`import.meta` 直接编译报错）。
 * 所以这里不能像 mcp-everything 早期那样用 `import.meta.dirname`，统一走
 * 「从 cwd 向上找最近的 package.json」：桌面端 cwd = 项目根；CLI 从仓库任意
 * 子目录启动也能向上命中。命中最近的一个（monorepo 嵌套时可能不是仓库根，
 * 当前单仓项目无此问题）。
 */

import { existsSync } from "node:fs";
import path from "node:path";

export function projectRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}
