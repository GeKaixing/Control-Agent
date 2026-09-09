/**
 * 文件日志（Environment 支柱的感知层）：进程内发生的事故——模型流失败、工具
 * 异常、顶层崩溃——不能只靠终端一闪而过，落盘才能事后归因。
 *
 * 设计约束（消失之问的下限版）：
 * - **零依赖**：只用 node:fs / node:path；
 * - **绝不抛错**：日志是诊断设施，自身任何失败（目录不可写、磁盘满）都静默
 *   禁用并放弃，绝不让主流程跟着失败；
 * - **同步写**：日志量很低（默认只记 info 以上），appendFileSync 换来的
 *   「崩溃前最后一行一定在盘上」比异步缓冲的吞吐重要得多；
 * - **按天分文件**：<cwd>/.c-agent/logs/agent-YYYY-MM-DD.log，初始化时清理
 *   只保留最近 KEEP_FILES 份，防止无限增长。
 *
 * 级别：debug < info < warn < error，外加 off。环境变量 C_AGENT_LOG 控制
 * （默认 info）；initFileLogging(cwd, { level }) 可显式指定（测试用）。
 * 未调用 initFileLogging 之前所有写入直接丢弃——只有入口（CLI / 桌面端）
 * 知道 cwd 在哪，日志目录由它显式指定，不在库里猜。
 */

import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";
/** off 是设置值不是记录级别：只出现在 C_AGENT_LOG / initFileLogging 里 */
export type LevelSetting = LogLevel | "off";

const LEVEL_ORDER: Record<LevelSetting, number> = { debug: 0, info: 1, warn: 2, error: 3, off: 4 };

/** 日志目录（相对 cwd）。.c-agent/ 由 sessions.ts（数据）与本模块（运行日志）分治 */
const LOG_DIR = path.join(".c-agent", "logs");
const FILE_PREFIX = "agent-";
/** 保留最近几份按天日志；更早的初始化时清理 */
const KEEP_FILES = 7;
/** 单条错误文本的截断长度；stack 足够定位，不值得无限堆 */
const MAX_ERROR_CHARS = 4000;

let dir: string | null = null;
let minLevel: LevelSetting = envLevel();
/** 首次写失败后置 true，后续调用直接返回——避免每条日志都重撞一次磁盘错误 */
let disabled = false;
let currentFile: string | null = null;
let currentDay = "";

/** 从环境变量读默认级别；非法值按 info 兜底，不给用户惊喜 */
function envLevel(): LevelSetting {
  const raw = process.env["C_AGENT_LOG"];
  if (raw === undefined) return "info";
  return (["debug", "info", "warn", "error", "off"] as const).includes(raw as LevelSetting)
    ? (raw as LevelSetting)
    : "info";
}

/**
 * 启用文件日志。CLI / 桌面端入口在拿到 cwd 后各调用一次；
 * 重复调用按最后一次为准（测试场景够用）。
 */
export function initFileLogging(cwd: string, opts?: { level?: LevelSetting }): void {
  dir = path.join(cwd, LOG_DIR);
  disabled = false;
  currentFile = null;
  currentDay = "";
  if (opts?.level !== undefined) minLevel = opts.level;
  // 目录先建好：cleanupOld 要读目录，且「初始化时清理」不能依赖首次写入时机
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // 建不出来不在这里判死刑：首次写入还会再试，失败时统一静默禁用
  }
  cleanupOld();
}

/** 运行时调整级别（REPL / 设置弹窗用）；off 关闭文件写入 */
export function setLogLevel(level: LevelSetting): void {
  minLevel = level;
}

/** 当前日志文件路径；未启用或尚未写过返回 null（给 /help 与排障提示用） */
export function logFilePath(): string | null {
  return currentFile;
}

/** 错误对象 → 可读文本：Error 优先取 stack（含定位行），非 Error 直接 String */
export function errorText(err: unknown): string {
  if (err instanceof Error) {
    const stack = err.stack ?? `${err.name}: ${err.message}`;
    return stack.length > MAX_ERROR_CHARS ? `${stack.slice(0, MAX_ERROR_CHARS)}…(截断)` : stack;
  }
  return String(err).length > MAX_ERROR_CHARS ? `${String(err).slice(0, MAX_ERROR_CHARS)}…(截断)` : String(err);
}

/** 本地时间戳（ISO 是 UTC，对排障的人不友好，这里直接按本机时区打印） */
function stamp(d: Date): string {
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  );
}

function dayKey(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 确保当天的日志文件路径就绪；跨天自动切换 */
function ensureFile(now: Date): void {
  const day = dayKey(now);
  if (currentFile !== null && day === currentDay) return;
  mkdirSync(dir as string, { recursive: true });
  currentFile = path.join(dir as string, `${FILE_PREFIX}${day}.log`);
  currentDay = day;
}

/** 清理超出 KEEP_FILES 的旧日志；失败静默（旧文件删不掉无伤大雅） */
function cleanupOld(): void {
  try {
    if (dir === null) return;
    const files = readdirSync(dir)
      .filter((f) => new RegExp(`^${FILE_PREFIX}\\d{4}-\\d{2}-\\d{2}\\.log$`).test(f))
      .sort();
    const excess = files.length - (KEEP_FILES - 1); // 留 1 个位置给今天即将创建的
    for (let i = 0; i < excess; i++) {
      const victim = path.join(dir, files[i]);
      // 排除极端情况：同一天被清理到当前文件（理论不可达，防御 stat 漂移）
      if (statSync(victim).isFile()) unlinkSync(victim);
    }
  } catch {
    // 目录不存在 / 无权限：留给首次写入时报
  }
}

function write(level: LogLevel, scope: string, message: string, err?: unknown): void {
  if (disabled || dir === null) return;
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  const line = `${stamp(new Date())} [${level}] [${scope}] ${message}`;
  const full = err === undefined ? line : `${line}\n    ${errorText(err).replace(/\n/g, "\n    ")}`;
  try {
    ensureFile(new Date());
    appendFileSync(currentFile as string, `${full}\n`, "utf8");
  } catch {
    disabled = true;
  }
}

/**
 * 全局日志单例。用法：`log.warn("agent", "工具执行失败", err)`。
 * scope 是模块短名（agent / cli / provider / bot / …），让日志可按来源 grep。
 */
export const log = {
  debug: (scope: string, message: string, err?: unknown): void => write("debug", scope, message, err),
  info: (scope: string, message: string, err?: unknown): void => write("info", scope, message, err),
  warn: (scope: string, message: string, err?: unknown): void => write("warn", scope, message, err),
  error: (scope: string, message: string, err?: unknown): void => write("error", scope, message, err),
};
