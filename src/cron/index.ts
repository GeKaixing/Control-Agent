/**
 * Cron 模块统一出口 —— 引用方只认这里，不直接深链子文件。
 *
 * 模块职责：让 agent 能在指定时刻自动执行提示词。三块能力：
 *  - 时间：parser（5 字段 cron 解析 + nextRun）
 *  - 存储：store（.c-agent/cron/jobs.json，原子写、坏文件回退）
 *  - 调度：scheduler（轮询触发，串行防并发）+ runner（无头执行一条任务）
 * CLI 子命令入口 handleCronCommand 在 ./cli.js（带终端输出的模块不进本出口，
 * 免得 REPL 引出口时连带拉进 stdout 渲染）。
 *
 * 设计取舍与边界见 doc/README.md。
 */

export { parseCron, nextCronRun } from "./parser.js";
export type { CronFields, CronFieldValues } from "./parser.js";
export {
  CRON_DIR,
  addCronJob,
  cronJobsPath,
  readCronJobs,
  removeCronJob,
  setCronJobEnabled,
  updateCronJob,
  writeCronJobs,
} from "./store.js";
export type { CronJob } from "./store.js";
export { CronScheduler } from "./scheduler.js";
export type { CronSchedulerOptions } from "./scheduler.js";
export { runJobOnce } from "./runner.js";
export type { CronRunResult } from "./runner.js";
