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
  ToolCallContent,
  ToolResultMessage,
  UserMessage,
} from "../types.js";
import { assistantToolCalls, emptyUsage } from "../types.js";
import { transformContext, type TransformOptions } from "./context.js";
import { convertToLlm } from "./convert.js";
import { MessageQueue } from "./queue.js";
import { appendNode, currentNode } from "./state.js";
import type { AgentState } from "./state.js";

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
  | { type: "notice"; message: string }
  | { type: "agent_end"; toolRounds: number };

export interface AgentOptions {
  state: AgentState;
  queue?: MessageQueue;
  stream: StreamFn;
  onEvent?: (event: AgentEvent) => void;
  transform?: Partial<TransformOptions>;
  /** 内层循环的工具往返上限，防止死循环 */
  maxToolRounds?: number;
  /** 多个只读工具是否并行执行 */
  allowParallelTools?: boolean;
  /** 黑名单：被禁用的工具即使注册了，模型调用时也会返回错误 */
  disabledTools?: ToolName[];
  /** 单次工具返回结果的最大字符数；超出按头/尾截断。默认 50000 */
  maxToolResultChars?: number;
}

const DEFAULT_MAX_TOOL_RESULT_CHARS = 50_000;

const STEERING_PREFIX = "[中途插入指令] ";
const MAX_REPEATED_FAILURES = 3;

interface Outcome {
  call: ToolCallContent;
  result: ToolResult;
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
  }

  get isRunning(): boolean {
    return this.running;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** 用户新的一轮请求 → 进入后续指令队列 */
  enqueueUser(text: string): void {
    this.queue.enqueueFollowUp(text);
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
   * 外层循环：取后续指令 → 跑内层循环 → 还有后续指令就再来一轮，否则结束。
   */
  async run(): Promise<void> {
    if (this.running) throw new Error("代理正在运行中，请勿重复调用 run()");
    this.running = true;
    this.toolRounds = 0;
    this.failureCounts.clear();
    this.emit({ type: "agent_start" });

    try {
      while (!this.controller.signal.aborted) {
        const followUps = this.queue.drainFollowUps();
        for (const text of followUps) this.pushUser(text);

        if (!this.hasPendingWork()) break;

        this.emit({ type: "turn_start", pendingFollowUps: followUps.length });
        await this.runInnerLoop();

        if (this.controller.signal.aborted) break;
        if (this.queue.hasFollowUps()) continue;
        break;
      }
    } finally {
      this.running = false;
      this.emit({ type: "agent_end", toolRounds: this.toolRounds });
    }
  }

  /**
   * 内层循环：中途指令 → transformContext → convertToLlm → StreamFn
   * → 有工具调用就执行并把结果写回消息记录 → 再进入下一轮。
   */
  private async runInnerLoop(): Promise<void> {
    while (!this.controller.signal.aborted) {
      // 中途插入的指令
      const steering = this.queue.drainSteering();
      if (steering.length > 0) {
        for (const text of steering) this.pushUser(`${STEERING_PREFIX}${text}`);
        this.emit({ type: "steering", texts: steering });
      }

      const ctx = transformContext(this.state, this.transformOptions);
      if (ctx.droppedMessages > 0 || ctx.prunedToolResults > 0) {
        this.emit({
          type: "context_pruned",
          droppedMessages: ctx.droppedMessages,
          prunedToolResults: ctx.prunedToolResults,
        });
      }

      const llmMessages = convertToLlm(ctx.messages);
      const assistant = await this.callModel(ctx.tools, llmMessages);
      appendNode(this.state, assistant);
      this.emit({ type: "turn_end", message: assistant });

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

      // 同一个调用反复失败，说明再试也没用，及时止损
      if (this.hasRepeatedFailure(outcomes)) {
        this.emit({
          type: "notice",
          message: `同一个工具调用连续失败 ${MAX_REPEATED_FAILURES} 次，停止本轮任务`,
        });
        return;
      }

      this.toolRounds += 1;
      if (this.toolRounds >= this.maxToolRounds) {
        this.emit({
          type: "notice",
          message: `内层循环已达上限 ${this.maxToolRounds} 轮，停止继续调用工具`,
        });
        return;
      }
    }
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
      thinkingLevel: this.state.thinkingLevel,
      signal: this.controller.signal,
    };
    if (this.state.model.maxTokens !== undefined) {
      options.maxTokens = this.state.model.maxTokens;
    }

    let final: AssistantMessage | null = null;

    try {
      for await (const event of this.stream(options)) {
        this.emit({ type: "stream", event });
        if (event.type === "done") final = event.message;
        else if (event.type === "error") final = event.error;
      }
    } catch (err) {
      const message: AssistantMessage = {
        role: "assistant",
        content: [],
        model: `${this.state.model.provider}:${this.state.model.id}`,
        stopReason: "error",
        errorMessage: this.controller.signal.aborted
          ? "已中断"
          : `调用模型失败：${String(err)}`,
        usage: emptyUsage(),
        timestamp: Date.now(),
      };
      this.emit({
        type: "stream",
        event: { type: "error", reason: "error", error: message },
      });
      return message;
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
    }
    return final;
  }

  /** 串行或并行执行工具，结果统一写回消息记录 */
  private async executeToolCalls(
    calls: ToolCallContent[],
    parallel: boolean,
  ): Promise<Outcome[]> {
    const runOne = async (call: ToolCallContent): Promise<Outcome> => {
      const startedAt = Date.now();
      this.emit({ type: "tool_start", toolCall: call, parallel });

      const tool = this.lookupTool(call.name);
      let result: ToolResult;
      if (tool === undefined) {
        const reason = this.disabledTools.has(call.name) ? "已被禁用" : "未知";
        result = fail(
          `${reason}工具：${call.name}。可用工具：${this.availableToolNames().join(", ")}`,
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
            result = fail(`工具 ${call.name} 执行异常：${String(err)}`);
          }
        }
      }

      this.emit({
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
      for (const call of calls) outcomes.push(await runOne(call));
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

  /** 单次工具结果超长时按头/尾截断，避免单条撑爆上下文 */
  private maybeTruncateResult(toolName: string, content: ToolResult["content"]): ToolResult["content"] {
    const text = content.map((c) => c.text).join("");
    if (text.length <= this.maxToolResultChars) return content;
    return [{ type: "text", text: `[${toolName} 输出已截断，原长度 ${text.length} 字符]\n\n${truncateText(text, this.maxToolResultChars)}` }];
  }

  /** 工具查找优先走代理自己注册的工具表；被禁用的工具返回 undefined */
  private lookupTool(name: string): Tool | undefined {
    if (this.disabledTools.has(name)) return undefined;
    return this.state.tools.find((t) => t.name === name);
  }

  /** 列出当前可用的工具名（用于告诉模型哪些能用） */
  private availableToolNames(): string[] {
    return this.state.tools.map((t) => t.name).filter((n) => !this.disabledTools.has(n));
  }

  /** 同一个调用连续失败 3 次即判定无解 */
  private hasRepeatedFailure(outcomes: Outcome[]): boolean {
    let repeated = false;
    for (const { call, result } of outcomes) {
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

  private pushUser(content: string): void {
    const message: UserMessage = {
      role: "user",
      content,
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

  private emit(event: AgentEvent): void {
    this.onEvent?.(event);
  }
}
