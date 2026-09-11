/**
 * 数据目录单一真相源（零依赖叶子模块，logger / cron / sessions / bot 共用，避免循环依赖）。
 *
 * 历史：2026-09-11 项目更名 c-agent → Control-Agent 时数据目录从 `.control-agent/`
 * 改为 `.control-agent/`。改名不能丢数据——migrateDataDir 在各入口启动时
 * 做一次性目录改名（只挪目录，不动内部结构：sessions / logs / cron / config 全在）。
 *
 * 注意：localStorage key（c-agent.*）、听写文件（c-agent-dictate.json）、
 * 环境变量前缀（C_AGENT_*）是标识符不是路径，刻意不改（数据连续性）。
 */

import { existsSync, renameSync } from "node:fs";
import path from "node:path";

export const DATA_DIR = ".control-agent";

/** 旧数据目录名（2026-09-11 前的版本写入这里；批量改名时被误伤过一次，别再动它） */
export const LEGACY_DATA_DIR = ".c-agent";

/**
 * 一次性迁移：<cwd>/.control-agent → <cwd>/.control-agent。
 * 新目录已存在（迁移完成过）或旧目录不存在 → no-op；
 * 改名失败不阻塞启动——老目录原样保留，下次启动再试。
 * 必须在入口最早处调用（早于 initFileLogging / 会话清单读取）。
 */
export function migrateDataDir(cwd: string): void {
  const from = path.join(cwd, LEGACY_DATA_DIR);
  const to = path.join(cwd, DATA_DIR);
  try {
    if (!existsSync(from) || existsSync(to)) return;
    renameSync(from, to);
  } catch {
    // 静默：日志还没初始化，也没有更好的上报通道；老数据不会丢，只是留在原地
  }
}
