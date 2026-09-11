/**
 * Cron 模块：任务执行 —— 到点的任务用一次完整的 agent 会话跑完。
 *
 * 为什么不复用 REPL 的活动 Agent：守护模式（cron run）根本没有 REPL；
 * REPL 模式的到点任务走「注入活动会话」路径（见 src/index.ts），那条路
 * 不经过本文件。这里只服务「无头执行」：每个任务一个固定 session id
 * （cron_<jobId>），已有会话文件就整体还原续跑——同一条任务跨 tick
 * 是一段连续对话（微信 bot 续聊同一套机制），监控聊天窗口这类任务
 * 靠它记住上一轮回了什么。
 *
 * 事件收敛复用 ui/print.ts 的 createPrintOutput：拿最终答案 + 错误清单，
 * 进度噪音不进 stdout。
 */

import { Agent } from "../agent/agent.js";
import { loadSessionInto, sessionFileExists, type AgentState } from "../context/index.js";
import { assembleSession } from "../session.js";
import { createPrintOutput } from "../ui/print.js";
import { log } from "../log/index.js";

export interface CronRunResult {
  /** 模型最终输出的正文（可能为空串，配合 errors 判断成败） */
  answer: string;
  warnings: string[];
  errors: string[];
}

/**
 * per-job 持久会话接线：有持久化文件就整体还原续接（含 compact 旧分支）；
 * 没有则预占 id，让 agent_end 后的 saveSession 落到同一个文件——
 * 同一条任务跨 tick 是一段连续对话（与微信 bot 续聊同一套机制）。
 * 导出为纯异步函数便于离线单测（不碰模型）。
 */
export async function attachPersistentSession(state: AgentState, cwd: string, sessionId: string): Promise<void> {
  if (await sessionFileExists(cwd, sessionId)) {
    await loadSessionInto(state, cwd, sessionId);
  } else {
    state.sessionId = sessionId;
  }
}

/** 无头跑一条定时任务提示词。装配失败 / 模型报错都折进 errors，不抛错 */
export async function runJobOnce(opts: { cwd: string; prompt: string; label: string; sessionId?: string }): Promise<CronRunResult> {
  const warnings: string[] = [];
  let state;
  let queue;
  let stream;
  try {
    const assembled = await assembleSession({ cwd: opts.cwd });
    state = assembled.state;
    queue = assembled.queue;
    stream = assembled.resolved.stream;
    if (assembled.resolved.degraded !== undefined) warnings.push(assembled.resolved.degraded);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("cron", `任务 ${opts.label} 会话装配失败`, err instanceof Error ? err : undefined);
    return { answer: "", warnings, errors: [`会话装配失败：${message}`] };
  }

  // per-job 持久会话：续接或预占（细节见 attachPersistentSession）
  if (opts.sessionId !== undefined) {
    await attachPersistentSession(state, opts.cwd, opts.sessionId);
  }

  const sink = createPrintOutput();
  const agent = new Agent({
    state,
    queue,
    stream,
    onEvent: (e) => sink.onEvent(e),
    ...(opts.sessionId !== undefined ? { persistSessions: true } : {}),
  });
  // 前缀让模型知道这是无人值守的自动触发，别反问用户「要继续吗」
  agent.enqueueUser(`[定时任务 ${opts.label}] ${opts.prompt}`);
  await agent.run();

  const result: CronRunResult = { answer: sink.answer, warnings: [...warnings, ...sink.warnings], errors: [...sink.errors] };
  if (result.errors.length > 0) {
    log.error("cron", `任务 ${opts.label} 执行出错：${result.errors.join("; ")}`);
  } else if (result.answer.trim().length === 0) {
    log.warn("cron", `任务 ${opts.label} 没有产生输出`);
  } else {
    log.info("cron", `任务 ${opts.label} 完成（答案 ${result.answer.length} 字符）`);
  }
  return result;
}
