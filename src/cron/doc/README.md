# cron/ — 定时任务

让 agent 在指定时刻自动执行提示词。零 npm 依赖：5 字段 cron 解析与调度循环都是本目录自实现（运行时依赖只有 Node 内置模块）。

## 文件

- `parser.ts` — `parseCron`（5 字段表达式 → 布尔查找表）/ `nextCronRun`（严格「之后」的下一次触发时刻，按天跳跃避免逐分钟扫描）。dom/dow 都被显式约束时取**或**（POSIX cron 语义）。
- `store.ts` — `.control-agent/cron/jobs.json` 持久化。原子写（tmp + rename）、版本字段、坏文件静默回退 `[]`，与 `context/sessions.ts` 同一套纪律。`nextRunAt` 落盘保证同一分钟内重启不重复触发。
- `scheduler.ts` — `CronScheduler` 轮询触发（默认 30s 一查，interval `unref`）。**补跑语义**：停机期间错过的时点下个 tick 补跑一次然后跳到未来，不逐个补齐。串行 `await onDue` + `ticking` 标志 + `isBusy` 回调三层防并发。
- `runner.ts` — `runJobOnce`：无头执行一条任务（`assembleSession` 临时会话，跑完即弃，不持久化会话树），事件收敛复用 `ui/print.ts`。
- `cli.ts` — `npm start -- cron list|add|rm|on|off|run` 子命令；`cron run` 是前台守护（Ctrl-C 退出）。
- `index.ts` — 统一出口；`cli.ts` 不进出口（避免 REPL 引出口时连带 stdout 渲染）。

## 两条执行路径

1. **REPL 注入**（`src/index.ts`）：REPL 启动时创建常驻调度器；到点任务以 `[定时任务] <prompt>` 作为 user 消息注入**当前活动会话**，输出直接进终端。`agent.isRunning` 或上一个定时任务未跑完时延迟到下个 tick。
2. **前台守护**（`cron run`）：无终端交互，每个到点任务走 `runJobOnce` 独立无头会话，答案写 stdout、诊断写 stderr。

## 边界（刻意不做）

- 不支持秒级与月份/星期英文名（5 字段、数字值已覆盖真实需求）。
- 不做时区字段（跟随本地时区）。
- 调度器不管进程死活：interval `unref`，守护模式由 `cron run` 自己常驻；进程退了任务就停，长期无人值守应交给系统级 cron/pm2 拉起 `cron run`。
- **Permission**：到点任务无人值守执行，工具调用没有审批门（CLI 本就不接 `approvalGate`）。任务清单写在项目内 `.control-agent/cron/jobs.json`，谁能写它谁就能安排自动执行——这是 Environment 层的边界，不在本模块补课。
