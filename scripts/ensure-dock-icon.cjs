/**
 * 给 dev 用的 Electron.app 注入项目 Dock 图标（docs/logo.png → electron.icns）。
 *
 * 为什么需要：dev 模式 Dock 里显示的是 node_modules 内 Electron.app 自带的
 * 图标；macOS 的 Dock 图标来自 bundle 的 icns，BrowserWindow 的 icon 项管不到
 * （见 desktop/main/index.ts appIconPath 注释）。打包分发时由打包配置正式
 * 指定图标，届时删掉此脚本。
 *
 * 这是对 node_modules 内 Electron.app 的 dev 期 hack（与 ensure-mic-plist
 * 同类决策）：
 *  - 单机开发可接受
 *  - npm install / electron 升级会还原 icns —— 所以 desktop:dev 前每次都跑
 *
 * 幂等：生成的 icns 与现文件一致则跳过；重复运行无害。
 */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// 图标源图：优先 logo-icon.png（1024px 圆角透明底，macOS 规范形状），
// 回退 logo.png（满幅方图，直角白底在 Dock 里不好看）
const iconPng = path.resolve(__dirname, "..", "docs", "logo-icon.png");
const fallbackPng = path.resolve(__dirname, "..", "docs", "logo.png");
const logoPath = fs.existsSync(iconPng) ? iconPng : fallbackPng;
const appDir = path.resolve(
  __dirname,
  "..",
  "node_modules",
  "electron",
  "dist",
  "Electron.app",
);
const icnsPath = path.join(appDir, "Contents", "Resources", "electron.icns");

if (
  process.platform !== "darwin" ||
  !fs.existsSync(logoPath) ||
  !fs.existsSync(path.dirname(icnsPath))
) {
  // 非 macOS / 无 logo / 纯 CLI 环境（无 electron 依赖）时静默跳过
  process.exit(0);
}

// 标准 iconset：16/32/128/256/512 各配 @2x（覆盖 16–1024px）
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cagent-dock-icon-"));
const iconset = path.join(tmp, "electron.iconset");
fs.mkdirSync(iconset);
try {
  for (const s of [16, 32, 128, 256, 512]) {
    for (const [name, px] of [
      [`icon_${s}x${s}.png`, s],
      [`icon_${s}x${s}@2x.png`, s * 2],
    ]) {
      execFileSync(
        "sips",
        ["-s", "format", "png", "-z", String(px), String(px), logoPath, "--out", path.join(iconset, name)],
        { stdio: "ignore" },
      );
    }
  }
  const outIcns = path.join(tmp, "electron.icns");
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", outIcns]);

  if (fs.existsSync(icnsPath) && fs.readFileSync(icnsPath).equals(fs.readFileSync(outIcns))) {
    console.log("[ensure-dock-icon] electron.icns 已是最新，跳过");
    return;
  }
  fs.copyFileSync(outIcns, icnsPath);
  // touch .app 让 Finder/Dock 的 bundle 图标缓存失效
  execFileSync("touch", [appDir]);
  console.log("[ensure-dock-icon] 已写入 electron.icns（重启 Electron 后 Dock 生效）");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
