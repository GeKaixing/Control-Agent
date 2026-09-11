/**
 * 五支柱增量测试（2026-09-06）：
 * - Model：流失败自动重试（成功 / 耗尽 / abort 不重试）
 * - Permission：审批门（拒绝 / 只拦 mutating / 抛异常按拒绝）+ 灾难命令护栏
 * - Context：collectProjectMemory + assembleSession 记忆注入
 * - Environment：readGitSnapshot
 * - Tool：read 剩余行提示 + 二进制文件提示
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { test, assert } from "./registry.js";

/** 取工具结果内容里的全部文本（content 现在可能含 screenshot 返回的图片块） */
function resultTextOf(content: { type: string; text?: string }[]): string {
  return content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
}
import { Agent, type AgentEvent } from "../src/agent/agent.js";
import { createInitialState, MessageQueue } from "../src/context/index.js";
import { SessionManager } from "../desktop/main/session.js";
import { emptyUsage } from "../src/types.js";
import type { AgentMessage, AssistantMessage } from "../src/types.js";
import type { StreamEvent, StreamFn } from "../src/providers/types.js";
import { allTools, readTool, memoryTool, memoryPath } from "../src/tools/index.js";
import { matchCatastrophicCommand, bashTool } from "../src/tools/bash.js";
import { fail, ok, type Tool } from "../src/tools/types.js";
import { openaiStream, reasoningEffort } from "../src/providers/openai.js";
import {
  assembleSession,
  collectProjectMemory,
  formatAdbSnapshotLine,
  parseAdbDevices,
  readAdbSnapshot,
  readGitSnapshot,
} from "../src/session.js";
import { convertToLlm } from "../src/agent/convert.js";
import type { LlmMessage } from "../src/providers/types.js";

// ------------------------------------------------------------ 构造辅助

function textMsg(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    model: "mock:m",
    stopReason: "stop",
    usage: emptyUsage(),
    timestamp: 0,
  };
}

function errMsg(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    model: "mock:m",
    stopReason: "error",
    errorMessage: text,
    usage: emptyUsage(),
    timestamp: 0,
  };
}

function toolMsg(toolCall: { id: string; name: string; arguments: Record<string, unknown> }): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", ...toolCall }],
    model: "mock:m",
    stopReason: "toolUse",
    usage: emptyUsage(),
    timestamp: 0,
  };
}

function streamOf(script: (call: number) => StreamEvent[]): StreamFn {
  let call = 0;
  return async function* () {
    call += 1;
    for (const event of script(call)) yield event;
  };
}

async function makeAgent(opts: {
  stream: StreamFn;
  cwd?: string;
  approvalGate?: ConstructorParameters<typeof Agent>[0]["approvalGate"];
  maxStreamRetries?: number;
}): Promise<{ agent: Agent; events: AgentEvent[] }> {
  const state = createInitialState({
    cwd: opts.cwd ?? os.tmpdir(),
    model: { provider: "mock", id: "m" },
    tools: allTools,
  });
  const events: AgentEvent[] = [];
  const agent = new Agent({
    state,
    stream: opts.stream,
    approvalGate: opts.approvalGate,
    maxStreamRetries: opts.maxStreamRetries,
    onEvent: (event) => {
      events.push(event);
    },
  });
  return { agent, events };
}

function lastText(messages: AgentMessage[]): string {
  const last = messages[messages.length - 1];
  if (last === undefined || last.role !== "assistant") return "";
  return last.content
    .filter((c): c is Extract<(typeof last)["content"][number], { type: "text" }> => c.type === "text")
    .map((c) => c.text)
    .join("");
}

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "pillars-"));
}

// ------------------------------------------------------------ Model：流失败重试

test("Model：流失败自动重试，第二次成功", async () => {
  const { agent, events } = await makeAgent({
    stream: streamOf((call) =>
      call === 1
        ? [{ type: "error", reason: "error", error: errMsg("网络抖动") }]
        : [{ type: "done", reason: "stop", message: textMsg("恢复后的回答") }],
    ),
    maxStreamRetries: 1,
  });
  agent.enqueueUser("hi");
  await agent.run();
  assert.equal(lastText(agent.state.messages), "恢复后的回答");
  const notices = events.filter((e) => e.type === "notice");
  assert.equal(notices.length, 1);
  assert.ok(notices[0] !== undefined && notices[0].message.includes("自动重试"));
});

test("Model：重试耗尽后落 error 终态", async () => {
  const { agent, events } = await makeAgent({
    stream: streamOf(() => [{ type: "error", reason: "error", error: errMsg("一直挂") }]),
    maxStreamRetries: 1,
  });
  agent.enqueueUser("hi");
  await agent.run();
  const last = agent.state.messages[agent.state.messages.length - 1];
  assert.ok(last !== undefined && last.role === "assistant");
  const asst = last as AssistantMessage;
  assert.equal(asst.stopReason, "error");
  assert.equal(asst.errorMessage, "一直挂");
  // 恰好重试 1 次：两次模型调用 + 一条重试 notice
  const notices = events.filter((e) => e.type === "notice");
  assert.equal(notices.length, 1);
});

test("Model：reason=aborted 不重试", async () => {
  let calls = 0;
  const { agent } = await makeAgent({
    stream: streamOf(() => {
      calls += 1;
      return [{ type: "error", reason: "aborted", error: errMsg("已中断") }];
    }),
    maxStreamRetries: 3,
  });
  agent.enqueueUser("hi");
  await agent.run();
  assert.equal(calls, 1);
});

// ------------------------------------------------------------ Model：动态推理强度

test("Model：openai 请求体带 reasoning_effort；o/gpt-5 系列用 max_completion_tokens", async () => {
  const captured: Record<string, unknown>[] = [];
  const sse =
    'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n' +
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n' +
    "data: [DONE]\n\n";
  const stubFetch: typeof fetch = async (_url, init) => {
    captured.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return new Response(sse, { status: 200 });
  };
  const origFetch = globalThis.fetch;
  globalThis.fetch = stubFetch;
  try {
    const opts = {
      model: { provider: "openai" as const, id: "mimo-v2.5", apiKey: "k" },
      systemPrompt: "s",
      messages: [],
      tools: [],
      maxTokens: 100,
      signal: new AbortController().signal,
    };
    // high → reasoning_effort "high"；普通兼容端点仍用 max_tokens
    for await (const _ of openaiStream({ ...opts, thinkingLevel: "high" })) void _;
    assert.deepEqual(captured[0]?.["reasoning_effort"], "high");
    assert.equal(captured[0]?.["max_tokens"], 100);
    assert.equal(captured[0]?.["max_completion_tokens"], undefined);

    // off → 不发 reasoning_effort
    for await (const _ of openaiStream({ ...opts, thinkingLevel: "off" })) void _;
    assert.equal(captured[1]?.["reasoning_effort"], undefined);

    // o 系列：max_tokens 改走 max_completion_tokens
    for await (const _ of openaiStream({
      ...opts,
      model: { provider: "openai" as const, id: "o4-mini", apiKey: "k" },
      thinkingLevel: "medium",
    })) void _;
    assert.deepEqual(captured[2]?.["reasoning_effort"], "medium");
    assert.equal(captured[2]?.["max_completion_tokens"], 100);
    assert.equal(captured[2]?.["max_tokens"], undefined);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("Model：reasoningEffort 映射 off 不发、minimal/low 归 low", () => {
  assert.equal(reasoningEffort("off"), undefined);
  assert.equal(reasoningEffort("minimal"), "low");
  assert.equal(reasoningEffort("low"), "low");
  assert.equal(reasoningEffort("medium"), "medium");
  assert.equal(reasoningEffort("high"), "high");
});

test("Model：工具连续失败升档推理强度，成功回落", async () => {
  const seenLevels: string[] = [];
  const boom: Tool = {
    name: "boom",
    description: "总是失败",
    parameters: { type: "object", properties: {}, required: [] },
    isMutating: false,
    execute: async () => fail("总是失败"),
  };
  const fine: Tool = {
    name: "fine",
    description: "总是成功",
    parameters: { type: "object", properties: {}, required: [] },
    isMutating: false,
    execute: async () => ok("成功"),
  };
  const state = createInitialState({
    cwd: os.tmpdir(),
    model: { provider: "mock", id: "m" },
    tools: [boom, fine], // thinkingLevel 缺省 low
  });

  let call = 0;
  const stream: StreamFn = async function* (opts) {
    call += 1;
    seenLevels.push(opts.thinkingLevel);
    if (call === 1) yield { type: "done", reason: "toolUse", message: toolMsg({ id: "c1", name: "boom", arguments: {} }) };
    else if (call === 2) yield { type: "done", reason: "toolUse", message: toolMsg({ id: "c2", name: "boom", arguments: {} }) };
    else if (call === 3) yield { type: "done", reason: "toolUse", message: toolMsg({ id: "c3", name: "fine", arguments: {} }) };
    else yield { type: "done", reason: "stop", message: textMsg("完成") };
  };

  const events: AgentEvent[] = [];
  const agent = new Agent({ state, stream, onEvent: (e) => void events.push(e) });
  agent.enqueueUser("hi");
  await agent.run();

  // 第 1 轮 low；第 1 次失败后仍 low（阈值 2）；第 2 次失败升 medium；成功后回落 low
  assert.deepEqual(seenLevels, ["low", "low", "medium", "low"]);
  const escalations = events.filter(
    (e) => e.type === "notice" && e.message.includes("推理强度 low → medium"),
  );
  assert.equal(escalations.length, 1);
  // state.thinkingLevel 不被动态调整污染
  assert.equal(state.thinkingLevel, "low");
});

test("Model：base thinkingLevel off 时不参与动态升降", async () => {
  const seenLevels: string[] = [];
  const boom: Tool = {
    name: "boom",
    description: "总是失败",
    parameters: { type: "object", properties: {}, required: [] },
    isMutating: false,
    execute: async () => fail("总是失败"),
  };
  const state = createInitialState({
    cwd: os.tmpdir(),
    model: { provider: "mock", id: "m" },
    tools: [boom],
    thinkingLevel: "off",
  });

  let call = 0;
  const stream: StreamFn = async function* (opts) {
    call += 1;
    seenLevels.push(opts.thinkingLevel);
    if (call <= 2) yield { type: "done", reason: "toolUse", message: toolMsg({ id: `c${call}`, name: "boom", arguments: {} }) };
    else yield { type: "done", reason: "stop", message: textMsg("完成") };
  };

  const agent = new Agent({ state, stream });
  agent.enqueueUser("hi");
  await agent.run();
  assert.deepEqual(seenLevels, ["off", "off", "off"]);
});

// ------------------------------------------------------------ Permission：审批门

test("Permission：审批门拒绝 mutating 工具，文件不被写", async () => {
  const dir = await tmpDir();
  const target = path.join(dir, "no.txt");
  const gated: string[] = [];
  const { agent } = await makeAgent({
    cwd: dir,
    stream: streamOf((call) =>
      call === 1
        ? [{
            type: "done",
            reason: "toolUse" as const,
            message: toolMsg({ id: "c1", name: "write", arguments: { path: "no.txt", content: "x" } }),
          }]
        : [{ type: "done", reason: "stop" as const, message: textMsg("好的，不写了") }],
    ),
    approvalGate: (req) => {
      gated.push(req.toolName);
      return false;
    },
  });
  agent.enqueueUser("写个文件");
  await agent.run();
  assert.deepEqual(gated, ["write"]);
  await assert.rejects(fs.access(target));
  const result = agent.state.messages.find(
    (m): m is Extract<typeof m, { role: "toolResult" }> => m.role === "toolResult",
  );
  assert.ok(result !== undefined && result.isError);
  assert.ok(resultTextOf(result.content).includes("审批门"));
});

test("Permission：只读工具不经过审批门", async () => {
  const dir = await tmpDir();
  await fs.writeFile(path.join(dir, "a.txt"), "内容", "utf8");
  let gateCalls = 0;
  const { agent } = await makeAgent({
    cwd: dir,
    stream: streamOf((call) =>
      call === 1
        ? [{
            type: "done",
            reason: "toolUse" as const,
            message: toolMsg({ id: "c1", name: "read", arguments: { path: "a.txt" } }),
          }]
        : [{ type: "done", reason: "stop" as const, message: textMsg("读完了") }],
    ),
    approvalGate: () => {
      gateCalls += 1;
      return false;
    },
  });
  agent.enqueueUser("读文件");
  await agent.run();
  assert.equal(gateCalls, 0);
  const result = agent.state.messages.find((m) => m.role === "toolResult");
  assert.ok(result !== undefined && result.role === "toolResult" && !result.isError);
});

test("Permission：审批门抛异常按拒绝处理并发 notice", async () => {
  const dir = await tmpDir();
  const { agent, events } = await makeAgent({
    cwd: dir,
    stream: streamOf((call) =>
      call === 1
        ? [{
            type: "done",
            reason: "toolUse" as const,
            message: toolMsg({ id: "c1", name: "write", arguments: { path: "x.txt", content: "x" } }),
          }]
        : [{ type: "done", reason: "stop" as const, message: textMsg("收到") }],
    ),
    approvalGate: () => {
      throw new Error("审批 UI 崩了");
    },
  });
  agent.enqueueUser("hi");
  await agent.run();
  const result = agent.state.messages.find(
    (m): m is Extract<typeof m, { role: "toolResult" }> => m.role === "toolResult",
  );
  assert.ok(result !== undefined && result.isError);
  assert.ok(events.some((e) => e.type === "notice" && e.message.includes("审批门异常")));
});

// ------------------------------------------------------------ Permission×Environment：灾难命令护栏

test("Permission：灾难命令模式识别（纯函数）", () => {
  assert.ok(matchCatastrophicCommand("rm -rf /") !== null);
  assert.ok(matchCatastrophicCommand("rm -fr ~") !== null);
  assert.ok(matchCatastrophicCommand("rm -f -r / ") !== null);
  assert.ok(matchCatastrophicCommand("mkfs.ext4 /dev/sda1") !== null);
  assert.ok(matchCatastrophicCommand("dd if=zero of=/dev/disk0") !== null);
  assert.ok(matchCatastrophicCommand(":(){ :|:& };:") !== null);
  assert.ok(matchCatastrophicCommand("chmod -R 777 /") !== null);
  // Windows 灾难模式（format / diskpart / 递归删盘 / 注册表 hive / 卷影副本）
  assert.ok(matchCatastrophicCommand("format C: /fs:ntfs") !== null);
  assert.ok(matchCatastrophicCommand("format.com D:") !== null);
  assert.ok(matchCatastrophicCommand("echo select disk 0 > dp.txt && echo clean >> dp.txt && diskpart /s dp.txt") !== null);
  assert.ok(matchCatastrophicCommand("Remove-Item -Recurse -Force C:\\") !== null);
  assert.ok(matchCatastrophicCommand("Remove-Item -Recurse C:\\*") !== null);
  assert.ok(matchCatastrophicCommand("rm -Recurse $env:USERPROFILE") !== null);
  assert.ok(matchCatastrophicCommand("Remove-Item -Recurse ~") !== null);
  assert.ok(matchCatastrophicCommand("rd /s /q C:\\") !== null);
  assert.ok(matchCatastrophicCommand("del /s /q C:\\*.*") !== null);
  assert.ok(matchCatastrophicCommand("reg delete HKLM /f") !== null);
  assert.ok(matchCatastrophicCommand("reg delete HKLM\\SOFTWARE /f") !== null);
  assert.ok(matchCatastrophicCommand("vssadmin delete shadows /all /quiet") !== null);
  assert.ok(matchCatastrophicCommand("wmic shadowcopy where \"Drive='C:'\" delete") !== null);
  // Windows 日常操作不拦（子目录、深层注册表键、format-patch 等同形词）
  assert.equal(matchCatastrophicCommand("Remove-Item -Recurse ./dist"), null);
  assert.equal(matchCatastrophicCommand("Remove-Item -Recurse C:\\temp\\build"), null);
  assert.equal(matchCatastrophicCommand("del /s /q C:\\temp\\*.log"), null);
  assert.equal(matchCatastrophicCommand("reg delete HKCU\\Environment /v TEMP /f"), null);
  assert.equal(matchCatastrophicCommand("git format-patch -1 HEAD"), null);
  assert.equal(matchCatastrophicCommand("Get-ChildItem -Recurse C:\\Windows"), null);
  // 日常危险操作不拦
  assert.equal(matchCatastrophicCommand("rm -rf node_modules build"), null);
  assert.equal(matchCatastrophicCommand("rm -rf /tmp/x"), null);
  assert.equal(matchCatastrophicCommand("chmod 777 ./script.sh"), null);
  assert.equal(matchCatastrophicCommand("git push --force"), null);
});

test("Permission：bash 工具拦截灾难命令，不真正执行", async () => {
  const result = await bashTool.execute(
    { command: "echo 前置 && rm -rf /" },
    { cwd: os.tmpdir(), signal: new AbortController().signal },
  );
  assert.ok(result.isError);
  assert.ok(resultTextOf(result.content).includes("已拦截灾难性命令"));
});

// ------------------------------------------------------------ Context：项目记忆注入

test("Context：collectProjectMemory 只注入 .control-agent 跨会话记忆，不注入 AGENTS.md", async () => {
  const dir = await tmpDir();
  await fs.writeFile(path.join(dir, "AGENTS.md"), "# 仓库规则\n先跑测试", "utf8");
  await fs.mkdir(path.join(dir, ".workbuddy", "memory"), { recursive: true });
  await fs.writeFile(path.join(dir, ".workbuddy", "memory", "MEMORY.md"), "长期记忆内容", "utf8");
  const memory = await collectProjectMemory(dir);
  // 开发/人类侧文档不注入：AGENTS.md 与 .workbuddy 记忆都按需 read
  assert.ok(!memory.includes("先跑测试"));
  assert.ok(!memory.includes("长期记忆内容"));

  const empty = await tmpDir();
  assert.equal(await collectProjectMemory(empty), "");
});

// ------------------------------------------------------------ Context：跨会话记忆

test("Tool：memory append 写入带时间戳条目，read 读回", async () => {
  const dir = await tmpDir();
  const ctx = { cwd: dir, signal: new AbortController().signal };

  // 空记忆：read 提示不存在
  const empty = await memoryTool.execute({ action: "read" }, ctx);
  assert.equal(empty.isError, false);
  assert.ok(resultTextOf(empty.content).includes("还没有任何跨会话记忆"));

  // append → 写入 .control-agent/memory.md，带时间戳
  const appended = await memoryTool.execute(
    { action: "append", content: "用户偏好 TypeScript 严格模式" },
    ctx,
  );
  assert.equal(appended.isError, false);
  const raw = await fs.readFile(memoryPath(dir), "utf8");
  assert.match(raw, /^- \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] 用户偏好 TypeScript 严格模式$/m);

  // 再 append 一条：追加不覆盖
  await memoryTool.execute({ action: "append", content: "项目用 npm test 跑测试" }, ctx);
  const raw2 = await fs.readFile(memoryPath(dir), "utf8");
  assert.ok(raw2.includes("用户偏好 TypeScript 严格模式"));
  assert.ok(raw2.includes("项目用 npm test 跑测试"));

  // read → 两条都在
  const readBack = await memoryTool.execute({ action: "read" }, ctx);
  assert.ok(resultTextOf(readBack.content).includes("用户偏好 TypeScript 严格模式"));
  assert.ok(resultTextOf(readBack.content).includes("项目用 npm test 跑测试"));
});

test("Tool：memory append 空 content 报错；未知 action 报错", async () => {
  const dir = await tmpDir();
  const ctx = { cwd: dir, signal: new AbortController().signal };

  const noContent = await memoryTool.execute({ action: "append", content: "  " }, ctx);
  assert.ok(noContent.isError);

  const badAction = await memoryTool.execute({ action: "delete" }, ctx);
  assert.ok(badAction.isError);
  assert.ok(resultTextOf(badAction.content).includes("未知 action"));
});

test("Context：collectProjectMemory 注入跨会话记忆，assembleSession 传导", async () => {
  const dir = await tmpDir();
  const ctx = { cwd: dir, signal: new AbortController().signal };
  await memoryTool.execute({ action: "append", content: "记住：用户偏好 gitmoji 彩卡" }, ctx);

  const memory = await collectProjectMemory(dir);
  assert.ok(memory.includes("跨会话记忆"));
  assert.ok(memory.includes("记住：用户偏好 gitmoji 彩卡"));

  const { state } = await assembleSession({ cwd: dir });
  assert.ok(state.systemPrompt.includes("记住：用户偏好 gitmoji 彩卡"));
});

test("Context：assembleSession 把跨会话记忆注入系统提示词", async () => {
  const dir = await tmpDir();
  // 记忆文件在项目根（MEMORY.md，用户定调：可见、可直接编辑）
  await fs.writeFile(path.join(dir, "MEMORY.md"), "项目约定内容XYZ", "utf8");
  const { state } = await assembleSession({ cwd: dir });
  assert.ok(state.systemPrompt.includes("# 追加指令"));
  assert.ok(state.systemPrompt.includes("项目约定内容XYZ"));
  // tmp 目录不是 git 仓库 → 不注入 git 环境快照。
  // 注意：`[环境快照]` 前缀被 git 与 adb 两条线共用，而 adb 探测与是否 git 仓库无关
  // （装了 adb 就会注入一行），所以断言必须落在 git 专属字段上，不能整个前缀一起否掉。
  assert.ok(!state.systemPrompt.includes("git 分支"));
  const envLines = state.systemPrompt
    .split("\n")
    .filter((line) => line.startsWith("[环境快照]"));
  assert.ok(envLines.every((line) => line.includes("adb")));

  // 显式 systemPrompt 时完全替换，不注入
  const { state: s2 } = await assembleSession({ cwd: dir, systemPrompt: "自定义提示词" });
  assert.ok(!s2.systemPrompt.includes("项目约定内容XYZ"));
});

// ------------------------------------------------------------ Environment：git 环境快照

test("Environment：readGitSnapshot 在真实 git 仓库读出分支", async () => {
  const snap = await readGitSnapshot(process.cwd());
  // 测试跑在项目根目录（本仓库就是 git 仓库）
  assert.ok(snap !== null);
  assert.ok(snap.branch.length > 0);
  assert.equal(typeof snap.dirty, "boolean");

  const outside = await readGitSnapshot(await tmpDir());
  assert.equal(outside, null);
});

test("Environment：parseAdbDevices 解析 adb 输出；注入行区分有/无设备", async () => {
  // 标准输出：daemon 告警 + 表头 + 两台设备（一台已授权一台未授权）
  const devices = parseAdbDevices(
    [
      "* daemon not running; starting now at tcp:5037",
      "List of devices attached",
      "emulator-5554\tdevice",
      "1A2B3C4D\tunauthorized",
      "",
    ].join("\n"),
  );
  assert.deepEqual(devices, [
    { serial: "emulator-5554", state: "device" },
    { serial: "1A2B3C4D", state: "unauthorized" },
  ]);

  // Windows \r\n 换行也能解析
  assert.deepEqual(
    parseAdbDevices("List of devices attached\r\nXYZ123\tdevice\r\n"),
    [{ serial: "XYZ123", state: "device" }],
  );

  // adb 在场但没设备 → 空数组
  assert.deepEqual(parseAdbDevices("List of devices attached\n"), []);

  // 注入行：有设备时报设备名与能力提示；未授权的提醒确认弹窗
  const line = formatAdbSnapshotLine({ devices });
  assert.match(line, /emulator-5554\(device\)/);
  assert.match(line, /1A2B3C4D\(unauthorized\)/);
  assert.match(line, /mobile_screen/);
  assert.match(line, /mobile_ui/);
  assert.match(line, /mobile_act/);
  assert.match(line, /USB 调试授权弹窗/);

  // 无设备：仍告知 adb 通道存在，并指路 USB 调试
  const emptyLine = formatAdbSnapshotLine({ devices: [] });
  assert.match(emptyLine, /adb 可用/);
  assert.match(emptyLine, /USB 调试/);

  // 真机探测：adb 未装 → null；装了 → devices 是数组（不假设本机是否连着手机）
  const snap = await readAdbSnapshot();
  if (snap !== null) {
    assert.ok(Array.isArray(snap.devices));
  }
});

// ------------------------------------------------------------ Tool：read 观测质量

test("Tool：read 未读完时提示剩余行数与续读 offset", async () => {
  const dir = await tmpDir();
  const lines = Array.from({ length: 10 }, (_, i) => `第${i + 1}行`);
  await fs.writeFile(path.join(dir, "long.txt"), lines.join("\n"), "utf8");
  const result = await readTool.execute(
    { path: "long.txt", limit: 3 },
    { cwd: dir, signal: new AbortController().signal },
  );
  assert.ok(!result.isError);
  const text = resultTextOf(result.content);
  assert.ok(text.includes("共 10 行"));
  assert.ok(text.includes("后续还有 7 行未读"));
  assert.ok(text.includes("offset=4"));
});

test("Tool：read 二进制文件给出媒体格式提示", async () => {
  const dir = await tmpDir();
  await fs.writeFile(path.join(dir, "img.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]), "utf8");
  const result = await readTool.execute(
    { path: "img.png" },
    { cwd: dir, signal: new AbortController().signal },
  );
  assert.ok(result.isError);
  const text = resultTextOf(result.content);
  assert.ok(text.includes("无法按文本读取"));
  assert.ok(text.includes(".png"));
});

// ────────────── Permission：桌面端审批接线（SessionManager + 审批门） ──────────────

interface AnyEvent {
  t?: string;
  type?: string;
  [k: string]: unknown;
}

async function until(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("等待超时：agent 未按时结束");
    await new Promise((r) => setTimeout(r, 25));
  }
}

function makeSession(opts: {
  dir: string;
  script: (call: number) => StreamEvent[];
  approvalPrompt?: (req: { toolName: string; args: string }) => Promise<"allow" | "always" | "deny">;
}): { sm: SessionManager; events: AnyEvent[] } {
  const state = createInitialState({
    cwd: opts.dir,
    model: { provider: "mock", id: "mock-1" },
    tools: allTools,
  });
  const events: AnyEvent[] = [];
  const sm = new SessionManager(
    {
      state,
      queue: new MessageQueue(),
      resolved: { model: { provider: "mock", id: "mock-1" }, stream: streamOf(opts.script) },
    },
    { emit: (e) => events.push(e as AnyEvent), approvalPrompt: opts.approvalPrompt },
  );
  return { sm, events };
}

test("Permission：桌面端审批——拒绝时工具不执行且广播审批事件", async () => {
  const dir = await tmpDir();
  const decisions: string[] = [];
  const { sm, events } = makeSession({
    dir,
    script: (call) =>
      call === 1
        ? [{ type: "done", reason: "toolUse" as const, message: toolMsg({ id: "c1", name: "write", arguments: { path: "out.txt", content: "x" } }) }]
        : [{ type: "done", reason: "stop" as const, message: textMsg("收到拒绝，不再写") }],
    approvalPrompt: async (req) => {
      decisions.push(req.toolName);
      return "deny";
    },
  });
  sm.setApprovalMode(true);
  assert.equal(sm.getApprovalMode(), true);
  assert.equal(sm.info().approvalMode, true);

  await sm.submit("写个文件");
  await until(() => events.some((e) => e.t === "end"));

  assert.deepEqual(decisions, ["write"]);
  await assert.rejects(fs.access(path.join(dir, "out.txt")));
  assert.ok(events.some((e) => e.t === "approval_request" && (e.toolName as string) === "write"));
  assert.ok(events.some((e) => e.t === "approval_done" && e.allow === false));
  // 直接验证 state：最后一个 toolResult 是审批拒绝
  const st = sm.getState();
  const toolResult = st.messages.find(
    (m): m is Extract<typeof m, { role: "toolResult" }> => m.role === "toolResult",
  );
  assert.ok(toolResult !== undefined && toolResult.isError);
  assert.ok(resultTextOf(toolResult.content).includes("审批"));
});

test("Permission：桌面端审批——「本会话全部允许」后续不再询问", async () => {
  const dir = await tmpDir();
  let prompts = 0;
  const { sm, events } = makeSession({
    dir,
    script: (call) => {
      if (call === 1) {
        return [{ type: "done", reason: "toolUse" as const, message: toolMsg({ id: "c1", name: "write", arguments: { path: "a.txt", content: "a" } }) }];
      }
      if (call === 2) return [{ type: "done", reason: "stop" as const, message: textMsg("第一轮完") }];
      if (call === 3) {
        return [{ type: "done", reason: "toolUse" as const, message: toolMsg({ id: "c2", name: "write", arguments: { path: "b.txt", content: "b" } }) }];
      }
      return [{ type: "done", reason: "stop" as const, message: textMsg("第二轮完") }];
    },
    approvalPrompt: async () => {
      prompts += 1;
      return "always";
    },
  });
  sm.setApprovalMode(true);
  await sm.submit("写 a.txt");
  await until(() => events.filter((e) => e.t === "end").length >= 1);
  await sm.submit("写 b.txt");
  await until(() => events.filter((e) => e.t === "end").length >= 2);

  assert.equal(prompts, 1); // 第二次 write 直接放行
  await fs.access(path.join(dir, "a.txt"));
  await fs.access(path.join(dir, "b.txt"));
});

test("Permission：审批模式关闭时不询问、直接执行", async () => {
  const dir = await tmpDir();
  let prompts = 0;
  const { sm, events } = makeSession({
    dir,
    script: (call) =>
      call === 1
        ? [{ type: "done", reason: "toolUse" as const, message: toolMsg({ id: "c1", name: "write", arguments: { path: "y.txt", content: "y" } }) }]
        : [{ type: "done", reason: "stop" as const, message: textMsg("写完了") }],
    approvalPrompt: async () => {
      prompts += 1;
      return "deny";
    },
  });
  await sm.submit("写文件");
  await until(() => events.some((e) => e.t === "end"));
  assert.equal(prompts, 0);
  await fs.access(path.join(dir, "y.txt"));
});

// ------------------------------------------------------------ 多模态（图片附件）

const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

test("多模态：convertToLlm 把 images 拼成 image 块，有图无文本用占位正文", () => {
  const now = Date.now();
  const out = convertToLlm([
    { role: "user", content: "图里有什么", images: [{ type: "image", dataUrl: PNG_DATA_URL }], timestamp: now },
  ]);
  assert.equal(out.length, 1);
  const msg = out[0];
  const imgs = msg.content.filter((c) => c.type === "image");
  assert.equal(imgs.length, 1);
  assert.equal((imgs[0] as { dataUrl: string }).dataUrl, PNG_DATA_URL);
  assert.ok(msg.content.some((c) => c.type === "text" && c.text === "图里有什么"));

  // 有图无文本：不能丢消息，正文用占位
  const imageOnly = convertToLlm([
    { role: "user", content: "", images: [{ type: "image", dataUrl: PNG_DATA_URL }], timestamp: now },
  ]);
  assert.equal(imageOnly.length, 1);
  const m2 = imageOnly[0];
  assert.ok(m2.content.some((c) => c.type === "text" && c.text.length > 0));
  assert.equal(m2.content.filter((c) => c.type === "image").length, 1);

  // 无图无文本：仍跳过
  assert.equal(convertToLlm([{ role: "user", content: "  ", timestamp: now }]).length, 0);
});

test("多模态：enqueueUser 带图片 → 消息树 images 落账、模型收到 image 块", async () => {
  let seenMessages: LlmMessage[] = [];
  const state = createInitialState({
    cwd: os.tmpdir(),
    model: { provider: "mock", id: "m" },
    tools: allTools,
  });
  const queue = new MessageQueue();
  const agent = new Agent({
    state,
    queue,
    stream: async function* (options) {
      seenMessages = options.messages;
      yield { type: "done", reason: "stop" as const, message: textMsg("看到了") };
    },
    onEvent: () => {},
  });
  agent.enqueueUser("图里有什么", [{ dataUrl: PNG_DATA_URL }]);
  await agent.run();

  const userMsg = state.messages.find((m) => m.role === "user");
  assert.ok(userMsg !== undefined && userMsg.role === "user");
  assert.equal(userMsg.images?.length, 1);
  assert.equal(userMsg.images?.[0]?.dataUrl, PNG_DATA_URL);

  const llmUser = seenMessages.find((m) => m.role === "user");
  assert.ok(llmUser !== undefined);
  assert.equal(llmUser.content.filter((c) => c.type === "image").length, 1);
});

test("多模态：estimateTokens 对图片按固定估值，不随 base64 长度爆炸", async () => {
  const state = createInitialState({
    cwd: os.tmpdir(),
    model: { provider: "mock", id: "m" },
    tools: allTools,
  });
  const bigDataUrl = "data:image/png;base64," + "A".repeat(1_000_000);
  state.messages.push({
    role: "user",
    content: "hi",
    images: [{ type: "image", dataUrl: bigDataUrl }],
    timestamp: Date.now(),
  });
  const { estimateTokens } = await import("../src/context/index.js");
  const tokens = estimateTokens(state.messages, "");
  // 1M base64 字符若按字符算约 28 万 token；固定估值下应远小于这个数
  assert.ok(tokens < 5_000, `tokens=${tokens}`);
});

test("Context：lastInputTokens 取最近一次 prompt_tokens，不是累计（窗口占比的分子）", async () => {
  const state = createInitialState({
    cwd: os.tmpdir(),
    model: { provider: "mock", id: "m" },
    tools: allTools,
  });
  const { lastInputTokens, totalUsage } = await import("../src/context/index.js");

  // 还没跑过任何一轮：没有真值，调用方该降级到估算
  assert.equal(lastInputTokens(state), null);

  // 造 3 轮：每轮重发整段上下文，input 递增（10k / 12k / 15k）
  for (const input of [10_000, 12_000, 15_000]) {
    state.messages.push({
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      model: "mock:m",
      stopReason: "stop",
      usage: { input, output: 100, cacheRead: 0, cacheWrite: 0, total: input + 100 },
      timestamp: Date.now(),
    });
  }

  assert.equal(lastInputTokens(state), 15_000);
  // 累计口径是 37k —— 正是拿它当窗口占用会几十倍高估的原因
  assert.equal(totalUsage(state).input, 37_000);
  assert.notEqual(lastInputTokens(state), totalUsage(state).input);
});

test("Context：estimateTokens 支持传自校准后的 chars/token（与 transform 预算同口径）", async () => {
  const { estimateTokens } = await import("../src/context/index.js");
  const messages = [
    {
      role: "user" as const,
      content: "x".repeat(3_500),
      timestamp: Date.now(),
    },
  ];
  // 默认 3.5 字符/token → 1000；显式传 7 → 500
  assert.equal(estimateTokens(messages, ""), 1_000);
  assert.equal(estimateTokens(messages, "", 7), 500);
});
