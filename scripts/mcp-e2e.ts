/**
 * MCP 外部工具端到端测试：网络获取的官方 MCP server 经 MCP 桥接 connector
 * 进入 agent，验证「发现 → 直调 → 真模型自主调用」三层。
 *
 * Part A 直调：loader → runtime → runtime.execute，直接打每个 server 的代表工具。
 * Part B 真模型：mimo-v2.5 自己决定调外部工具完成算术 + 回显任务。
 *
 * 注意：server-everything v2.0.0 起工具名改为 kebab-case（add → get-sum、
 * printEnv → get-env）。跑法：npx tsx scripts/mcp-e2e.ts
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Agent, type AgentEvent } from "../src/agent/agent.js";
import { ConnectorLoader } from "../src/connector/loader/connector-loader.js";
import { ConnectorRuntime } from "../src/connector/runtime/connector-runtime.js";
import { validateParams } from "../src/tools/validate.js";
import { assembleSession, loadDotEnv } from "../src/session.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const CONNECTORS_DIR = path.join(ROOT, "connectors-mcp");

const BUILTIN_NAMES = new Set(["read", "write", "edit", "bash", "glob", "grep", "memory"]);

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

async function setupRuntime(tmp: string): Promise<ConnectorRuntime> {
  const loader = new ConnectorLoader({ paths: [CONNECTORS_DIR] });
  const { loaded, failed } = await loader.scan();
  for (const f of failed) console.error(`  [loader] failed: ${path.basename(f.rootDir)} -> ${f.error}`);

  const runtime = new ConnectorRuntime({
    cwd: tmp,
    // server-memory 的知识图谱落到临时目录，不污染仓库
    env: Object.fromEntries(Object.entries(process.env)),
  });
  for (const c of loaded) {
    if (runtime.registry.get(c.manifest.id) === undefined) runtime.adopt(c);
  }
  const startFailed = await runtime.start();
  if (startFailed.length > 0) {
    throw new Error(`connector start failed: ${startFailed.join(", ")}`);
  }
  return runtime;
}

async function exec(
  runtime: ConnectorRuntime,
  tool: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string }> {
  const r = await runtime.execute(tool, args);
  return { isError: r.isError, text: r.content.map((c) => ("text" in c ? c.text : "")).join("\n") };
}

// ============================================================ Part A

async function partA(tmp: string): Promise<ConnectorRuntime> {
  console.log("\n== Part A：直调外部 MCP 工具（loader → runtime → execute）==\n");
  const runtime = await setupRuntime(tmp);

  const names = runtime.registry.toolNames();
  console.log(`  发现外部工具 ${names.length} 个：${names.join(", ")}`);
  check("三个 MCP server 全部加载", runtime.size() === 3, `实际 ${runtime.size()}`);
  check("everything 有 echo 工具", names.includes("echo"));
  check("everything 有 get-sum 工具（v2.0 起 add 改名）", names.includes("get-sum"));
  check("sequential-thinking 有 sequentialthinking 工具", names.includes("sequentialthinking"));
  check("memory 有知识图谱工具", names.includes("create_entities") && names.includes("read_graph"));

  // ---- everything: echo + get-sum
  const echo = await exec(runtime, "echo", { message: "hello-from-c-agent" });
  check("everything/echo 回显", !echo.isError && echo.text.includes("hello-from-c-agent"), echo.text.slice(0, 80));

  const sum = await exec(runtime, "get-sum", { a: 20, b: 22 });
  check("everything/get-sum 20+22=42", !sum.isError && sum.text.includes("42"), sum.text.slice(0, 80));

  // 参数 schema 归一化后能被项目 validateParams 接受
  const sumTool = runtime.extraTools().find((t) => t.name === "get-sum");
  assert.ok(sumTool);
  const v = validateParams(sumTool.parameters, { a: 20, b: 22 });
  check("get-sum 的 MCP schema 归一化后通过 validateParams", v.ok);
  check("get-sum 只读不标记 mutating", sumTool.isMutating === false);

  // ---- sequential-thinking
  const st = await exec(runtime, "sequentialthinking", {
    thought: "先把 20 和 22 相加，得到 42。",
    nextThoughtNeeded: false,
    thoughtNumber: 1,
    totalThoughts: 1,
  });
  check("sequentialthinking 返回推理记录", !st.isError && st.text.length > 0, st.text.slice(0, 80));

  // ---- memory: 知识图谱增查
  const create = await exec(runtime, "create_entities", {
    entities: [{ name: "小码", entityType: "AI-agent", observations: ["会写 TypeScript", "住在 WorkBuddy 里"] }],
  });
  check("memory/create_entities 成功", !create.isError, create.text.slice(0, 120));

  const read = await exec(runtime, "read_graph", {});
  check("memory/read_graph 读回实体", !read.isError && read.text.includes("小码"), read.text.slice(0, 120));

  const search = await exec(runtime, "search_nodes", { query: "小码" });
  check("memory/search_nodes 命中", !search.isError && search.text.includes("TypeScript"), search.text.slice(0, 120));

  // mutating 标记走审批门的工具
  const createTool = runtime.extraTools().find((t) => t.name === "create_entities");
  check("memory 写工具标记 isMutating", createTool?.isMutating === true);

  console.log(`\nPart A 完成：${passed} 项断言通过`);
  return runtime;
}

// ============================================================ Part B

async function partB(runtime: ConnectorRuntime, tmp: string): Promise<void> {
  console.log("\n== Part B：真模型自主调用外部 MCP 工具 ==\n");

  await loadDotEnv(ROOT);
  const { state, queue, resolved } = await assembleSession({ cwd: tmp, extraTools: runtime.extraTools() });
  const extNames = state.tools.filter((t) => !BUILTIN_NAMES.has(t.name)).map((t) => t.name);
  console.log(`  模型：${resolved.model.provider}:${resolved.model.id}，外部工具进上下文：${extNames.join(", ")}`);

  const calls: string[] = [];
  const onEvent = (event: AgentEvent): void => {
    if (event.type === "tool_start") {
      const argStr = JSON.stringify(event.toolCall.arguments);
      console.log(`  → ${event.toolCall.name}(${argStr.slice(0, 90)}${argStr.length > 90 ? "…" : ""})`);
      calls.push(event.toolCall.name);
    }
  };

  const agent = new Agent({ state, queue, stream: resolved.stream, onEvent });
  agent.enqueueUser(
    "请依次完成两步：1) 用 get-sum 工具计算 231 加 312；2) 用 echo 工具把结果原样回显一遍。" +
    "最后用一句话告诉我最终数字。不要用 bash 或心算，必须用这两个工具。",
  );
  await agent.run();

  check("模型调用了外部 get-sum 工具", calls.includes("get-sum"));
  check("模型调用了外部 echo 工具", calls.includes("echo"));
  const finalText = state.messages
    .filter((m) => m.role === "assistant")
    .map((m) => m.content.filter((c) => c.type === "text").map((c) => c.text).join(""))
    .join("\n");
  check("最终回答包含 543", finalText.includes("543"), finalText.slice(-150));

  console.log(`\nPart B 完成：模型共调用工具 ${calls.length} 次（${[...new Set(calls)].join(", ")}）`);
}

async function main(): Promise<void> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-e2e-"));
  let runtime: ConnectorRuntime | undefined;
  try {
    runtime = await partA(tmp);
    await partB(runtime, tmp);
  } finally {
    await runtime?.dispose().catch(() => {});
    await fs.rm(tmp, { recursive: true, force: true });
  }
  if (process.exitCode === 1) {
    console.error("\nMCP 外部工具测试存在失败项 ✗");
  } else {
    console.log("\nMCP 外部工具测试全部通过 ✓");
  }
}

main().catch((err: unknown) => {
  console.error("\nMCP E2E 异常退出：", err);
  process.exitCode = 1;
});
