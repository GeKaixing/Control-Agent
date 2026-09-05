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
import { activeBranch, addNodeAt, appendNode, currentNode, pathToRoot, switchTo } from "../src/agent/state.js";
import { createMockStream } from "../src/providers/mock.js";
import type { StreamFn, StreamOptions } from "../src/providers/types.js";
import { allTools, bashTool, editTool, globTool, grepTool, readTool, writeTool, type ToolName } from "../src/tools/index.js";
import type { Tool } from "../src/tools/types.js";
import { ok } from "../src/tools/types.js";
import { globToRegExp, matchesGlob } from "../src/tools/glob-matcher.js";
import { validateParams } from "../src/tools/validate.js";
import { buildSeedMessages, DEFAULT_PREFILL_COMMIT } from "../src/index.js";
import { createPrintOutput } from "../src/ui/print.js";
import type {
  AgentMessage,
  AssistantMessage,
  ModelRef,
  ToolCallContent,
} from "../src/types.js";
import { emptyUsage } from "../src/types.js";

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
