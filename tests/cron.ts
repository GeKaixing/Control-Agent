/**
 * Cron 模块测试：表达式解析、nextRun 计算、存储增删改查、调度触发。
 *
 * 不测的部分：runner（需要真实模型装配，print 收敛逻辑已被 print 用例覆盖）
 * 与 CLI / REPL 命令解析（薄壳，逻辑都在被测的 store / parser 里）。
 */

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { nextCronRun, parseCron } from "../src/cron/parser.js";
import {
  addCronJob,
  readCronJobs,
  removeCronJob,
  setCronJobEnabled,
  updateCronJob,
  writeCronJobs,
} from "../src/cron/store.js";
import { CronScheduler } from "../src/cron/scheduler.js";
import { attachPersistentSession } from "../src/cron/runner.js";
import { assembleSession } from "../src/session.js";
import { saveSession, sessionFileExists } from "../src/context/index.js";
import type { CronJob } from "../src/cron/store.js";

import { test } from "./registry.js";

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "cron-test-"));
}

/** 便捷构造：本地时区的 Date（测试里比 UTC 数字好读） */
function at(y: number, m: number, d: number, h: number, min: number): Date {
  return new Date(y, m - 1, d, h, min, 0, 0);
}

// ------------------------------------------------------------ parser

test("cron parser: 基础字段、列表、范围、步进、Vixie 语义", () => {
  const f = parseCron("*/15 0-6/2 1,15 3,6 0,7");
  assert.ok(f !== null);
  assert.equal(f.minutes.values.filter(Boolean).length, 4); // 0,15,30,45
  assert.equal(f.hours.values[0], true && f.hours.values[2] && f.hours.values[4] && f.hours.values[6]);
  assert.equal(f.hours.values[1], false);
  assert.equal(f.doms.values[1] && f.doms.values[15], true);
  assert.equal(f.dows.values[0], true, "dow 7 应归一到周日 0");
  assert.equal(f.domRestricted && f.dowRestricted, true);

  // `5/15` 是起点 + 步进，不是单值（Vixie cron 语义）
  const vixie = parseCron("5/15 * * * *");
  assert.ok(vixie !== null);
  assert.equal(vixie.minutes.values[5] && vixie.minutes.values[20] && vixie.minutes.values[50], true);
  assert.equal(vixie.minutes.values[0], false);

  // 未约束字段全 true 且 restricted=false
  const star = parseCron("* * * * *");
  assert.ok(star !== null);
  assert.equal(star.minutes.values.every(Boolean), true);
  assert.equal(star.minutes.restricted, false);
});

test("cron parser: 非法表达式一律 null，不抛错", () => {
  for (const bad of [
    "",
    "* * * *", // 缺字段
    "* * * * * *", // 多字段
    "60 * * * *", // 分钟越界
    "* 24 * * *", // 小时越界
    "* * 0 * *", // 日从 1 起
    "* * * 13 *", // 月越界
    "* * * * 8", // 周最大 7
    "a * * * *", // 非数字
    "*/0 * * * *", // 步进 0
    "1,,2 * * * *", // 空段
    "10-5 * * * *", // 倒序范围
  ]) {
    assert.equal(parseCron(bad), null, `应拒绝：${JSON.stringify(bad)}`);
  }
});

test("cron nextRun: 顺延、跨周末、闰年、dow=7", () => {
  // 13:00 的下一个每天 9 点是明天
  assert.deepEqual(nextCronRun("0 9 * * *", at(2026, 9, 10, 13, 0)), at(2026, 9, 11, 9, 0));
  // 同一分钟内不重复触发：恰好在触发分钟上 → 下一分钟起算
  assert.deepEqual(nextCronRun("0 9 * * *", at(2026, 9, 11, 9, 0)), at(2026, 9, 12, 9, 0));
  // 周一到周五：周五 10 点之后是下周一（2026-09-11 是周五）
  assert.deepEqual(nextCronRun("30 9 * * 1-5", at(2026, 9, 11, 10, 0)), at(2026, 9, 14, 9, 30));
  // 步进：09:59 → 10:00；10:00 → 10:15
  assert.deepEqual(nextCronRun("*/15 * * * *", at(2026, 9, 10, 9, 59)), at(2026, 9, 10, 10, 0));
  assert.deepEqual(nextCronRun("*/15 * * * *", at(2026, 9, 10, 10, 0)), at(2026, 9, 10, 10, 15));
  // 闰日：2027 非闰年跳过，落在 2028-02-29
  assert.deepEqual(nextCronRun("0 0 29 2 *", at(2026, 1, 1, 0, 0)), at(2028, 2, 29, 0, 0));
  // dow 写 7 等价周日
  assert.deepEqual(nextCronRun("0 12 * * 7", at(2026, 9, 13, 13, 0)), at(2026, 9, 20, 12, 0));
  // dom 与 dow 都被约束时取或：1 号或周一，先到者得（2026-09-14 是周一 1 号前的最近匹配）
  assert.deepEqual(nextCronRun("0 8 1 * 1", at(2026, 9, 10, 0, 0)), at(2026, 9, 14, 8, 0));
  // 无解表达式 → null
  assert.equal(nextCronRun("0 0 31 2 *", at(2026, 1, 1, 0, 0)), null, "2 月没有 31 日");
  assert.equal(nextCronRun("nonsense", new Date()), null);
});

// ------------------------------------------------------------- store

test("cron store: 增删改查与坏文件回退", async () => {
  const dir = await tempDir();

  // 空目录 → []
  assert.deepEqual(await readCronJobs(dir), []);

  // 非法表达式 / 空提示词 → null，不落盘
  assert.equal(await addCronJob(dir, "bad expr", "写日报"), null);
  assert.equal(await addCronJob(dir, "0 9 * * *", "  "), null);
  assert.deepEqual(await readCronJobs(dir), []);

  // 正常新增：enabled、nextRunAt 在未来
  const job = await addCronJob(dir, "0 9 * * *", "写日报");
  assert.ok(job !== null);
  assert.equal(job.enabled, true);
  assert.ok(job.nextRunAt !== null && job.nextRunAt > Date.now());

  // 启停：off 后再 on，nextRunAt 从现在重算
  const offJob = await setCronJobEnabled(dir, job.id, false);
  assert.ok(offJob !== null && offJob.enabled === false);
  const onJob = await setCronJobEnabled(dir, job.id, true);
  assert.ok(onJob !== null && onJob.enabled === true && onJob.nextRunAt !== null && onJob.nextRunAt > Date.now());

  // 记账：lastRunAt / nextRunAt 更新
  await updateCronJob(dir, job.id, { lastRunAt: 1000, nextRunAt: 2000 });
  const after = (await readCronJobs(dir)).find((j) => j.id === job.id);
  assert.ok(after !== undefined);
  assert.equal(after.lastRunAt, 1000);
  assert.equal(after.nextRunAt, 2000);

  // 删除：存在 true，不存在 false
  assert.equal(await removeCronJob(dir, job.id), true);
  assert.equal(await removeCronJob(dir, job.id), false);
  assert.deepEqual(await readCronJobs(dir), []);

  // 坏文件 / 版本不识别 → []（静默回退，不抛错）
  await writeCronJobs(dir, []);
  await fs.writeFile(path.join(dir, ".control-agent", "cron", "jobs.json"), "{broken", "utf8");
  assert.deepEqual(await readCronJobs(dir), []);
});

// --------------------------------------------------------- scheduler

test("cron scheduler: 到点触发一次并记账，busy / 停用不触发", async () => {
  const dir = await tempDir();
  const job = await addCronJob(dir, "0 9 * * *", "写日报");
  assert.ok(job !== null);

  // 把 nextRunAt 拨到过去，模拟「到点」
  await updateCronJob(dir, job.id, { nextRunAt: Date.now() - 1000 });

  const fired: CronJob[] = [];
  const scheduler = new CronScheduler({ cwd: dir, onDue: (j) => void fired.push(j), checkIntervalMs: 1000 });
  await scheduler.tick();

  assert.equal(fired.length, 1, "到点任务应触发一次");
  assert.equal(fired[0]?.id, job.id);

  const after = (await readCronJobs(dir)).find((j) => j.id === job.id);
  assert.ok(after !== undefined);
  assert.ok(after.lastRunAt !== null, "触发后应记账 lastRunAt");
  assert.ok(after.nextRunAt !== null && after.nextRunAt > Date.now(), "nextRunAt 应推进到未来");

  // 再 tick 一轮：nextRunAt 已在未来，不重复触发
  await scheduler.tick();
  assert.equal(fired.length, 1);

  // busy 时不触发
  await updateCronJob(dir, job.id, { nextRunAt: Date.now() - 1000 });
  const busyScheduler = new CronScheduler({ cwd: dir, onDue: (j) => void fired.push(j), isBusy: () => true });
  await busyScheduler.tick();
  assert.equal(fired.length, 1, "busy 时本轮应跳过");

  // 停用的任务不触发
  await setCronJobEnabled(dir, job.id, false);
  const quietScheduler = new CronScheduler({ cwd: dir, onDue: (j) => void fired.push(j) });
  await quietScheduler.tick();
  assert.equal(fired.length, 1, "停用任务不应触发");

  // async onDue：tick 串行等待回调完成（先启用再拨时间——重新启用会把
  // nextRunAt 重算到未来，顺序反了就把「到点」覆盖掉了）
  await setCronJobEnabled(dir, job.id, true);
  await updateCronJob(dir, job.id, { nextRunAt: Date.now() - 1000 });
  let asyncDone = false;
  const asyncScheduler = new CronScheduler({
    cwd: dir,
    onDue: async () => {
      await new Promise((r) => setTimeout(r, 20));
      asyncDone = true;
    },
  });
  await asyncScheduler.tick();
  assert.equal(asyncDone, true, "tick 应等待 async onDue 完成");
});

// ------------------------------------------------------------ runner: per-job 持久会话

test("cron runner: attachPersistentSession 无文件预占 id、有文件续接", async () => {
  const dir = await tempDir();
  const first = await assembleSession({ cwd: dir });

  // 无会话文件 → 预占 id（后续 saveSession 落到同名文件），此时文件尚不存在
  await attachPersistentSession(first.state, dir, "cron_t1");
  assert.equal(first.state.sessionId, "cron_t1");
  assert.equal(await sessionFileExists(dir, "cron_t1"), false);

  // 落盘一份会话 → 同 id 再接线走续接路径（不抛错、id 保持）
  await saveSession(first.state, dir);
  assert.equal(await sessionFileExists(dir, "cron_t1"), true);
  const second = await assembleSession({ cwd: dir });
  await attachPersistentSession(second.state, dir, "cron_t1");
  assert.equal(second.state.sessionId, "cron_t1");
});
