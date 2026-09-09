/**
 * 编译 Windows 听写 helper：desktop/native/win/dictate.cs → dictate.exe
 *
 * 用系统自带的 .NET Framework 4.x csc.exe（C# 5 + async/await，支持 winmd 引用），
 * 零 SDK 依赖：
 *   - csc.exe：C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe
 *   - WinRT 元数据：C:\Windows\System32\WinMetadata\Windows.{Foundation,Media,Globalization}.winmd
 *   - WinRT↔Task 桥：同目录 System.Runtime.WindowsRuntime.dll
 *
 * 产物 desktop/native/win/dictate.exe 由 desktop/main/dictation.ts 的
 * startWindows() 在 win32 下 spawn。重复编译幂等（直接覆盖）。
 */

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const csc = path.join(process.env["WINDIR"] ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
const winmdDir = path.join(process.env["WINDIR"] ?? "C:\\Windows", "System32", "WinMetadata");
const winRuntimeBridge = path.join(path.dirname(csc), "System.Runtime.WindowsRuntime.dll");
const source = path.join(repoRoot, "desktop", "native", "win", "dictate.cs");
const outExe = path.join(repoRoot, "desktop", "native", "win", "dictate.exe");

/**
 * .NET facade 程序集（System.Runtime 等）：winmd 投影编译必需（CS0012），
 * 但 GAC 路径带版本号——按目录名模糊定位，不写死版本。
 */
const gacRoot = path.join(process.env["WINDIR"] ?? "C:\\Windows", "Microsoft.NET", "assembly", "GAC_MSIL");
function findInGac(name) {
  const dir = path.join(gacRoot, name);
  if (!fs.existsSync(dir)) return undefined;
  for (const entry of fs.readdirSync(dir)) {
    const dll = path.join(dir, entry, `${name}.dll`);
    if (fs.existsSync(dll)) return dll;
  }
  return undefined;
}
const facades = [
  "System.Runtime",
  "System.Runtime.InteropServices.WindowsRuntime",
  "System.Threading.Tasks",
  "System.ObjectModel",
  "System.Collections",
  "System.IO",
]
  .map((name) => findInGac(name))
  .filter((file) => file !== undefined);

// WinRT↔Task 桥必须用 GAC 的完整实现版（GetAwaiter 扩展在 WindowsRuntimeSystemExtensions）：
// Framework 目录里那份可能是削过的 facade，引用它会 CS4028（IAsyncOperation 没有 GetAwaiter）
const runtimeBridge = findInGac("System.Runtime.WindowsRuntime") ?? winRuntimeBridge;

for (const [label, file] of [
  ["csc.exe", csc],
  ["Windows.Foundation.winmd", path.join(winmdDir, "Windows.Foundation.winmd")],
  ["Windows.Media.winmd", path.join(winmdDir, "Windows.Media.winmd")],
  ["Windows.Globalization.winmd", path.join(winmdDir, "Windows.Globalization.winmd")],
  ["System.Runtime.WindowsRuntime.dll", runtimeBridge],
  ["dictate.cs", source],
]) {
  if (!fs.existsSync(file)) {
    console.error(`[build-dictate-win] 缺少 ${label}：${file}`);
    process.exit(1);
  }
}

const args = [
  "/nologo",
  "/target:exe",
  `/out:${outExe}`,
  `/r:${path.join(winmdDir, "Windows.Foundation.winmd")}`,
  `/r:${path.join(winmdDir, "Windows.Media.winmd")}`,
  `/r:${path.join(winmdDir, "Windows.Globalization.winmd")}`,
  // 桥接扩展不再需要：WinRtAwait 自带 AsTask（见 dictate.cs）
  ...facades.map((file) => `/r:${file}`),
  source,
];

try {
  execFileSync(csc, args, { stdio: "inherit" });
} catch (err) {
  console.error("[build-dictate-win] 编译失败：", err instanceof Error ? err.message : err);
  process.exit(1);
}

if (!fs.existsSync(outExe)) {
  console.error("[build-dictate-win] csc 未产出 dictate.exe");
  process.exit(1);
}
console.log(`[build-dictate-win] OK → ${outExe}`);
