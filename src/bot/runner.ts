/**
 * Bot 运行器（平台无关）：把聊天消息变成 Agent 的一轮对话。
 *
 * 职责边界：
 *  - per-chat 会话隔离：每个 chatId 一套 AssembledSession（state + queue + stream），
 *    会话 id 固定为 bot_<platform>_<sanitized chatId>，落 .control-agent/sessions/，
 *    重启自动续聊（同 CLI --resume 的存储，不另造索引）。
 *  - 同聊天串行、跨聊天并发：per-chat promise 链排队；运行中的新消息走
 *    MessageQueue 的 followUps 通道，由 Agent 外层循环在同一 run 内合并。
 *  - 回复收集：复用 print.ts 的事件收敛（text_delta 拼答案），按长度分块发送。
 *
 * 安全默认（Permission 支柱：聊天窗口是远程输入面，不可信输入直通模型）：
 *  - 默认 answer_only（模型看不到任何工具）；--mode full 显式放开是操作者的决定。
 *  - runner 只做上下文与回复，允许与否的最终闸门在 adapter（如群聊必须 @）。
 */

import { Agent } from "../agent/agent.js";
import { loadSessionInto, sessionFileExists, type AgentState, type MessageQueue } from "../context/index.js";
import type { StreamFn } from "../providers/types.js";
import { assembleSession, type SessionMode } from "../session.js";
import { createPrintOutput } from "../ui/print.js";
import type { BotAdapter, BotIncomingMessage } from "./types.js";

/** 追加到默认系统提示词末尾的 bot 身份说明 */
const BOT_SYSTEM_SUFFIX = `

[模式: 聊天机器人] 你正通过即时聊天软件与人对话：
- 你的回复会被原样发送到聊天窗口：保持简洁、口语化，避免大段 markdown 与表格；
- 群聊消息会带发言者前缀（"名字：内容"），注意区分不同的人；
- 不知道就直说，不要编造。`;

export interface BotRunnerOptions {
  cwd: string;
  /** "openai:gpt-4o-mini" / "mock"；省略走环境变量 → 降级 mock */
  modelSpec?: string;
  /** 默认 answer_only：远程输入面不挂工具，防聊天窗口当遥控器 */
  mode?: SessionMode;
  /** 单条回复消息的最大字符数，超出按换行边界分块。默认 2000 */
  maxReplyChars?: number;
  /** 运行日志出口；默认 console.log */
  log?: (line: string) => void;
}

interface ChatSlot {
  sessionId: string;
  state: AgentState;
  queue: MessageQueue;
  stream: StreamFn;
  /** per-chat 串行链：同一聊天的消息按到达顺序逐条处理 */
  chain: Promise<void>;
}

export class BotRunner {
  private readonly slots = new Map<string, Promise<ChatSlot>>();
  private readonly log: (line: string) => void;
  private readonly mode: SessionMode;
  private readonly maxReplyChars: number;
  private stopped = false;

  constructor(
    private readonly adapter: BotAdapter,
    private readonly opts: BotRunnerOptions,
  ) {
    this.log = opts.log ?? ((line) => console.log(line));
    this.mode = opts.mode ?? "answer_only";
    this.maxReplyChars = opts.maxReplyChars ?? 2_000;
  }

  /** 启动适配器并开始处理消息；resolve 表示平台连接已就绪 */
  async start(): Promise<void> {
    await this.adapter.start((msg) =>
      // 返回 promise 而非丢弃：愿意等的 adapter（如测试）可以 await 到处理完成
      this.dispatch(msg).catch((err) => {
        this.log(`[bot] 处理消息失败：${err instanceof Error ? err.stack : String(err)}`);
      }),
    );
    this.log(
      `[bot] ${this.adapter.platform} bot 已启动（cwd=${this.opts.cwd}，mode=${this.mode}，model=${this.opts.modelSpec ?? "环境变量默认"}）`,
    );
    if (this.mode !== "answer_only") {
      this.log(`[bot] ⚠️ mode=${this.mode}：模型可以调用本机工具（read/write/bash…），聊天窗口里的消息将直接驱动它们`);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.adapter.stop();
  }

  /** 单条入站消息的入口：白名单 → 取/建会话槽 → 排入该聊天的串行链，等本条处理完 */
  async dispatch(msg: BotIncomingMessage): Promise<void> {
    if (this.stopped) return;
    const slot = await this.ensureSlot(msg.chatId);
    const run = slot.chain.then(() => this.process(slot, msg)).catch((err) => {
      this.log(`[bot] ${msg.chatName} 消息处理失败：${err instanceof Error ? err.message : String(err)}`);
    });
    slot.chain = run;
    await run;
  }

  /** 测试可见：某聊天的会话 id（bot_<platform>_<sanitized>） */
  sessionIdFor(chatId: string): string {
    return `bot_${this.adapter.platform}_${sanitizeId(chatId)}`;
  }

  /**
   * 取或建聊天槽。并发首条消息共享同一个组装 Promise（Map 里存 Promise 而非值），
   * 避免同聊天两条消息同时到达时组装两套会话。
   */
  private ensureSlot(chatId: string): Promise<ChatSlot> {
    const existing = this.slots.get(chatId);
    if (existing !== undefined) return existing;
    const created = this.createSlot(chatId);
    this.slots.set(chatId, created);
    return created;
  }

  private async createSlot(chatId: string): Promise<ChatSlot> {
    const sessionId = this.sessionIdFor(chatId);
    const assembled = await assembleSession({
      cwd: this.opts.cwd,
      ...(this.opts.modelSpec !== undefined ? { modelSpec: this.opts.modelSpec } : {}),
      mode: this.mode,
      appendSystemPrompt: BOT_SYSTEM_SUFFIX,
    });
    const { state, queue } = assembled;
    // 会话续聊：已有持久化文件就整体还原（含 compact 旧分支）；没有则预占 id，
    // 让 agent_end 后的 saveSession 落到同一个文件
    if (await sessionFileExists(this.opts.cwd, sessionId)) {
      await loadSessionInto(state, this.opts.cwd, sessionId);
      this.log(`[bot] ${chatId} 续接已有会话 ${sessionId}`);
    } else {
      state.sessionId = sessionId;
    }
    if (assembled.resolved.degraded !== undefined) {
      this.log(`[bot] ${assembled.resolved.degraded}`);
    }
    return { sessionId, state, queue, stream: assembled.resolved.stream, chain: Promise.resolve() };
  }

  /** 串行链里的单条消息处理：入队 → 跑一轮 → 收敛回复 → 分块发送 */
  private async process(slot: ChatSlot, msg: BotIncomingMessage): Promise<void> {
    const output = createPrintOutput();
    const agent = new Agent({
      state: slot.state,
      queue: slot.queue,
      stream: slot.stream,
      onEvent: (event) => {
        void output.onEvent(event);
      },
      persistSessions: true,
    });

    const text = msg.isRoom ? `${msg.senderName}：${msg.text}` : msg.text;
    agent.enqueueUser(text);
    await agent.run();

    const answer = output.answer.trim();
    if (answer.length > 0) {
      for (const part of splitReply(answer, this.maxReplyChars)) {
        await this.adapter.sendText(msg.chatId, part);
      }
      // 模型中途出错但已吐出部分正文：补一条错误说明，别让半截回答装作完整
      if (output.errors.length > 0) {
        const raw = output.errors[0] ?? "未知错误";
        const detail = raw.length > 300 ? `${raw.slice(0, 300)}…` : raw;
        await this.adapter.sendText(msg.chatId, `⚠️ 本轮模型中途出错，回复可能不完整：${detail}`);
      }
      return;
    }
    // 无正文但有报错：把错误摘要发回去，别让消息石沉大海
    if (output.errors.length > 0) {
      await this.adapter.sendText(msg.chatId, `处理出错：${output.errors[0] ?? "未知错误"}`);
    }
  }
}

/**
 * 会话 id 里 chatId 的安全化：只留文件名安全字符。
 * 注意有极小的碰撞可能（不同 chatId 清洗后同串）——v1 接受，doc 里有说明。
 */
export function sanitizeId(chatId: string): string {
  return chatId.replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * 长回复分块：优先在块内的换行处切，整块没有换行才硬切。
 * 空白块丢弃，全空白输入返回空数组（调用方不发）。
 */
export function splitReply(text: string, max: number): string[] {
  if (text.length <= max) return text.trim().length > 0 ? [text] : [];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < Math.floor(max / 2)) cut = max;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest.trim().length > 0) parts.push(rest);
  return parts.filter((p) => p.trim().length > 0);
}
