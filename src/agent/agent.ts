/**
 * 代理循环：外层循环负责一轮又一轮的任务，内层循环负责当前任务里
 * 「大模型 ↔ 工具」的多轮往返。与流程图一一对应。
 */

import type { StreamEvent, StreamFn, StreamOptions } from "../providers/types.js";
import { describeToolsForModel, type Tool, type ToolName, type ToolResult } from "../tools/index.js";
import { fail } from "../tools/types.js";
import { truncateText } from "../tools/fs-utils.js";
import { validateParams } from "../tools/validate.js";
import type {
  AssistantMessage,
  ModelRef,
  ThinkingLevel,
  ToolCallContent,
  ToolResultMessage,
  UserMessage,
} from "../types.js";
import { assistantText, assistantToolCalls, emptyUsage } from "../types.js";
import {
  addNodeAt,
  appendNode,
  calibrateCharsPerToken,
  currentNode,
  defaultTransformOptions,
  maxContextTokensFor,
  messageChars,
  MessageQueue,
  saveSession,
  shouldAutoCompact,
  transformContext,
  type AgentState,
  type TransformOptions,
} from "../context/index.js";
import { convertToLlm } from "./convert.js";
import { log } from "../log/index.js";

export type AgentEvent =
  | { type: "agent_start" }
  | { type: "turn_start"; pendingFollowUps: number }
  | { type: "steering"; texts: string[] }
  | { type: "stream"; event: StreamEvent }
  | { type: "tool_start"; toolCall: ToolCallContent; parallel: boolean }
  | {
      type: "tool_end";
      toolCall: ToolCallContent;
      result: ToolResult;
      durationMs: number;
    }
  | { type: "turn_end"; message: AssistantMessage }
  | { type: "context_pruned"; droppedMessages: number; prunedToolResults: number }
  | { type: "context_compact"; summaryChars: number; replacedMessages: number }
  | { type: "notice"; message: string }
  | { type: "agent_end"; toolRounds: number };

export interface AgentOptions {
  state: AgentState;
  queue?: MessageQueue;
  stream: StreamFn;
  /**
   * 事件回调。可以是 async：Agent 会 `await`，这样 `SessionManager` 这一层
   * 可以在 stream 事件流里插入"暂停门"——一停下，agent 整体就停了，token
   * 不会再被消费。这就是「下个 token 前暂停」语义。
   */
  onEvent?: (event: AgentEvent) => void | Promise<void>;
  transform?: Partial<TransformOptions>;
  /** 内层循环的工具往返上限，防止死循环 */
  maxToolRounds?: number;
  /** 多个只读工具是否并行执行 */
  allowParallelTools?: boolean;
  /** 黑名单：被禁用的工具即使注册了，模型调用时也会返回错误 */
  disabledTools?: ToolName[];
  /** 单次工具返回结果的最大字符数；超出按头/尾截断。默认 50000 */
  maxToolResultChars?: number;
  /**
   * 模型流失败（reason=error 的 error 事件 / 抛异常）后的自动重试次数。
   * abort / 用户中断不重试。默认 1；0 关闭。
   */
  maxStreamRetries?: number;
  /**
   * 动态推理强度开关（Model 支柱）：连续工具失败升档、成功回落。
   * 默认开启；固定推理档的调用方（桌面端 fast/balanced/ultra）传 false 关掉，
   * 只有「auto」档（或 CLI 这种没有档位选择器的场景）让它生效。
   */
  dynamicThinking?: boolean;
  /**
   * 自动 compact（Context 支柱）：内层循环每轮开跑前，若上下文越过迟滞触发线
   * （与 trimToBudget 同一套预算数学），先让模型把历史摘要成新 Root 再继续，
   * 抢在机械裁剪（丢整轮）之前——摘要保得住要点，丢轮次做不到。compact 失败
   * 自动落回机械裁剪，本次 run 内不再重试（每次失败也是真金白银的模型调用）。
   * 默认开启；false 关闭（手动 /compact 与机械裁剪不受影响）。
   */
  autoCompact?: boolean;
  /**
   * 会话持久化（Context 支柱）：每次 run() 结束（agent_end）后把会话树整体
   * 落盘到 .c-agent/sessions/<id>.json，--resume 可整体还原（含 compact 旧分支）。
   * 默认关闭；CLI 交互模式开启，print 单轮与桌面端自行决定。
   */
  persistSessions?: boolean;
  /**
   * 审批门（Permission 支柱）：mutating 工具（write/edit/bash/…）执行前调用，
   * 返回 false 拒绝本次调用（结果以 isError 回给模型）。只读工具不经过审批。
   * undefined = 全部放行。门自身抛异常按拒绝处理，并发 notice 告知。
   */
  approvalGate?: (req: {
    toolName: string;
    arguments: Record<string, unknown>;
  }) => boolean | Promise<boolean>;
}

const DEFAULT_MAX_TOOL_RESULT_CHARS = 50_000;
/** 流失败重试的退避基值：第 n 次重试前等 BASE * 2^(n-1) ms */
const STREAM_RETRY_BASE_MS = 200;

const STEERING_PREFIX = "[中途插入指令] ";
const MAX_REPEATED_FAILURES = 3;
/** 连续工具失败达到该次数后，推理强度升一档重试 */
const THINKING_ESCALATE_AFTER = 2;
/** ThinkingLevel 升降阶梯（off 在最底端：用户显式关闭时不参与动态调整） */
const THINKING_LADDER: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];

/**
 * Context 超限降档系数：模型报上下文超限时，把 maxContextTokens 按此比例缩小
 * 重裁重试一次。只降一档——再超限就把错误落树返回，防止反复震荡白烧 token。
 */
const CONTEXT_OVERFLOW_SHRINK = 0.6;

/**
 * 各家 provider 的上下文超限报错特征（openai "context_length_exceeded..." /
 * anthropic "prompt is too long" / gemini "exceeds the maximum number of tokens" /
 * 各兼容端点的变体）。宁可漏判不可误判：误判会把普通错误当超限白跑一次重试。
 */
const CONTEXT_OVERFLOW_PATTERN =
  /context[-_ ]?(length|window)|maximum context|max context|prompt is too long|too many tokens|reduce the length|input length and .max_tokens|exceeds the maximum number of tokens/i;

/** 是否为上下文超限类错误（供 Context 支柱的失败驱动降档判定） */
export function isContextOverflowError(errorMessage?: string): boolean {
  if (errorMessage === undefined || errorMessage.length === 0) return false;
  return CONTEXT_OVERFLOW_PATTERN.test(errorMessage);
}

const COMPACT_INSTRUCTION = [
  "请把上面的对话历史压缩成一份摘要，它将成为后续对话的唯一上下文。必须保留：",
  "1. 用户的核心目标与最新指令；",
  "2. 已完成的关键步骤与结论；",
  "3. 涉及的文件路径、分支、命令与重要数据；",
  "4. 未完成的事项、遗留问题与注意事项。",
  "直接输出摘要正文，不要开场白和客套。",
].join("\n");

const COMPACT_HEADER =
  "[前文对话摘要。原始历史已压缩，需要细节时重新查看文件或重新执行命令]";

interface Outcome {
  call: ToolCallContent;
  result: ToolResult;
  /** true = 用户中途插话被打断，没真正执行（不参与失败计数与推理升降档） */
  skipped?: boolean;
}

export class Agent {
  readonly state: AgentState;
  readonly queue: MessageQueue;
  private stream: StreamFn;
  private readonly onEvent: ((event: AgentEvent) => void) | undefined;
  private readonly transformOptions: Partial<TransformOptions> | undefined;
  private readonly maxToolRounds: number;
  private readonly allowParallelTools: boolean;
  private readonly controller = new AbortController();
  private running = false;
  private toolRounds = 0;
  private readonly failureCounts = new Map<string, number>();
  private readonly disabledTools: Set<string>;
  private readonly maxToolResultChars: number;
  private readonly maxStreamRetries: number;
  private readonly approvalGate: AgentOptions["approvalGate"];
  /**
   * 动态推理强度（Model 支柱）：不问模型、由客观信号驱动。
   * base 取用户配置的 state.thinkingLevel（"off" 表示用户明确关闭，不参与升降）；
   * 连续工具失败达到阈值升一档，任一工具成功即回落。state.thinkingLevel 本身不动。
   */
  private readonly baseThinkingLevel: ThinkingLevel;
  private currentThinkingLevel: ThinkingLevel;
  private thinkingFailureStreak = 0;
  private readonly dynamicThinking: boolean;
  /** 自动 compact 开关（设置弹窗可运行时切换）；autoCompactBlocked = 本次 run 内已失败/超线，不再重试 */
  private autoCompact: boolean;
  private autoCompactBlocked = false;
  private readonly persistSessions: boolean;
  /** state.tools 按引用缓存 name → Tool 索引；换工具表时自动重建 */
  private toolIndex: { tools: Tool[]; map: Map<string, Tool> } | undefined;

  constructor(options: AgentOptions) {
    this.state = options.state;
    this.queue = options.queue ?? new MessageQueue();
    this.stream = options.stream;
    this.onEvent = options.onEvent;
    this.transformOptions = options.transform;
    this.maxToolRounds = options.maxToolRounds ?? 50;
    this.allowParallelTools = options.allowParallelTools ?? true;
    this.disabledTools = new Set(options.disabledTools ?? []);
    this.maxToolResultChars = options.maxToolResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS;
    this.maxStreamRetries = options.maxStreamRetries ?? 1;
    this.approvalGate = options.approvalGate;
    this.dynamicThinking = options.dynamicThinking ?? true;
    this.autoCompact = options.autoCompact ?? true;
    this.persistSessions = options.persistSessions ?? false;
    this.baseThinkingLevel = options.state.thinkingLevel;
    this.currentThinkingLevel = options.state.thinkingLevel;
  }

  /**
   * 运行时开关自动 compact（设置弹窗）。对正在跑的 Agent 立即生效；
   * 重新打开时清掉 blocked 标记，让 compact 恢复尝试。
   */
  setAutoCompact(on: boolean): void {
    this.autoCompact = on;
    if (on) this.autoCompactBlocked = false;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** 用户新的一轮请求 → 进入后续指令队列（可携带图片附件，多模态） */
  enqueueUser(text: string, images?: { dataUrl: string }[]): void {
    this.queue.enqueueFollowUp(text, images);
  }

  /** 代理运行期间插入的指令 → 进入中途插入队列 */
  steer(text: string): void {
    this.queue.enqueueSteering(text);
  }

  /** 运行时切换模型：同时更新状态里的 ModelRef 与对应的 StreamFn */
  setModel(model: ModelRef, stream: StreamFn): void {
    this.state.model = model;
    this.stream = stream;
  }

  abort(reason = "用户中断"): void {
    if (!this.controller.signal.aborted) {
      this.controller.abort(new Error(reason));
    }
  }

  /**
   * 压缩对话历史（Context 支柱的 compact）：把当前活跃分支整体交给模型做摘要，
   * 摘要作为**新 Root 节点**写回会话树、★ 切过去——旧分支原样保留在树里，
   * 可回溯。这是扁平数组要做搬运才能实现的事，树结构天然支持。
   *
   * 消失之问检查：摘要这个智力活由模型自己做，harness 只负责触发、拼指令、
   * 把摘要写回树。摘要请求走的是 transformContext 之后的可见上下文
   * （历史本身快满时，只能压缩模型看得见的那部分）。
   *
   * 触发有两条路：REPL 的 /compact 手动调用（入口在下面这个公开方法），
   * 以及内层循环检测到上下文越线后的自动触发（runInnerLoop → doCompact）。
   *
   * @returns true = 压缩成功；false = 无历史 / 摘要调用失败（已发 notice）
   */
  async compact(): Promise<boolean> {
    if (this.running) {
      await this.emit({ type: "notice", message: "代理运行中，等本轮结束后再压缩" });
      return false;
    }
    return this.doCompact();
  }

  /** compact 内部实现：不做 running 检查（自动触发在内层循环里跑，天然互斥） */
  private async doCompact(): Promise<boolean> {
    const ctx = transformContext(this.state, this.contextTransform());
    if (ctx.messages.length === 0) return false;
    const replacedMessages = ctx.messages.length;

    const instruction: UserMessage = {
      role: "user",
      content: COMPACT_INSTRUCTION,
      timestamp: Date.now(),
    };
    const assistant = await this.callModel([], convertToLlm([...ctx.messages, instruction]));

    if (assistant.stopReason === "error") {
      await this.emit({
        type: "notice",
        message: `压缩失败：${assistant.errorMessage ?? "未知错误"}（对话历史未改动）`,
      });
      return false;
    }

    const summary = assistantText(assistant).trim();
    if (summary.length === 0) {
      await this.emit({ type: "notice", message: "压缩失败：模型返回了空摘要（对话历史未改动）" });
      return false;
    }

    // 新 Root：parent 为 null → rootId / ★ / messages 线性视图全部切到摘要节点，
    // 旧分支的节点仍留在 state.nodes 里（switchTo 可回）。
    addNodeAt(this.state, null, {
      role: "user",
      content: `${COMPACT_HEADER}\n\n${summary}`,
      timestamp: Date.now(),
    });
    await this.emit({
      type: "context_compact",
      summaryChars: summary.length,
      replacedMessages,
    });
    return true;
  }

  /**
   * 外层循环：取后续指令 → 跑内层循环 → 还有后续指令就再来一轮，否则结束。
   */
  async run(): Promise<void> {
    if (this.running) throw new Error("代理正在运行中，请勿重复调用 run()");
    this.running = true;
    log.debug(
      "agent",
      `run 开始 model=${this.state.model.provider}:${this.state.model.id} thinking=${this.currentThinkingLevel}`,
    );
    this.toolRounds = 0;
    this.failureCounts.clear();
    this.autoCompactBlocked = false;
    // 推理强度复位到用户配置的基准档（上一次 run 可能升过档）
    this.currentThinkingLevel = this.baseThinkingLevel;
    this.thinkingFailureStreak = 0;
    await this.emit({ type: "agent_start" });

    try {
      while (!this.controller.signal.aborted) {
        const followUps = this.queue.drainFollowUps();
        for (const fu of followUps) this.pushUser(fu.text, fu.images);

        if (!this.hasPendingWork()) break;

        await this.emit({ type: "turn_start", pendingFollowUps: followUps.length });
        await this.runInnerLoop();

        // 中断交给 while 条件收口；没有新 followUps 就结束
        if (!this.queue.hasFollowUps()) break;
      }
    } finally {
      this.running = false;
      log.debug("agent", `run 结束 toolRounds=${this.toolRounds}`);
      await this.emit({ type: "agent_end", toolRounds: this.toolRounds });
      // 会话持久化：agent_end 之后落盘（emit 先行，UI 不用等磁盘）。
      // 失败只 notice 不抛——持久化是增强，不能让对话本身跟着失败。
      if (this.persistSessions) {
        try {
          await saveSession(this.state, this.state.cwd);
        } catch (err) {
          log.error("agent", `会话持久化失败 session=${this.state.sessionId ?? "?"}`, err);
          await this.emit({
            type: "notice",
            message: `会话持久化失败：${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    }
  }

  /**
   * 内层循环：中途指令 → transformContext → convertToLlm → StreamFn
   * → 有工具调用就执行并把结果写回消息记录 → 再进入下一轮。
   */
  private async runInnerLoop(): Promise<void> {
    // Context 超限降档：1 = 未触发；触发后按比例缩 maxContextTokens 重试一次
    let overflowShrink = 1;
    while (!this.controller.signal.aborted) {
      // 中途插入的指令
      const steering = this.queue.drainSteering();
      if (steering.length > 0) {
        for (const text of steering) this.pushUser(`${STEERING_PREFIX}${text}`);
        await this.emit({ type: "steering", texts: steering });
      }

      // 自动 compact（Context 支柱）：上下文越过迟滞触发线时，先让模型把历史
      // 摘要成新 Root，抢在 transformContext 的机械裁剪（丢整轮）之前——
      // 同一条触发线，摘要先走；失败自动落回机械裁剪，本次 run 内不再重试。
      if (
        this.autoCompact &&
        !this.autoCompactBlocked &&
        shouldAutoCompact(this.state, this.contextTransform())
      ) {
        const ok = await this.doCompact();
        if (ok && !shouldAutoCompact(this.state, this.contextTransform())) {
          continue; // 压缩后上下文已大幅缩水，重走本轮（重新 drain steering / transform）
        }
        this.autoCompactBlocked = true;
        await this.emit({
          type: "notice",
          message: ok
            ? "压缩后仍超出预算线（摘要过长），停用自动压缩防循环"
            : "自动压缩未成功，本轮改用机械裁剪兜底",
        });
      }

      const ctx = transformContext(this.state, this.effectiveTransformOptions(overflowShrink));
      if (ctx.droppedMessages > 0 || ctx.prunedToolResults > 0) {
        await this.emit({
          type: "context_pruned",
          droppedMessages: ctx.droppedMessages,
          prunedToolResults: ctx.prunedToolResults,
        });
      }

      const llmMessages = convertToLlm(ctx.messages);
      const assistant = await this.callModel(ctx.tools, llmMessages);

      // Context 支柱的失败驱动调参（对齐 Model 支柱的 thinkingLevel 升档）：
      // provider 报上下文超限时把错误甩给用户没有意义，按比例缩预算重裁后
      // 重试一次；仍超限才把错误落树返回。只降一档，防止反复震荡。
      if (
        assistant.stopReason === "error" &&
        overflowShrink === 1 &&
        !this.controller.signal.aborted &&
        isContextOverflowError(assistant.errorMessage)
      ) {
        overflowShrink = CONTEXT_OVERFLOW_SHRINK;
        await this.emit({
          type: "notice",
          message: `模型报告上下文超限，按 ${Math.round(CONTEXT_OVERFLOW_SHRINK * 100)}% 预算裁剪后重试`,
        });
        continue;
      }

      appendNode(this.state, assistant);

      // Context 自校准：真实用量反馈修正 chars/token 口径（纯记账，失败静默跳过）。
      // 分母用 usage.input（prompt_tokens，已含缓存部分）；空 usage（error/aborted）自动跳过。
      let sentChars = ctx.systemPrompt.length;
      for (const m of ctx.messages) sentChars += messageChars(m);
      calibrateCharsPerToken(this.state, sentChars, assistant.usage.input);

      await this.emit({ type: "turn_end", message: assistant });

      if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
        return;
      }

      const calls = assistantToolCalls(assistant);
      if (calls.length === 0) return;

      const parallel =
        this.allowParallelTools &&
        calls.length > 1 &&
        calls.every((c) => {
          const tool = this.lookupTool(c.name);
          return tool !== undefined && !tool.isMutating;
        });

      const outcomes = await this.executeToolCalls(calls, parallel);

      // 动态推理强度：连续失败升档重试，成功回落（Model 支柱，客观信号驱动）
      await this.adjustThinkingLevel(outcomes);

      // 同一个调用反复失败，说明再试也没用，及时止损
      if (this.hasRepeatedFailure(outcomes)) {
        await this.emit({
          type: "notice",
          message: `同一个工具调用连续失败 ${MAX_REPEATED_FAILURES} 次，停止本轮任务`,
        });
        return;
      }

      this.toolRounds += 1;
      if (this.toolRounds >= this.maxToolRounds) {
        await this.emit({
          type: "notice",
          message: `内层循环已达上限 ${this.maxToolRounds} 轮，停止继续调用工具`,
        });
        return;
      }
    }
  }

  /**
   * 裁剪预算的解析顺序（Context 支柱）：显式 transform 优先（桌面端带
   * /models 元数据真值）→ 模型自带 contextWindow（resolveModel 按粗表填充，
   * /model 切换会经 setModel 更新 state.model，预算自动跟随）→ 默认 120k。
   */
  private contextTransform(): Partial<TransformOptions> | undefined {
    if (this.transformOptions?.maxContextTokens !== undefined) return this.transformOptions;
    const ctx = this.state.model.contextWindow;
    if (ctx === undefined) return this.transformOptions;
    return { ...this.transformOptions, maxContextTokens: maxContextTokensFor(ctx) };
  }

  /** Context 超限降档时的 transform 参数：按 shrink 缩 maxContextTokens，其余原样 */
  private effectiveTransformOptions(shrink: number): Partial<TransformOptions> | undefined {
    if (shrink === 1) return this.contextTransform();
    const base =
      this.contextTransform()?.maxContextTokens ?? defaultTransformOptions.maxContextTokens;
    return { ...this.transformOptions, maxContextTokens: Math.floor(base * shrink) };
  }

  /** 调用统一大模型接口，把流式事件透传给 UI，并累积出最终消息 */
  private async callModel(
    tools: AgentState["tools"],
    llmMessages: ReturnType<typeof convertToLlm>,
  ): Promise<AssistantMessage> {
    const options: StreamOptions = {
      model: this.state.model,
      systemPrompt: this.state.systemPrompt,
      messages: llmMessages,
      tools: describeToolsForModel(tools),
      thinkingLevel: this.currentThinkingLevel,
      signal: this.controller.signal,
      // 会话 id：部分中继（opencode zen go）要求 x-opencode-session，缺失 400。
      // 为空时提前分配并写回 state——sessions.ts 落盘时复用同一个 id。
      sessionId: this.state.sessionId ?? (this.state.sessionId = crypto.randomUUID()),
    };
    if (this.state.model.maxTokens !== undefined) {
      options.maxTokens = this.state.model.maxTokens;
    }

    let final: AssistantMessage | null = null;

    // 流失败自动重试：指数退避（BASE * 2^attempt），abort 不重试。
    // 重试前发 notice 让 UI 可见；上一轮已 emit 的 error/delta 事件不回滚。
    for (let attempt = 0; ; attempt++) {
      final = null;
      let retryable = false;
      try {
        for await (const event of this.stream(options)) {
          await this.emit({ type: "stream", event });
          if (event.type === "done") final = event.message;
          else if (event.type === "error") {
            final = event.error;
            retryable = event.reason !== "aborted";
            if (event.reason === "error") {
              // provider 内部把 HTTP 状态 / 响应体摘要把进了 errorMessage，
              // 这里原样落盘——终端上它可能只显示一行，日志里有全量。
              log.error(
                "agent",
                `模型返回错误 model=${this.state.model.provider}:${this.state.model.id}（第 ${attempt + 1} 次尝试）：${final.errorMessage ?? "未知原因"}`,
              );
            }
          }
        }
      } catch (err) {
        const aborted = this.controller.signal.aborted;
        log.error(
          "agent",
          `模型调用异常 model=${this.state.model.provider}:${this.state.model.id}（第 ${attempt + 1} 次尝试）${aborted ? "（已中断）" : ""}`,
          err,
        );
        final = {
          role: "assistant",
          content: [],
          model: `${this.state.model.provider}:${this.state.model.id}`,
          stopReason: "error",
          errorMessage: aborted ? "已中断" : `调用模型失败：${String(err)}`,
          usage: emptyUsage(),
          timestamp: Date.now(),
        };
        retryable = !aborted;
        // reason 必须如实区分 error / aborted：桌面端显示层靠 reason 过滤
        // 「用户主动中断不算错误」，这里硬编码 error 会让中断也弹错误提示。
        await this.emit({
          type: "stream",
          event: { type: "error", reason: aborted ? "aborted" : "error", error: final },
        });
      }

      if (!retryable || attempt >= this.maxStreamRetries) break;
      if (this.controller.signal.aborted) break;

      const delayMs = STREAM_RETRY_BASE_MS * 2 ** attempt;
      log.info(
        "agent",
        `流失败自动重试 attempt=${attempt + 1}/${this.maxStreamRetries} delay=${delayMs}ms`,
      );
      await this.emit({
        type: "notice",
        message: `模型流失败（${final?.errorMessage ?? "未知原因"}），${delayMs}ms 后自动重试（第 ${attempt + 1}/${this.maxStreamRetries} 次）`,
      });
      await this.sleep(delayMs);
      if (this.controller.signal.aborted) break;
    }

    if (final === null) {
      final = {
        role: "assistant",
        content: [],
        model: `${this.state.model.provider}:${this.state.model.id}`,
        stopReason: "error",
        errorMessage: "模型没有返回任何内容",
        usage: emptyUsage(),
        timestamp: Date.now(),
      };
      // 流式通道一个事件都没出就结束（空流）：补发 error 事件，让所有显示端
      // 走同一条错误通道看到它——否则这个失败只藏在 turn_end 的 errorMessage
      // 里，桌面端会静默漏掉（SessionManager/显示 connector 不读 turn_end 的消息体）。
      await this.emit({
        type: "stream",
        event: { type: "error", reason: "error", error: final },
      });
    }
    return final;
  }

  /**
   * 退避等待。**必须保持 ref**：print 这类短命进程里，流失败后唯一的挂起任务
   * 就是这个定时器——unref 会让 event loop 提前清空，进程带着 exit 0 静默退出，
   * 错误与重试都到不了用户。REPL / 桌面端有别的句柄保活，ref 的代价只是
   * 退出前多等 ≤200ms；醒来后由调用方检查 abort。
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  /** 串行或并行执行工具，结果统一写回消息记录 */
  private async executeToolCalls(
    calls: ToolCallContent[],
    parallel: boolean,
  ): Promise<Outcome[]> {
    const runOne = async (call: ToolCallContent): Promise<Outcome> => {
      const startedAt = Date.now();
      await this.emit({ type: "tool_start", toolCall: call, parallel });

      const tool = this.lookupTool(call.name);
      let result: ToolResult;
      if (tool === undefined) {
        const reason = this.disabledTools.has(call.name) ? "已被禁用" : "未知";
        result = fail(
          `${reason}工具：${call.name}。可用工具：${this.availableToolNames().join(", ")}`,
        );
      } else if (
        tool.isMutating &&
        this.approvalGate !== undefined &&
        !(await this.tryApprove(call.name, call.arguments))
      ) {
        result = fail(
          `用户拒绝了本次 ${call.name} 调用（审批门）。不要原样重试；调整方案、或把意图告诉用户等放行。`,
        );
      } else {
        const checked = validateParams(tool.parameters, call.arguments);
        if (!checked.ok) {
          result = fail(`工具 ${call.name} 参数错误：${checked.error}`);
        } else {
          try {
            result = await tool.execute(checked.value, {
              cwd: this.state.cwd,
              signal: this.controller.signal,
            });
          } catch (err) {
            log.error("agent", `工具 ${call.name} 执行抛异常`, err);
            result = fail(`工具 ${call.name} 执行异常：${String(err)}`);
          }
        }
      }

      if (result.isError) {
        // 工具自己报的失败（不抛异常）也要留痕：模型可能自己消化掉，
        // 用户在终端上根本看不到这条——日志是唯一可靠的痕迹。
        const text = result.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join(" ");
        log.warn("agent", `工具 ${call.name} 返回错误（${Date.now() - startedAt}ms）：${text.slice(0, 300)}`);
      }

      await this.emit({
        type: "tool_end",
        toolCall: call,
        result,
        durationMs: Date.now() - startedAt,
      });
      return { call, result };
    };

    let outcomes: Outcome[];
    if (parallel) {
      outcomes = await Promise.all(calls.map((c) => runOne(c)));
    } else {
      outcomes = [];
      for (let i = 0; i < calls.length; i++) {
        // pi 式打断（借鉴 badlogic/pi-mono）：串行工具的间隙发现有中途插话，
        // 立即停手，剩余调用标 skipped 回给模型——下一轮模型同时看到
        // 「已执行的结果 + 被跳过的调用 + 用户插话」，能马上调整方向。
        // 这里只偷看队列不取：真正注入仍由内层循环顶部统一做，保证
        // toolResult 紧跟 assistant(toolCalls) 的消息顺序不破。
        if (i > 0 && this.queue.hasSteering()) {
          for (const remaining of calls.slice(i)) outcomes.push(await this.skipToolCall(remaining));
          break;
        }
        outcomes.push(await runOne(calls[i]));
      }
    }

    for (const { call, result } of outcomes) {
      const message: ToolResultMessage = {
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: this.maybeTruncateResult(call.name, result.content),
        isError: result.isError,
        timestamp: Date.now(),
      };
      appendNode(this.state, message);
    }

    return outcomes;
  }

  /** 被打断的调用不真正执行；tool_start/end 仍配对发出，让 UI 有迹可循 */
  private async skipToolCall(call: ToolCallContent): Promise<Outcome> {
    const result = fail("用户发来了新指令，本次工具调用已跳过。结合新指令调整后续方案。");
    await this.emit({ type: "tool_start", toolCall: call, parallel: false });
    await this.emit({ type: "tool_end", toolCall: call, result, durationMs: 0 });
    return { call, result, skipped: true };
  }

  /**
   * 走审批门：false = 拒绝。门抛异常视为拒绝（fail-safe）并发 notice，
   * 这样桌面端审批 UI 崩溃时不会悄悄变成「全部放行」。
   */
  private async tryApprove(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<boolean> {
    if (this.approvalGate === undefined) return true;
    try {
      return await this.approvalGate({ toolName, arguments: args });
    } catch (err) {
      log.error("agent", `审批门异常 tool=${toolName}，已按拒绝处理`, err);
      await this.emit({
        type: "notice",
        message: `审批门异常，已按拒绝处理：${String(err)}`,
      });
      return false;
    }
  }

  /** 单次工具结果超长时按头/尾截断，避免单条撑爆上下文 */
  private maybeTruncateResult(toolName: string, content: ToolResult["content"]): ToolResult["content"] {
    // 图片块不计入字符预算；超长截断时整条替换（含图片），由占位文本说明
    const text = content
      .filter((c): c is Extract<(typeof content)[number], { type: "text" }> => c.type === "text")
      .map((c) => c.text)
      .join("");
    if (text.length <= this.maxToolResultChars) return content;
    return [{ type: "text", text: `[${toolName} 输出已截断，原长度 ${text.length} 字符]\n\n${truncateText(text, this.maxToolResultChars)}` }];
  }

  /** 工具查找优先走代理自己注册的工具表；被禁用的工具返回 undefined */
  private lookupTool(name: string): Tool | undefined {
    if (this.disabledTools.has(name)) return undefined;
    const tools = this.state.tools;
    // O(1) 查找：每个 toolCall 都要经过这里，线性 find 在长会话里是纯浪费
    if (this.toolIndex === undefined || this.toolIndex.tools !== tools) {
      const map = new Map<string, Tool>();
      for (const t of tools) {
        // 与 Array.find 语义一致：同名保留先注册的那个
        if (!map.has(t.name)) map.set(t.name, t);
      }
      this.toolIndex = { tools, map };
    }
    return this.toolIndex.map.get(name);
  }

  /** 列出当前可用的工具名（用于告诉模型哪些能用） */
  private availableToolNames(): string[] {
    return this.state.tools.map((t) => t.name).filter((n) => !this.disabledTools.has(n));
  }

  /** 同一个调用连续失败 3 次即判定无解（被打断跳过的不算失败） */
  private hasRepeatedFailure(outcomes: Outcome[]): boolean {
    let repeated = false;
    for (const { call, result, skipped } of outcomes) {
      if (skipped) continue;
      const key = `${call.name}:${JSON.stringify(call.arguments)}`;
      if (!result.isError) {
        this.failureCounts.delete(key);
        continue;
      }
      const count = (this.failureCounts.get(key) ?? 0) + 1;
      this.failureCounts.set(key, count);
      if (count >= MAX_REPEATED_FAILURES) repeated = true;
    }
    return repeated;
  }

  /**
   * 动态推理强度（重试的「推理版」）：工具连续失败到阈值就升一档，让下一轮
   * 带着更强的思考重试；任一工具成功立即回落到用户配置的基准档。
   * base 为 off（用户显式关闭思考）时不参与。升档发 notice 让 UI 可见。
   */
  private async adjustThinkingLevel(outcomes: Outcome[]): Promise<void> {
    if (!this.dynamicThinking || this.baseThinkingLevel === "off") return;

    // 用户插话导致的跳过既不是模型的成功也不是失败，不该污染升降档信号
    const effective = outcomes.filter((o) => !o.skipped);
    if (effective.length === 0) return;

    const anyFailure = effective.some((o) => o.result.isError);
    if (!anyFailure) {
      this.thinkingFailureStreak = 0;
      this.currentThinkingLevel = this.baseThinkingLevel;
      return;
    }

    this.thinkingFailureStreak += 1;
    if (this.thinkingFailureStreak < THINKING_ESCALATE_AFTER) return;

    const from = this.currentThinkingLevel;
    const idx = THINKING_LADDER.indexOf(from);
    const next = THINKING_LADDER[Math.min(idx + 1, THINKING_LADDER.length - 1)];
    if (next === from) return; // 已到 high 顶格
    this.currentThinkingLevel = next;
    await this.emit({
      type: "notice",
      message: `工具连续失败 ${this.thinkingFailureStreak} 次，推理强度 ${from} → ${next}`,
    });
  }

  private pushUser(content: string, images?: { dataUrl: string }[]): void {
    const message: UserMessage = {
      role: "user",
      content,
      ...(images !== undefined && images.length > 0
        ? { images: images.map((img) => ({ type: "image" as const, dataUrl: img.dataUrl })) }
        : {}),
      timestamp: Date.now(),
    };
    appendNode(this.state, message);
  }

  /**
   * 最后一条消息是 user 或 toolResult，说明还有活没干完。
   * 优先读 ★ Current Node 上的消息；★ 缺失时取 messages 数组末位
   * （老 fallback 路径 / 没塞进过节点的纯 messages 数组状态）。
   */
  private hasPendingWork(): boolean {
    const current = currentNode(this.state);
    const last =
      current?.message ?? this.state.messages[this.state.messages.length - 1];
    return last !== undefined && (last.role === "user" || last.role === "toolResult");
  }

  private async emit(event: AgentEvent): Promise<void> {
    if (this.onEvent === undefined) return;
    // onEvent 只是观察者，抛错不应影响主流程——但要等它完成后才往下走
    // （这样 SessionManager 才能在 stream 事件之间插入 pause gate）。
    try {
      await this.onEvent(event);
    } catch (err) {
      // 观察者错误不影响主流程，但要留痕——「渲染器炸了导致黑屏」这类问题
      // 没有日志就只能靠猜。
      log.debug("agent", "onEvent 观察者异常（不影响主流程）", err);
    }
  }
}
