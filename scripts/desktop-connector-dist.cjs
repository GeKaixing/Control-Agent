/**
 * 把 connectors-mcp 下每个 connector 目录里的 connector.json 复制进桌面主进程编译产物的对应目录。
 *
 * 为什么需要：桌面主进程是编译后的 CJS（Electron 无 ts loader），ConnectorLoader
 * 在 dist 里扫描时必须能找到 manifest（tsc 只 emit .ts 的 .js，不搬 .json）。
 * dist 布局有两种历史形态（outDir/rootDir 组合决定），按存在性探测。
 *
 * 跑法：desktop:build:main 的最后一步（tsc 之后）。
 */

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const srcDir = path.join(root, "connectors-mcp");
const distRoot = path.join(root, "desktop/main/dist");

/**
 * 定位编译产物里的 connectors-mcp。
 *
 * rootDir 布局决定产物深嵌一层「仓库所在目录名」：`dist/<仓库目录名>/connectors-mcp`。
 * 目录名是环境产物（项目在 g/ 下就叫 g，搬到 c/ 下就叫 c），不能写死——
 * 以前写死 ["g", ""] 两个候选，项目搬到 c/ 后两个都落空，复制步骤静默跳过，
 * 桌面端 connector 因此加载不到。改成扫 dist/ 子目录动态找（与 entry.mjs
 * resolveDistMain / index.ts resolveDistConnectorsDir 同坑同修）。
 */
function resolveDistConnectorsDir() {
  const direct = path.join(distRoot, "connectors-mcp");
  if (fs.existsSync(direct)) return direct;
  try {
    for (const entry of fs.readdirSync(distRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(distRoot, entry.name, "connectors-mcp");
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    // dist 不存在（未编译）或读不了
  }
  return null;
}

const distDir = resolveDistConnectorsDir();
if (distDir === null) {
  console.log("[desktop-connector-dist] dist 里没有编译产物 connectors-mcp，跳过");
  process.exit(0);
}

let copied = 0;
for (const name of fs.readdirSync(srcDir)) {
  const manifest = path.join(srcDir, name, "connector.json");
  if (!fs.existsSync(manifest)) continue;
  fs.mkdirSync(path.join(distDir, name), { recursive: true });
  fs.copyFileSync(manifest, path.join(distDir, name, "connector.json"));
  copied++;
}
console.log(`[desktop-connector-dist] ${copied} 个 manifest 已复制 -> ${distDir}`);
