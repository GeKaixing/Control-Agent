/**
 * Mock 模型派发逻辑测试：覆盖 connector tool 派发分支。
 *
 * 测的是内部 `decide()` 函数——mock 流式生成的"决策阶段"。
 * 这是 mock 模型的核心：决定这一轮调哪个工具、传什么参数。
 *
 * 内置 6 个 tool（read/write/edit/bash/glob/grep）的派发在更早的测试里有覆盖，
 * 本文件只聚焦 connector 派发分支 + 边缘情况。
 */

import assert from "node:assert/strict";
import type { StreamOptions, StreamEvent } from "../src/providers/types.js";
import { decideForTest, mockStream } from "../src/providers/mock.js";
import type { JsonSchema, LlmTool } from "../src/providers/types.js";
import { test } from "./registry.js";

// ---- 工具：构造一份最小可用的 StreamOptions ----

const MODEL = { provider: "mock", id: "mock-1" } as const;

function llmTool(name: string, required: readonly string[] = ["input"]): LlmTool {
  const properties: JsonSchema["properties"] = {};
  for (const k of required) {
    properties[k] = { type: "string", description: `${k} parameter` };
  }
  // 加几个常见的可选字段，方便测试不同参数提取路径
  if (name === "video.cut" || name === "video.convert") {
    properties["output"] = { type: "string" };
    properties["codec"] = { type: "string" };
  }
  if (name === "video.cut") {
    properties["start"] = { type: "string" };
    properties["end"] = { type: "string" };
  }
  if (name === "audio.extract") {
    properties["output"] = { type: "string" };
  }
  return {
    name,
    description: `mock test tool ${name}`,
    parameters: { type: "object", properties, required: [...required] },
  };
}

function opts(
  userText: string,
  tools: readonly LlmTool[],
): StreamOptions {
  return {
    model: MODEL,
    systemPrompt: "",
    messages: [{ role: "user", content: [{ type: "text", text: userText }] }],
    tools: [...tools],
    thinkingLevel: "off",
    signal: new AbortController().signal,
  };
}

// ---- 测试 ----

test("mock: connector probe 关键字 → 派发到 video.probe", () => {
  const tools = [llmTool("video.probe")];
  const plan = decideForTest(opts("探测一下 /tmp/x.mp4 的元数据", tools));
  assert.equal(plan.calls.length, 1);
  assert.equal(plan.calls[0]?.name, "video.probe");
  assert.equal(plan.calls[0]?.arguments["input"], "/tmp/x.mp4");
});

test("mock: probe 英文关键字也命中", () => {
  const tools = [llmTool("video.probe")];
  const plan = decideForTest(opts("please probe /tmp/clip.mp4", tools));
  assert.equal(plan.calls.length, 1);
  assert.equal(plan.calls[0]?.name, "video.probe");
  assert.equal(plan.calls[0]?.arguments["input"], "/tmp/clip.mp4");
});

test("mock: cut 关键字 → 派发到 video.cut 并提取起止", () => {
  const tools = [llmTool("video.cut", ["input", "output", "start", "end"])];
  const plan = decideForTest(
    opts("把 /tmp/x.mp4 从 0:30 到 1:30 剪切输出到 /tmp/y.mp4", tools),
  );
  assert.equal(plan.calls.length, 1);
  assert.equal(plan.calls[0]?.name, "video.cut");
  const args = plan.calls[0]?.arguments as Record<string, string>;
  assert.equal(args["input"], "/tmp/x.mp4");
  assert.equal(args["output"], "/tmp/y.mp4");
  assert.equal(args["start"], "0:30");
  assert.equal(args["end"], "1:30");
});

test("mock: extract audio → audio.extract", () => {
  const tools = [llmTool("audio.extract", ["input", "output"])];
  const plan = decideForTest(
    opts("提取 /tmp/v.mp4 的音频到 /tmp/v.mp3", tools),
  );
  assert.equal(plan.calls.length, 1);
  assert.equal(plan.calls[0]?.name, "audio.extract");
  const args = plan.calls[0]?.arguments as Record<string, string>;
  assert.equal(args["input"], "/tmp/v.mp4");
  assert.equal(args["output"], "/tmp/v.mp3");
});

test("mock: convert 关键字 → video.convert + codec 提取", () => {
  const tools = [llmTool("video.convert", ["input", "output"])];
  const plan = decideForTest(
    opts("把 /tmp/a.mov 转成 /tmp/a.mp4，用 libx264 编码", tools),
  );
  assert.equal(plan.calls.length, 1);
  assert.equal(plan.calls[0]?.name, "video.convert");
  const args = plan.calls[0]?.arguments as Record<string, string>;
  assert.equal(args["input"], "/tmp/a.mov");
  assert.equal(args["output"], "/tmp/a.mp4");
  assert.equal(args["codec"], "libx264");
});

test("mock: 没装 connector 时不强行派发", () => {
  // 只有内置 tool：connector 派发应直接返回 null，让其它分支接管
  const tools = [
    llmTool("read"),
    llmTool("bash"),
    llmTool("grep"),
  ];
  const plan = decideForTest(opts("探测 /tmp/x.mp4 的元数据", tools));
  // 不应该派发 video.probe；应该走通用兜底（无工具调用）
  for (const c of plan.calls) {
    assert.notEqual(c.name, "video.probe");
  }
});

test("mock: 关键字命中但缺 input 时降级到普通回答", () => {
  const tools = [llmTool("video.probe")];
  // 没有任何路径字面量
  const plan = decideForTest(opts("帮我探测视频", tools));
  // 没 input 应该让其它分支处理：不会调 video.probe
  for (const c of plan.calls) {
    assert.notEqual(c.name, "video.probe");
  }
});

test("mock: 内置工具派发仍然工作（grep）", () => {
  const tools = [
    llmTool("read"),
    llmTool("grep"),
    llmTool("video.probe"),
  ];
  const plan = decideForTest(opts("搜索 TODO", tools));
  assert.equal(plan.calls.length, 1);
  assert.equal(plan.calls[0]?.name, "grep");
});

test("mock: 内置工具派发仍然工作（read）", () => {
  const tools = [
    llmTool("read"),
    llmTool("video.probe"),
  ];
  const plan = decideForTest(opts("查看 src/index.ts 的内容", tools));
  assert.equal(plan.calls.length, 1);
  assert.equal(plan.calls[0]?.name, "read");
});

test("mock: 内置工具派发仍然工作（bash）", () => {
  const tools = [
    llmTool("bash"),
    llmTool("video.probe"),
  ];
  const plan = decideForTest(opts("运行 `ls -la`", tools));
  assert.equal(plan.calls.length, 1);
  assert.equal(plan.calls[0]?.name, "bash");
  assert.equal(
    (plan.calls[0]?.arguments as Record<string, string>)["command"],
    "ls -la",
  );
});

test("mock: probe 派发优先级高于通用 grep/read（不会被误派到 read）", () => {
  // "看看 X.mp4 的元数据"——既含 "看看" 又含 ".mp4"。
  // connector 派发应该先命中，不会被 read 抢走。
  const tools = [
    llmTool("read"),
    llmTool("grep"),
    llmTool("video.probe"),
  ];
  const plan = decideForTest(opts("看看 /tmp/clip.mp4 的元数据", tools));
  assert.equal(plan.calls.length, 1);
  assert.equal(plan.calls[0]?.name, "video.probe");
});

test("mock: 「模拟模型失败」触发流错误事件（错误输出链路测试钩子）", async () => {
  const events: StreamEvent[] = [];
  for await (const e of mockStream(opts("模拟模型失败", []))) events.push(e);

  assert.equal(events.length, 1, "只 yield 一个 error 事件，无 start/text/done");
  const errors = events.flatMap((e) => (e.type === "error" ? [e] : []));
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.reason, "error");
  assert.match(errors[0]?.error.errorMessage ?? "", /MOCK_ERROR/);
  assert.equal(errors[0]?.error.stopReason, "error");
});

test("mock: 工具结果已在上下文时直接给总结，不再二次派发", () => {
  // 这一轮已经走完了工具调用，mock 不应该再调一次
  const tools = [llmTool("video.probe")];
  const resultOpts: StreamOptions = {
    model: MODEL,
    systemPrompt: "",
    messages: [
      { role: "user", content: [{ type: "text", text: "探测 /tmp/x.mp4" }] },
      {
        role: "toolResult",
        content: [
          {
            type: "toolResult",
            toolCallId: "x",
            toolName: "video.probe",
            isError: false,
            content: [{ type: "text", text: "{...}" }],
          },
        ],
      },
    ],
    tools: [...tools],
    thinkingLevel: "off",
    signal: new AbortController().signal,
  };
  const plan = decideForTest(resultOpts);
  assert.equal(plan.calls.length, 0);
  assert.match(plan.text, /工具返回/);
});
