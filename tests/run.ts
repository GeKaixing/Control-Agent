/**
 * 零依赖测试运行器：node --import tsx tests/run.ts
 * 覆盖工具、上下文变换、格式转换，以及一条完整的端到端链路。
 */

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Agent, type AgentEvent } from "../src/agent/agent.js";
import { transformContext } from "../src/agent/context.js";
import { convertToLlm } from "../src/agent/convert.js";
import { createInitialState } from "../src/agent/state.js";
import { createMockStream } from "../src/providers/mock.js";
import type { StreamFn, StreamOptions } from "../src/providers/types.js";
import { allTools, bashTool, editTool, globTool, grepTool, readTool, writeTool, type ToolName } from "../src/tools/index.js";
import type { Tool } from "../src/tools/types.js";
import { ok } from "../src/tools/types.js";
import { globToRegExp, matchesGlob } from "../src/tools/glob-matcher.js";
import { validateParams } from "../src/tools/validate.js";
import { createPrintOutput } from "../src/ui/print.js";
import type {
  AgentMessage,
  AssistantMessage,
  ModelRef,
  ToolCallContent,
} from "../src/types.js";

interface Case {
  name: string;
  fn: () => Promise<void> | void;
}

const cases: Case[] = [];
function test(name: string, fn: () => Promise<void> | void): void {
  cases.push({ name, fn });
}

const noSignal = (): AbortSignal => new AbortController().signal;

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agent-test-"));
}

/** 构造一条纯文本的助手消息，供自定义 StreamFn 收尾使用 */
function textOnly(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    model: "mock:mock-1",
    stopReason: "stop",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    timestamp: Date.now(),
  };
}

// ---------------------------------------------------------------- glob

test("glob: ** 匹配任意层级", () => {
  assert.equal(matchesGlob("src/**/*.ts", "src/a.ts"), true);
  assert.equal(matchesGlob("src/**/*.ts", "src/x/y.ts"), true);
  assert.equal(matchesGlob("src/**/*.ts", "src/a.js"), false);
  assert.equal(matchesGlob("**/*.md", "README.md"), true);
  assert.equal(matchesGlob("*.{ts,js}", "a.js"), true);
  assert.equal(matchesGlob("*.{ts,js}", "a.py"), false);
  assert.equal(globToRegExp("a?c.ts").test("abc.ts"), true);
});

// ------------------------------------------------------------ validate

test("validateParams: 必填、类型、枚举、额外参数", () => {
  const schema = {
    type: "object",
    properties: {
      path: { type: "string" },
      limit: { type: "integer" },
      mode: { type: "string", enum: ["a", "b"] },
    },
    required: ["path"],
    additionalProperties: false,
  } as const;

  assert.equal(validateParams(schema, {}).ok, false);
  assert.equal(validateParams(schema, { path: 1 }).ok, false);
  assert.equal(validateParams(schema, { path: "a", limit: 1.5 }).ok, false);
  assert.equal(validateParams(schema, { path: "a", mode: "c" }).ok, false);
  assert.equal(validateParams(schema, { path: "a", extra: 1 }).ok, false);
  const good = validateParams(schema, { path: "a", limit: 3, mode: "b" });
  assert.equal(good.ok, true);
  if (good.ok) assert.equal(good.value["limit"], 3);
});

// ---------------------------------------------------------------- read

test("read: 行号与 offset/limit", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "a.txt");
  await fs.writeFile(file, "one\ntwo\nthree\nfour\n");

  const full = await readTool.execute({ path: file }, { cwd: dir, signal: noSignal() });
  assert.equal(full.isError, false);
  assert.match(full.content[0]?.text ?? "", /1\tone/);

  const part = await readTool.execute(
    { path: "a.txt", offset: 2, limit: 2 },
    { cwd: dir, signal: noSignal() },
  );
  const text = part.content[0]?.text ?? "";
  assert.match(text, /2\ttwo/);
  assert.match(text, /3\tthree/);
  assert.doesNotMatch(text, /4\tfour/);

  const missing = await readTool.execute(
    { path: "nope.txt" },
    { cwd: dir, signal: noSignal() },
  );
  assert.equal(missing.isError, true);
});

// --------------------------------------------------------------- write

test("write: 自动创建目录，且允许写入 cwd 之外的路径", async () => {
  const dir = await tempDir();
  const result = await writeTool.execute(
    { path: "deep/nested/x.txt", content: "hi" },
    { cwd: dir, signal: noSignal() },
  );
  assert.equal(result.isError, false);
  assert.equal(await fs.readFile(path.join(dir, "deep/nested/x.txt"), "utf8"), "hi");

  // 路径围栏已移除：cwd 之外可以正常写入，与 read / bash 的行为保持一致
  const escape = path.join(path.dirname(dir), `escape-${path.basename(dir)}.txt`);
  const outside = await writeTool.execute(
    { path: escape, content: "outside" },
    { cwd: dir, signal: noSignal() },
  );
  assert.equal(outside.isError, false);
  try {
    assert.equal(await fs.readFile(escape, "utf8"), "outside");
  } finally {
    await fs.rm(escape, { force: true });
  }
});

// ---------------------------------------------------------------- edit

test("edit: 唯一匹配才替换", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "e.txt");
  await fs.writeFile(file, "alpha\nbeta\nalpha\n");

  const dup = await editTool.execute(
    { path: file, oldString: "alpha", newString: "gamma" },
    { cwd: dir, signal: noSignal() },
  );
  assert.equal(dup.isError, true);
  assert.match(dup.content[0]?.text ?? "", /出现 2 次/);

  const missing = await editTool.execute(
    { path: file, oldString: "zzz", newString: "x" },
    { cwd: dir, signal: noSignal() },
  );
  assert.equal(missing.isError, true);

  const good = await editTool.execute(
    { path: file, oldString: "beta", newString: "BETA" },
    { cwd: dir, signal: noSignal() },
  );
  assert.equal(good.isError, false);
  assert.equal(await fs.readFile(file, "utf8"), "alpha\nBETA\nalpha\n");
});

// ---------------------------------------------------------------- bash

test("bash: 成功、失败与超时", async () => {
  const dir = await tempDir();

  const good = await bashTool.execute(
    { command: "echo bash-ok" },
    { cwd: dir, signal: noSignal() },
  );
  assert.equal(good.isError, false);
  assert.match(good.content[0]?.text ?? "", /bash-ok/);

  const bad = await bashTool.execute(
    { command: "exit 3" },
    { cwd: dir, signal: noSignal() },
  );
  assert.equal(bad.isError, true);
  assert.match(bad.content[0]?.text ?? "", /退出码 3/);

  const slow = await bashTool.execute(
    { command: "sleep 5", timeout: 1000 },
    { cwd: dir, signal: noSignal() },
  );
  assert.equal(slow.isError, true);
  assert.match(slow.content[0]?.text ?? "", /超时/);
});

// -------------------------------------------------------- glob / grep

test("glob / grep 工具在真实目录上工作", async () => {
  const dir = await tempDir();
  await fs.mkdir(path.join(dir, "src/lib"), { recursive: true });
  await fs.writeFile(path.join(dir, "src/index.ts"), "const A = 1;\n");
  await fs.writeFile(path.join(dir, "src/lib/util.ts"), "function target() {}\n");
  await fs.writeFile(path.join(dir, "README.md"), "# docs\n");

  const listed = await globTool.execute(
    { pattern: "**/*.ts" },
    { cwd: dir, signal: noSignal() },
  );
  const listedText = listed.content[0]?.text ?? "";
  assert.match(listedText, /src\/index\.ts/);
  assert.match(listedText, /src\/lib\/util\.ts/);
  assert.doesNotMatch(listedText, /README\.md/);

  const found = await grepTool.execute(
    { pattern: "function\\s+target", include: "**/*.ts" },
    { cwd: dir, signal: noSignal() },
  );
  assert.match(found.content[0]?.text ?? "", /src\/lib\/util\.ts:1/);

  const none = await grepTool.execute(
    { pattern: "not-there-anywhere" },
    { cwd: dir, signal: noSignal() },
  );
  assert.equal(none.isError, false);
  assert.match(none.content[0]?.text ?? "", /没有匹配/);
});

// ------------------------------------------------------------ convert

test("convertToLlm: 合并连续工具结果，丢弃空消息", () => {
  const messages: AgentMessage[] = [
    { role: "user", content: "hi", timestamp: 0 },
    {
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      model: "m",
      stopReason: "stop",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      timestamp: 0,
    },
    { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "a" }], isError: false, timestamp: 0 },
    { role: "toolResult", toolCallId: "c2", toolName: "read", content: [{ type: "text", text: "b" }], isError: false, timestamp: 0 },
  ];

  const out = convertToLlm(messages);
  assert.equal(out.length, 3);
  assert.equal(out[2]?.role, "toolResult");
  assert.equal(out[2]?.content.length, 2);

  const leadingAssistant = convertToLlm([
    {
      role: "assistant",
      content: [{ type: "text", text: "orphan" }],
      model: "m",
      stopReason: "stop",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      timestamp: 0,
    },
  ]);
  assert.equal(leadingAssistant.length, 0);
});

// ----------------------------------------------------------- context

test("transformContext: 清理孤儿工具结果并按预算裁剪", () => {
  const messages: AgentMessage[] = [
    { role: "user", content: "u1", timestamp: 0 },
    { role: "toolResult", toolCallId: "ghost", toolName: "read", content: [{ type: "text", text: "orphan" }], isError: false, timestamp: 0 },
  ];
  for (let i = 0; i < 4; i++) {
    messages.push({ role: "user", content: "x".repeat(1500), timestamp: 0 });
    messages.push({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "t".repeat(200) },
        { type: "text", text: "y".repeat(1500) },
      ],
      model: "m",
      stopReason: "stop",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      timestamp: 0,
    });
  }

  const state = createInitialState({
    cwd: process.cwd(),
    model: { provider: "mock", id: "mock-1" },
    tools: allTools,
  });
  state.messages = messages;

  const ctx = transformContext(state, {
    maxContextTokens: 3000,
    reservedTokens: 500,
    keepRecentTurns: 1,
    maxToolResultChars: 100,
  });

  assert.equal(
    ctx.messages.some((m) => m.role === "toolResult" && m.toolCallId === "ghost"),
    false,
    "孤儿工具结果应被清理",
  );
  assert.ok(ctx.droppedMessages > 0, "应当有消息被裁剪");
  const last = ctx.messages[ctx.messages.length - 1];
  assert.equal(last?.role, "assistant", "最后一轮必须保住");
  assert.ok(ctx.messages.length < messages.length);
});

// ------------------------------------------------------------- 端到端

async function runAgent(options: {
  cwd: string;
  prompt: string;
  stream?: StreamFn;
  tools?: Tool[];
  allowParallelTools?: boolean;
  disabledTools?: ToolName[];
  maxToolResultChars?: number;
}): Promise<{ events: AgentEvent[]; messages: AgentMessage[]; durationMs: number }> {
  const model: ModelRef = { provider: "mock", id: "mock-1" };
  const state = createInitialState({
    cwd: options.cwd,
    model,
    tools: options.tools ?? allTools,
  });
  const events: AgentEvent[] = [];
  const extra: { allowParallelTools?: boolean; disabledTools?: ToolName[]; maxToolResultChars?: number } = {};
  if (options.allowParallelTools !== undefined) extra.allowParallelTools = options.allowParallelTools;
  if (options.disabledTools !== undefined) extra.disabledTools = options.disabledTools;
  if (options.maxToolResultChars !== undefined) extra.maxToolResultChars = options.maxToolResultChars;
  const agent = new Agent({
    state,
    stream: options.stream ?? createMockStream({ delayMs: 0 }),
    onEvent: (e) => events.push(e),
    ...extra,
  });

  agent.enqueueUser(options.prompt);
  const started = Date.now();
  await agent.run();
  return { events, messages: state.messages, durationMs: Date.now() - started };
}

test("端到端：mock 模型调用 bash 并把结果带回来", async () => {
  const dir = await tempDir();
  const { events, messages } = await runAgent({
    cwd: dir,
    prompt: "执行命令: echo agent-ok",
  });

  const toolEnds = events.filter((e) => e.type === "tool_end");
  assert.equal(toolEnds.length, 1, "应执行一次工具");
  const first = toolEnds[0];
  assert.ok(first?.type === "tool_end" && first.toolCall.name === "bash");

  const toolResults = messages.filter((m) => m.role === "toolResult");
  assert.equal(toolResults.length, 1);
  assert.match(toolResults[0]?.content.map((c) => c.text).join("") ?? "", /agent-ok/);

  const assistants = messages.filter((m) => m.role === "assistant");
  const finalText = assistants[assistants.length - 1];
  assert.ok(finalText?.role === "assistant");
  assert.ok(
    (finalText.content.find((c) => c.type === "text") as { text: string } | undefined)
      ?.text.length ?? 0 > 0,
    "最后一轮应给出文字总结",
  );
});

test("端到端：未知工具会把错误反馈给模型", async () => {
  const dir = await tempDir();
  let fired = false;
  const bogus: StreamFn = async function* (_options: StreamOptions) {
    if (fired) {
      yield { type: "done", reason: "stop", message: textOnly("已收到错误反馈") };
      return;
    }
    fired = true;
    const call: ToolCallContent = {
      type: "toolCall",
      id: "c1",
      name: "no_such_tool",
      arguments: {},
    };
    const partial: AssistantMessage = {
      role: "assistant",
      content: [call],
      model: "mock:mock-1",
      stopReason: "toolUse",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      timestamp: Date.now(),
    };
    yield { type: "toolcall_end", toolCall: call, partial };
    yield { type: "done", reason: "toolUse", message: partial };
  };

  const { messages } = await runAgent({
    cwd: dir,
    prompt: "随便做点什么",
    stream: bogus,
  });
  const toolResults = messages.filter((m) => m.role === "toolResult");
  assert.equal(toolResults.length, 1);
  assert.equal(toolResults[0]?.isError, true);
  assert.match(toolResults[0]?.content[0]?.text ?? "", /未知工具/);
});

test("串行 / 并行：只读工具可并行，开关可强制串行", async () => {
  const dir = await tempDir();
  const slowTool: Tool = {
    name: "slow",
    description: "测试用的慢速只读工具",
    parameters: {
      type: "object",
      properties: { ms: { type: "integer" } },
      required: ["ms"],
    },
    isMutating: false,
    async execute(args) {
      const ms = Number(args["ms"] ?? 0);
      await new Promise((r) => setTimeout(r, ms));
      return ok(`slept ${ms}`);
    },
  };

  const makeStream = (): StreamFn => {
    let round = 0;
    return async function* (_options: StreamOptions) {
      round += 1;
      // 只在第一轮调用工具，之后直接给结论，避免测试跑满内层循环上限
      if (round > 1) {
        yield { type: "done", reason: "stop", message: textOnly("完成") };
        return;
      }
      const calls: ToolCallContent[] = [
        { type: "toolCall", id: "s1", name: "slow", arguments: { ms: 250 } },
        { type: "toolCall", id: "s2", name: "slow", arguments: { ms: 250 } },
      ];
      const partial: AssistantMessage = {
        role: "assistant",
        content: calls,
        model: "mock:mock-1",
        stopReason: "toolUse",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        timestamp: Date.now(),
      };
      for (const call of calls) {
        yield { type: "toolcall_end", toolCall: call, partial };
      }
      yield { type: "done", reason: "toolUse", message: partial };
    };
  };

  const parallel = await runAgent({
    cwd: dir,
    prompt: "x",
    stream: makeStream(),
    tools: [slowTool],
    allowParallelTools: true,
  });
  assert.ok(
    parallel.durationMs < 480,
    `两个 250ms 的只读工具并行应快于 480ms，实际 ${parallel.durationMs}ms`,
  );

  const serial = await runAgent({
    cwd: dir,
    prompt: "x",
    stream: makeStream(),
    tools: [slowTool],
    allowParallelTools: false,
  });
  assert.ok(
    serial.durationMs >= 480,
    `串行执行应慢于 480ms，实际 ${serial.durationMs}ms`,
  );
});

test("端到端：disabledTools 黑名单里的工具调用会返回 '已被禁用' 错误", async () => {
  const dir = await tempDir();
  // 自定义 stream 强制调用 bash（无论 prompt 里有什么关键词）
  const stream: StreamFn = async function* () {
    const call: ToolCallContent = {
      type: "toolCall",
      id: "c1",
      name: "bash",
      arguments: { command: "echo should-not-run" },
    };
    const partial: AssistantMessage = {
      role: "assistant",
      content: [call],
      model: "mock:mock-1",
      stopReason: "toolUse",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      timestamp: Date.now(),
    };
    yield { type: "toolcall_end", toolCall: call, partial };
    yield { type: "done", reason: "toolUse", message: partial };
  };
  const { messages } = await runAgent({
    cwd: dir,
    prompt: "x",
    stream,
    disabledTools: ["bash"],
  });

  const bashError = messages.find(
    (m) => m.role === "toolResult" && m.toolName === "bash",
  );
  assert.ok(bashError && bashError.role === "toolResult", "应有针对 bash 的工具结果");
  assert.equal(bashError.isError, true);
  assert.match(bashError.content[0]?.text ?? "", /已被禁用/);
  // 「可用工具：」列表里不应再出现 bash
  const available = bashError.content[0]?.text.split("可用工具：")[1] ?? "";
  assert.equal(available.split(/[\s,，]+/).includes("bash"), false);
});

test("端到端：超过 maxToolResultChars 的工具结果会被截断", async () => {
  const dir = await tempDir();
  const hugeTool: Tool = {
    name: "huge",
    description: "返回大字符串的测试工具",
    parameters: { type: "object", properties: {}, required: [] },
    isMutating: false,
    async execute() {
      return ok("A".repeat(20_000));
    },
  };
  // 自定义 stream 强制调用 hugeTool
  const stream: StreamFn = async function* () {
    const call: ToolCallContent = {
      type: "toolCall",
      id: "h1",
      name: "huge",
      arguments: {},
    };
    const partial: AssistantMessage = {
      role: "assistant",
      content: [call],
      model: "mock:mock-1",
      stopReason: "toolUse",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      timestamp: Date.now(),
    };
    yield { type: "toolcall_end", toolCall: call, partial };
    yield { type: "done", reason: "toolUse", message: partial };
  };
  const { messages } = await runAgent({
    cwd: dir,
    prompt: "x",
    stream,
    tools: [hugeTool],
    maxToolResultChars: 500,
  });

  const toolResult = messages.find((m) => m.role === "toolResult");
  assert.ok(toolResult && toolResult.role === "toolResult");
  const text = toolResult.content.map((c) => c.text).join("");
  assert.ok(text.length < 1000, `截断后应远小于原长 20000，实际 ${text.length}`);
  assert.match(text, /输出已截断/);
  assert.match(text, /A{50,}/, "应保留 A 字符内容");
});

test("registry：拼写错误的工具名会在 runAgent 路径上走 '未知工具'", async () => {
  // 这条用例保护：即使将来 TOOL_REGISTRY 改名，调用方拼错名字时仍走 fail，
  // 而不是默默得到 undefined 再让 executeToolCalls 崩。
  const dir = await tempDir();
  let fired = false;
  const bogus: StreamFn = async function* (_options: StreamOptions) {
    if (fired) {
      yield { type: "done", reason: "stop", message: textOnly("done") };
      return;
    }
    fired = true;
    const call: ToolCallContent = {
      type: "toolCall",
      id: "c1",
      name: "typo_tool",
      arguments: {},
    };
    const partial: AssistantMessage = {
      role: "assistant",
      content: [call],
      model: "mock:mock-1",
      stopReason: "toolUse",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      timestamp: Date.now(),
    };
    yield { type: "toolcall_end", toolCall: call, partial };
    yield { type: "done", reason: "toolUse", message: partial };
  };
  const { messages } = await runAgent({
    cwd: dir,
    prompt: "x",
    stream: bogus,
  });
  const toolResult = messages.find((m) => m.role === "toolResult");
  assert.ok(toolResult && toolResult.role === "toolResult");
  assert.equal(toolResult.isError, true);
  assert.match(toolResult.content[0]?.text ?? "", /未知工具/);
});

// ----------------------------------------------------------------- print

test("print 模式：事件收敛成最终答案，不带进度噪音", async () => {
  const dir = await tempDir();
  const out = createPrintOutput();
  const { events } = await runAgent({
    cwd: dir,
    prompt: "执行命令: echo print-ok",
    stream: createMockStream({ delayMs: 0 }),
  });
  for (const event of events) out.onEvent(event);

  assert.match(out.answer, /print-ok/, "最终答案里应带上工具结果");
  assert.equal(out.answer.includes("✓"), false, "不应混入工具执行的进度标记");
  assert.equal(out.answer.includes("→ "), false, "不应混入工具调用行");
  assert.deepEqual(out.warnings, []);
  assert.deepEqual(out.errors, []);
  assert.equal(out.exitCode, 0);
});

test("print 模式：只取正文，不把思考过程混进答案", () => {
  const out = createPrintOutput();
  const partial = textOnly("");
  out.onEvent({ type: "stream", event: { type: "thinking_delta", delta: "先想想", partial } });
  out.onEvent({ type: "stream", event: { type: "text_delta", delta: "最终", partial } });
  out.onEvent({ type: "stream", event: { type: "text_delta", delta: "答案", partial } });

  assert.equal(out.answer, "最终答案");
  assert.equal(out.exitCode, 0);
});

test("print 模式：模型报错记入 errors，退出码为 1", () => {
  const out = createPrintOutput();
  const failed: AssistantMessage = {
    role: "assistant",
    content: [],
    model: "mock:mock-1",
    stopReason: "error",
    errorMessage: "调用模型失败：boom",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    timestamp: Date.now(),
  };
  out.onEvent({ type: "stream", event: { type: "error", reason: "error", error: failed } });

  assert.deepEqual(out.errors, ["调用模型失败：boom"]);
  assert.equal(out.answer, "");
  assert.equal(out.exitCode, 1);
});

test("print 模式：中断的 turn_end 也算错误", () => {
  const out = createPrintOutput();
  out.onEvent({
    type: "turn_end",
    message: {
      role: "assistant",
      content: [],
      model: "mock:mock-1",
      stopReason: "aborted",
      errorMessage: "已中断",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      timestamp: Date.now(),
    },
  });

  assert.deepEqual(out.errors, ["已中断"]);
  assert.equal(out.exitCode, 1);
});

test("print 模式：notice 与上下文裁剪只是警告，不影响退出码", () => {
  const out = createPrintOutput();
  out.onEvent({ type: "notice", message: "内层循环已达上限" });
  out.onEvent({ type: "context_pruned", droppedMessages: 3, prunedToolResults: 2 });

  assert.deepEqual(out.warnings, [
    "内层循环已达上限",
    "上下文已裁剪：丢弃 3 条消息，压缩 2 处工具结果",
  ]);
  assert.deepEqual(out.errors, []);
  assert.equal(out.exitCode, 0);
});

// ---------------------------------------------------------------- runner

async function main(): Promise<void> {
  let failed = 0;
  for (const c of cases) {
    const started = Date.now();
    try {
      await c.fn();
      console.log(`  ✓ ${c.name} (${Date.now() - started}ms)`);
    } catch (err) {
      failed += 1;
      console.log(`  ✗ ${c.name}`);
      console.log(`    ${String(err)}`);
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} 通过`);
  if (failed > 0) process.exitCode = 1;
}

const invokedDirectly = process.argv[1] !== undefined && process.argv[1].endsWith("run.ts");
if (invokedDirectly) {
  await main();
}
