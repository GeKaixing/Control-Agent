/**
 * 给 dev 用的 Electron.app 注入麦克风 + 语音识别权限声明（macOS TCC）。
 *
 * 为什么需要：听写 helper（desktop/native/dictate.swift）由 Electron spawn，
 * TCC 责任人是 Electron.app 本体。没有 Info.plist 里的两个 key 时，macOS
 * 会直接拒绝授权（弹窗都不弹），SFSpeechRecognizer 拿不到任何音频。
 *
 * 这是对 node_modules 内 Electron.app 的 dev 期 hack：
 *  - 单机开发可接受（与 no-sandbox 同类决策）
 *  - npm install / electron 升级会还原 plist —— 所以 desktop:dev 前每次都跑
 *  - 打包分发时应在打包配置里正式声明这两个 key，届时删掉此脚本
 *
 * 幂等：key 已存在则跳过；重复运行无害。
 */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const KEYS = {
  NSMicrophoneUsageDescription: "c-agent 需要使用麦克风进行语音输入（听写）。",
  NSSpeechRecognitionUsageDescription: "c-agent 使用 macOS 系统语音识别把你的语音转换为文字（听写）。",
};

const plistPath = path.resolve(
  __dirname,
  "..",
  "node_modules",
  "electron",
  "dist",
  "Electron.app",
  "Contents",
  "Info.plist",
);
if (!fs.existsSync(plistPath)) {
  // 没有 electron 依赖（比如纯 CLI 环境）时静默跳过
  process.exit(0);
}

for (const [key, value] of Object.entries(KEYS)) {
  let exists = false;
  try {
    execFileSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plistPath], { stdio: "pipe" });
    exists = true;
  } catch {
    exists = false;
  }
  if (exists) continue;
  try {
    execFileSync("/usr/libexec/PlistBuddy", ["-c", `Add :${key} string ${value}`, plistPath], {
      stdio: "pipe",
    });
    console.log(`[ensure-mic-plist] 已注入 ${key}`);
  } catch (err) {
    console.error(`[ensure-mic-plist] 注入 ${key} 失败：${err.message}`);
    process.exitCode = 1;
  }
}
