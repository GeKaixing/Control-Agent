/**
 * 交互式 REPL 循环 —— 把 `src/index.ts` 里内联的 readline 主循环抽到这里。
 *
 * 为什么抽：
 * 1. `src/index.ts` 早期就被 main() + 启动横幅 + 进程退出码 print 捏成一坨，
 *    改了哪段都要重读整块；拆出来后 src/index.ts 只剩组装 / 模式分发两段。
 * 2. **手动式测试**需要用 in-process 跑 REPL —— 真终端下要让一个 PTY 进程
 *    的 stdin/stdout 跟 Node 子进程对上，那要么写 PTY 助手（重）要么绕。
 *    抽出来之后 `LoopInput` 协议对外，把 `FakeInput` 灌进来就能纯 in-process 跑；
 *    真用时仍是 `InputController` 接 `process.stdin`，代码路径不变。
 *
 * 设计细节见各函数 JSDoc。
 */

import type { Agent } from "../agent/agent.js";
import { deleteSession, listSessions, totalUsage } from "../context/index.js";
import type { AgentState, MessageQueue } from "../context/index.js";
import { addCronJob, nextCronRun, readCronJobs, removeCronJob, setCronJobEnabled } from "../cron/index.js";
import type { CronJob } from "../cron/index.js";
import type { ModelRef } from "../types.js";
import type { StreamFn } from "../providers/types.js";
import { setAskUserHandler, type AskUserFn, type AskUserRequest } from "../tools/ask-user.js";
import type { Tool } from "../tools/types.js";
import type { LoopInput } from "./input.js";

// -------------------------------------------------------------- 配置项

export interface ReplOptions {
  agent: Agent;
  state: AgentState;
  queue: MessageQueue;
  /** 所有可注册的工具（含 disabled 的也无所谓，agent 内部会过滤） */
  allTools: readonly Tool[];
  /** 帮助文本：/help 命令打到 output 的内容 */
  helpText: string;
  /**
   * 输入接口。生产环境传 `new InputController()`；测试传 `new FakeInput()`。
   */
  input: LoopInput;
  /**
   * 输出接口。所有用户可见的文本一律走这里：横幅、命令响应、log 等。
   * 不附带换行——调用方自己控制。
   */
  output: (text: string) => void;
  /** /verbose 初始状态 */
  initialVerbose: boolean;
  /** /verbose 翻转时调，把状态同步到 renderer */
  onToggleVerbose: (next: boolean) => void;
  /** /model 命令换供应商时调用——返回 null 表示 spec 不合法 */
  resolveNewModel: (
    spec: string,
  ) => { model: ModelRef; stream: StreamFn; degraded?: string } | null;
  /** /usage 命令的瞬时数据 */
  getUsage: () => { input: number; output: number; total: number };
  /** steering 定时 pump 间隔，ms。默认 120——和原 src/index.ts 一样 */
  steeringPollMs?: number;
}

// -------------------------------------------------------------- ask_user 通道

/**
 * ask_user 工具的 REPL 实现：把问题渲染到 output，借 `LoopInput.ask()` 等
 * 下一行输入作为答案。
 *
 * 为什么能安全借用 ask()：REPL 主循环在 `agent.run()` 期间不持有 ask() 的
 * waiter，而 ask_user 执行时主循环必然停在 `await agent.run()` 上——
 * InputController 单 waiter 语义下不会打架。用户此时敲的行进答案通道
 * 而不是 steering，这正是提问期间的预期行为。
 *
 * 数字快捷回答：用户输入的纯数字若落在选项序号范围内，映射成选项原文
 * 回给模型（模型不需要再猜「2 是什么意思」）。
 * 中断语义：agent abort / EOF → 返回 null，工具侧据此 fail。
 */
export function createReplAskUser(io: { input: LoopInput; output: (text: string) => void }): AskUserFn {
  return async (req: AskUserRequest, ctx): Promise<string | null> => {
    let text = `\n[模型提问] ${req.question}\n`;
    if (req.choices !== undefined && req.choices.length > 0) {
      req.choices.forEach((c, i) => {
        text += `  ${i + 1}. ${c}\n`;
      });
      text += "（输入序号或直接回答，回车提交）\n";
    }
    io.output(text);

    const line = await new Promise<string | null>((resolve) => {
      if (ctx.signal.aborted) {
        resolve(null);
        return;
      }
      const onAbort = (): void => resolve(null);
      ctx.signal.addEventListener("abort", onAbort, { once: true });
      io.input.ask("› ").then((answer) => {
        ctx.signal.removeEventListener("abort", onAbort);
        resolve(answer);
      });
    });

    if (line === null) return null;
    const trimmed = line.trim();
    if (/^\d+$/.test(trimmed) && req.choices !== undefined) {
      const idx = Number(trimmed) - 1;
      const picked = req.choices[idx];
      if (picked !== undefined) return picked;
    }
    return trimmed;
  };
}

// -------------------------------------------------------------- 主循环

/**
 * 跑交互循环直到用户 /exit 或 EOF（Ctrl-D）。
 *
 * 返回值即 CLI 的退出码，0 表示正常退出。
 *
 * 行为细节（与 src/index.ts 原内联版本一致；改动若有，列在这里）：
 * - 空行忽略，继续等
 * - 以 "/" 开头的行被当成命令；不是合法命令时打 "未知命令：/xxx" 提示，继续等
 * - 其他文本走 `agent.enqueueUser` → `agent.run()` → 等完成 → 回到 ask
 * - agent 运行期间通过 setInterval 定时 drainSteering 给 agent.steer()
 *   —— 这一段 setInterval 在 finally 里 clear，避免孤儿 timer
 */
export async function runRepl(opts: ReplOptions): Promise<number> {
  const pollMs = opts.steeringPollMs ?? 120;

  // ask_user 通道：REPL 有交互终端，注入实现；退出时撤下（防止悬挂引用）
  setAskUserHandler(createReplAskUser({ input: opts.input, output: opts.output }));

  // pumping steering：原 src/index.ts 用一个 setInterval 120ms 间隔 drain
  const pump = setInterval(() => {
    if (!opts.agent.isRunning) return;
    for (const text of opts.input.drainSteering()) opts.agent.steer(text);
  }, pollMs);
  pump.unref();

  // 默认 OnSigint：agent 在跑就 abort，否则关 readline 退循环
  // 这里把"现在 verbose 是什么"放到一个闭包变量，handleSlashCommand 反向访问
  const verboseState = { current: opts.initialVerbose };
  // bind 把 opts/verboseState 绑死，省得后面写 opts.verboseState 这种鬼话
  const handle = async (line: string): Promise<SlashResult> =>
    handleSlashCommand(line, opts, verboseState);

  const defaultSigint = (): "abort-agent" | "exit-repl" => {
    if (opts.agent.isRunning) return "abort-agent";
    return "exit-repl";
  };
  opts.input.onSigint(() => {
    const action = defaultSigint();
    if (action === "abort-agent") {
      opts.agent.abort();
      opts.output("\n(已请求中断，正在收尾)\n");
    } else {
      opts.input.close();
    }
  });

  try {
    while (true) {
      const line = await opts.input.ask("› ");
      // EOF：Ctrl-D 引起 readline close，resolve(null)
      if (line === null) return 0;

      const trimmed = line.trim();
      if (trimmed.length === 0) continue;

      if (trimmed.startsWith("/")) {
        const handled = await handle(trimmed);
        if (handled.exit) return handled.code;
        continue;
      }

      opts.agent.enqueueUser(trimmed);
      await opts.agent.run();
    }
  } finally {
    clearInterval(pump);
    opts.input.close();
  }
}

// -------------------------------------------------------------- /xxx 命令

interface SlashResult {
  /** true：REPL 退循环；false：继续 ask */
  exit: boolean;
  /** exit=true 时随带的退出码 */
  code: number;
}

/** 可变 verbose 状态句柄：handleSlashCommand 通过它读/写当前值 */
interface VerboseState {
  current: boolean;
}

/**
 * 处理以 "/" 开头的命令。返回 exit/code。
 *
 * 不在主循环里写 switch 是因为这段在 src/index.ts 已经不小，独立更易看。
 *
 * 注意：`state` / `verboseState` 都是可变状态。`/clear` 会动 messages；
 * `/verbose` 会动 verboseState 并通过 `opts.onToggleVerbose` 通知 renderer。
 * 跨次调用不能 clone state——它们必须共享同一份。
 */
async function handleSlashCommand(
  line: string,
  opts: ReplOptions,
  verboseState: VerboseState,
): Promise<SlashResult> {
  const [command, ...rest] = line.slice(1).split(/\s+/);
  const argument = rest.join(" ").trim();

  switch (command) {
    case "exit":
    case "quit":
      return { exit: true, code: 0 };

    case "help":
      opts.output(`${opts.helpText}\n`);
      return { exit: false, code: 0 };

    case "tools":
      for (const t of opts.allTools) {
        opts.output(`  ${t.name} — ${t.description}\n`);
      }
      return { exit: false, code: 0 };

    case "usage": {
      const u = opts.getUsage();
      opts.output(`  input ${u.input} / output ${u.output} / 合计 ${u.total}\n`);
      return { exit: false, code: 0 };
    }

    case "clear":
      // 注意：仅清线性视图，nodes / currentNodeId / rootId 不动 —— 这是 src/index.ts 的原行为。
      // 树状 session 下 /clear 有 bug（见 MEMORY.md "tree / /clear bug"），这里只是忠实迁移。
      opts.state.messages.length = 0;
      opts.output("  对话历史已清空\n");
      return { exit: false, code: 0 };

    case "compact": {
      // 模型生成摘要 → 新 Root 分支（旧分支保留可回溯）。失败时 agent 内部发 notice。
      opts.output("  正在把对话历史压缩成摘要…\n");
      const done = await opts.agent.compact();
      if (done) {
        opts.output("  已压缩：后续对话以摘要为上下文，需要细节时重新查看文件即可\n");
      }
      return { exit: false, code: 0 };
    }

    case "sessions": {
      // 子命令：/sessions 列清单；/sessions rm <id> 删除（id 支持前缀唯一匹配）
      const sub = argument.split(/\s+/)[0]?.toLowerCase() ?? "";
      if (sub === "rm" || sub === "del" || sub === "delete") {
        const target = argument.slice(sub.length).trim();
        if (target.length === 0) {
          opts.output("  用法：/sessions rm <id>（id 可只写前缀，/sessions 查看清单）\n");
          return { exit: false, code: 0 };
        }
        // 当前会话正在被自动保存：删了下轮也会重建，直接拒绝并说明
        if (target === opts.state.sessionId) {
          opts.output("  拒绝删除：这是当前正在使用的会话（每轮结束自动保存，删了也会重建）。\n");
          return { exit: false, code: 0 };
        }
        const sessions = await listSessions(opts.state.cwd);
        const matches = sessions.filter((s) => s.id.startsWith(target));
        if (matches.length === 0) {
          opts.output(`  没有匹配的会话：${target}\n`);
          return { exit: false, code: 0 };
        }
        if (matches.length > 1) {
          opts.output(`  前缀不唯一（${matches.length} 个匹配），请写更长的 id：\n`);
          for (const s of matches) opts.output(`  ${s.id}\n`);
          return { exit: false, code: 0 };
        }
        const victim = matches[0];
        if (victim === undefined) return { exit: false, code: 0 };
        if (victim.id === opts.state.sessionId) {
          opts.output("  拒绝删除：这是当前正在使用的会话（每轮结束自动保存，删了也会重建）。\n");
          return { exit: false, code: 0 };
        }
        const when = new Date(victim.savedAt).toLocaleString("zh-CN", { hour12: false });
        const okDel = await deleteSession(opts.state.cwd, victim.id);
        opts.output(
          okDel
            ? `  已删除会话 ${victim.id}（${when}，${victim.nodeCount} 节点）\n`
            : `  删除失败：${victim.id}（文件不存在或无法删除）\n`,
        );
        return { exit: false, code: 0 };
      }

      // 会话持久化清单（恢复走 CLI 的 --resume [id]）
      const sessions = await listSessions(opts.state.cwd);
      if (sessions.length === 0) {
        opts.output("  （还没有已持久化的会话；交互模式每轮结束自动保存）\n");
        return { exit: false, code: 0 };
      }
      opts.output(`  共 ${sessions.length} 个会话（新的在前，恢复用 --resume <id>）：\n`);
      for (const s of sessions.slice(0, 10)) {
        const current = s.id === opts.state.sessionId ? "  ← 当前" : "";
        const when = new Date(s.savedAt).toLocaleString("zh-CN", { hour12: false });
        opts.output(`  ${s.id}  ${when}  ${s.nodeCount} 节点${current}\n`);
      }
      return { exit: false, code: 0 };
    }

    case "cron": {
      // 定时任务管理：/cron [list] | /cron add <expr 5 段> <提示词...> | /cron rm|on|off <id>
      // 表达式按空格分段取前 5 个 token——REPL 里不支持引号包裹（与 CLI 的 add 不同），
      // 换来的代价是提示词里出现 "0 9 * * *" 这类内容时必须走 CLI 或调整写法。
      const toks = argument.split(/\s+/).filter((t) => t.length > 0);
      const sub = toks[0]?.toLowerCase() ?? "list";
      const cwd = opts.state.cwd;

      if (sub === "list" || sub === "ls") {
        const jobs = await readCronJobs(cwd);
        if (jobs.length === 0) {
          opts.output("  （还没有定时任务）\n");
          return { exit: false, code: 0 };
        }
        opts.output(`  共 ${jobs.length} 个任务：\n`);
        for (const j of jobs) {
          opts.output(`  ${j.id}  ${j.expr}${j.enabled ? "" : "（已停用）"}\n`);
          const nextMs = j.enabled
            ? j.nextRunAt ?? nextCronRun(j.expr, new Date())?.getTime() ?? null
            : null;
          const next = j.enabled
            ? nextMs === null
              ? "无（表达式无解）"
              : new Date(nextMs).toLocaleString("zh-CN", { hour12: false })
            : "已停用";
          opts.output(`    下次：${next}｜${j.prompt.replace(/\s+/g, " ").slice(0, 50)}\n`);
        }
        return { exit: false, code: 0 };
      }

      if (sub === "add") {
        const expr = toks.slice(1, 6).join(" ");
        const prompt = toks.slice(6).join(" ");
        const job = await addCronJob(cwd, expr, prompt);
        if (job === null) {
          opts.output(
            "  添加失败：表达式非法或提示词为空。\n  用法：/cron add 0 9 * * * 写日报（5 字段表达式 + 提示词）\n",
          );
          return { exit: false, code: 0 };
        }
        const next = job.nextRunAt === null ? "无" : new Date(job.nextRunAt).toLocaleString("zh-CN", { hour12: false });
        opts.output(`  已添加 ${job.id}，下次执行：${next}\n`);
        return { exit: false, code: 0 };
      }

      if (sub === "rm" || sub === "del" || sub === "on" || sub === "off") {
        const prefix = toks[1] ?? "";
        if (prefix.length === 0) {
          opts.output(`  用法：/cron ${sub} <id>（id 可只写前缀，/cron 查看清单）\n`);
          return { exit: false, code: 0 };
        }
        const jobs = await readCronJobs(cwd);
        const matches = jobs.filter((j) => j.id.startsWith(prefix));
        if (matches.length === 0) {
          opts.output(`  没有匹配的任务：${prefix}\n`);
          return { exit: false, code: 0 };
        }
        if (matches.length > 1) {
          opts.output(`  前缀不唯一（${matches.length} 个匹配），请写更长的 id：\n`);
          for (const m of matches) opts.output(`  ${m.id}\n`);
          return { exit: false, code: 0 };
        }
        const target: CronJob = matches[0]!;
        if (sub === "rm" || sub === "del") {
          const okDel = await removeCronJob(cwd, target.id);
          opts.output(okDel ? `  已删除任务 ${target.id}\n` : `  删除失败：${target.id}\n`);
        } else {
          const updated = await setCronJobEnabled(cwd, target.id, sub === "on");
          if (updated === null) {
            opts.output(`  任务不存在：${target.id}\n`);
          } else {
            const next = updated.nextRunAt === null ? "无" : new Date(updated.nextRunAt).toLocaleString("zh-CN", { hour12: false });
            opts.output(updated.enabled ? `  已启用 ${updated.id}，下次执行：${next}\n` : `  已停用 ${updated.id}\n`);
          }
        }
        return { exit: false, code: 0 };
      }

      opts.output(
        "  用法：/cron [list]｜/cron add <expr> <提示词>｜/cron rm <id>｜/cron on|off <id>\n",
      );
      return { exit: false, code: 0 };
    }

    case "verbose": {
      verboseState.current = !verboseState.current;
      opts.onToggleVerbose(verboseState.current);
      opts.output(`  思考过程显示：${verboseState.current ? "开" : "关"}\n`);
      return { exit: false, code: 0 };
    }

    case "model":
      if (argument.length === 0) {
        opts.output(`  当前模型：${opts.state.model.provider}:${opts.state.model.id}\n`);
        return { exit: false, code: 0 };
      }
      {
        const resolved = opts.resolveNewModel(argument);
        if (resolved === null) {
          opts.output(`  无法解析模型：${argument}\n`);
          return { exit: false, code: 0 };
        }
        opts.agent.setModel(resolved.model, resolved.stream);
        opts.output(`  已切换到 ${resolved.model.provider}:${resolved.model.id}\n`);
        if (resolved.degraded !== undefined) {
          opts.output(`  提示：${resolved.degraded}\n`);
        }
      }
      return { exit: false, code: 0 };

    default:
      opts.output(`  未知命令：/${command}，输入 /help 查看可用命令\n`);
      return { exit: false, code: 0 };
  }
}

/**
 * 把 token 累计凑齐一回打印。/usage 命令用到。
 *
 * 单独抽出是因为 src/index.ts:266 那一行 `const u = totalUsage(state)` 的写法也
 * 可以搬进来；不过保留 `getUsage` 注入也方便测试模拟用量——所以通过回调拿。
 */
export function usageSnapshot(state: AgentState): { input: number; output: number; total: number } {
  const u = totalUsage(state);
  return { input: u.input, output: u.output, total: u.total };
}
