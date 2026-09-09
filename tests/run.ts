/**
 * 零依赖测试运行器：npx tsx tests/run.ts
 *
 * 用例分三块，本文件是核心单元 / 端到端测试：
 * 1. `tests/run.ts`（本文件）—— 工具、上下文、状态树、消息流转、print 收敛、markdown 渲染
 * 2. `tests/cli-print.ts` —— 子进程级 CLI 测试，spawn 真 c-agent 跑 print 模式
 * 3. `tests/repl-loop.ts` —— in-process REPL 测试，把 src/ui/repl.ts 的循环用 FakeInput 驱动
 *
 * 子用例文件通过 registry.register 注册用例，main() 顺序执行。本文件保留最厚的
 * 那部分——它直接 import 内部模块测单元/集成，比 spawn 子进程快几倍。
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";

import { Agent, isContextOverflowError, type AgentEvent } from "../src/agent/agent.js";
import {
  activeBranch,
  addNodeAt,
  appendNode,
  calibrateCharsPerToken,
  createInitialState,
  currentNode,
  messageChars,
  latestSessionId,
  listSessions,
  loadSessionInto,
  maxContextTokensFor,
  modelSpecString,
  pathToRoot,
  readSavedCustomModel,
  readSavedModelSpec,
  saveCustomModel,
  saveModelSpec,
  saveSession,
  sessionFileExists,
  sessionsDir,
  shouldAutoCompact,
  switchTo,
  transformContext,
} from "../src/context/index.js";
import { convertToLlm } from "../src/agent/convert.js";
import { mapMacHotkey } from "../src/tools/darwin-cu.js";
import { toOpenAiMessages } from "../src/providers/openai.js";
import { createMockStream } from "../src/providers/mock.js";
import {
  lookupContextWindow,
  lookupKnownContextWindow,
  parseModelSpec,
  resolveModel,
} from "../src/providers/index.js";
import type { StreamEvent, StreamFn, StreamOptions } from "../src/providers/types.js";
import { allTools, bashTool, editTool, globTool, grepTool, readTool, resolveShell, writeTool, type ToolName } from "../src/tools/index.js";
import type { Tool } from "../src/tools/types.js";
import { ok } from "../src/tools/types.js";
import { globToRegExp, matchesGlob } from "../src/tools/glob-matcher.js";
import { validateParams } from "../src/tools/validate.js";
import { buildSeedMessages, readGitSnapshot, DEFAULT_PREFILL_COMMIT } from "../src/session.js";
import { buildApprovalDetail } from "../desktop/main/approval-diff.js";
import { createPrintOutput } from "../src/ui/print.js";
import { createMarkdownStream, renderMarkdown } from "../src/ui/markdown.js";
import type {
  AgentMessage,
  AssistantMessage,
  ModelRef,
  ToolCallContent,
} from "../src/types.js";
import { emptyUsage } from "../src/types.js";

import { test } from "./registry.js";

/** 取工具结果内容里的全部文本（content 现在可能含 screenshot 返回的图片块） */
function resultText(content: { type: string; text?: string }[]): string {
  return content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
}
// 加载子用例文件：import 时它们就调 test() 把自己注册进 registry。
// 这一段就是子用例的唯一接线点；加新分类的子文件时，加一行 import 就够了。
import "./cli-print.js";
import "./repl-loop.js";
import "./pillars.js";
import "./provider-mock.js";
import "./display-connector.js";
import "./ws-bridge.js";
import "./bot-runner.js";
import "./bot-weixin.js";

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
  assert.match(resultText(full.content), /1\tone/);

  const part = await readTool.execute(
    { path: "a.txt", offset: 2, limit: 2 },
    { cwd: dir, signal: noSignal() },
  );
  const text = resultText(part.content);
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
  assert.match(resultText(dup.content), /出现 2 次/);

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
  assert.match(resultText(good.content), /bash-ok/);

  const bad = await bashTool.execute(
    { command: "exit 3" },
    { cwd: dir, signal: noSignal() },
  );
  assert.equal(bad.isError, true);
  assert.match(resultText(bad.content), /退出码 3/);

  const slow = await bashTool.execute(
    { command: "sleep 5", timeout: 1000 },
    { cwd: dir, signal: noSignal() },
  );
  assert.equal(slow.isError, true);
  assert.match(resultText(slow.content), /超时/);
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
  const listedText = resultText(listed.content);
  assert.match(listedText, /src\/index\.ts/);
  assert.match(listedText, /src\/lib\/util\.ts/);
  assert.doesNotMatch(listedText, /README\.md/);

  const found = await grepTool.execute(
    { pattern: "function\\s+target", include: "**/*.ts" },
    { cwd: dir, signal: noSignal() },
  );
  assert.match(resultText(found.content), /src\/lib\/util\.ts:1/);

  const none = await grepTool.execute(
    { pattern: "not-there-anywhere" },
    { cwd: dir, signal: noSignal() },
  );
  assert.equal(none.isError, false);
  assert.match(resultText(none.content), /没有匹配/);
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

test("transformContext: 迟滞裁剪——总量落在迟滞带内不裁，超触发线一次裁到目标线", () => {
  const makeState = () => {
    const state = createInitialState({
      cwd: process.cwd(),
      model: { provider: "mock", id: "mock-1" },
      tools: allTools,
    });
    for (let i = 0; i < 3; i++) {
      appendNode(state, { role: "user", content: "x".repeat(3000), timestamp: 0 });
      appendNode(state, {
        role: "assistant",
        content: [{ type: "text", text: "y".repeat(3000) }],
        model: "m",
        stopReason: "stop",
        usage: emptyUsage(),
        timestamp: 0,
      });
    }
    return state;
  };

  // 迟滞带内的预算线：maxContextTokens 使 0.7B < total < 0.85B → 不应裁剪
  const bandState = makeState();
  const bandTotal =
    bandState.systemPrompt.length +
    bandState.messages.reduce((n, m) => n + messageChars(m), 0);
  const bandOptions = {
    reservedTokens: 0,
    keepRecentTurns: 1,
    maxToolResultChars: 4000,
    trimTriggerRatio: 0.85,
    trimTargetRatio: 0.7,
  };
  const bandCtx = transformContext(bandState, {
    ...bandOptions,
    maxContextTokens: Math.ceil(bandTotal / 0.8 / 3.5), // total = 0.8 × 预算
  });
  assert.equal(
    bandCtx.droppedMessages,
    0,
    "总量落在迟滞带（70%~85%）内不应裁剪——保住前缀缓存",
  );

  // 超触发线：total ≈ 0.95 × 预算（> 0.85 触发线）→ 触发裁剪；
  // 目标线 = 0.7 × 预算 ≈ 0.735 × total，丢一轮后应降到目标线以下即收手
  const overState = makeState();
  const overCtx = transformContext(overState, {
    ...bandOptions,
    maxContextTokens: Math.ceil(bandTotal / 1.05 / 3.5),
  });
  assert.ok(overCtx.droppedMessages > 0, "超触发线应当裁剪");
  const overTotal =
    overCtx.systemPrompt.length +
    overCtx.messages.reduce((n, m) => n + messageChars(m), 0);
  const target = (bandTotal / 1.05) * 0.7;
  assert.ok(
    overTotal <= target,
    "裁剪应一次降到目标线以下，而不是裁到刚好贴线",
  );
  assert.ok(
    overCtx.messages[overCtx.messages.length - 1]?.role === "assistant",
    "最后一轮必须保住",
  );
});

test("transformContext: 旧轮超长成功工具结果替换成指针，error 结果仍截断", () => {
  const state = createInitialState({
    cwd: process.cwd(),
    model: { provider: "mock", id: "mock-1" },
    tools: allTools,
  });
  const long = "z".repeat(2000);
  // 第 1 轮：一个超长成功结果 + 一个超长 error 结果；后面垫两轮把第 1 轮推进旧区
  appendNode(state, { role: "user", content: "t1", timestamp: 0 });
  appendNode(state, {
    role: "assistant",
    content: [
      { type: "toolCall", id: "a1", name: "read", arguments: { path: "x.ts" } },
      { type: "toolCall", id: "a2", name: "bash", arguments: { command: "ls" } },
    ],
    model: "m",
    stopReason: "toolUse",
    usage: emptyUsage(),
    timestamp: 0,
  });
  appendNode(state, { role: "toolResult", toolCallId: "a1", toolName: "read", content: [{ type: "text", text: long }], isError: false, timestamp: 0 });
  appendNode(state, { role: "toolResult", toolCallId: "a2", toolName: "bash", content: [{ type: "text", text: long }], isError: true, timestamp: 0 });
  for (let i = 0; i < 2; i++) {
    appendNode(state, { role: "user", content: `t${i + 2}`, timestamp: 0 });
    appendNode(state, {
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      model: "m",
      stopReason: "stop",
      usage: emptyUsage(),
      timestamp: 0,
    });
  }

  const ctx = transformContext(state, {
    maxContextTokens: 1_000_000, // 预算给足，只测压缩不测裁剪
    reservedTokens: 8_000,
    keepRecentTurns: 2,
    maxToolResultChars: 500,
    trimTriggerRatio: 0.85,
    trimTargetRatio: 0.7,
  });

  const success = ctx.messages.find(
    (m) => m.role === "toolResult" && m.toolCallId === "a1",
  );
  assert.ok(success && success.role === "toolResult");
  const successText = resultText(success.content);
  assert.match(successText, /工具结果已省略/);
  assert.match(successText, /read/);
  assert.match(successText, /2000 字符/);
  assert.ok(successText.length < 120, "占位指针应远短于原结果");

  const err = ctx.messages.find(
    (m) => m.role === "toolResult" && m.toolCallId === "a2",
  );
  assert.ok(err && err.role === "toolResult");
  const errText = resultText(err.content);
  assert.doesNotMatch(errText, /工具结果已省略/, "error 结果不替换成指针");
  assert.ok(errText.length <= 600, "error 结果仍走头尾截断");

  assert.equal(ctx.prunedToolResults, 2, "两条超长结果都计入 prunedToolResults");
});

test("context: calibrateCharsPerToken 用真实 usage 修正 chars/token 口径", () => {
  const state = createInitialState({
    cwd: process.cwd(),
    model: { provider: "mock", id: "mock-1" },
    tools: allTools,
  });
  assert.equal(state.observedCharsPerToken, undefined);

  calibrateCharsPerToken(state, 4200, 1000); // 观测 4.2，首次直接采纳
  assert.ok(Math.abs((state.observedCharsPerToken ?? 0) - 4.2) < 1e-9);

  calibrateCharsPerToken(state, 3000, 1000); // 观测 3.0，EMA 往下拉
  const after = state.observedCharsPerToken ?? 0;
  assert.ok(after < 4.2 && after > 3.0, "EMA 应介于新旧观测之间");

  const before = state.observedCharsPerToken;
  calibrateCharsPerToken(state, 100, 1000); // 0.1 < 下界，异常观测丢弃
  calibrateCharsPerToken(state, 0, 1000); // 无效输入 no-op
  calibrateCharsPerToken(state, 1000, 0);
  assert.equal(state.observedCharsPerToken, before, "异常观测不污染口径");
});

test("context: isContextOverflowError 识别各家长度超限报错，不误判普通错误", () => {
  assert.equal(isContextOverflowError(undefined), false);
  assert.equal(isContextOverflowError(""), false);
  assert.equal(
    isContextOverflowError("Error: This model's maximum context length is 8192 tokens"),
    true,
    "openai 口径",
  );
  assert.equal(isContextOverflowError("prompt is too long: 250000 tokens > 200000 maximum"), true, "anthropic 口径");
  assert.equal(isContextOverflowError("context_length_exceeded"), true, "openai 错误码");
  assert.equal(
    isContextOverflowError(
      "400 The input token count (250000) exceeds the maximum number of tokens allowed (200000).",
    ),
    true,
    "gemini 口径",
  );
  assert.equal(isContextOverflowError("连接超时"), false, "普通错误不误判");
  assert.equal(isContextOverflowError("工具参数校验失败"), false);
});

test("context: 模型报上下文超限 → 按 60% 预算重裁重试一次（失败驱动降档）", async () => {
  const state = createInitialState({
    cwd: process.cwd(),
    model: { provider: "mock", id: "mock-1" },
    tools: allTools,
  });
  // 4 个大轮次 + 待处理的 user 消息：全量 ≈ 20k 字符
  for (let i = 0; i < 4; i++) {
    appendNode(state, { role: "user", content: "x".repeat(2500), timestamp: 0 });
    appendNode(state, {
      role: "assistant",
      content: [{ type: "text", text: "y".repeat(2500) }],
      model: "m",
      stopReason: "stop",
      usage: emptyUsage(),
      timestamp: 0,
    });
  }

  let calls = 0;
  const callSizes: number[] = [];
  const stream: StreamFn = async function* (options) {
    calls += 1;
    callSizes.push(options.messages.length);
    if (calls === 1) {
      const overflow: AssistantMessage = {
        role: "assistant",
        content: [],
        model: "mock:mock-1",
        stopReason: "error",
        errorMessage: "Error: This model's maximum context length is 8192 tokens",
        usage: emptyUsage(),
        timestamp: 0,
      };
      yield { type: "error", reason: "error", error: overflow };
      return;
    }
    yield { type: "done", reason: "stop", message: textOnly("完成") };
  };

  const events: AgentEvent[] = [];
  const agent = new Agent({
    state,
    stream,
    onEvent: (e) => {
      events.push(e);
    },
    maxStreamRetries: 0, // 关掉朴素重试，隔离出降档重试的信号
    autoCompact: false, // 关掉自动压缩，隔离出降档重试的信号（否则会先走摘要路径）
    transform: { maxContextTokens: 7000, reservedTokens: 100 },
  });
  agent.enqueueUser("继续");
  await agent.run();

  assert.equal(calls, 2, "应恰好调用两次模型（超限一次 + 降档后一次）");
  assert.ok(callSizes[0] !== undefined && callSizes[1] !== undefined);
  assert.ok(
    (callSizes[1] ?? 0) < (callSizes[0] ?? 0),
    `降档后送出的消息应更少（${callSizes[0]} → ${callSizes[1]}）`,
  );
  const notices = events.filter((e) => e.type === "notice");
  assert.ok(
    notices.some((e) => e.type === "notice" && /上下文超限/.test(e.message)),
    "降档应发 notice 告知",
  );
  const last = state.messages[state.messages.length - 1];
  assert.ok(last?.role === "assistant" && state.messages.some((m) => m.role === "assistant" && m.content[0]?.type === "text" && m.content[0].text === "完成"));
});

test("context: Agent.compact 把历史摘要写回会话树新 Root，旧分支保留", async () => {
  const state = createInitialState({
    cwd: process.cwd(),
    model: { provider: "mock", id: "mock-1" },
    tools: allTools,
  });
  appendNode(state, { role: "user", content: "帮我改 a.ts", timestamp: 0 });
  appendNode(state, {
    role: "assistant",
    content: [{ type: "text", text: "已修改" }],
    model: "m",
    stopReason: "stop",
    usage: emptyUsage(),
    timestamp: 0,
  });
  const oldRootId = state.rootId;
  const oldNodeCount = state.nodes.size;

  let compactCallMessages: ReturnType<typeof convertToLlm> = [];
  const stream: StreamFn = async function* (options) {
    compactCallMessages = options.messages;
    yield { type: "done", reason: "stop", message: textOnly("用户要求改 a.ts，已完成") };
  };
  const agent = new Agent({ state, stream });

  const done = await agent.compact();
  assert.equal(done, true);
  const llmText = (m: (typeof compactCallMessages)[number] | undefined): string => {
    const c = m?.content;
    if (typeof c === "string") return c;
    return (c ?? [])
      .map((p) => ("text" in p ? p.text : ""))
      .join("");
  };
  assert.match(
    llmText(compactCallMessages[compactCallMessages.length - 1]),
    /压缩成一份摘要/,
    "摘要指令应作为最后一条 user 消息发出",
  );
  assert.ok((compactCallMessages.length ?? 0) >= 2, "摘要请求应携带完整历史");

  assert.equal(state.messages.length, 1, "压缩后线性视图只剩摘要一条");
  const compactRoot = state.messages[0];
  assert.ok(compactRoot?.role === "user");
  assert.match(compactRoot.content, /前文对话摘要/);
  assert.match(compactRoot.content, /改 a\.ts/, "摘要正文应在新 Root 消息里");
  assert.notEqual(state.rootId, oldRootId, "应建立新 Root");
  assert.equal(state.nodes.size, oldNodeCount + 1, "旧分支节点保留在树中");
  assert.equal(state.currentNodeId, state.rootId, "★ 推进到摘要节点");

  // 压缩失败路径：模型报错 → 状态原样不动。
  // maxStreamRetries: 0——本用例不关心重试，0 免去退避等待（且避免 unref 缺失时
  // 裸测试进程多活 200ms）。
  const before = { rootId: state.rootId, count: state.nodes.size, messages: state.messages.length };
  const failAgent = new Agent({
    state,
    stream: async function* () {
      yield {
        type: "error",
        reason: "error",
        error: { ...textOnly(""), stopReason: "error" as const, errorMessage: "boom" },
      };
    },
    maxStreamRetries: 0,
  });
  assert.equal(await failAgent.compact(), false);
  assert.equal(state.rootId, before.rootId);
  assert.equal(state.nodes.size, before.count);
  assert.equal(state.messages.length, before.messages);
});

// ----------------------------------------------------------------- 自动 compact

test("context: shouldAutoCompact 按迟滞触发线判定，观测口径参与计算", () => {
  const state = createInitialState({
    cwd: process.cwd(),
    model: { provider: "mock", id: "mock-1" },
    tools: allTools,
  });
  const opts = { maxContextTokens: 7000, reservedTokens: 100 };
  assert.equal(shouldAutoCompact(state, opts), false, "空状态不触发");

  // 预算 6900 × 3.5 = 24150 chars，触发线 0.85 ≈ 20527 chars
  appendNode(state, { role: "user", content: "a".repeat(20_000), timestamp: 0 });
  appendNode(state, {
    role: "assistant",
    content: [{ type: "text", text: "b".repeat(2_000) }],
    model: "m",
    stopReason: "stop",
    usage: emptyUsage(),
    timestamp: 0,
  });
  const sysPrompt = state.systemPrompt.length;
  assert.ok(sysPrompt + 22_000 > 24_150 * 0.85, "前置：系统提示词不够小，否则用例无意义");
  assert.equal(shouldAutoCompact(state, opts), true, "越过触发线应触发");

  // 观测口径参与判定：观测 chars/token = 7（偏大）→ 预算字符量翻倍 → 不触发
  state.observedCharsPerToken = 7;
  assert.equal(shouldAutoCompact(state, opts), false, "观测口径偏大时触发线右移");
});

test("context: maxContextTokensFor 由模型窗口推导裁剪预算", () => {
  assert.equal(maxContextTokensFor(128_000), 115_200, "0.9 系数留估算误差余量");
  assert.equal(maxContextTokensFor(1_000_000), 900_000, "1M 窗口模型不再被写死的 120k 卡住");
  assert.equal(maxContextTokensFor(32_000), 28_800, "小窗口模型提前按小预算裁剪");
  assert.equal(maxContextTokensFor(4_096), 16_000, "下限保护：预算不为负（reservedTokens × 2）");
  assert.equal(maxContextTokensFor(17_777), 16_000, "恰在下限附近时取下限");
});

test("providers: lookupContextWindow 粗表命中与兜底", () => {
  assert.equal(lookupContextWindow("claude-3-5-sonnet-20241022"), 200_000);
  assert.equal(lookupContextWindow("gemini-1.5-pro"), 1_000_000);
  assert.equal(lookupContextWindow("mimo-v2.5"), 1_000_000, "MiMo 官方 1M（元数据缺失端点靠粗表兜底）");
  assert.equal(lookupContextWindow("deepseek-chat"), 128_000);
  assert.equal(lookupContextWindow("kimi-k2-0905-preview"), 256_000);
  assert.equal(lookupContextWindow("mock-1"), 32_000);
  assert.equal(lookupContextWindow("totally-unknown-model"), 1_000_000, "用户定调：未知模型 1M 兜底（误判大只浪费余量，误判小白丢历史）");
});

test("providers: lookupKnownContextWindow 严格版——命中才返回，未知 undefined", () => {
  assert.equal(lookupKnownContextWindow("deepseek-chat"), 128_000);
  assert.equal(lookupKnownContextWindow("kimi-k2-0905-preview"), 256_000);
  assert.equal(lookupKnownContextWindow("openai/gpt-4o-mini"), 128_000, "openrouter 前缀 id 不影响家族正则命中");
  assert.equal(lookupKnownContextWindow("totally-unknown-model"), undefined, "未知模型不猜：展示值宁缺毋滥");
  assert.equal(lookupKnownContextWindow("glm-5.3"), undefined, "不在粗表的家族留空");
});

test("providers: resolveModel 统一填充 contextWindow（显式值不覆盖）", () => {
  const filled = resolveModel({ provider: "mock", id: "mock-1" });
  assert.equal(filled.model.contextWindow, 32_000, "缺省按粗表填充");
  const kept = resolveModel({ provider: "mock", id: "mock-1", contextWindow: 555_000 });
  assert.equal(kept.model.contextWindow, 555_000, "调用方显式给的值优先");
});

test("context: 上下文越线自动 compact，抢在机械裁剪之前", async () => {
  const state = createInitialState({
    cwd: process.cwd(),
    model: { provider: "mock", id: "mock-1" },
    tools: allTools,
  });
  // 5 个大轮次 ≈ 30k chars，远超触发线 ≈ 20.5k
  for (let i = 0; i < 5; i++) {
    appendNode(state, { role: "user", content: "x".repeat(3000), timestamp: 0 });
    appendNode(state, {
      role: "assistant",
      content: [{ type: "text", text: "y".repeat(3000) }],
      model: "m",
      stopReason: "stop",
      usage: emptyUsage(),
      timestamp: 0,
    });
  }
  const oldNodeCount = state.nodes.size;

  let calls = 0;
  const prompts: string[] = [];
  const llmText = (m: { content: unknown } | undefined): string => {
    const c = m?.content;
    if (typeof c === "string") return c;
    return ((c ?? []) as { text?: string }[]).map((p) => p.text ?? "").join("");
  };
  const stream: StreamFn = async function* (options) {
    calls += 1;
    prompts.push(llmText(options.messages[options.messages.length - 1]));
    if (calls === 1) {
      yield { type: "done", reason: "stop", message: textOnly("摘要：用户要改 a.ts，已完成") };
      return;
    }
    yield { type: "done", reason: "stop", message: textOnly("完成") };
  };

  const events: AgentEvent[] = [];
  const agent = new Agent({
    state,
    stream,
    onEvent: (e) => {
      events.push(e);
    },
    maxStreamRetries: 0,
    transform: { maxContextTokens: 7000, reservedTokens: 100 },
  });
  agent.enqueueUser("继续");
  await agent.run();

  assert.equal(calls, 2, "应恰好两次模型调用（摘要一次 + 正常回答一次）");
  assert.match(prompts[0] ?? "", /压缩成一份摘要/, "第一次调用应是摘要请求");
  assert.ok(events.some((e) => e.type === "context_compact"), "应发出 context_compact 事件");
  assert.ok(
    !events.some((e) => e.type === "context_pruned"),
    "compact 抢在机械裁剪之前，不应有丢轮次",
  );
  assert.ok(
    events.some((e) => e.type === "notice" && /上下文超限/.test(e.message)) === false,
    "不应走到超限降档",
  );
  // 压缩后第二次调用只看得到摘要
  assert.equal(state.messages.length, 2, "线性视图 = 摘要 + 最终回答");
  assert.ok(state.messages[0]?.role === "user");
  assert.match(state.messages[0]?.content ?? "", /前文对话摘要/);
  assert.equal(state.nodes.size, oldNodeCount + 3, "旧分支保留；新增继续/摘要/回答三个节点");
});

test("context: 无显式 transform 时 Agent 按模型 contextWindow 推导预算（CLI 路径）", async () => {
  const makeState = (contextWindow?: number) =>
    createInitialState({
      cwd: process.cwd(),
      model: contextWindow === undefined
        ? { provider: "mock", id: "mock-1" }
        : { provider: "mock", id: "mock-1", contextWindow },
      tools: allTools,
    });

  // 6 个大轮次 ≈ 36k chars。小窗口（20k → 预算 18k tokens → 触发线 ≈ 29.7k chars）应触发自动 compact；
  // 无窗口标注（默认 120k 预算）同样的内容远够不着触发线——两条路径唯一差别就是 ModelRef.contextWindow。
  const seed = (state: ReturnType<typeof makeState>): void => {
    for (let i = 0; i < 6; i++) {
      appendNode(state, { role: "user", content: "x".repeat(3000), timestamp: 0 });
      appendNode(state, {
        role: "assistant",
        content: [{ type: "text", text: "y".repeat(3000) }],
        model: "m",
        stopReason: "stop",
        usage: emptyUsage(),
        timestamp: 0,
      });
    }
  };

  const mkAgent = (state: ReturnType<typeof makeState>) => {
    let calls = 0;
    const stream: StreamFn = async function* () {
      calls += 1;
      if (calls === 1) {
        yield { type: "done", reason: "stop", message: textOnly("摘要：用户要改 a.ts，已完成") };
        return;
      }
      yield { type: "done", reason: "stop", message: textOnly("完成") };
    };
    const agent = new Agent({ state, stream, onEvent: () => {}, maxStreamRetries: 0 });
    return { agent, getCalls: () => calls };
  };

  // 小窗口：预算随窗口收缩 → 自动 compact 抢先
  const small = makeState(20_000);
  seed(small);
  const a1 = mkAgent(small);
  a1.agent.enqueueUser("继续");
  await a1.agent.run();
  assert.equal(a1.getCalls(), 2, "小窗口模型应触发自动 compact（摘要 + 回答两次调用）");

  // 无标注：默认 120k 预算，同样内容不触发
  const plain = makeState();
  seed(plain);
  const a2 = mkAgent(plain);
  a2.agent.enqueueUser("继续");
  await a2.agent.run();
  assert.equal(a2.getCalls(), 1, "默认预算下同样的内容够不着触发线");
});

test("context: 自动 compact 失败 → 本次 run 停用并落回机械裁剪", async () => {
  const state = createInitialState({
    cwd: process.cwd(),
    model: { provider: "mock", id: "mock-1" },
    tools: allTools,
  });
  for (let i = 0; i < 5; i++) {
    appendNode(state, { role: "user", content: "x".repeat(3000), timestamp: 0 });
    appendNode(state, {
      role: "assistant",
      content: [{ type: "text", text: "y".repeat(3000) }],
      model: "m",
      stopReason: "stop",
      usage: emptyUsage(),
      timestamp: 0,
    });
  }

  let calls = 0;
  const prompts: string[] = [];
  const llmText = (m: { content: unknown } | undefined): string => {
    const c = m?.content;
    if (typeof c === "string") return c;
    return ((c ?? []) as { text?: string }[]).map((p) => p.text ?? "").join("");
  };
  const stream: StreamFn = async function* (options) {
    calls += 1;
    prompts.push(llmText(options.messages[options.messages.length - 1]));
    if (calls === 1) {
      yield {
        type: "error",
        reason: "error",
        error: { ...textOnly(""), stopReason: "error" as const, errorMessage: "boom" },
      };
      return;
    }
    yield { type: "done", reason: "stop", message: textOnly("完成") };
  };

  const events: AgentEvent[] = [];
  const agent = new Agent({
    state,
    stream,
    onEvent: (e) => {
      events.push(e);
    },
    maxStreamRetries: 0, // 本用例不关心重试：0 免去退避等待
    transform: { maxContextTokens: 7000, reservedTokens: 100 },
  });
  agent.enqueueUser("继续");
  await agent.run();

  assert.equal(calls, 2, "摘要失败只尝试一次，之后正常回答");
  assert.equal(
    prompts.filter((p) => /压缩成一份摘要/.test(p)).length,
    1,
    "本次 run 内不应重试摘要",
  );
  assert.ok(
    events.some((e) => e.type === "notice" && /自动压缩未成功/.test(e.message)),
    "失败应发 notice 告知",
  );
  assert.ok(events.some((e) => e.type === "context_pruned"), "机械裁剪兜底生效");
  assert.ok(!events.some((e) => e.type === "context_compact"), "失败路径不应发出压缩事件");
  const last = state.messages[state.messages.length - 1];
  assert.ok(
    last?.role === "assistant" &&
      state.messages.some(
        (m) => m.role === "assistant" && m.content[0]?.type === "text" && m.content[0].text === "完成",
      ),
  );
});

// ----------------------------------------------------------------- 树状

test("tree: appendNode 推进 ★ Current Node 且 messages 同步", () => {
  const state = createInitialState({
    cwd: process.cwd(),
    model: { provider: "mock", id: "mock-1" },
    tools: allTools,
  });
  const u = appendNode(state, { role: "user", content: "hi", timestamp: 0 });
  assert.equal(state.currentNodeId, u.id);
  assert.equal(state.rootId, u.id);
  assert.equal(state.nodes.size, 1);
  assert.deepEqual(state.messages.map((m) => m.content), ["hi"]);

  const a = appendNode(state, { role: "assistant", content: [{ type: "text", text: "yo" }], model: "mock", stopReason: "stop", usage: emptyUsage(), timestamp: 1 });
  assert.equal(state.currentNodeId, a.id);
  assert.equal(a.parent, u.id);
  assert.equal(u.children.length, 1);
  assert.equal(u.children[0], a.id);
  assert.deepEqual(
    state.messages.map((m) => m.role),
    ["user", "assistant"],
  );
  assert.equal(state.nodes.size, 2);
});

test("tree: addNodeAt 可创建分支，且 ★ 切换会同步 messages", () => {
  const state = createInitialState({
    cwd: process.cwd(),
    model: { provider: "mock", id: "mock-1" },
    tools: allTools,
  });

  const u1 = appendNode(state, { role: "user", content: "u1", timestamp: 1 });
  const a1 = appendNode(state, {
    role: "assistant",
    content: [{ type: "text", text: "a1" }],
    model: "m",
    stopReason: "stop",
    usage: emptyUsage(),
    timestamp: 2,
  });

  // 在 a1 下开一个新的 user 节点（不和 a1 默认的「下一条线性」冲突）
  const u_branch = addNodeAt(state, a1.id, { role: "user", content: "u-branch", timestamp: 3 });
  assert.equal(u_branch.parent, a1.id);
  assert.equal(state.currentNodeId, u_branch.id);
  assert.equal(state.messages.length, 3);

  // 切回 a1：messages 应同步成 [u1, a1]
  switchTo(state, a1.id);
  assert.equal(state.currentNodeId, a1.id);
  assert.deepEqual(
    state.messages.map((m) => m.role),
    ["user", "assistant"],
  );

  // 在 a1 下追加新的 user 节点——和 u_branch 平起平坐
  const u_main = appendNode(state, { role: "user", content: "u-main", timestamp: 4 });
  assert.equal(u_main.parent, a1.id);
  assert.equal(a1.children.length, 2);

  // 再切回 u_branch：messages 应同步成 [u1, a1, u_branch]
  switchTo(state, u_branch.id);
  assert.equal(state.messages.length, 3);
  assert.equal(state.messages[2]?.role, "user");
  assert.equal(
    (state.messages[2] as { content: string }).content,
    "u-branch",
  );

  // u1 永远只有一个 a1 子节点
  assert.equal(u1.children.length, 1);
  assert.equal(u1.children[0], a1.id);
});

test("tree: 兼容路径——直接赋值 messages 时 activeBranch fallback", () => {
  const state = createInitialState({
    cwd: process.cwd(),
    model: { provider: "mock", id: "mock-1" },
    tools: allTools,
  });
  // 没有走 appendNode，直接 push messages（模拟老写法 / 把兼容路径用起来）
  state.messages.push({ role: "user", content: "u", timestamp: 0 });
  state.messages.push({ role: "assistant", content: [{ type: "text", text: "a" }], model: "mock", stopReason: "stop", usage: emptyUsage(), timestamp: 1 });
  // currentNodeId 仍是 null，activeBranch 应回退到 messages 数组
  assert.equal(state.currentNodeId, null);
  assert.equal(state.nodes.size, 0);
  assert.deepEqual(
    activeBranch(state).map((m) => m.role),
    ["user", "assistant"],
  );
});

test("tree: pathToRoot 安全处理坏 id", () => {
  const state = createInitialState({
    cwd: process.cwd(),
    model: { provider: "mock", id: "mock-1" },
    tools: allTools,
  });
  appendNode(state, { role: "user", content: "u", timestamp: 0 });
  // 不存在的 id：应当返回 [] 而不抛错
  assert.deepEqual(pathToRoot(state, "non-existent"), []);
  assert.deepEqual(pathToRoot(state, null), []);
});

// --------------------------------------------------- prompts 注入

test("prompts: createInitialState 不传 append 时与原行为一致", () => {
  const state = createInitialState({
    cwd: process.cwd(),
    model: { provider: "mock", id: "mock-1" },
    tools: allTools,
  });
  // 没传 append 时 systemPrompt 就是 buildSystemPrompt 默认值
  assert.ok(state.systemPrompt.includes("你是一个在终端里工作的编码代理。"));
  assert.ok(!state.systemPrompt.includes("# 追加指令"));
});

test("prompts: 默认系统提示词要求闲聊/打招呼不调用工具", () => {
  const state = createInitialState({
    cwd: process.cwd(),
    model: { provider: "mock", id: "mock-1" },
    tools: allTools,
  });
  assert.ok(state.systemPrompt.includes("直接用文字回答，一个工具都不要调用"));
  // 全量工具下，grep/glob 在场 → 用定位式规则，不再写通用兜底句
  assert.ok(state.systemPrompt.includes("查找优先用 grep / glob 定位"));
  assert.ok(!state.systemPrompt.includes("只有任务涉及读代码、查文件、改文件或跑命令时才动手"));
});

test("prompts: guidelines 按工具集动态生成（学 pi）", () => {
  const makePrompt = (toolNames: string[]) =>
    createInitialState({
      cwd: process.cwd(),
      model: { provider: "mock", id: "mock-1" },
      tools: allTools.filter((t) => toolNames.includes(t.name)),
    }).systemPrompt;

  // 只有 bash：不出现 grep/glob 与 edit/write 规则，bash 规则在
  const bashOnly = makePrompt(["bash"]);
  assert.ok(bashOnly.includes("只有任务涉及读代码、查文件、改文件或跑命令时才动手"));
  assert.ok(bashOnly.includes("运行命令用 bash"));
  assert.ok(!bashOnly.includes("grep / glob"));
  assert.ok(!bashOnly.includes("edit 做精确替换"));

  // 没有 bash：bash 规则消失
  const noBash = makePrompt(["read", "edit", "write"]);
  assert.ok(!noBash.includes("运行命令用 bash"));
  assert.ok(noBash.includes("edit 做精确替换"));

  // 工具全缺：只剩恒定规则，可用工具列表为空
  const none = makePrompt([]);
  assert.ok(none.includes("直接用文字回答，一个工具都不要调用"));
  assert.ok(none.includes("可用工具：") && none.endsWith("可用工具："));
});

test("prompts: maturity strong 时纪律规则消失，budget/缺省保留（设计哲学）", () => {
  const makePrompt = (maturity?: "strong" | "budget") =>
    createInitialState({
      cwd: process.cwd(),
      model: { provider: "mock", id: "mock-1", maturity },
      tools: allTools,
    }).systemPrompt;

  // 缺省 = budget：纪律规则在
  assert.ok(makePrompt(undefined).includes("直接用文字回答，一个工具都不要调用"));
  assert.ok(makePrompt("budget").includes("直接用文字回答，一个工具都不要调用"));

  // strong：闲聊规则与兜底句都消失，工具条件规则（效率/偏好类）保留
  const strong = makePrompt("strong");
  assert.ok(!strong.includes("直接用文字回答，一个工具都不要调用"));
  assert.ok(!strong.includes("只有任务涉及读代码、查文件、改文件或跑命令时才动手"));
  assert.ok(strong.includes("查找优先用 grep / glob 定位"));
  assert.ok(strong.includes("edit 做精确替换"));
  assert.ok(strong.includes("运行命令用 bash"));
});

test("providers: parseModelSpec 支持末段 :strong/:budget 档位", () => {
  const strong = parseModelSpec("openai:gpt-5.2:strong");
  assert.equal(strong.id, "gpt-5.2");
  assert.equal(strong.maturity, "strong");
  const budget = parseModelSpec("mock:mock-1:budget");
  assert.equal(budget.id, "mock-1");
  assert.equal(budget.maturity, "budget");
  // 非档位末段仍当作 id 一部分
  const plain = parseModelSpec("openai:gpt-4o-mini");
  assert.equal(plain.id, "gpt-4o-mini");
  assert.equal(plain.maturity, undefined);
});

test("providers: parseModelSpec 识别厂商预设（baseUrl / key env / 别名 / 无 key 端点）", () => {
  const saved = process.env["DEEPSEEK_API_KEY"];
  const savedZen = process.env["OPENCODE_API_KEY"];
  const savedGo = process.env["OPENCODE_GO_API_KEY"];
  try {
    // 有 key：厂商前缀 → 对应 provider + 默认 baseUrl + key env
    process.env["DEEPSEEK_API_KEY"] = "sk-test";
    const ds = parseModelSpec("deepseek:deepseek-chat");
    assert.equal(ds.provider, "deepseek");
    assert.equal(ds.id, "deepseek-chat");
    assert.equal(ds.baseUrl, "https://api.deepseek.com/v1");
    assert.equal(ds.apiKey, "sk-test");

    // 只写前缀：回退厂商默认模型（别名 kimi → moonshot）
    const bare = parseModelSpec("kimi:");
    assert.equal(bare.provider, "moonshot");
    assert.equal(bare.id, "kimi-k2-0905-preview");

    // opencode（OpenCode Zen，别名 zen）：默认模型 + key env
    process.env["OPENCODE_API_KEY"] = "sk-zen-test";
    const zen = parseModelSpec("zen:");
    assert.equal(zen.provider, "opencode");
    assert.equal(zen.id, "glm-5.3");
    assert.equal(zen.baseUrl, "https://opencode.ai/zen/v1");
    assert.equal(zen.apiKey, "sk-zen-test");

    // opencode-go（OpenCode Go 订阅通道，别名 go）：base 带 /zen 段，key env 独立
    process.env["OPENCODE_GO_API_KEY"] = "sk-go-test";
    const go = parseModelSpec("go:");
    assert.equal(go.provider, "opencode-go");
    assert.equal(go.id, "glm-5.1");
    assert.equal(go.baseUrl, "https://opencode.ai/zen/go/v1");
    assert.equal(go.apiKey, "sk-go-test");

    // 缺 key 降级提示用预设表的真实 env 名（id 带 "-"，不能从 provider 推导）
    delete process.env["OPENCODE_GO_API_KEY"];
    const goDegraded = resolveModel(parseModelSpec("go:"));
    assert.ok(goDegraded.degraded?.includes("OPENCODE_GO_API_KEY"));
    process.env["OPENCODE_GO_API_KEY"] = "sk-go-test";

    // ollama 本地端点：无需 key，填占位 key 不降级
    const local = parseModelSpec("ollama:qwen3");
    assert.equal(local.provider, "ollama");
    assert.equal(local.baseUrl, "http://localhost:11434/v1");
    assert.ok((local.apiKey ?? "").length > 0);
    const resolvedLocal = resolveModel(local);
    assert.equal(resolvedLocal.degraded, undefined);

    // 缺 key：stream 换成 mock，ModelRef 保留原样（providers/doc/README.md 约定），提示里带正确的 env 名
    delete process.env["DEEPSEEK_API_KEY"];
    const degraded = resolveModel(parseModelSpec("deepseek:deepseek-chat"));
    assert.equal(degraded.model.provider, "deepseek");
    assert.ok(degraded.degraded?.includes("DEEPSEEK_API_KEY"));
  } finally {
    if (saved !== undefined) process.env["DEEPSEEK_API_KEY"] = saved;
    else delete process.env["DEEPSEEK_API_KEY"];
    if (savedZen !== undefined) process.env["OPENCODE_API_KEY"] = savedZen;
    else delete process.env["OPENCODE_API_KEY"];
    if (savedGo !== undefined) process.env["OPENCODE_GO_API_KEY"] = savedGo;
    else delete process.env["OPENCODE_GO_API_KEY"];
  }
});

test("prompts: appendSystemPrompt 会在默认系统提示词后追加 # 追加指令 段", () => {
  const state = createInitialState({
    cwd: process.cwd(),
    model: { provider: "mock", id: "mock-1" },
    tools: allTools,
    appendSystemPrompt: "只能用一句话回答。",
  });
  assert.ok(state.systemPrompt.includes("# 追加指令"));
  assert.ok(state.systemPrompt.endsWith("只能用一句话回答。"));
});

test("prompts: appendSystemPrompt 空字符串等同未传，不会污染默认段", () => {
  const state = createInitialState({
    cwd: process.cwd(),
    model: { provider: "mock", id: "mock-1" },
    tools: allTools,
    appendSystemPrompt: "",
  });
  assert.ok(!state.systemPrompt.includes("# 追加指令"));
});

test("prompts: systemPrompt 完整替换默认；append 在替换值之后仍生效", () => {
  const state = createInitialState({
    cwd: process.cwd(),
    model: { provider: "mock", id: "mock-1" },
    tools: allTools,
    systemPrompt: "你是复读机，只回显用户输入。",
    appendSystemPrompt: "末尾规则。",
  });
  // 被替换的默认字符不应出现
  assert.ok(!state.systemPrompt.includes("你是一个在终端里工作的编码代理。"));
  // 替换值 + 追加段都应在
  assert.ok(state.systemPrompt.startsWith("你是复读机"));
  assert.ok(state.systemPrompt.endsWith("末尾规则。"));
});

test("prompts: seedMessages 把 user / assistant 注入到会话树最前面", () => {
  const state = createInitialState({
    cwd: process.cwd(),
    model: { provider: "mock", id: "mock-1" },
    tools: allTools,
    seedMessages: [
      { role: "user", content: "你好" },
      { role: "assistant", content: "在的。" },
    ],
  });
  assert.equal(state.messages.length, 2);
  assert.equal(state.messages[0]?.role, "user");
  assert.equal(state.messages[1]?.role, "assistant");
  // ★ 推进到 assistant 节点
  const current = currentNode(state);
  assert.ok(current?.message.role === "assistant");
  assert.equal(state.rootId !== null, true);
});

test("prompts: transformContext 能看到 seedMessages 注入的 prefill", () => {
  const state = createInitialState({
    cwd: process.cwd(),
    model: { provider: "mock", id: "mock-1" },
    tools: allTools,
    seedMessages: [
      { role: "user", content: "u" },
      { role: "assistant", content: "好的，" },
    ],
  });
  const ctx = transformContext(state);
  // prefill 不能凭空出现；必须有 user 开头
  assert.equal(ctx.messages[0]?.role, "user");
  // prefill 必须出现在 user 之后
  assert.ok(ctx.messages.some((m) => m.role === "assistant"));
});

test("prompts: appendSystemPrompt 与 seedMessages 同时使用，互不冲突", () => {
  const state = createInitialState({
    cwd: process.cwd(),
    model: { provider: "mock", id: "mock-1" },
    tools: allTools,
    appendSystemPrompt: "末尾规则。",
    seedMessages: [{ role: "user", content: "你好" }],
  });
  assert.ok(state.systemPrompt.includes("# 追加指令"));
  assert.ok(state.systemPrompt.endsWith("末尾规则。"));
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0]?.role === "user" ? state.messages[0].content : "", "你好");
});

// -------------------- CLI: --prefill-commit 配置 --------------------

test("cli: buildSeedMessages --assistant-prompt 不传 prefillCommit 时用默认接续消息", () => {
  const { seeds, error } = buildSeedMessages({
    userPrompt: "用一句话回答",
    assistantPrompt: "好的，",
    positional: "",
    prefillCommit: null,
  });
  assert.equal(error, undefined);
  assert.equal(seeds.length, 3);
  assert.equal(seeds[0]?.content, "用一句话回答");
  assert.equal(seeds[1]?.content, "好的，");
  assert.equal(seeds[2]?.content, DEFAULT_PREFILL_COMMIT);
  assert.equal(seeds[2]?.content, "[c-agent prefill] 请基于上一条助手消息继续。");
});

test("cli: buildSeedMessages 自定义 prefillCommit 完整替换默认接续消息", () => {
  const { seeds, error } = buildSeedMessages({
    userPrompt: "u",
    assistantPrompt: "好的，",
    positional: "",
    prefillCommit: "--- PLEASE CONTINUE FROM HERE ---",
  });
  assert.equal(error, undefined);
  assert.equal(seeds.length, 3);
  assert.equal(seeds[2]?.role, "user");
  if (seeds[2]?.role === "user") assert.equal(seeds[2].content, "--- PLEASE CONTINUE FROM HERE ---");
  // 不应再包含默认的那条中文消息
  assert.ok(!seeds.some((s) => s.content === DEFAULT_PREFILL_COMMIT));
});

test("cli: buildSeedMessages 传空串 prefillCommit 表示「跳过接续消息」", () => {
  const { seeds, error } = buildSeedMessages({
    userPrompt: "u",
    assistantPrompt: "好的，",
    positional: "",
    prefillCommit: "",
  });
  assert.equal(error, undefined);
  // 只有 user + assistant 两条，prefill 后不追加任何东西
  assert.equal(seeds.length, 2);
  assert.equal(seeds[0]?.role, "user");
  assert.equal(seeds[1]?.role, "assistant");
});

test("cli: buildSeedMessages 不传 assistantPrompt 时 prefillCommit 没有意义也不生效", () => {
  // 只有 user 提示词；不应该被强行追加 prefillCommit
  const { seeds, error } = buildSeedMessages({
    userPrompt: "u",
    assistantPrompt: null,
    positional: "",
    prefillCommit: "这条不该出现",
  });
  assert.equal(error, undefined);
  assert.equal(seeds.length, 1);
  assert.equal(seeds[0]?.role, "user");
  if (seeds[0]?.role === "user") assert.equal(seeds[0].content, "u");
});

test("cli: buildSeedMessages 仍拒绝 --user-prompt 与位置参数同时给出", () => {
  const { seeds, error } = buildSeedMessages({
    userPrompt: "u",
    assistantPrompt: null,
    positional: "from positional",
    prefillCommit: null,
  });
  assert.ok(error !== undefined);
  assert.equal(seeds.length, 0);
});

test("cli: buildSeedMessages 仍要求 --assistant-prompt 与 --user-prompt 同用", () => {
  const { error } = buildSeedMessages({
    userPrompt: null,
    assistantPrompt: "孤零零的 prefill",
    positional: "fallback positional",
    prefillCommit: "x",
  });
  assert.ok(error !== undefined);
  assert.match(error ?? /.*/, /--assistant-prompt/);
});

test("cli: 自定义 prefillCommit 真的进了 transformContext 路径", () => {
  // 端到端一次：用 createInitialState 的 seedMessages 拼接，证明消息能传到 LLM 看到的地方
  const state = createInitialState({
    cwd: process.cwd(),
    model: { provider: "mock", id: "mock-1" },
    tools: allTools,
    seedMessages: [
      { role: "user", content: "u" },
      { role: "assistant", content: "好的，" },
      { role: "user", content: ">>> CONTINUE PROMPT <<<" }, // 用户自定义的 commit
    ],
  });
  const out = transformContext(state);
  // 最后一条 user 应该就是 commit 自定义内容
  const last = out.messages[out.messages.length - 1];
  assert.ok(last !== undefined);
  if (last !== undefined && last.role === "user") {
    assert.equal(last.content, ">>> CONTINUE PROMPT <<<");
  } else {
    assert.fail("expected last message to be user");
  }
  // assistant 消息的 content 是 AssistantContent[]，需要从 text 块里取
  function assistantText(m: (typeof out.messages)[number]): string {
    if (m.role !== "assistant") return "";
    return m.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("");
  }
  assert.ok(out.messages.some((m) => assistantText(m) === "好的，"));
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
    onEvent: (e) => {
      events.push(e);
    },
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
  assert.match(resultText(toolResults[0]?.content ?? []), /agent-ok/);

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
  assert.match(resultText(toolResults[0]?.content ?? []), /未知工具/);
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

test("端到端：串行工具间隙的中途插话会打断剩余调用（pi 式 steering）", async () => {
  const dir = await tempDir();
  const model: ModelRef = { provider: "mock", id: "mock-1" };
  const slowTool: Tool = {
    name: "slow",
    description: "执行期间插话的 mutating 工具（强制串行，制造工具间隙）",
    parameters: {
      type: "object",
      properties: { tag: { type: "string" } },
      required: ["tag"],
    },
    isMutating: true,
    async execute(args, _ctx) {
      void _ctx;
      // 第一个工具执行期间用户插话：剩余调用应被跳过
      if (args["tag"] === "a") agent.steer("改方向");
      return ok(`slow:${String(args["tag"])}`);
    },
  };
  const state = createInitialState({ cwd: dir, model, tools: [slowTool] });
  const events: AgentEvent[] = [];

  const toolCall = (id: string, tag: string): ToolCallContent => ({
    type: "toolCall",
    id,
    name: "slow",
    arguments: { tag },
  });
  const assistantWith = (calls: ToolCallContent[]): AssistantMessage => ({
    role: "assistant",
    content: calls,
    model: "mock:mock-1",
    stopReason: "toolUse",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    timestamp: Date.now(),
  });

  let round = 0;
  const stream: StreamFn = async function* (_options: StreamOptions) {
    void _options;
    round += 1;
    if (round > 1) {
      yield { type: "done", reason: "stop", message: textOnly("已按新指令调整") };
      return;
    }
    const c1 = toolCall("c1", "a");
    const c2 = toolCall("c2", "b");
    const partial = assistantWith([c1, c2]);
    yield { type: "toolcall_end", toolCall: c1, partial };
    yield { type: "toolcall_end", toolCall: c2, partial };
    yield { type: "done", reason: "toolUse", message: partial };
  };

  const agent = new Agent({
    state,
    stream,
    onEvent: (e) => {
      events.push(e);
    },
  });
  agent.enqueueUser("做两件事");
  await agent.run();

  // 事件：c1 正常结束，c2 被跳过（isError 但带「已跳过」标记）
  const toolEnds = events.filter((e) => e.type === "tool_end");
  assert.equal(toolEnds.length, 2, "c1 执行 + c2 跳过，共两次 tool_end");
  const second = toolEnds[1];
  assert.ok(second?.type === "tool_end" && second.result.isError);
  assert.match(resultText(second.result.content), /已跳过/);

  // 事件：steering 在下一轮顶部广播（注入仍由内层循环统一做）
  assert.ok(events.some((e) => e.type === "steering" && e.texts[0] === "改方向"));

  // 消息顺序：assistant(toolCalls) → toolResult(c1) → toolResult(c2 跳过) → user(steering)
  // 这个顺序不能破——toolResult 必须紧跟带 toolCalls 的 assistant，否则真实端点会拒绝
  const msgs = state.messages;
  const assistantIdx = msgs.findIndex((m) => m.role === "assistant");
  const c1Idx = msgs.findIndex((m) => m.role === "toolResult" && m.toolCallId === "c1");
  const c2Idx = msgs.findIndex((m) => m.role === "toolResult" && m.toolCallId === "c2");
  const steerIdx = msgs.findIndex(
    (m) => m.role === "user" && m.content.includes("改方向"),
  );
  assert.ok(c1Idx === assistantIdx + 1, "c1 结果应紧跟 assistant");
  assert.ok(c2Idx === c1Idx + 1, "c2 跳过结果应紧跟 c1");
  assert.ok(steerIdx === c2Idx + 1, "steering 注入应在两个 toolResult 之后");
  assert.ok(
    (msgs[steerIdx] as { content: string }).content.startsWith("[中途插入指令] "),
    "steering 注入保留中途插入前缀",
  );

  // c1 真执行了，c2 没执行（c2 若执行会返回 slow:b，但它的结果是跳过错误）
  const c1Result = msgs[c1Idx];
  assert.ok(c1Result?.role === "toolResult" && !c1Result.isError);
  assert.match(resultText(c1Result.content), /slow:a/);

  // 最后一轮模型按新指令收尾
  const assistants = msgs.filter((m) => m.role === "assistant");
  const last = assistants[assistants.length - 1];
  assert.ok(last?.role === "assistant");
  assert.match(
    last.content.find((c) => c.type === "text")?.text ?? "",
    /已按新指令调整/,
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
  assert.match(resultText(bashError.content), /已被禁用/);
  // 「可用工具：」列表里不应再出现 bash
  const available = resultText(bashError.content).split("可用工具：")[1] ?? "";
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
  const text = resultText(toolResult.content);
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
  assert.match(resultText(toolResult.content), /未知工具/);
});

// ------------------------------------------------------------- markdown

test("markdown: 行内标记渲染成 ANSI，标记字符不留在输出里", () => {
  const out = renderMarkdown("这是 **粗体**、*斜体*、~~删除~~ 和 `code`。");
  assert.ok(!out.includes("**"), `不应残留 **：${out}`);
  assert.ok(!out.includes("~~"), `不应残留 ~~：${out}`);
  assert.ok(!out.includes("`"), `不应残留反引号：${out}`);
  assert.ok(out.includes("粗体") && out.includes("斜体") && out.includes("code"));
  assert.ok(out.includes("\x1b[1m"), "粗体应有 BOLD");
  assert.ok(out.includes("\x1b[36m"), "行内码应有 CYAN");
});

test("markdown: snake_case 不会被误判成斜体", () => {
  const out = renderMarkdown("变量名 foo_bar_baz 保持原样");
  assert.ok(!out.includes("\x1b[3m"), "下划线不该触发斜体");
});

test("markdown: 链接渲染成「文字 + 地址」，标题去掉井号", () => {
  const link = renderMarkdown("见 [文档](https://example.com) ");
  assert.ok(link.includes("文档"));
  assert.ok(link.includes("https://example.com"));
  assert.ok(!link.includes("]("), "链接语法应被消化掉");

  const heading = renderMarkdown("## 二级标题\n", { width: 10 });
  assert.ok(!heading.includes("## "), "井号应被去掉");
  assert.ok(heading.includes("二级标题"));
});

test("markdown: 列表、引用、分隔线按块级处理", () => {
  const list = renderMarkdown("- 第一项\n1. 第二项\n");
  assert.ok(list.includes("第一项") && list.includes("第二项"));

  const quote = renderMarkdown("> 引用一句\n");
  assert.ok(quote.includes("│"), "引用应换成竖线前缀");
  assert.ok(quote.includes("引用一句"));

  const hr = renderMarkdown("---\n", { width: 5 });
  assert.ok(hr.includes("─".repeat(5)), "分隔线应按给定宽度铺满");
});

test("markdown: 围栏代码块里的内容原样输出，且状态跨行保留", () => {
  const out = renderMarkdown("```ts\nconst a = **not bold**;\n```\n");
  assert.ok(out.includes("**not bold**"), "代码块内不应解析行内标记");

  // 围栏必须成对：只有开栏时，后面所有行都还在代码里
  const dangling = renderMarkdown("```\n- 仍是代码\n");
  assert.ok(dangling.includes("仍是代码"));
  assert.equal(dangling.split("\x1b[2m").length - 1, 2, "围栏行与代码行都应是 DIM 包裹");
});

test("markdown: 流式渲染——跨 delta 的标记不会被切坏", () => {
  const stream = createMarkdownStream({ width: 40 });
  assert.equal(stream.push("这是 **bo"), "", "半行不输出");
  const out = stream.push("ld** 结束\n");
  assert.ok(!out.includes("**"), `跨 delta 的粗体应被正确渲染：${out}`);
  assert.ok(out.endsWith("\n"));
});

test("markdown: end() 冲出最后没有换行的半行", () => {
  const stream = createMarkdownStream({ width: 40 });
  stream.push("**收尾**");
  assert.equal(stream.end(), "\x1b[1m收尾\x1b[0m");
  assert.equal(stream.end(), "", "重复 end 应为空");
});

test("markdown: enabled 为 false 时纯透传，不打任何转义序列", () => {
  const raw = "# 标题\n- **粗体**\n";
  assert.equal(renderMarkdown(raw, { enabled: false }), raw);

  const stream = createMarkdownStream({ enabled: false });
  assert.equal(stream.push("**a**"), "**a**");
  assert.equal(stream.end(), "");
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

test("print 模式：流错误被重试恢复（turn_end 干净收尾）→ 不计失败", () => {
  const out = createPrintOutput();
  // 第 1 次尝试流失败 → agent 自动重试 → 重试成功 turn_end 干净收尾
  out.onEvent({
    type: "stream",
    event: { type: "error", reason: "error", error: { ...textOnly(""), stopReason: "error" as const, errorMessage: "HTTP 502" } },
  });
  out.onEvent({ type: "turn_end", message: textOnly("重试成功后的回答") });

  assert.deepEqual(out.errors, [], "恢复成功的一轮不应被记为失败");
  assert.equal(out.exitCode, 0);
});

test("print 模式：流错误与 turn_end 同文去重", () => {
  const out = createPrintOutput();
  out.onEvent({
    type: "stream",
    event: { type: "error", reason: "error", error: { ...textOnly(""), stopReason: "error" as const, errorMessage: "调用模型失败：boom" } },
  });
  out.onEvent({
    type: "turn_end",
    message: { ...textOnly(""), stopReason: "error" as const, errorMessage: "调用模型失败：boom" },
  });

  assert.deepEqual(out.errors, ["调用模型失败：boom"], "同一次失败只记一条");
  assert.equal(out.exitCode, 1);
});

test("agent: 空流（无任何事件）补发 stream error，错误对所有显示端可见", async () => {
  const dir = await tempDir();
  const state = createInitialState({ cwd: dir, model: { provider: "mock", id: "mock-1" }, tools: allTools });
  const stream: StreamFn = async function* () {
    // 一个事件都不 yield 就结束（空流）
  };
  const events: AgentEvent[] = [];
  const agent = new Agent({ state, stream, onEvent: (e) => void events.push(e), maxStreamRetries: 0 });
  agent.enqueueUser("hi");
  await agent.run();

  const streamErrors = events.flatMap((e) =>
    e.type === "stream" && e.event.type === "error" ? [e.event] : [],
  );
  assert.equal(streamErrors.length, 1, "空流失败必须补发 error 事件");
  assert.equal(streamErrors[0]?.reason, "error");
  assert.equal(streamErrors[0]?.error.errorMessage, "模型没有返回任何内容");
  const last = state.messages[state.messages.length - 1];
  assert.ok(last?.role === "assistant" && last.stopReason === "error");
  assert.equal(last.errorMessage, "模型没有返回任何内容");
});

test("agent: 流抛异常且已 abort → reason 如实标记 aborted（中断不算错误）", async () => {
  const dir = await tempDir();
  const state = createInitialState({ cwd: dir, model: { provider: "mock", id: "mock-1" }, tools: allTools });
  let agentRef: Agent | undefined;
  const stream: StreamFn = async function* () {
    agentRef?.abort("测试中断");
    throw new Error("连接被重置");
  };
  const events: AgentEvent[] = [];
  const agent = new Agent({ state, stream, onEvent: (e) => void events.push(e), maxStreamRetries: 0 });
  agentRef = agent;
  agent.enqueueUser("hi");
  await agent.run();

  const streamErrors = events.flatMap((e) =>
    e.type === "stream" && e.event.type === "error" ? [e.event] : [],
  );
  assert.equal(streamErrors.length, 1);
  assert.equal(streamErrors[0]?.reason, "aborted", "中断必须标记 reason=aborted，显示层据此静默");
  assert.equal(streamErrors[0]?.error.errorMessage, "已中断");
});

// ----------------------------------------------------- bash 跨平台 shell

test("resolveShell: 非 win32 恒返回 bash -lc，与原行为字节级一致", () => {
  const spec = resolveShell();
  if (process.platform !== "win32") {
    assert.equal(spec.file, "bash");
    assert.deepEqual(spec.args("echo hi"), ["-lc", "echo hi"]);
  } else {
    // win32 下要么是某个真实存在的 bash.exe，要么是 powershell.exe
    if (spec.file !== "powershell.exe") {
      assert.ok(
        spec.file.toLowerCase().endsWith("bash.exe"),
        `win32 下非 PowerShell 时应该指向 bash.exe，得到 ${spec.file}`,
      );
    }
    assert.ok(typeof spec.args("echo hi")[0] === "string");
  }
});

test("bash 工具：非 win32 上能跑 echo bash-ok", async () => {
  if (process.platform === "win32") return; // 条件用例，win32 上的 PowerShell 用例暂未覆盖
  const tmp = await tempDir();
  try {
    const result = await bashTool.execute(
      { command: "echo bash-ok" },
      { cwd: tmp, signal: new AbortController().signal },
    );
    assert.equal(result.isError, false);
    assert.ok(
      result.content.some((c) => c.type === "text" && c.text.includes("bash-ok")),
      `应该返回包含 bash-ok 的输出，得到 ${JSON.stringify(result.content)}`,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// ───────────── pause / resume 接 Agent.onEvent 真起作用 ─────────────
import { SessionManager } from "../desktop/main/session.js";
import DesktopDisplayConnector from "../src/connector/connectors/desktop-display/index.js";
import { createDisplayRoute } from "../src/connector/runtime/display-route.js";
import { ConnectorRegistry } from "../src/connector/registry/connector-registry.js";
import type { DisplayEvent } from "../src/connector/core/types.js";
import type { WireEvent } from "../desktop/shared/api.js";

/**
 * 真链路装配：SessionManager 的 emit → createDisplayRoute → DesktopDisplayConnector
 * （transport 是数组收集器）。测试断言的是渲染层实际收到的 WireEvent，
 * 与 desktop/main/index.ts 的装配方式保持同构。
 */
function makeWireCollector(): {
  deps: { emit: (event: DisplayEvent) => void };
  wires: WireEvent[];
} {
  const wires: WireEvent[] = [];
  const display = new DesktopDisplayConnector({ transport: (w) => wires.push(w) });
  const registry = new ConnectorRegistry();
  registry.register({
    manifest: {
      id: "desktop-display",
      version: "0.0.0-test",
      type: "desktop",
      capabilities: [],
    },
    instance: display,
    state: "ready",
    rootDir: "/test/desktop-display",
  });
  const route = createDisplayRoute({ registry }, () => {
    throw new Error("有 display connector 时 fallback 不应被调用");
  });
  return { deps: { emit: (event) => route(event) }, wires };
}

test("pause 真接入：pause 后 stream 文本不再 emit 直到 resume()", async () => {
  // 慢流：每个 token 之间 30ms，给 pause 留出空档
  function slowStream(options: StreamOptions): AsyncGenerator<import("../src/providers/types.js").StreamEvent> {
    const text = "hello world this is a slow stream payload";
    return (async function* () {
      // partial 类型是 AssistantMessage，缺 role/stopReason/usage/timestamp 会 typecheck 失败
      const partial = {
        role: "assistant" as const,
        content: [],
        model: options.model.id,
        stopReason: "stop" as const,
        usage: emptyUsage(),
        timestamp: Date.now(),
      };
      yield { type: "start", partial };
      for (let i = 0; i < text.length; i += 1) {
        await new Promise((r) => setTimeout(r, 30));
        yield { type: "text_delta", delta: text[i]!, partial };
      }
      yield {
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          content: [{ type: "text", text }],
          model: options.model.id,
          stopReason: "stop",
          usage: emptyUsage(),
          timestamp: Date.now(),
        },
      };
    })();
  }

  const cwd = await tempDir();
  const state = createInitialState({
    cwd,
    model: { provider: "mock", id: "mock-1" },
    tools: [],
  });
  const ctx = await import("../src/context/index.js");
  const queue = new ctx.MessageQueue();
  const { deps, wires: received } = makeWireCollector();

  const sm = new SessionManager(
    { state, queue, resolved: { model: { provider: "mock", id: "mock-1" }, stream: slowStream } },
    deps,
  );

  // 50ms 后 pause；600ms 后 resume
  setTimeout(() => {
    sm.pause();
  }, 50);
  const resumeAt = new Promise<void>((r) =>
    setTimeout(() => {
      sm.resume();
      r();
    }, 600),
  );

  await sm.submit("run slow stream", []);
  await resumeAt;
  // 缓冲让流跑完
  await new Promise((r) => setTimeout(r, 200));

  const pausedIdx = received.findIndex((e) => e.t === "paused");
  const resumedIdx = received.findIndex((e) => e.t === "resumed");
  assert.ok(pausedIdx !== -1, "应当推过 `paused` 事件");
  assert.ok(resumedIdx !== -1, "应当推过 `resumed` 事件");
  assert.ok(resumedIdx > pausedIdx, "resumed 必须在 paused 之后");

  // 暂停期间不应有 text 事件出来
  const textEvents = received.filter((e) => e.t === "text");
  const duringPause = textEvents.filter((e) => {
    const idx = received.indexOf(e);
    return idx > pausedIdx && idx < resumedIdx;
  });
  assert.equal(
    duringPause.length,
    0,
    `pause 期间不应有 text 增量，实际 ${duringPause.length} 条（pause gate 必须真起到停流作用）`,
  );

  // resume 之后 text 必须恢复
  const afterResume = textEvents.filter((e) => received.indexOf(e) >= resumedIdx);
  assert.ok(afterResume.length > 0, "resume 之后应当继续推 text 增量");

  await fs.rm(cwd, { recursive: true, force: true });
});

test("submit 真接入：用户输入广播为 user_text，且先于 start（真链路）", async () => {
  function instantStream(options: StreamOptions): AsyncGenerator<import("../src/providers/types.js").StreamEvent> {
    return (async function* () {
      const partial = {
        role: "assistant" as const,
        content: [],
        model: options.model.id,
        stopReason: "stop" as const,
        usage: emptyUsage(),
        timestamp: Date.now(),
      };
      yield { type: "start", partial };
      yield {
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          model: options.model.id,
          stopReason: "stop",
          usage: emptyUsage(),
          timestamp: Date.now(),
        },
      };
    })();
  }

  const cwd = await tempDir();
  const state = createInitialState({
    cwd,
    model: { provider: "mock", id: "mock-1" },
    tools: [],
  });
  const ctx = await import("../src/context/index.js");
  const queue = new ctx.MessageQueue();
  const { deps, wires } = makeWireCollector();

  const sm = new SessionManager(
    { state, queue, resolved: { model: { provider: "mock", id: "mock-1" }, stream: instantStream } },
    deps,
  );
  await sm.submit("你好", []);
  await new Promise((r) => setTimeout(r, 150));

  const userIdx = wires.findIndex((e) => e.t === "user_text");
  const startIdx = wires.findIndex((e) => e.t === "start");
  assert.ok(userIdx !== -1, "submit 必须广播 user_text（独立 UI 靠它显示用户输入）");
  assert.deepEqual(wires[userIdx], { t: "user_text", text: "你好" });
  assert.ok(startIdx !== -1 && userIdx < startIdx, "user_text 必须先于本轮 start");

  // steer 也广播
  wires.length = 0;
  sm.steer("插一句");
  const steerIdx = wires.findIndex((e) => e.t === "user_text");
  assert.ok(steerIdx !== -1, "steer 也要广播 user_text");
  assert.deepEqual(wires[steerIdx], { t: "user_text", text: "插一句" });

  await fs.rm(cwd, { recursive: true, force: true });
});

// ───────────── reasoning / endpoint / mode 真接入 ─────────────
import { MessageQueue } from "../src/context/index.js";

test("reasoning 真接入：fast/balanced/ultra 写 maxTokens；mock 不写", () => {
  const cwd = process.cwd();
  const state = createInitialState({
    cwd,
    model: { provider: "openai", id: "gpt-4o-mini" },
    tools: [],
  });
  const queue2 = new MessageQueue();
  const sm = new SessionManager(
    { state, queue: queue2, resolved: { model: { provider: "openai", id: "gpt-4o-mini" }, stream: createMockStream({ delayMs: 0 }) } },
    { emit: () => {} },
  );

  assert.equal(sm.info().maxTokens, 4096, "balanced → 4096");
  sm.setReasoning("fast");
  assert.equal(sm.info().maxTokens, 1024, "fast → 1024");
  sm.setReasoning("ultra");
  assert.equal(sm.info().maxTokens, 8192, "ultra → 8192");

  sm.setEndpoint("mock");
  assert.equal(sm.info().maxTokens, 0, "mock 不写 maxTokens");
  sm.setReasoning("fast");
  assert.equal(sm.info().maxTokens, 0, "mock + fast → 0");

  void cwd;
});

test("reasoning auto：不锁 maxTokens，thinkingLevel 落 low，agent 开动态升降", () => {
  const state = createInitialState({
    cwd: process.cwd(),
    model: { provider: "openai", id: "gpt-4o-mini" },
    tools: [],
  });
  const sm = new SessionManager(
    { state, queue: new MessageQueue(), resolved: { model: { provider: "openai", id: "gpt-4o-mini" }, stream: createMockStream({ delayMs: 0 }) } },
    { emit: () => {} },
  );

  sm.setReasoning("auto");
  assert.equal(sm.info().maxTokens, 0, "auto 不锁 maxTokens（走端点默认）");
  assert.equal(sm.getState().thinkingLevel, "low", "auto 基准档 low");
  // 从 ultra 切回 auto：旧档位残留的 8192 上限要被清掉
  sm.setReasoning("ultra");
  assert.equal(sm.info().maxTokens, 8192);
  sm.setReasoning("auto");
  assert.equal(sm.info().maxTokens, 0, "切回 auto 清掉残留上限");
});

test("reasoning 固定档映射 thinkingLevel：fast→low / balanced→medium / ultra→high", () => {
  const state = createInitialState({
    cwd: process.cwd(),
    model: { provider: "openai", id: "gpt-4o-mini" },
    tools: [],
  });
  const sm = new SessionManager(
    { state, queue: new MessageQueue(), resolved: { model: { provider: "openai", id: "gpt-4o-mini" }, stream: createMockStream({ delayMs: 0 }) } },
    { emit: () => {} },
  );

  sm.setReasoning("ultra");
  assert.equal(sm.getState().thinkingLevel, "high");
  sm.setReasoning("balanced");
  assert.equal(sm.getState().thinkingLevel, "medium");
  sm.setReasoning("fast");
  assert.equal(sm.getState().thinkingLevel, "low");
});

test("setCustomModel：三要素构造 OpenAI 兼容 ModelRef；坏输入 fail-visible", () => {
  const state = createInitialState({
    cwd: process.cwd(),
    model: { provider: "openai", id: "gpt-4o-mini" },
    tools: [],
  });
  const sm = new SessionManager(
    { state, queue: new MessageQueue(), resolved: { model: { provider: "openai", id: "gpt-4o-mini" }, stream: createMockStream({ delayMs: 0 }) } },
    { emit: () => {} },
  );

  // 正常路径：baseUrl / key 原样落到 ModelRef，modelSpec 同步更新
  const out = sm.setCustomModel({
    baseURL: "https://api.deepseek.com/v1/",
    apiKey: "sk-test",
    model: "deepseek-chat",
  });
  assert.equal(out.model, "deepseek:deepseek-chat", "label 前缀从 baseUrl 域名推导");
  assert.equal(sm.info().baseURL, "https://api.deepseek.com/v1", "尾部 / 剥掉");
  assert.equal(sm.info().modelSpec, "openai:deepseek-chat");
  assert.equal(sm.info().endpoint, "openai");

  // apiKey 留空：本地无 key 端点用 "EMPTY" 占位，不降级 mock
  sm.setCustomModel({ baseURL: "http://127.0.0.1:1234/v1", apiKey: "", model: "local-model" });
  assert.equal(sm.info().degraded, undefined, "空 key 用 EMPTY 占位不应降级");

  // 坏输入：抛 Error（dispatchApi 转 rejected promise，弹窗可见），状态不被污染
  assert.throws(() => sm.setCustomModel({ baseURL: "api.deepseek.com/v1", apiKey: "k", model: "m" }), /接口地址/);
  assert.throws(() => sm.setCustomModel({ baseURL: "https://x.com/v1", apiKey: "", model: " " }), /模型名称/);
  assert.throws(
    () => sm.setCustomModel({ baseURL: "https://x.com", apiKey: "", model: "m", protocol: "grpc" as never }),
    /不支持的协议/,
  );
  assert.equal(sm.info().modelSpec, "openai:local-model", "抛错后模型保持上一次成功值");
});

test("setCustomModel：上下文窗口手动覆写（k/m 后缀、非法格式、留空回退）", () => {
  const state = createInitialState({
    cwd: process.cwd(),
    model: { provider: "openai", id: "gpt-4o-mini" },
    tools: [],
  });
  const sm = new SessionManager(
    { state, queue: new MessageQueue(), resolved: { model: { provider: "openai", id: "gpt-4o-mini" }, stream: createMockStream({ delayMs: 0 }) } },
    { emit: () => {} },
  );

  // 手动覆写：k/m 后缀解析为 token 数，info() 分母与 Agent 预算跟着走
  sm.setCustomModel({ baseURL: "https://x.io/v1", apiKey: "k", model: "my-model", contextWindow: "256k" });
  assert.equal(sm.info().contextWindow, 256_000, "256k = 256,000（十进制，与厂商口径一致）");
  sm.setCustomModel({ baseURL: "https://x.io/v1", apiKey: "k", model: "my-model", contextWindow: "1M" });
  assert.equal(sm.info().contextWindow, 1_000_000, "后缀大小写不限");

  // 非法格式：fail-visible，状态不回退
  assert.throws(
    () => sm.setCustomModel({ baseURL: "https://x.io/v1", apiKey: "k", model: "m2", contextWindow: "abc" }),
    /上下文窗口/,
  );
  assert.equal(sm.info().modelSpec, "openai:my-model", "抛错后模型保持上一次成功值");

  // 留空：未知模型按 1M 兜底（用户定调），不再被填回的粗表值覆盖手动值
  sm.setCustomModel({ baseURL: "https://x.io/v1", apiKey: "k", model: "my-model" });
  assert.equal(sm.info().contextWindow, 1_000_000);
});

test("setAutoCompact：设置弹窗开关回显 info，默认开启", () => {
  const state = createInitialState({
    cwd: process.cwd(),
    model: { provider: "openai", id: "gpt-4o-mini" },
    tools: [],
  });
  const sm = new SessionManager(
    { state, queue: new MessageQueue(), resolved: { model: { provider: "openai", id: "gpt-4o-mini" }, stream: createMockStream({ delayMs: 0 }) } },
    { emit: () => {} },
  );

  assert.equal(sm.info().autoCompact, true, "默认开启（内核 autoCompact 缺省 true）");
  sm.setAutoCompact(false);
  assert.equal(sm.info().autoCompact, false, "关闭后 info 回显，设置弹层靠它回显开关");
  sm.setAutoCompact(true);
  assert.equal(sm.info().autoCompact, true);
});

test("setMsgWindow：独立消息弹窗默认不开启，开关回显 info", () => {
  const state = createInitialState({
    cwd: process.cwd(),
    model: { provider: "openai", id: "gpt-4o-mini" },
    tools: [],
  });
  const sm = new SessionManager(
    { state, queue: new MessageQueue(), resolved: { model: { provider: "openai", id: "gpt-4o-mini" }, stream: createMockStream({ delayMs: 0 }) } },
    { emit: () => {} },
  );

  assert.equal(sm.info().msgWindow, false, "默认不开启（用户定调）");
  sm.setMsgWindow(true);
  assert.equal(sm.info().msgWindow, true, "开启后 info 回显，设置弹层靠它回显开关");
  sm.setMsgWindow(false);
  assert.equal(sm.info().msgWindow, false);
});

test("setCustomModel：anthropic / gemini 协议直接构造对应 provider", () => {
  const state = createInitialState({
    cwd: process.cwd(),
    model: { provider: "openai", id: "gpt-4o-mini" },
    tools: [],
  });
  const sm = new SessionManager(
    { state, queue: new MessageQueue(), resolved: { model: { provider: "openai", id: "gpt-4o-mini" }, stream: createMockStream({ delayMs: 0 }) } },
    { emit: () => {} },
  );

  // anthropic：base 是根路径——用户手滑带 /v1 要剥掉（否则 /v1/v1/messages）
  sm.setCustomModel({
    baseURL: "https://api.anthropic.com/v1/",
    apiKey: "sk-ant",
    model: "claude-sonnet-4-5",
    protocol: "anthropic",
  });
  assert.equal(sm.info().baseURL, "https://api.anthropic.com");
  assert.equal(sm.info().modelSpec, "anthropic:claude-sonnet-4-5");
  assert.equal(sm.info().endpoint, "anthropic");

  // gemini：base 到 /v1beta，原样保留
  sm.setCustomModel({
    baseURL: "https://generativelanguage.googleapis.com/v1beta",
    apiKey: "g-key",
    model: "gemini-2.5-flash",
    protocol: "gemini",
  });
  assert.equal(sm.info().baseURL, "https://generativelanguage.googleapis.com/v1beta");
  assert.equal(sm.info().modelSpec, "gemini:gemini-2.5-flash");
  assert.equal(sm.info().endpoint, "gemini");
  assert.equal(sm.info().degraded, undefined);
});

// ----------------------------------------------------- gemini 原生适配器

test("geminiStream：SSE 解析 text/thought/functionCall/usage；请求形状正确", async () => {
  const { geminiStream } = await import("../src/providers/gemini.js");
  const enc = new TextEncoder();
  let i = 0;
  const chunks = [
    'data: {"candidates":[{"content":{"parts":[{"text":"你"}]}}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":1}}\n\n',
    'data: {"candidates":[{"content":{"parts":[{"text":"好"},{"text":"想一下","thought":true}]}}]}\n\n',
    'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"read","args":{"path":"a.ts"}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5,"thoughtsTokenCount":3}}\n\n',
  ];  const captured: { url: string; headers: Record<string, string> }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: { headers?: Record<string, string> }) => {
    captured.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return {
      ok: true,
      status: 200,
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]!));
          else controller.close();
        },
      }),
    } as unknown as Response;
  }) as unknown as typeof fetch;

  try {
    const gen = geminiStream({
      model: { provider: "gemini", id: "gemini-2.5-flash", baseUrl: "https://g.example/v1beta", apiKey: "g-key" },
      systemPrompt: "sys",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [],
      thinkingLevel: "medium",
    });
    const events: StreamEvent[] = [];
    for await (const e of gen) {
      events.push(e);
    }

    // 请求形状：URL、鉴权 header、thinkingConfig
    assert.equal(captured.length, 1);
    assert.equal(
      captured[0]!.url,
      "https://g.example/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
    );
    assert.equal(captured[0]!.headers["x-goog-api-key"], "g-key");

    // 事件流：start → text_delta("你") → text_delta("好") → thinking_delta("想一下") → toolcall_end(read) → done
    const types = events.map((e) => e.type);
    assert.deepEqual(types, ["start", "text_delta", "text_delta", "thinking_delta", "toolcall_end", "done"]);
    const toolCallEnd = events[4] as { type: "toolcall_end"; toolCall: { id: string; name: string; arguments: Record<string, unknown> } };
    assert.equal(toolCallEnd.toolCall.name, "read");
    assert.deepEqual(toolCallEnd.toolCall.arguments, { path: "a.ts" });
    assert.ok(toolCallEnd.toolCall.id.startsWith("call_"), "gemini 无 tool call id，应自造 call_N");

    const done = events[5] as { type: "done"; reason: string; message: { usage: { input: number; output: number } } };
    assert.equal(done.reason, "toolUse", "含 functionCall → toolUse");
    assert.equal(done.message.usage.input, 10);
    assert.equal(done.message.usage.output, 8, "candidates 5 + thoughts 3");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("openaiStream：透传 sessionId 为 x-opencode-session 头 + 自定义 UA", async () => {
  const { openaiStream } = await import("../src/providers/openai.js");
  const chunks = ['data: {"choices":[{"delta":{"content":"好"},"finish_reason":null}]}\n\n', "data: [DONE]\n\n"];
  const captured: { url: string; headers: Record<string, string> }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: { headers?: Record<string, string> }) => {
    captured.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const enc = new TextEncoder();
    let i = 0;
    return {
      ok: true,
      status: 200,
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]!));
          else controller.close();
        },
      }),
    } as unknown as Response;
  }) as unknown as typeof fetch;

  try {
    const gen = openaiStream({
      model: { provider: "openai", id: "mimo-v2.5", baseUrl: "https://opencode.ai/zen/go/v1", apiKey: "k" },
      systemPrompt: "sys",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [],
      thinkingLevel: "low",
      sessionId: "sess-fixed-123",
    });
    for await (const _e of gen) {
      void _e; // 消费事件流
    }

    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.headers["x-opencode-session"], "sess-fixed-123", "opencode zen go 中继要求会话头，缺失 400");
    assert.equal(captured[0]!.headers["user-agent"], "c-agent/0.1", "文档禁止 generic SDK 默认 UA");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("openaiStream：401 且无有效 key（含 EMPTY 占位）附中文指引；有 key 时只回端点原文", async () => {
  const { openaiStream } = await import("../src/providers/openai.js");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return {
      ok: false,
      status: 401,
      text: async () => '{"error":{"message":"You didn\'t provide an API key."}}',
    } as unknown as Response;
  }) as unknown as typeof fetch;

  const run = async (apiKey: string | undefined): Promise<string> => {
    const gen = openaiStream({
      model: { provider: "openai", id: "gpt-4o-mini", baseUrl: "https://api.example.com/v1", apiKey },
      systemPrompt: "sys",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [],
      thinkingLevel: "low",
    });
    let errorMessage = "";
    for await (const e of gen) {
      if (e.type === "error") errorMessage = e.error.errorMessage ?? "";
    }
    return errorMessage;
  };

  try {
    // EMPTY 占位（桌面端自定义模型留空 key 的约定）：401 指引必须到位
    const noKey = await run("EMPTY");
    assert.ok(noKey.includes("OpenAI 401"), "保留端点状态码原文");
    assert.ok(noKey.includes("没有配置 API KEY"), `EMPTY 占位 401 应附指引，实际：${noKey}`);
    const undefinedKey = await run(undefined);
    assert.ok(undefinedKey.includes("没有配置 API KEY"), "apiKey 缺省同样附指引");
    // 真实 key 被端点拒：不再误导用户去补 key（端点原文照旧）
    const withKey = await run("sk-real");
    assert.equal(withKey.includes("没有配置 API KEY"), false, "有 key 的 401 不应误导用户去补 key");
    assert.ok(withKey.includes("You didn't provide an API key"), "端点原文保留");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("openaiStream：Anthropic 形状错误体（协议错配）附切换协议指引；OpenAI 形状错误体不附", async () => {
  const { openaiStream } = await import("../src/providers/openai.js");
  const originalFetch = globalThis.fetch;
  let respondBody = "";
  globalThis.fetch = (async () => {
    return {
      ok: false,
      status: 500,
      text: async () => respondBody,
    } as unknown as Response;
  }) as unknown as typeof fetch;

  const run = async (): Promise<string> => {
    const gen = openaiStream({
      model: { provider: "openai", id: "glm-5.3", baseUrl: "https://relay.example.com/v1", apiKey: "sk-real" },
      systemPrompt: "sys",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [],
      thinkingLevel: "low",
    });
    let errorMessage = "";
    for await (const e of gen) {
      if (e.type === "error") errorMessage = e.error.errorMessage ?? "";
    }
    return errorMessage;
  };

  try {
    // 用户实报场景：openai 适配器 + Anthropic 信封 → 必须给出「协议切 anthropic」指引
    respondBody = '{"type":"error","error":{"type":"error","message":"Internal server error"}}';
    const mismatch = await run();
    assert.ok(mismatch.includes("OpenAI 500"), "保留端点状态码原文");
    assert.ok(
      mismatch.includes("Anthropic 协议的错误格式"),
      `Anthropic 信封 500 应附协议错配指引，实际：${mismatch}`,
    );
    assert.ok(mismatch.includes("协议切到 anthropic"), "指引必须包含可操作动作");
    // OpenAI 家族形状（{"error":{...}}，无顶层 type）→ 不误伤
    respondBody = '{"error":{"message":"Internal server error","type":"internal_error"}}';
    const normal = await run();
    assert.equal(
      normal.includes("Anthropic 协议的错误格式"),
      false,
      `OpenAI 形状错误体不应误报协议错配，实际：${normal}`,
    );
    // 非 JSON（HTML 错误页）→ 静默跳过，不抛异常
    respondBody = "<html>502 Bad Gateway</html>";
    const html = await run();
    assert.equal(html.includes("Anthropic 协议的错误格式"), false, "非 JSON 响应体不判断协议");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("responsesStream：/v1/responses 请求形状（instructions/扁平 tools/reasoning）+ 事件流 + usage", async () => {
  const { responsesStream } = await import("../src/providers/responses.js");
  const chunks = [
    'data: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
    'data: {"type":"response.output_text.delta","delta":"你好"}\n\n',
    'data: {"type":"response.reasoning_summary_text.delta","delta":"想一下"}\n\n',
    'data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"fc_1","name":"read"}}\n\n',
    'data: {"type":"response.function_call_arguments.delta","delta":"{\\"path\\":\\"a.ts\\"}"}\n\n',
    'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"fc_1","name":"read","arguments":"{\\"path\\":\\"a.ts\\"}"}}\n\n',
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":8,"output_tokens_details":{"reasoning_tokens":3},"input_tokens_details":{"cached_tokens":4}}}}\n\n',
  ];
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedHeaders: Record<string, string> = {};
  let capturedBody: Record<string, unknown> = {};
  globalThis.fetch = (async (url: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
    capturedUrl = String(url);
    capturedHeaders = init?.headers ?? {};
    capturedBody = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    const enc = new TextEncoder();
    let i = 0;
    return {
      ok: true,
      status: 200,
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]!));
          else controller.close();
        },
      }),
    } as unknown as Response;
  }) as unknown as typeof fetch;

  try {
    const gen = responsesStream({
      model: { provider: "openai-responses", id: "gpt-5.1", baseUrl: "https://api.example.com/v1", apiKey: "sk-x" },
      systemPrompt: "sys-prompt",
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "不回放" },
            { type: "text", text: "上轮回复" },
            { type: "toolCall", id: "fc_0", name: "glob", arguments: { pattern: "*.ts" } },
          ],
        },
        { role: "toolResult", content: [{ type: "toolResult", toolCallId: "fc_0", toolName: "glob", isError: false, content: [{ type: "text", text: "结果" }] }] },
        { role: "user", content: [{ type: "text", text: "继续" }] },
      ],
      tools: [{ name: "read", description: "读文件", parameters: { type: "object", properties: {} } }],
      thinkingLevel: "medium",
      maxTokens: 4096,
    });
    const events: StreamEvent[] = [];
    for await (const e of gen) {
      events.push(e);
    }

    // 请求形状：/responses 端点 + Bearer + instructions/扁平 tools/reasoning/max_output_tokens
    assert.equal(capturedUrl, "https://api.example.com/v1/responses");
    assert.equal(capturedHeaders["authorization"], "Bearer sk-x");
    assert.equal(capturedBody["instructions"], "sys-prompt");
    assert.equal(capturedBody["max_output_tokens"], 4096);
    assert.deepEqual(capturedBody["reasoning"], { effort: "medium" });
    const tools = capturedBody["tools"] as Array<Record<string, unknown>>;
    assert.equal(tools.length, 1);
    assert.equal(tools[0]!["type"], "function");
    assert.equal(tools[0]!["name"], "read", "Responses 工具定义是扁平结构，name 在顶层");
    // input：user 文本 / assistant thinking 不回放 / toolCall 独立 item / function_call_output
    const input = capturedBody["input"] as Array<Record<string, unknown>>;
    assert.equal(input.length, 5, "user + assistant(output_text) + function_call + function_call_output + user");
    assert.deepEqual(input[0], { role: "user", content: "hi" });
    assert.deepEqual(input[1], { role: "assistant", content: [{ type: "output_text", text: "上轮回复" }] });
    assert.deepEqual(input[2], { type: "function_call", call_id: "fc_0", name: "glob", arguments: '{"pattern":"*.ts"}' });
    assert.deepEqual(input[3], { type: "function_call_output", call_id: "fc_0", output: "结果" });

    // 事件流：text → thinking → toolcall_delta → toolcall_end → done(toolUse)
    const types = events.map((e) => e.type);
    assert.deepEqual(types, ["start", "text_delta", "thinking_delta", "toolcall_delta", "toolcall_end", "done"]);
    const toolEnd = events[4] as { type: "toolcall_end"; toolCall: { id: string; name: string; arguments: Record<string, unknown> } };
    assert.equal(toolEnd.toolCall.id, "fc_1");
    assert.equal(toolEnd.toolCall.name, "read");
    assert.deepEqual(toolEnd.toolCall.arguments, { path: "a.ts" });
    const done = events[5] as { type: "done"; reason: string; message: { usage: { input: number; output: number; cacheRead: number } } };
    assert.equal(done.reason, "toolUse");
    assert.equal(done.message.usage.input, 10);
    assert.equal(done.message.usage.output, 8);
    assert.equal(done.message.usage.cacheRead, 4, "input_tokens_details.cached_tokens 记入 cacheRead");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("toResponsesInput：user 图片转 input_image（纯字符串 URL）；toolResult 图片转占位", async () => {
  const { toResponsesInput } = await import("../src/providers/responses.js");
  const out = toResponsesInput([
    {
      role: "user",
      content: [
        { type: "text", text: "看图" },
        { type: "image", dataUrl: "data:image/png;base64,AAAA" } as never,
      ],
    },
    { role: "toolResult", content: [{ type: "toolResult", toolCallId: "fc_9", toolName: "screenshot", isError: false, content: [{ type: "text", text: "截图" }, { type: "image", dataUrl: "data:image/png;base64,BBBB" } as never] }] },
  ]);
  const user = out[0] as { role: string; content: Array<{ type: string; image_url?: string }> };
  assert.equal(user.content.length, 2);
  assert.equal(user.content[1]!.type, "input_image");
  assert.equal(user.content[1]!.image_url, "data:image/png;base64,AAAA", "Responses 的 image_url 是纯字符串");
  const toolOut = out[1] as { type: string; call_id: string; output: string };
  assert.equal(toolOut.type, "function_call_output");
  assert.equal(toolOut.call_id, "fc_9");
  assert.ok(toolOut.output.includes("截图"), "文本保留");
  assert.ok(toolOut.output.includes("1 张图片"), "图片块转占位说明");
});

test("parseModelsResponse：gemini 端点的 models[] 格式（name 剥 models/ 前缀）", async () => {
  const { parseModelsResponse } = await import("../desktop/main/session.js");
  const out = parseModelsResponse(
    {
      models: [
        { name: "models/gemini-2.5-flash", displayName: "Gemini 2.5 Flash", inputTokenLimit: 1048576 },
        { name: "embedding-001", description: "embedding" },
        { name: "" },
      ],
    },
    "gemini",
  );
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { id: "gemini-2.5-flash", ownedBy: "Gemini 2.5 Flash", contextWindow: 1048576 });
  assert.equal(out[1]!.id, "embedding-001");

  // openai 端点行为不变：data[] 数组
  const oa = parseModelsResponse({ data: [{ id: "gpt-4o-mini", owned_by: "openai" }] }, "openai");
  assert.equal(oa.length, 1);
  assert.equal(oa[0]!.id, "gpt-4o-mini");
});


test("setEndpoint 真接入：endpoint 字段随调用立即更新", () => {
  const cwd = process.cwd();
  const state = createInitialState({
    cwd,
    model: { provider: "openai", id: "gpt-4o-mini" },
    tools: [],
  });
  const queue3 = new MessageQueue();
  const sm = new SessionManager(
    { state, queue: queue3, resolved: { model: { provider: "openai", id: "gpt-4o-mini" }, stream: createMockStream({ delayMs: 0 }) } },
    { emit: () => {} },
  );

  assert.equal(sm.info().endpoint, "openai");
  sm.setEndpoint("mock");
  assert.equal(sm.info().endpoint, "mock");
  sm.setEndpoint("anthropic");
  assert.equal(sm.info().endpoint, "anthropic");

  void cwd;
});

test("setMode 真接入：mode 字段被持久化（下次 start 时由 assembleSession 装配）", () => {
  const cwd = process.cwd();
  const state = createInitialState({
    cwd,
    model: { provider: "mock", id: "mock-1" },
    tools: [],
  });
  const queue4 = new MessageQueue();
  const sm = new SessionManager(
    { state, queue: queue4, resolved: { model: { provider: "mock", id: "mock-1" }, stream: createMockStream({ delayMs: 0 }) } },
    { emit: () => {} },
  );

  assert.equal(sm.getMode(), "full");
  sm.setMode("answer_only");
  assert.equal(sm.getMode(), "answer_only");
  sm.setMode("plan");
  assert.equal(sm.getMode(), "plan");

  void cwd;
});

test("模型持久化钩子：setModel / setEndpoint 走 spec 版，setCustomModel 走完整参数版（互斥语义）", () => {
  const state = createInitialState({
    cwd: process.cwd(),
    model: { provider: "mock", id: "mock-1" },
    tools: [],
  });
  const savedSpecs: string[] = [];
  const savedCustoms: { provider: string; id: string; baseUrl: string; apiKey: string }[] = [];
  const sm = new SessionManager(
    { state, queue: new MessageQueue(), resolved: { model: { provider: "mock", id: "mock-1" }, stream: createMockStream({ delayMs: 0 }) } },
    {
      emit: () => {},
      persistModel: (spec) => savedSpecs.push(spec),
      persistCustomModel: (custom) => savedCustoms.push(custom),
    },
  );

  sm.setModel("mock:abc");
  assert.deepEqual(savedSpecs, ["mock:abc"], "setModel 成功后触发 spec 持久化钩子");
  sm.setEndpoint("openai");
  assert.deepEqual(savedSpecs, ["mock:abc", "openai:abc"], "setEndpoint 保留当前 model id 并触发钩子");

  sm.setCustomModel({ baseURL: "https://custom.example/v1/", apiKey: "sk-x", model: "cm-1" });
  assert.equal(savedSpecs.length, 2, "setCustomModel 不触发 spec 版钩子（互斥）");
  assert.equal(savedCustoms.length, 1, "setCustomModel 触发完整参数持久化钩子（重启后可恢复）");
  assert.deepEqual(
    savedCustoms[0],
    { provider: "openai", id: "cm-1", baseUrl: "https://custom.example/v1", apiKey: "sk-x" },
    "参数取自归一后的 ModelRef（协议缺省 openai、尾斜杠已剥的真值）",
  );

  // 恢复场景：anthropic 协议 + contextWindow 覆写，同样完整落盘
  sm.setCustomModel({
    baseURL: "https://relay.example.com/v1",
    apiKey: "sk-y",
    model: "glm-5.3",
    protocol: "anthropic",
    contextWindow: "200k",
  });
  assert.equal(savedCustoms.length, 2);
  assert.deepEqual(
    savedCustoms[1],
    { provider: "anthropic", id: "glm-5.3", baseUrl: "https://relay.example.com", apiKey: "sk-y", contextWindow: 200000 },
    "anthropic 地址剥 /v1、contextWindow 解析为数字",
  );
});

test("桌面端换模型真生效：submit 后请求用切换后的 ref（401 根因回归）", async () => {
  const cwd = await tempDir();
  const state = createInitialState({
    cwd,
    model: { provider: "mock", id: "mock-1" },
    tools: [],
  });
  const queue = new MessageQueue();
  const { deps } = makeWireCollector();

  const sm = new SessionManager(
    { state, queue, resolved: { model: { provider: "mock", id: "mock-1" }, stream: createMockStream({ delayMs: 0 }) } },
    deps,
  );

  sm.setModel("mock:xyz");
  await sm.submit("你好", []);
  // setModel 换上的 mock 流默认 8ms/增量，一段回复要 ~1s：轮询等助手消息，不固定死等
  let lastAssistant: AssistantMessage | undefined;
  for (let i = 0; i < 100; i++) {
    lastAssistant = [...sm.getState().messages]
      .reverse()
      .find((m): m is AssistantMessage => m.role === "assistant");
    if (lastAssistant !== undefined) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(lastAssistant, "应当有助手回复");
  // Agent.callModel 用 state.model 发请求：不同步的话请求永远携带 bootstrap 旧 ref
  //（自定义模型的 baseUrl / key 全丢 → 打到默认端点 401「没有提供 API key」）
  assert.equal(sm.getState().model.id, "xyz", "state.model 必须同步为切换后的模型");
  assert.equal(
    lastAssistant.model,
    "mock:xyz",
    `流收到的必须是新 ref（mock 回显 provider:id），实际 ${lastAssistant.model}`,
  );

  await fs.rm(cwd, { recursive: true, force: true });
});

// ───────────── 多会话：newSession 归档 + switchSession 切换 ─────────────

test("多会话：newSession 归档旧会话，switchSession 可切回且消息保留", () => {
  const cwd = process.cwd();
  const state = createInitialState({
    cwd,
    model: { provider: "mock", id: "mock-1" },
    tools: [],
  });
  const sm = new SessionManager(
    { state, queue: new MessageQueue(), resolved: { model: { provider: "mock", id: "mock-1" }, stream: createMockStream({ delayMs: 0 }) } },
    { emit: () => {} },
  );

  // 初始 1 个会话；往当前会话塞一条用户消息
  appendNode(sm.getState(), { role: "user", content: "第一条会话的消息", timestamp: 1 });
  assert.equal(sm.getState().messages.length, 1);

  // newSession：归档旧会话 + 新建空会话 → total=2，当前 index=1
  sm.newSession();
  assert.equal(sm.getState().messages.length, 0);

  // ← 切回第一个会话：消息还在（归档而非销毁）
  const back = sm.switchSession(-1);
  assert.deepEqual(back, { index: 0, total: 2 });
  assert.equal(sm.getState().messages.length, 1);

  // → 回到第二个；再 ← 越界夹在 0；→ 越界夹在末尾
  assert.deepEqual(sm.switchSession(1), { index: 1, total: 2 });
  assert.deepEqual(sm.switchSession(1), { index: 1, total: 2 });
  assert.deepEqual(sm.switchSession(-1), { index: 0, total: 2 });
  assert.deepEqual(sm.switchSession(-1), { index: 0, total: 2 });
  assert.equal(sm.getState().messages.length, 1);

  void cwd;
});

test("多会话：plan review 状态随会话保留（切走再切回不丢）", () => {
  const cwd = process.cwd();
  const state = createInitialState({
    cwd,
    model: { provider: "mock", id: "mock-1" },
    tools: [],
  });
  const sm = new SessionManager(
    { state, queue: new MessageQueue(), resolved: { model: { provider: "mock", id: "mock-1" }, stream: createMockStream({ delayMs: 0 }) } },
    { emit: () => {} },
  );
  sm.setMode("plan");
  // 直接翻内部状态模拟「plan review 中」（不走完整 agent 轮次）
  sm["planPending"] = true;
  sm["planRound"] = 3;

  sm.newSession();
  assert.equal(sm.isPlanPending(), false); // 新会话不在 review

  sm.switchSession(-1);
  assert.equal(sm.isPlanPending(), true); // 切回后恢复

  sm.switchSession(1);
  assert.equal(sm.isPlanPending(), false);

  void cwd;
});

// ───────────── listModels：可配置的动态模型列表 ─────────────
import { parseModelsResponse, resolveModelsUrl } from "../desktop/main/session.js";

/** 保存并替换 env，测试结束还原（不污染其他用例） */
function withEnv(values: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(values)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("resolveModelsUrl：默认按 baseUrl 推导；env 显式覆盖优先；mock 无 URL", () => {
  withEnv(
    {
      OPENAI_MODELS_URL: undefined,
      OPENAI_BASE_URL: "https://opencode.ai/zen/go/v1",
      ANTHROPIC_MODELS_URL: undefined,
      ANTHROPIC_BASE_URL: undefined,
    },
    () => {
      // openai baseUrl 含 /v1 → models 直接拼 /models
      assert.equal(resolveModelsUrl("openai"), "https://opencode.ai/zen/go/v1/models");
      // anthropic baseUrl 不含 /v1 → 拼 /v1/models
      assert.equal(resolveModelsUrl("anthropic"), "https://api.anthropic.com/v1/models");
      // mock 不走网络
      assert.equal(resolveModelsUrl("mock"), undefined);
    },
  );
  withEnv({ OPENAI_MODELS_URL: "https://custom.example.com/v1/all-models" }, () => {
    assert.equal(
      resolveModelsUrl("openai"),
      "https://custom.example.com/v1/all-models",
      "OPENAI_MODELS_URL 必须优先于 baseUrl 推导",
    );
  });
});

test("parseModelsResponse：OpenAI 兼容格式解析；缺 id 跳过；坏结构报错", () => {
  const ok = parseModelsResponse({
    object: "list",
    data: [
      { id: "glm-5.3", object: "model", created: 1, owned_by: "opencode" },
      { id: "kimi-k3", object: "model", context_window: 262144 },
      { object: "model" }, // 缺 id → 跳过
      { id: "", object: "model" }, // 空 id → 跳过
    ],
  });
  assert.equal(ok.length, 2);
  assert.deepEqual(ok[0], { id: "glm-5.3", ownedBy: "opencode" });
  assert.deepEqual(ok[1], { id: "kimi-k3", contextWindow: 262144 });

  // context_length 别名也认
  const alias = parseModelsResponse({ data: [{ id: "m", context_length: 8192 }] });
  assert.equal(alias[0]?.contextWindow, 8192);

  // 元数据缺失时用内核粗表严格补：识别的家族填值，未知家族留空（展示宁缺毋滥）
  const hinted = parseModelsResponse({ data: [{ id: "deepseek-reasoner" }, { id: "some-obscure-model" }] });
  assert.equal(hinted[0]?.contextWindow, 128_000, "deepseek 家族命中粗表");
  assert.equal(hinted[1]?.contextWindow, undefined, "未知家族不显示猜出来的数字");

  // 元数据给的值永远赢过粗表
  const both = parseModelsResponse({ data: [{ id: "deepseek-chat", context_window: 131_072 }] });
  assert.equal(both[0]?.contextWindow, 131_072, "端点元数据优先于粗表估值");

  // 坏结构必须 throw（fetchModelsFor 会转成 result.error，让前端回退静态预设）
  assert.throws(() => parseModelsResponse(null));
  assert.throws(() => parseModelsResponse({}));
  assert.throws(() => parseModelsResponse({ data: "not-array" }));
  assert.throws(() => parseModelsResponse({ data: [] }));
  assert.throws(() => parseModelsResponse({ data: [{ no: "id" }] }));
});

test("listModels：mock 走固定列表不打网络；openai 用注入 fetch + 5min 缓存 + refresh 强刷 + HTTP 错误回退", async () => {
  const cwd = process.cwd();
  const state = createInitialState({ cwd, model: { provider: "mock", id: "mock-1" }, tools: [] });
  const queue = new MessageQueue();

  // mock：fetchModels 若被调用就让测试失败
  const smMock = new SessionManager(
    { state, queue, resolved: { model: { provider: "mock", id: "mock-1" }, stream: createMockStream({ delayMs: 0 }) } },
    {
      emit: () => {},
      fetchModels: (async () => {
        throw new Error("mock 端点不应打网络");
      }) as unknown as typeof fetch,
    },
  );
  const mockResult = await smMock.listModels("mock");
  assert.equal(mockResult.error, undefined);
  assert.equal(mockResult.models.length, 1);
  assert.equal(mockResult.models[0]?.id, "mock");

  // openai：注入 fake fetch
  let calls = 0;
  const payload = { object: "list", data: [{ id: "glm-5.3", owned_by: "opencode" }] };
  const fakeFetch = (async () => {
    calls += 1;
    if (calls === 2) {
      // 第 2 次（refresh 后那次）模拟服务端 500
      return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => payload } as unknown as Response;
  }) as unknown as typeof fetch;

  const smOpenai = new SessionManager(
    { state, queue, resolved: { model: { provider: "openai", id: "gpt-4o-mini" }, stream: createMockStream({ delayMs: 0 }) } },
    { emit: () => {}, fetchModels: fakeFetch },
  );
  const r1 = await smOpenai.listModels("openai");
  assert.equal(r1.error, undefined);
  assert.equal(r1.models[0]?.id, "glm-5.3");
  assert.equal(r1.url.endsWith("/models"), true, "URL 应按 baseUrl 推导出 /models");
  assert.equal(calls, 1);

  // 缓存：第二次不再打网络
  const r2 = await smOpenai.listModels("openai");
  assert.equal(calls, 1, "TTL 内应命中缓存");
  assert.equal(r2.models[0]?.id, "glm-5.3");

  // refresh=true 强制刷新 → 第 3 次调用模拟 HTTP 500 → error 回退且不打成功缓存
  const r3 = await smOpenai.listModels("openai", true);
  assert.equal(calls, 2, "refresh=true 应绕过缓存");
  assert.ok(
    r3.error !== undefined && r3.error.includes("500"),
    `HTTP 500 应转成 error 字符串，实际 ${String(r3.error)}`,
  );
  assert.equal(r3.models.length, 0);

  // refresh 失败后旧的成功缓存仍在（TTL 内）：非 refresh 再拉命中旧缓存，不打网络。
  // 语义：失败不打掉已有成功结果——UI 点刷新失败时列表还能显示旧数据。
  const r4 = await smOpenai.listModels("openai");
  assert.equal(calls, 2, "失败不应打掉 TTL 内的成功缓存");
  assert.equal(r4.error, undefined);
  assert.equal(r4.models[0]?.id, "glm-5.3");

  void cwd;
});

test("info().contextWindow：优先取提供商 /models 元数据；warmModelsCache 拉到后广播 refresh-info", async () => {
  const cwd = process.cwd();
  const state = createInitialState({ cwd, model: { provider: "mock", id: "mock-1" }, tools: [] });
  const queue = new MessageQueue();
  const payload = {
    object: "list",
    data: [{ id: "glm-5.3", owned_by: "opencode", context_window: 200000 }],
  };
  const requestedUrls: string[] = [];
  const fakeFetch = (async (url: string | URL) => {
    requestedUrls.push(String(url));
    return { ok: true, status: 200, json: async () => payload } as unknown as Response;
  }) as unknown as typeof fetch;

  const sm = new SessionManager(
    { state, queue, resolved: { model: { provider: "openai", id: "glm-5.3" }, stream: createMockStream({ delayMs: 0 }) } },
    { emit: () => {}, fetchModels: fakeFetch },
  );
  // 未预热：元数据缓存为空 → 回退内置粗表（glm-5.3 不在表里 → 1M 兜底，用户定调）
  assert.equal(sm.info().contextWindow, 1_000_000);

  // 拉到提供商元数据 → 返回 true（主进程据此广播 refresh-info），分母换成真值
  assert.equal(await sm.warmModelsCache(), true);
  assert.equal(sm.info().contextWindow, 200000);
  assert.equal(requestedUrls.some((u) => u.endsWith("/models")), true, "应请求端点推导的 /models URL");
  // TTL 内再预热：值没变化 → false，不再广播
  assert.equal(await sm.warmModelsCache(), false);
  void cwd;
});

test("info().contextWindow：自定义模型 baseUrl 直连 /models 的元数据也认", async () => {
  const state = createInitialState({ cwd: process.cwd(), model: { provider: "mock", id: "mock-1" }, tools: [] });
  const queue = new MessageQueue();
  const payload = { object: "list", data: [{ id: "my-model", context_window: 96000 }] };
  const requestedUrls: string[] = [];
  const fakeFetch = (async (url: string | URL) => {
    requestedUrls.push(String(url));
    return { ok: true, status: 200, json: async () => payload } as unknown as Response;
  }) as unknown as typeof fetch;
  const sm = new SessionManager(
    {
      state,
      queue,
      resolved: {
        model: { provider: "openai", id: "my-model", baseUrl: "https://custom.example.com/v1", apiKey: "sk-test" },
        stream: createMockStream({ delayMs: 0 }),
      },
    },
    { emit: () => {}, fetchModels: fakeFetch },
  );
  assert.equal(await sm.warmModelsCache(), true);
  assert.equal(sm.info().contextWindow, 96000);
  assert.ok(
    requestedUrls.includes("https://custom.example.com/v1/models"),
    `应请求自定义 baseUrl 直连的 /models，实际：${JSON.stringify(requestedUrls)}`,
  );
});

test("listCustomModels：三协议 URL 推导与鉴权头；无 key 不带鉴权；非 http 前缀直接报错", async () => {
  const state = createInitialState({ cwd: process.cwd(), model: { provider: "mock", id: "mock-1" }, tools: [] });
  const queue = new MessageQueue();
  const requested: Array<{ url: string; headers: Record<string, string> }> = [];
  const fakeFetch = (async (url: string | URL, init?: { headers?: Record<string, string> }) => {
    requested.push({ url: String(url), headers: init?.headers ?? {} });
    // gemini 端点回 models[] 格式，其余回 openai 的 data[] 格式（parseModelsResponse 按协议分流）
    const body = String(url).includes("generativelanguage")
      ? { models: [{ name: "models/gemini-2.5-flash", displayName: "Gemini 2.5 Flash", inputTokenLimit: 1048576 }] }
      : { object: "list", data: [{ id: "glm-5.3" }] };
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;

  const sm = new SessionManager(
    { state, queue, resolved: { model: { provider: "mock", id: "mock-1" }, stream: createMockStream({ delayMs: 0 }) } },
    { emit: () => {}, fetchModels: fakeFetch },
  );

  // openai 兼容：Bearer + {base}/models（尾斜杠剥掉）
  const r1 = await sm.listCustomModels({ baseURL: "https://api.deepseek.com/v1/", apiKey: "sk-ds" });
  assert.equal(r1.error, undefined);
  assert.equal(r1.models[0]?.id, "glm-5.3");
  assert.equal(r1.url, "https://api.deepseek.com/v1/models");
  assert.equal(requested[0]?.headers["authorization"], "Bearer sk-ds");

  // anthropic：x-api-key + anthropic-version + {base}/v1/models
  const r2 = await sm.listCustomModels({
    baseURL: "https://api.anthropic.com",
    apiKey: "sk-ant",
    protocol: "anthropic",
  });
  assert.equal(r2.error, undefined);
  assert.equal(r2.url, "https://api.anthropic.com/v1/models");
  assert.equal(requested[1]?.headers["x-api-key"], "sk-ant");
  assert.equal(requested[1]?.headers["anthropic-version"], "2023-06-01");

  // gemini：x-goog-api-key + {base}/models；models[] 格式解析后 name 剥掉 models/ 前缀
  const r3 = await sm.listCustomModels({
    baseURL: "https://generativelanguage.googleapis.com/v1beta",
    apiKey: "g-key",
    protocol: "gemini",
  });
  assert.equal(r3.error, undefined);
  assert.equal(r3.url, "https://generativelanguage.googleapis.com/v1beta/models");
  assert.equal(r3.models[0]?.id, "gemini-2.5-flash");
  assert.equal(requested[2]?.headers["x-goog-api-key"], "g-key");

  // 无 key（本地端点）：请求照发，但不带鉴权字段
  const r4 = await sm.listCustomModels({ baseURL: "http://127.0.0.1:11434/v1" });
  assert.equal(r4.error, undefined);
  assert.equal(requested[3]?.headers["authorization"], undefined);

  // 非 http 前缀：直接报错，不打网络
  const r5 = await sm.listCustomModels({ baseURL: "api.example.com/v1", apiKey: "sk-x" });
  assert.ok(r5.error !== undefined && r5.error.includes("http"), `应提示 http 前缀，实际 ${String(r5.error)}`);
  assert.equal(r5.models.length, 0);
  assert.equal(requested.length, 4, "非法 baseURL 不应发出请求");
});

// ───────────── macOS 听写：helper stdout 协议解析 ─────────────
import { parseDictationLine } from "../desktop/main/dictation.js";

test("parseDictationLine：ready/partial/final/error 四种行；坏行静默丢弃", () => {
  assert.deepEqual(parseDictationLine('{"kind":"ready"}'), { kind: "ready", text: "" });
  assert.deepEqual(parseDictationLine('{"kind":"partial","text":"你好"}'), {
    kind: "partial",
    text: "你好",
  });
  assert.deepEqual(parseDictationLine('{"kind":"final","text":"你好世界"}'), {
    kind: "final",
    text: "你好世界",
  });
  assert.deepEqual(parseDictationLine('{"kind":"error","message":"麦克风权限被拒绝"}'), {
    kind: "error",
    text: "麦克风权限被拒绝",
  });
  // error 行也可能带 text（协议宽容）；两者都没有时空串
  assert.deepEqual(parseDictationLine('{"kind":"error","text":"x"}'), { kind: "error", text: "x" });
  assert.deepEqual(parseDictationLine('{"kind":"error"}'), { kind: "error", text: "" });

  // 坏行 → null（不打断识别流）
  assert.equal(parseDictationLine(""), null);
  assert.equal(parseDictationLine("   \n"), null);
  assert.equal(parseDictationLine("not-json"), null);
  assert.equal(parseDictationLine('{"no-kind":1}'), null);
  assert.equal(parseDictationLine("[]"), null);
});

// ------------------------------------------------- approval diff 预览（desktop）

test("approval-diff：bash 给命令原文；未知工具退回 JSON 摘要", () => {
  assert.equal(
    buildApprovalDetail({ toolName: "bash", args: { command: "echo hi" }, cwd: "/tmp" }),
    "echo hi",
  );
  const detail = buildApprovalDetail({ toolName: "ffmpeg_export", args: { input: "a.mp4" }, cwd: "/tmp" });
  assert.match(detail, /"input"/, "非内置 mutating 工具退回 JSON 参数摘要");
});

test("approval-diff：write 新文件给头部预览，覆盖写给 -/+ diff", async () => {
  const dir = await tempDir();

  // 新文件：不存在 → 「新文件」+ 内容头部预览
  const fresh = buildApprovalDetail({
    toolName: "write",
    args: { path: "new.txt", content: "l1\nl2\nl3" },
    cwd: dir,
  });
  assert.match(fresh, /新文件/);
  assert.match(fresh, /\| l1/);
  assert.match(fresh, /3 行/);

  // 覆盖写：读旧内容做 diff，中间改动块 -/+，前后未变行数注明
  await fs.writeFile(path.join(dir, "a.txt"), "head\nold-1\nold-2\ntail", "utf8");
  const overwrite = buildApprovalDetail({
    toolName: "write",
    args: { path: "a.txt", content: "head\nnew-1\nnew-2\ntail" },
    cwd: dir,
  });
  assert.match(overwrite, /a\.txt（行数 4 → 4）/);
  assert.match(overwrite, /前后共 2 行未变/);
  assert.match(overwrite, /- old-1/);
  assert.match(overwrite, /\+ new-1/);
  assert.doesNotMatch(overwrite, /- head/, "未变行不出现在 diff 里");
});

test("approval-diff：edit 给行号与唯一性预检；找不到 oldString 提前告知", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "b.txt");
  await fs.writeFile(file, "one\ntwo\nthree\n", "utf8");

  const unique = buildApprovalDetail({
    toolName: "edit",
    args: { path: file, oldString: "two", newString: "TWO" },
    cwd: dir,
  });
  assert.match(unique, /1 处替换，第 2 行起/);
  assert.match(unique, /- two/);
  assert.match(unique, /\+ TWO/);

  const missing = buildApprovalDetail({
    toolName: "edit",
    args: { path: file, oldString: "nope", newString: "x" },
    cwd: dir,
  });
  assert.match(missing, /oldString 在文件中未找到，执行会失败/);

  // "two"、"three" 里各出现一次 → 2 次
  const dup = buildApprovalDetail({
    toolName: "edit",
    args: { path: file, oldString: "t", newString: "x" },
    cwd: dir,
  });
  assert.match(dup, /出现 2 次，执行会失败/);
});

test("approval-diff：超长 diff 截断并注明省略量；文件过大不逐行 diff", async () => {
  const dir = await tempDir();

  // 旧文件 60 行 → 新内容 60 行：前后缀不重叠，-/+ 合计 120 行 → 截断到 40
  const old60 = Array.from({ length: 60 }, (_, i) => `old${i}`).join("\n");
  await fs.writeFile(path.join(dir, "big.txt"), old60, "utf8");
  const many = buildApprovalDetail({
    toolName: "write",
    args: {
      path: "big.txt",
      content: Array.from({ length: 60 }, (_, i) => `new${i}`).join("\n"),
    },
    cwd: dir,
  });
  assert.match(many, /diff 共 120 行，已省略 80 行/);

  // 旧文件超过 MAX_DIFF_FILE_LINES → 只给统计不给逐行
  const hugeOld = Array.from({ length: 5200 }, () => "x").join("\n");
  await fs.writeFile(path.join(dir, "huge.txt"), hugeOld, "utf8");
  const stats = buildApprovalDetail({
    toolName: "write",
    args: { path: "huge.txt", content: "y" },
    cwd: dir,
  });
  assert.match(stats, /文件过大，不生成逐行 diff/);
  assert.match(stats, /行数 5200 → 1/);
});

test("prompts: 默认系统提示词带 Environment 事实（日期 / shell），不带规则化建议", () => {
  const state = createInitialState({
    cwd: process.cwd(),
    model: { provider: "mock", id: "mock-1" },
    tools: allTools,
  });
  // 感知注入是事实不是规则：日期、shell、运行时都在
  assert.match(state.systemPrompt, /当前日期：\d{4}-\d{2}-\d{2}（周.）/);
  assert.match(state.systemPrompt, /Shell：/);
  assert.match(state.systemPrompt, /运行时：/);
  // 快照建议句已按消失之问砍掉——事实给足，谨慎交给模型
  assert.ok(!state.systemPrompt.includes("破坏性 git 操作"));
});

test("Environment：readGitSnapshot 带未提交文件数；非 git 目录返回 null", async () => {
  const dir = await tempDir();
  assert.equal(await readGitSnapshot(dir), null);

  const git = (args: string[]) => promisify(execFile)("git", args, { cwd: dir });
  await git(["init", "-q"]);
  await git(["-c", "user.email=t@t.local", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "init"]);

  const clean = await readGitSnapshot(dir);
  assert.equal(clean?.dirty, false);
  assert.equal(clean?.dirtyFiles, 0);
  assert.ok((clean?.branch.length ?? 0) > 0);

  await fs.writeFile(path.join(dir, "a.txt"), "x", "utf8");
  await fs.writeFile(path.join(dir, "b.txt"), "y", "utf8");
  const dirty = await readGitSnapshot(dir);
  assert.equal(dirty?.dirty, true);
  assert.equal(dirty?.dirtyFiles, 2);
});

// ----------------------------------------------------------------- 会话持久化

test("sessions: save → load 往返还原会话树（含 compact 旧分支）", async () => {
  const dir = await tempDir();
  const state = createInitialState({
    cwd: dir,
    model: { provider: "mock", id: "mock-1" },
    tools: allTools,
  });
  appendNode(state, { role: "user", content: "第一轮", timestamp: 0 });
  appendNode(state, {
    role: "assistant",
    content: [{ type: "text", text: "好的" }],
    model: "m",
    stopReason: "stop",
    usage: emptyUsage(),
    timestamp: 0,
  });
  // compact 语义：建第二棵树的 Root，旧分支原样保留
  addNodeAt(state, null, { role: "user", content: "[前文对话摘要]\n摘要内容", timestamp: 0 });
  appendNode(state, { role: "user", content: "压缩后的新问题", timestamp: 0 });

  const id = await saveSession(state, dir);
  assert.match(id, /^s\d{8}_\d{6}_/);
  assert.equal(state.sessionId, id);
  assert.ok(await sessionFileExists(dir, id));

  const fresh = createInitialState({
    cwd: dir,
    model: { provider: "mock", id: "mock-1" },
    tools: allTools,
  });
  assert.equal(await loadSessionInto(fresh, dir, id), true);
  assert.equal(fresh.sessionId, id);
  assert.equal(fresh.rootId, state.rootId);
  assert.equal(fresh.currentNodeId, state.currentNodeId);
  assert.equal(fresh.nodes.size, state.nodes.size);
  for (const [nodeId, node] of state.nodes) {
    const restored = fresh.nodes.get(nodeId);
    assert.ok(restored !== undefined, `节点 ${nodeId} 应还原`);
    assert.equal(restored.parent, node.parent);
    assert.deepEqual(restored.children, node.children);
  }
  // 线性视图从 ★ 重算：只含摘要 Root + 新问题，compact 旧分支不进来
  assert.deepEqual(fresh.messages.map((m) => m.role), state.messages.map((m) => m.role));
  assert.equal(fresh.messages.length, 2);
  // 同一 state 再次保存落同一个文件
  assert.equal(await saveSession(fresh, dir), id);
});

test("sessions: listSessions 按 savedAt 倒序，latestSessionId 取最新", async () => {
  const dir = await tempDir();
  const state = createInitialState({
    cwd: dir,
    model: { provider: "mock", id: "mock-1" },
    tools: allTools,
  });
  const id1 = await saveSession(state, dir);
  state.sessionId = undefined; // 绕过同 id 复用，强制第二个会话
  await new Promise((r) => setTimeout(r, 5));
  const id2 = await saveSession(state, dir);
  assert.notEqual(id1, id2);

  const list = await listSessions(dir);
  assert.equal(list.length, 2);
  assert.equal(list[0]?.id, id2, "新的在前");
  assert.equal(await latestSessionId(dir), id2);
});

test("sessions: 载入不存在的 id / 损坏文件返回 false，state 不动", async () => {
  const dir = await tempDir();
  const state = createInitialState({
    cwd: dir,
    model: { provider: "mock", id: "mock-1" },
    tools: allTools,
  });
  appendNode(state, { role: "user", content: "hi", timestamp: 0 });
  const before = {
    rootId: state.rootId,
    current: state.currentNodeId,
    count: state.nodes.size,
    sessionId: state.sessionId,
  };

  assert.equal(await loadSessionInto(state, dir, "s_nothing"), false);
  await fs.mkdir(sessionsDir(dir), { recursive: true });
  await fs.writeFile(path.join(sessionsDir(dir), "s_bad.json"), "{not json", "utf8");
  assert.equal(await loadSessionInto(state, dir, "s_bad"), false);

  assert.equal(state.rootId, before.rootId);
  assert.equal(state.currentNodeId, before.current);
  assert.equal(state.nodes.size, before.count);
  assert.equal(state.sessionId, before.sessionId);
});

test("sessions: Agent persistSessions 在 agent_end 后自动落盘", async () => {
  const dir = await tempDir();
  const state = createInitialState({
    cwd: dir,
    model: { provider: "mock", id: "mock-1" },
    tools: allTools,
  });
  const agent = new Agent({
    state,
    stream: async function* () {
      yield { type: "done", reason: "stop", message: textOnly("完成") };
    },
    persistSessions: true,
  });
  agent.enqueueUser("记一下");
  await agent.run();

  const list = await listSessions(dir);
  assert.equal(list.length, 1);
  assert.ok(list[0] !== undefined && state.sessionId === list[0].id);
});

// ---------------------------------------------------------------- config

test("config: saveModelSpec / readSavedModelSpec 往返，覆盖写", async () => {
  const dir = await tempDir();
  assert.equal(await readSavedModelSpec(dir), null, "无配置文件 → null");

  await saveModelSpec(dir, "openai:gpt-4o-mini");
  assert.equal(await readSavedModelSpec(dir), "openai:gpt-4o-mini");

  await saveModelSpec(dir, "opencode:glm-5.3:strong");
  assert.equal(await readSavedModelSpec(dir), "opencode:glm-5.3:strong", "第二次保存覆盖第一次");

  await fs.rm(dir, { recursive: true, force: true });
});

test("config: 损坏 / 版本不识别 / model 字段缺失的 config.json 返回 null", async () => {
  const dir = await tempDir();
  const configFile = path.join(dir, ".c-agent", "config.json");
  await fs.mkdir(path.dirname(configFile), { recursive: true });

  await fs.writeFile(configFile, "{not json", "utf8");
  assert.equal(await readSavedModelSpec(dir), null, "坏 JSON → null");

  await fs.writeFile(configFile, JSON.stringify({ version: 99, model: "mock:mock-1" }), "utf8");
  assert.equal(await readSavedModelSpec(dir), null, "版本不识别 → null");

  await fs.writeFile(configFile, JSON.stringify({ version: 1 }), "utf8");
  assert.equal(await readSavedModelSpec(dir), null, "model 字段缺失 → null");

  await fs.writeFile(configFile, JSON.stringify({ version: 1, model: "   " }), "utf8");
  assert.equal(await readSavedModelSpec(dir), null, "空白 model → null");

  await fs.rm(dir, { recursive: true, force: true });
});

test("config: saveCustomModel / readSavedCustomModel 往返；spec 与 customModel 互斥（最后一次的选择是唯一真相）", async () => {
  const dir = await tempDir();
  assert.equal(await readSavedCustomModel(dir), null, "无配置文件 → null");

  await saveCustomModel(dir, {
    provider: "anthropic",
    id: "glm-5.3",
    baseUrl: "https://relay.example.com",
    apiKey: "sk-test",
    contextWindow: 200000,
  });
  const back = await readSavedCustomModel(dir);
  assert.notEqual(back, null, "customModel 往返");
  assert.equal(back!.provider, "anthropic");
  assert.equal(back!.id, "glm-5.3");
  assert.equal(back!.baseUrl, "https://relay.example.com");
  assert.equal(back!.apiKey, "sk-test");
  assert.equal(back!.contextWindow, 200000);

  // 互斥：写 spec 清 customModel
  await saveModelSpec(dir, "opencode:glm-5.3");
  assert.equal(await readSavedCustomModel(dir), null, "写 spec 后 customModel 被清");
  assert.equal(await readSavedModelSpec(dir), "opencode:glm-5.3");

  // 互斥：写 customModel 清 spec
  await saveCustomModel(dir, {
    provider: "openai",
    id: "deepseek-chat",
    baseUrl: "https://api.example.com/v1",
    apiKey: "EMPTY",
  });
  assert.equal(await readSavedModelSpec(dir), null, "写 customModel 后 spec 被清");
  const noCtx = await readSavedCustomModel(dir);
  assert.equal(noCtx!.contextWindow, undefined, "contextWindow 缺省不产出字段");
  assert.equal(noCtx!.apiKey, "EMPTY", "EMPTY 占位原样存取（本地端点约定）");

  await fs.rm(dir, { recursive: true, force: true });
});

test("config: 字段不完整的 customModel 视为损坏返回 null", async () => {
  const dir = await tempDir();
  const configFile = path.join(dir, ".c-agent", "config.json");
  await fs.mkdir(path.dirname(configFile), { recursive: true });

  await fs.writeFile(
    configFile,
    JSON.stringify({ version: 1, customModel: { provider: "", id: "x", baseUrl: "https://a", apiKey: "" } }),
    "utf8",
  );
  assert.equal(await readSavedCustomModel(dir), null, "provider 为空 → null");

  await fs.writeFile(
    configFile,
    JSON.stringify({ version: 1, customModel: { provider: "openai", id: "x", baseUrl: "", apiKey: "k" } }),
    "utf8",
  );
  assert.equal(await readSavedCustomModel(dir), null, "baseUrl 为空 → null");

  await fs.writeFile(
    configFile,
    JSON.stringify({ version: 1, customModel: { provider: "openai", id: "x", baseUrl: "https://a" } }),
    "utf8",
  );
  assert.equal(await readSavedCustomModel(dir), null, "apiKey 缺失 → null");

  await fs.rm(dir, { recursive: true, force: true });
});

test("config: modelSpecString 生成可回放的 spec（含 maturity），parseModelSpec 能无损吃回来", () => {
  assert.equal(modelSpecString({ provider: "opencode-go", id: "glm-5.1" }), "opencode-go:glm-5.1");
  assert.equal(
    modelSpecString({ provider: "zhipu", id: "glm-4.7", maturity: "strong" }),
    "zhipu:glm-4.7:strong",
  );
  const back = parseModelSpec(modelSpecString({ provider: "opencode", id: "glm-5.3", maturity: "budget" }));
  assert.equal(back.provider, "opencode");
  assert.equal(back.id, "glm-5.3");
  assert.equal(back.maturity, "budget");
});

// ------------------------------------------------------- computer use 通道

test("mapMacHotkey：修饰键+触发键 → kVK 键码 + CGEventFlags 掩码；非法输入 fail", () => {
  // ctrl c：ctrl=59（kVK_Control），c=8（kVK_ANSI_C），flags = kCGEventFlagMaskControl
  assert.deepEqual(mapMacHotkey("ctrl c"), { codes: [59, 8], flags: 1 << 18 });
  // cmd shift 3：cmd=55，shift=56，3=20；flags = command|shift
  assert.deepEqual(mapMacHotkey("cmd shift 3"), {
    codes: [55, 56, 20],
    flags: (1 << 20) | (1 << 17),
  });
  // 纯修饰键（无触发键）、空串、未知键名、超 3 键 → null
  assert.equal(mapMacHotkey("ctrl"), null);
  assert.equal(mapMacHotkey(""), null);
  assert.equal(mapMacHotkey("ctrl foo"), null);
  assert.equal(mapMacHotkey("a b c d"), null);
  // 字母键码非字母序（macOS kVK 表）：s=1、z=6、v=9
  assert.deepEqual(mapMacHotkey("alt v"), { codes: [58, 9], flags: 1 << 19 });
});

test("toolResult 图片块：convertToLlm 保留 screenshot 的图，openai 适配器转 image_url", () => {
  const dataUrl = "data:image/jpeg;base64,QUJD";
  const llm = convertToLlm([
    { role: "user", content: "看屏幕", timestamp: 0 },
    {
      role: "toolResult",
      toolCallId: "t1",
      toolName: "screenshot",
      content: [
        { type: "text", text: "屏幕截图 1920x1080" },
        { type: "image", dataUrl },
      ],
      isError: false,
      timestamp: 0,
    },
  ]);
  const block = llm.flatMap((m) => m.content).find((c) => c.type === "toolResult");
  assert.ok(block && block.type === "toolResult");
  assert.equal(block.content.some((c) => c.type === "image" && c.dataUrl === dataUrl), true,
    "图片块应随 toolResult 一起进模型上下文");

  const openai = toOpenAiMessages("sys", llm);
  // role=tool 消息只留文本；图片降级为紧随其后的 user 消息
  // （兼容上游拒 tool 消息带图：mimo-v2.5 实测 400，官方 API 同样不支持）
  const toolMsg = openai.find((m) => (m as { role?: string }).role === "tool") as
    | { content: string | Array<{ type: string; image_url?: { url: string } }> }
    | undefined;
  assert.ok(toolMsg);
  const toolHasImage =
    typeof toolMsg.content !== "string" &&
    toolMsg.content.some((p) => p.type === "image_url");
  assert.equal(toolHasImage, false, "role=tool 消息不应携带 image_url part");
  assert.equal(typeof toolMsg.content === "string" && toolMsg.content.includes("屏幕截图"), true,
    "tool 消息应保留文本部分");

  const afterTool = openai[openai.indexOf(toolMsg) + 1] as {
    role?: string;
    content?: Array<{ type: string; image_url?: { url: string } }>;
  };
  assert.equal(afterTool?.role, "user", "图片应作为 tool 消息之后的 user 消息注入");
  assert.equal(
    afterTool.content?.some((p) => p.type === "image_url" && p.image_url?.url === dataUrl),
    true,
    "user 消息应携带原图 image_url part",
  );
});

test("transformContext：旧轮次的截图块替换成占位文本，当前轮保留", () => {
  // 直接构造历史消息走 transformContext 的兼容路径（state.messages 赋值）
  const state = createInitialState({
    cwd: process.cwd(),
    model: { provider: "mock", id: "mock-1" },
    tools: allTools,
  });
  state.messages = [
    { role: "user", content: "看屏幕", timestamp: 1 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "a1", name: "screenshot", arguments: {} }],
      model: "mock",
      stopReason: "toolUse",
      usage: emptyUsage(),
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "a1",
      toolName: "screenshot",
      content: [
        { type: "text", text: "屏幕截图" },
        { type: "image", dataUrl: "data:image/jpeg;base64,XXX" },
      ],
      isError: false,
      timestamp: 3,
    },
    { role: "user", content: "新的请求", timestamp: 4 },
  ];
  const { messages: out } = transformContext(state, {
    maxContextTokens: 1_000_000,
    maxToolResultChars: 2000,
    keepRecentTurns: 0,
  });
  const tr = out.find((m) => m.role === "toolResult");
  assert.ok(tr && tr.role === "toolResult");
  assert.equal(tr.content.some((c) => c.type === "image"), false, "旧轮截图应被抹掉");
  assert.match(resultText(tr.content), /截图已省略/);
});

async function main(): Promise<void> {
  const { main: runMain } = await import("./registry.js");
  await runMain();
  await sweepTestTmpDirs();
}

/**
 * 测试各处用 mkdtemp 在系统 temp 下建目录，散落的用例大多没有清理——
 * 不清扫的话每跑一轮测试就在 temp 里漏十几个目录，日积月累上千个。
 * 这里在全部用例跑完后按前缀统一清扫：本轮新建的 + 历史漏网的都收掉。
 * 前缀刻意选了不易撞车的（pillars- 除外，但它在用户 temp 下只有本仓库会建）。
 */
const TMP_SWEEP_PREFIXES = ["agent-test-", "pillars-", "c-agent-bot-test-", "c-agent-weixin-test-"];

async function sweepTestTmpDirs(): Promise<void> {
  const tmp = os.tmpdir();
  const entries = await fs.readdir(tmp).catch(() => [] as string[]);
  let removed = 0;
  for (const name of entries) {
    if (!TMP_SWEEP_PREFIXES.some((p) => name.startsWith(p))) continue;
    await fs.rm(path.join(tmp, name), { recursive: true, force: true }).catch(() => {});
    removed += 1;
  }
  if (removed > 0) console.log(`\n[cleanup] 已清扫测试临时目录 ${removed} 个（${tmp}）`);
}

const invokedDirectly = process.argv[1] !== undefined && process.argv[1].endsWith("run.ts");
if (invokedDirectly) {
  await main();
}
