/**
 * Cron 模块：调度循环 —— 每隔一小段检查一次到点任务并触发回调。
 *
 * 为什么轮询而不是 setTimeout 到点唤醒：任务清单随时可能被 /cron 增删改，
 * 每次变动重排一堆 timer 是纯复杂度；30s 一次的查表循环既简单又对进程休眠
 * 友好（笔记本合盖唤醒后下一 tick 立刻补判）。
 *
 * 补跑语义：进程停机期间错过的触发点，下个 tick 补跑**一次**然后直接跳到
 * 下一个未来时点——不是逐个补齐错过的每一次（每分钟任务停机一天不会连跑
 * 1440 遍），也不是默默丢弃（每天任务停机一天，第二天开机该跑还是跑）。
 *
 * 并发纪律：tick 内串行 await onDue（上一个任务跑完才判下一个）；跨 tick
 * 用 ticking 标志 + isBusy 回调（调用方告知「agent 正忙」）双层防重叠。
 */

import type { CronJob } from "./store.js";
import { readCronJobs, updateCronJob } from "./store.js";
import { nextCronRun } from "./parser.js";
import { log } from "../log/index.js";

export interface CronSchedulerOptions {
  cwd: string;
  /** 到点回调。返回 Promise 时调度器会等它完成再继续（天然串行防并发） */
  onDue: (job: CronJob) => void | Promise<void>;
  /** 返回 true 时本轮检查直接跳过。REPL 里 agent 正在跑 / daemon 正在执行上一个任务时用 */
  isBusy?: () => boolean;
  /** 检查间隔 ms，默认 30_000 */
  checkIntervalMs?: number;
}

export class CronScheduler {
  private readonly opts: CronSchedulerOptions;
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;

  constructor(opts: CronSchedulerOptions) {
    this.opts = opts;
  }

  /** 启动：立即查一轮（捡起停机期间错过的任务），然后进入周期轮询 */
  start(): void {
    if (this.timer !== undefined) return;
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.opts.checkIntervalMs ?? 30_000);
    // unref：调度器不该独自吊住进程——`cron run` 守护模式自己用常驻 promise 保活
    this.timer.unref();
  }

  stop(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * 查一轮并触发到点任务。公开给测试与「想让刚加的任务立刻被看到」的调用方。
   * 任何单条任务的记账 / 回调异常都被吃掉记日志——调度循环活着比什么都重要。
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      if (this.opts.isBusy?.() === true) return;
      const now = Date.now();
      for (const job of await readCronJobs(this.opts.cwd)) {
        if (!job.enabled) continue;
        let dueAt = job.nextRunAt;
        if (dueAt === null) {
          // 旧数据 / 坏数据修复：从 lastRunAt 或 createdAt 重算并补写，下轮就有值
          dueAt = nextCronRun(job.expr, new Date(job.lastRunAt ?? job.createdAt))?.getTime() ?? null;
          if (dueAt === null) continue;
          await updateCronJob(this.opts.cwd, job.id, { nextRunAt: dueAt });
        }
        if (dueAt > now) continue;
        // 触发前先记账：回调崩溃 / 进程被杀也不会对同一时点重复轰炸
        await updateCronJob(this.opts.cwd, job.id, {
          lastRunAt: now,
          nextRunAt: nextCronRun(job.expr, new Date(now))?.getTime() ?? null,
        });
        log.info("cron", `任务 ${job.id} 到点触发：${job.prompt}`);
        await this.opts.onDue(job);
      }
    } catch (err) {
      log.warn("cron", "调度 tick 失败（下一轮重试）", err instanceof Error ? err : undefined);
    } finally {
      this.ticking = false;
    }
  }
}
