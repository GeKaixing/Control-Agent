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
const distCandidates = [
  path.join(root, "desktop/main/dist/g/connectors-mcp"),
  path.join(root, "desktop/main/dist/connectors-mcp"),
];

const distDir = distCandidates.find((p) => fs.existsSync(p));
if (distDir === undefined) {
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
