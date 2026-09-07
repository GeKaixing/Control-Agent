/**
 * 工具冒烟测试：不依赖测试框架，直接跑，退出码 0 = 全过。
 *
 * Part A「模型视角往返」：每个内置工具都走一遍模型真实调用路径——
 *   JSON 字符串参数（模型 toolcall_delta 发出来的就是它）→ JSON.parse
 *   → validateParams(tool.parameters) → execute() → 断言结果。
 * Part B「真模型端到端」：真端点跑一轮任务，让模型自己决定调哪些工具，
 *   校验 tool 事件序列与落盘产物。
 *
 * 跑法：npx tsx scripts/tool-smoke.ts
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Agent, type AgentEvent } from "../src/agent/agent.js";
import { TOOL_REGISTRY } from "../src/tools/index.js";
import { validateParams } from "../src/tools/validate.js";
import type { ToolContext } from "../src/tools/types.js";
import { assembleSession, loadDotEnv } from "../src/session.js";

const ROOT = path.resolve(import.meta.dirname, "..");

function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "tool-smoke-"));
}

function noSignal(): AbortSignal {
  return new AbortController().signal;
}

/** 模拟模型发来的 toolcall：参数是 JSON 字符串，走完整校验 → 执行链路 */
async function callAsModel(
  toolName: string,
  rawArgsJson: string,
  ctx: ToolContext,
): Promise<{ isError: boolean; text: string }> {
  const tool = TOOL_REGISTRY[toolName as keyof typeof TOOL_REGISTRY];
  assert.ok(tool, `未知工具：${toolName}`);
  const parsed: unknown = JSON.parse(rawArgsJson);
  const v = validateParams(tool.parameters, parsed);
  assert.equal(v.ok, true, `${toolName} 参数校验失败：${v.ok ? "" : v.error}`);
  if (!v.ok) throw new Error("unreachable");
  const result = await tool.execute(v.value, ctx);
  return { isError: result.isError, text: result.content.map((c) => ("text" in c ? c.text : "")).join("\n") };
}

let passed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
    process.exitCode = 1;
  }
}

// ============================================================ Part A

async function partA(): Promise<void> {
  console.log("\n== Part A：模型视角往返（JSON 参数 → 校验 → 执行）==\n");
  const dir = await tempDir();
  const ctx: ToolContext = { cwd: dir, signal: noSignal() };

  // ---- write → read 往返
  const w = await callAsModel("write", JSON.stringify({ path: "notes/demo.txt", content: "alpha\nbeta\ngamma\ndelta\nepsilon\n" }), ctx);
  check("write 创建嵌套目录写入", !w.isError);
  const onDisk = await fs.readFile(path.join(dir, "notes/demo.txt"), "utf8");
  check("write 落盘内容一致", onDisk.startsWith("alpha\nbeta"));

  const r = await callAsModel("read", JSON.stringify({ path: "notes/demo.txt" }), ctx);
  check("read 带行号返回", !r.isError && r.text.includes("1\talpha") && r.text.includes("5\tepsilon"));

  const r2 = await callAsModel("read", JSON.stringify({ path: "notes/demo.txt", offset: 2, limit: 2 }), ctx);
  check("read offset/limit 截取", !r2.isError && r2.text.includes("2\tbeta") && r2.text.includes("3\tgamma") && !r2.text.includes("4\tdelta"));

  const rMissing = await callAsModel("read", JSON.stringify({ path: "nope.txt" }), ctx);
  check("read 缺文件返回 isError", rMissing.isError);

  // ---- edit
  const e = await callAsModel("edit", JSON.stringify({ path: "notes/demo.txt", oldString: "gamma", newString: "GAMMA" }), ctx);
  const after = await fs.readFile(path.join(dir, "notes/demo.txt"), "utf8");
  check("edit 唯一匹配替换", !e.isError && after.includes("GAMMA") && !after.includes("gamma"));

  const eDup = await callAsModel("edit", JSON.stringify({ path: "notes/demo.txt", oldString: "a", newString: "X" }), ctx);
  check("edit 多处匹配拒绝", eDup.isError, eDup.text.slice(0, 60));

  // ---- bash
  const b = await callAsModel("bash", JSON.stringify({ command: "echo bash-$USER && printf 'pipe-ok'" }), ctx);
  check("bash 执行并回传输出", !b.isError && b.text.includes("pipe-ok"));

  const bFail = await callAsModel("bash", JSON.stringify({ command: "exit 7" }), ctx);
  check("bash 非零退出码 → isError", bFail.isError && bFail.text.includes("7"));

  // ---- glob / grep
  await fs.mkdir(path.join(dir, "src/lib"), { recursive: true });
  await fs.writeFile(path.join(dir, "src/a.ts"), "const smokeTarget = 1;\n");
  await fs.writeFile(path.join(dir, "src/lib/b.ts"), "// smokeTarget again\n");
  const g = await callAsModel("glob", JSON.stringify({ pattern: "src/**/*.ts" }), ctx);
  check("glob 递归匹配", !g.isError && g.text.includes("a.ts") && g.text.includes("b.ts"));

  const gr = await callAsModel("grep", JSON.stringify({ pattern: "smokeTarget" }), ctx);
  check("grep 命中两个文件", !gr.isError && gr.text.includes("a.ts") && gr.text.includes("b.ts"));

  const grNone = await callAsModel("grep", JSON.stringify({ pattern: "不存在的内容xyz" }), ctx);
  check("grep 无命中不报错", !grNone.isError);

  // ---- memory
  const m1 = await callAsModel("memory", JSON.stringify({ action: "append", content: "冒烟测试写入的记忆" }), ctx);
  check("memory append 成功", !m1.isError && m1.text.includes("已写入"));
  const m2 = await callAsModel("memory", JSON.stringify({ action: "read" }), ctx);
  check("memory read 回读", !m2.isError && m2.text.includes("冒烟测试写入的记忆"));

  // ---- 参数校验兜底（模型发错参数时 harness 的第一道防线）
  const bad1 = validateParams(TOOL_REGISTRY.read.parameters, JSON.parse('{"path": 123}'));
  check("validateParams 类型错误拦截", !bad1.ok);
  const bad2 = validateParams(TOOL_REGISTRY.memory.parameters, JSON.parse('{"action": "destroy"}'));
  check("validateParams enum 非法值拦截", !bad2.ok);
  const bad3 = validateParams(TOOL_REGISTRY.write.parameters, JSON.parse('{"path": "a.txt"}'));
  check("validateParams 缺必填拦截", !bad3.ok);

  await fs.rm(dir, { recursive: true, force: true });
  console.log(`\nPart A 完成：${passed} 项断言通过`);
}

// ============================================================ Part B

async function partB(): Promise<void> {
  console.log("\n== Part B：真模型端到端（模型自己挑工具完成任务）==\n");

  await loadDotEnv(ROOT); // 真端点密钥在仓库根 .env
  const workdir = await tempDir();
  const { state, queue, resolved } = await assembleSession({ cwd: workdir });
  if (resolved.degraded !== undefined) {
    console.log(`  （模型降级：${resolved.degraded}）`);
  }
  console.log(`  模型：${resolved.model.provider}:${resolved.model.id}`);

  const toolCalls: { name: string; ok: boolean }[] = [];
  const onEvent = (event: AgentEvent): void => {
    if (event.type === "tool_start") {
      const argStr = JSON.stringify(event.toolCall.arguments);
      console.log(`  → 模型调用 ${event.toolCall.name}(${argStr.slice(0, 80)}${argStr.length > 80 ? "…" : ""})`);
      toolCalls.push({ name: event.toolCall.name, ok: true });
    } else if (event.type === "tool_end") {
      const last = toolCalls[toolCalls.length - 1];
      if (last && !event.result.isError) check(`tool_end ${event.toolCall.name} 成功`, true);
    }
  };

  const agent = new Agent({ state, queue, stream: resolved.stream, onEvent });
  agent.enqueueUser(
    "请完成两步：1) 用 write 工具在当前目录创建 todo.txt，内容为『smoke-e2e-12345』；" +
    "2) 用 read 工具读回这个文件确认内容。完成后用一句话告诉我文件内容。",
  );
  await agent.run();

  const used = new Set(toolCalls.map((t) => t.name));
  const written = await fs.readFile(path.join(workdir, "todo.txt"), "utf8").catch(() => null);
  check("模型调用了 write", used.has("write"));
  check("模型调用了 read", used.has("read"));
  check("落盘文件内容正确", written === "smoke-e2e-12345", `实际：${JSON.stringify(written)}`);
  check("模型给了终态文本回复", state.messages.some((m) => m.role === "assistant"));

  await fs.rm(workdir, { recursive: true, force: true });
  console.log(`\nPart B 完成：工具调用 ${toolCalls.length} 次（${[...used].join(", ")}）`);
}

partA()
  .then(partB)
  .then(() => {
    if (process.exitCode === 1) {
      console.error("\n冒烟测试存在失败项 ✗");
    } else {
      console.log("\n冒烟测试全部通过 ✓");
    }
  })
  .catch((err: unknown) => {
    console.error("\n冒烟测试异常退出：", err);
    process.exitCode = 1;
  });
