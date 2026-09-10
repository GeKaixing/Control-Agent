/**
 * Cron 模块：任务持久化 —— .c-agent/cron/jobs.json，一套纪律。
 *
 * 与 sessions.ts（.c-agent/sessions/）同一套落盘纪律：原子写（tmp + rename）、
 * 版本字段、坏文件静默回退为空表——定时任务存不上不该让 agent 崩，
 * 丢一份任务清单的代价远小于把整个进程拖死。
 *
 * 与会话持久化的分工：sessions 存的是「对话历史」，这里存的是「未来要跑什么」。
 * nextRunAt 落盘是为了跨重启不重复触发：同一分钟内进程重启，下次 tick 看到
 * nextRunAt 已在未来就不会再跑一遍。
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { nextCronRun } from "./parser.js";

export const CRON_DIR = path.join(".c-agent", "cron");

const CRON_VERSION = 1;

/** 一条定时任务。时间戳一律 epoch 毫秒（与 sessions.ts 同口径） */
export interface CronJob {
  /** 短 id（c + 36 进制时间戳 + 4 位随机尾巴），REPL / CLI 里支持前缀匹配 */
  id: string;
  /** 5 字段 cron 表达式（原样保存，解析在读取侧） */
  expr: string;
  /** 到点喂给 agent 的提示词 */
  prompt: string;
  enabled: boolean;
  createdAt: number;
  /** 上次实际触发时刻；从未跑过为 null */
  lastRunAt: number | null;
  /** 下次应触发时刻；表达式彻底无解（如 2 月 30 日）为 null */
  nextRunAt: number | null;
}

interface StoredCron {
  version: number;
  jobs: CronJob[];
}

/** jobs.json 的绝对路径（.c-agent/ 下与 sessions / config 同级，同一套纪律） */
export function cronJobsPath(cwd: string): string {
  return path.join(cwd, CRON_DIR, "jobs.json");
}

/** 读全量任务清单。文件不存在 / JSON 损坏 / 版本不识别 → []，不打日志不抛错 */
export async function readCronJobs(cwd: string): Promise<CronJob[]> {
  let raw: string;
  try {
    raw = await readFile(cronJobsPath(cwd), "utf8");
  } catch {
    return [];
  }
  try {
    const data = JSON.parse(raw) as StoredCron;
    if (data.version !== CRON_VERSION || !Array.isArray(data.jobs)) return [];
    // 逐条形状校验：坏一条丢一条，不连坐整份文件
    return data.jobs.filter(
      (j) =>
        typeof j.id === "string" &&
        typeof j.expr === "string" &&
        typeof j.prompt === "string" &&
        typeof j.enabled === "boolean" &&
        typeof j.createdAt === "number",
    );
  } catch {
    return [];
  }
}

/** 原子写全量清单（tmp + rename）。写入失败抛出，由调用方决定怎么提示 */
export async function writeCronJobs(cwd: string, jobs: CronJob[]): Promise<void> {
  await mkdir(path.join(cwd, CRON_DIR), { recursive: true });
  const stored: StoredCron = { version: CRON_VERSION, jobs };
  const file = cronJobsPath(cwd);
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(stored, null, 2), "utf8");
  await rename(tmp, file);
}

/** 任务 id：36 进制时间戳 + 4 位随机尾巴，够短且按创建时间天然有序 */
function newJobId(): string {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 新增任务。表达式非法 / 提示词为空 → null（调用方提示用法，不抛错）。
 * nextRunAt 在新增时就算好并落盘——「刚添加就到点」的任务不会被立刻触发。
 */
export async function addCronJob(cwd: string, expr: string, prompt: string): Promise<CronJob | null> {
  const trimmedExpr = expr.trim();
  const trimmedPrompt = prompt.trim();
  if (nextCronRun(trimmedExpr, new Date()) === null || trimmedPrompt.length === 0) return null;
  const job: CronJob = {
    id: newJobId(),
    expr: trimmedExpr,
    prompt: trimmedPrompt,
    enabled: true,
    createdAt: Date.now(),
    lastRunAt: null,
    nextRunAt: nextCronRun(trimmedExpr, new Date())?.getTime() ?? null,
  };
  await writeCronJobs(cwd, [...(await readCronJobs(cwd)), job]);
  return job;
}

/** 删除任务（需完整 id）。id 不存在 → false，与 sessions.ts 的坏输入静默回退同款 */
export async function removeCronJob(cwd: string, id: string): Promise<boolean> {
  const jobs = await readCronJobs(cwd);
  const next = jobs.filter((j) => j.id !== id);
  if (next.length === jobs.length) return false;
  await writeCronJobs(cwd, next);
  return true;
}

/** 启用 / 停用。任务不存在 → null */
export async function setCronJobEnabled(cwd: string, id: string, enabled: boolean): Promise<CronJob | null> {
  const jobs = await readCronJobs(cwd);
  const job = jobs.find((j) => j.id === id);
  if (job === undefined) return null;
  job.enabled = enabled;
  // 停用期间错过的时点不补跑：重新启用时从现在起算下一次
  if (enabled) job.nextRunAt = nextCronRun(job.expr, new Date())?.getTime() ?? null;
  await writeCronJobs(cwd, jobs);
  return job;
}

/**
 * 触发后记账（scheduler 专用，也可用于测试拨时间）：
 * lastRunAt 置为 ranAt，nextRunAt 从 ranAt 起重算。任务不存在时静默忽略——
 * 触发到记账之间任务被删是正常竞态，不该让调度循环崩掉。
 */
export async function updateCronJob(
  cwd: string,
  id: string,
  patch: { lastRunAt?: number | null; nextRunAt?: number | null },
): Promise<void> {
  const jobs = await readCronJobs(cwd);
  const job = jobs.find((j) => j.id === id);
  if (job === undefined) return;
  if (patch.lastRunAt !== undefined) job.lastRunAt = patch.lastRunAt;
  if (patch.nextRunAt !== undefined) job.nextRunAt = patch.nextRunAt;
  await writeCronJobs(cwd, jobs);
}
