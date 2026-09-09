/**
 * 日志模块用例：级别过滤、stack 落盘、旧文件清理、目录不可写时静默禁用、
 * 运行时调级。全部走独立 tmp 目录，进程结束后由 run.ts 的统一清扫回收
 * （前缀 agent-test- 命中 TMP_SWEEP_PREFIXES）。
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { initFileLogging, log, logFilePath, setLogLevel } from "../src/log/index.js";
import { assert, test } from "./registry.js";

/** 当地时区的 YYYY-MM-DD（日志文件名口径，与 logger 内部一致） */
function localDay(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

test("log: 级别过滤 + 错误对象带 stack 落盘", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-test-log-"));
  initFileLogging(tmp, { level: "warn" });

  log.debug("t", "debug 行");
  log.info("t", "info 行");
  log.warn("t", "警告一行");
  log.error("t", "错误一行", new Error("boom-stack"));

  const file = logFilePath();
  assert.ok(file !== null, "logFilePath() 应返回当天文件");
  assert.ok(file!.includes(`agent-${localDay()}.log`), `文件名应是按天命名，实际 ${file}`);

  const content = await fs.readFile(file as string, "utf8");
  assert.ok(content.includes("[warn] [t] 警告一行"));
  assert.ok(content.includes("[error] [t] 错误一行"));
  assert.ok(content.includes("boom-stack"), "错误对象应带 message 落盘");
  assert.ok(content.includes("    at "), "Error 应带缩进 stack");
  assert.ok(!content.includes("debug 行"), "低于 warn 的级别不该写盘");
  assert.ok(!content.includes("info 行"), "低于 warn 的级别不该写盘");
});

test("log: 初始化时清理旧文件，保留最近 7 份", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-test-log-"));
  const logsDir = path.join(tmp, ".c-agent", "logs"); // 与 logger 的目录口径一致
  // 造 9 份旧日志（9 天前 → 1 天前）
  for (let i = 9; i >= 1; i--) {
    await fs.mkdir(logsDir, { recursive: true });
    await fs.writeFile(path.join(logsDir, `agent-${localDay(-i)}.log`), `old-${i}`, "utf8");
  }
  initFileLogging(tmp, { level: "info" });
  log.info("t", "今天这一行");

  const files = (await fs.readdir(logsDir)).sort();
  assert.equal(files.length, 7, `应保留 6 份旧 + 今天 1 份，实际 ${files.join(",")}`);
  assert.ok(files.includes(`agent-${localDay()}.log`), "今天的文件必须在");
  assert.ok(!files.includes(`agent-${localDay(-9)}.log`), "最旧的应被清理");
  const content = await fs.readFile(path.join(logsDir, `agent-${localDay()}.log`), "utf8");
  assert.ok(content.includes("今天这一行"));
});

test("log: 目录不可写时静默禁用，绝不抛错", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-test-log-"));
  const blocker = path.join(tmp, "not-a-dir");
  await fs.writeFile(blocker, "i-am-a-file", "utf8");

  // dir 指向一个文件：mkdir / append 都会失败，logger 必须吞掉并禁用
  initFileLogging(blocker, { level: "info" });
  assert.doesNotThrow(() => {
    log.info("t", "写不进去但不炸");
    log.error("t", "再撞一次也不炸", new Error("x"));
  });
  assert.equal(logFilePath(), null, "首次写入失败后不应有有效文件");

  // 恢复到正常目录后继续可用（disabled 被重置）
  initFileLogging(tmp, { level: "info" });
  log.error("t", "恢复后的第一行");
  const recovered = await fs.readdir(path.join(tmp, ".c-agent", "logs"));
  assert.ok(recovered.some((f) => f.startsWith("agent-")), "恢复后应能写盘");
});

test("log: setLogLevel 运行时调整与 off 关闭", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-test-log-"));
  initFileLogging(tmp, { level: "error" });
  log.warn("t", "error 级时不见");
  setLogLevel("debug");
  log.debug("t", "调到 debug 后可见");

  let content = await fs.readFile(logFilePath() as string, "utf8");
  assert.ok(!content.includes("error 级时不见"));
  assert.ok(content.includes("调到 debug 后可见"));

  setLogLevel("off");
  log.error("t", "off 之后不该落盘");
  content = await fs.readFile(logFilePath() as string, "utf8");
  assert.ok(!content.includes("off 之后不该落盘"), "off 应关闭全部写入");

  // 收尾：把单例调回 off，避免污染同进程后续用例
  setLogLevel("off");
});
