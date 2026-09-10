/**
 * Cron 模块：CLI 子命令（`npm start -- cron ...`）。
 *
 * 职责只有两件：管理任务清单（list/add/rm/on/off）与前台守护（run）。
 * REPL 侧的 /cron 命令（src/ui/repl.ts）直接调 store，不走这里——
 * 两处共用的是 store 与 scheduler，命令解析各写各的（参数形态不同：
 * CLI 的 add 支持引号包裹，REPL 走空格分段）。
 *
 * 退出码沿用 CLI 约定：0 成功，2 用法错误，1 执行出错。
 */

import { renderMarkdown } from "../ui/markdown.js";
import { log } from "../log/index.js";
import { nextCronRun } from "./parser.js";
import {
  addCronJob,
  readCronJobs,
  removeCronJob,
  setCronJobEnabled,
  type CronJob,
} from "./store.js";
import { CronScheduler } from "./scheduler.js";
import { runJobOnce } from "./runner.js";

const CRON_USAGE = [
  "用法：npm start -- cron <子命令>",
  "  cron list                     列出定时任务",
  "  cron add \"<expr>\" \"<prompt>\"  新增（5 字段 cron 表达式，建议引号包裹）",
  "  cron rm <id>                  删除（id 可只写前缀）",
  "  cron on <id> / cron off <id>  启用 / 停用（重新启用从现在起算下一次）",
  "  cron run                      前台守护：到点自动执行，Ctrl-C 退出",
  "示例：npm start -- cron add \"0 9 * * *\" \"汇总昨天的 git log 写一份日报\"",
].join("\n");

function formatWhen(ms: number | null): string {
  if (ms === null) return "无（表达式无解）";
  return new Date(ms).toLocaleString("zh-CN", { hour12: false });
}

function preview(s: string, max = 40): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function printJob(job: CronJob): void {
  const next = job.enabled ? formatWhen(job.nextRunAt ?? nextCronRun(job.expr, new Date())?.getTime() ?? null) : "已停用";
  const last = job.lastRunAt === null ? "从未" : formatWhen(job.lastRunAt);
  console.log(`  ${job.id}  ${job.expr}`);
  console.log(`    启用：${job.enabled ? "是" : "否"}｜上次：${last}｜下次：${next}`);
  console.log(`    ${preview(job.prompt)}`);
}

/** id 前缀唯一匹配（与 /sessions rm 同款交互）；无匹配 / 多匹配返回 null 并打提示 */
async function resolveJobId(cwd: string, prefix: string): Promise<string | null> {
  const jobs = await readCronJobs(cwd);
  const matches = jobs.filter((j) => j.id.startsWith(prefix));
  if (matches.length === 0) {
    console.error(`没有匹配的任务：${prefix}（cron list 查看清单）`);
    return null;
  }
  if (matches.length > 1) {
    console.error(`前缀不唯一（${matches.length} 个匹配），请写更长的 id：`);
    for (const j of matches) console.error(`  ${j.id}`);
    return null;
  }
  return matches[0]!.id;
}

/** 前台守护：到点任务无头执行，答案与错误直接写终端。永不正常返回（Ctrl-C 退出） */
async function runCronDaemon(cwd: string): Promise<number> {
  const jobs = (await readCronJobs(cwd)).filter((j) => j.enabled);
  console.log(`定时任务守护已启动：${jobs.length} 个启用中（.c-agent/cron/jobs.json），Ctrl-C 退出。`);
  if (jobs.length === 0) console.log("提示：还没有启用的任务，用 cron add 添加。");

  let busy = false;
  const scheduler = new CronScheduler({
    cwd,
    isBusy: () => busy,
    onDue: async (job) => {
      busy = true;
      try {
        const at = new Date().toLocaleString("zh-CN", { hour12: false });
        console.log(`\n[${at}] 定时任务 ${job.id} 触发：${preview(job.prompt)}`);
        const result = await runJobOnce({ cwd, prompt: job.prompt, label: job.id });
        if (result.answer.trim().length > 0) {
          const markdown = process.stdout.isTTY === true;
          process.stdout.write(`${renderMarkdown(result.answer.trim(), { enabled: markdown })}\n`);
        }
        for (const w of result.warnings) console.error(`提示：${w}`);
        for (const e of result.errors) console.error(`错误：${e}`);
      } finally {
        busy = false;
      }
    },
  });
  scheduler.start();
  // 调度 interval unref 了，进程靠这个常驻 promise 吊住；Ctrl-C 走默认退出
  await new Promise<never>(() => {});
  return 0;
}

/** cron 子命令入口。argv 是 "cron" 之后的参数（如 ["add", "0 9 * * *", "写日报"]） */
export async function handleCronCommand(cwd: string, argv: string[]): Promise<number> {
  const sub = argv[0]?.toLowerCase() ?? "list";

  if (sub === "list") {
    const jobs = await readCronJobs(cwd);
    if (jobs.length === 0) {
      console.log("（还没有定时任务）");
      return 0;
    }
    console.log(`共 ${jobs.length} 个任务：`);
    for (const j of jobs) printJob(j);
    return 0;
  }

  if (sub === "add") {
    const rest = argv.slice(1);
    // 形态一：字面引号包裹 `cron add "0 9 * * *" "提示词"`（引号留在 argv 里的场景）
    const joined = rest.join(" ");
    const quoted = joined.match(/^"([^"]*)"\s+"([^"]*)"$/) ?? joined.match(/^'([^']*)'\s+'([^']*)'$/);
    let expr: string;
    let prompt: string;
    if (quoted !== null) {
      expr = quoted[1] ?? "";
      prompt = quoted[2] ?? "";
    } else {
      // 形态二：按空格试探前缀。bash 里带引号的表达式整体是一个 argv 元素，
      // 不带引号时是 5 个独立 token——从短到长找第一个「合法表达式 + 非空提示词」
      // 的切分点（5 字段表达式不存在更短/更长的合法前缀，切分无歧义）。
      expr = "";
      prompt = "";
      for (let i = 1; i <= rest.length; i++) {
        const candidate = rest.slice(0, i).join(" ");
        const tail = rest.slice(i).join(" ");
        if (nextCronRun(candidate, new Date()) !== null && tail.trim().length > 0) {
          expr = candidate;
          prompt = tail;
          break;
        }
      }
    }
    const job = await addCronJob(cwd, expr, prompt);
    if (job === null) {
      console.error("错误：cron 表达式非法或提示词为空。");
      console.error('示例：npm start -- cron add "0 9 * * *" "写日报"');
      return 2;
    }
    console.log(`已添加任务 ${job.id}，下次执行：${formatWhen(job.nextRunAt)}`);
    log.info("cron", `新增任务 ${job.id}：${job.expr} -> ${job.prompt}`);
    return 0;
  }

  if (sub === "rm" || sub === "del" || sub === "delete") {
    const prefix = argv[1] ?? "";
    if (prefix.length === 0) {
      console.error("用法：cron rm <id>（id 可只写前缀，cron list 查看清单）");
      return 2;
    }
    const id = await resolveJobId(cwd, prefix);
    if (id === null) return 1;
    const ok = await removeCronJob(cwd, id);
    console.log(ok ? `已删除任务 ${id}` : `删除失败：${id}`);
    return ok ? 0 : 1;
  }

  if (sub === "on" || sub === "off") {
    const prefix = argv[1] ?? "";
    if (prefix.length === 0) {
      console.error(`用法：cron ${sub} <id>`);
      return 2;
    }
    const id = await resolveJobId(cwd, prefix);
    if (id === null) return 1;
    const job = await setCronJobEnabled(cwd, id, sub === "on");
    if (job === null) {
      console.error(`任务不存在：${id}`);
      return 1;
    }
    console.log(
      job.enabled
        ? `已启用 ${job.id}，下次执行：${formatWhen(job.nextRunAt)}`
        : `已停用 ${job.id}`,
    );
    return 0;
  }

  if (sub === "run") {
    return runCronDaemon(cwd);
  }

  console.error(`未知子命令：cron ${sub}`);
  console.error(CRON_USAGE);
  return 2;
}
