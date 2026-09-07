/**
 * Connector 端到端集成检查。
 *
 * 流程：bootstrap connector → assembleSession → 手写 StreamFn（每次 agent 调 model 时拿到
 * 新 generator；第一次返回带 video.probe 的 ToolCall，第二次返回收尾文本）→ Agent.run() →
 * 验证 ToolResultMessage 包含 ffprobe JSON。
 *
 * 这一脚本绕过真实大模型和 mock 关键字猜测，直接驱动 Agent 跑一次
 * Agent → state.tools → Tool.execute → Connector.execute → FFmpeg 完整链路。
 */

import { spawn } from "node:child_process";
import path from "node:path";

import { Agent, type AgentEvent } from "../src/agent/agent.js";
import { StreamAccumulator } from "../src/providers/stream.js";
import type { StreamEvent, StreamFn } from "../src/providers/types.js";
import { ConnectorLoader } from "../src/connector/loader/connector-loader.js";
import { ConnectorRuntime } from "../src/connector/runtime/connector-runtime.js";
import { assembleSession } from "../src/session.js";

const MP4 = "/tmp/integration-check.mp4";

async function prepareInput(): Promise<void> {
  await new Promise<void>((resolve) => {
    const p = spawn(
      "ffmpeg",
      ["-y", "-f", "lavfi", "-i", "color=size=64x64:duration=1:rate=10", "-c:v", "libx264", MP4],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
    p.on("close", () => resolve());
    p.on("error", () => resolve());
  });
}

interface Plan {
  toolName: string | null;
  toolArgs: Record<string, unknown>;
  closingText: string;
}

/** StreamFn 工厂：第 1 次 yield video.probe ToolCall，第 2 次 yield 收尾文本 */
function makeStream(): StreamFn {
  let callCount = 0;
  return async function* (opts) {
    callCount += 1;
    const plan: Plan =
      callCount === 1
        ? {
            toolName: "video.probe",
            toolArgs: { input: MP4 },
            closingText: "",
          }
        : { toolName: null, toolArgs: {}, closingText: "已收到 probe 结果，ffprobe 已成功返回元信息。" };

    const acc = new StreamAccumulator("mock:e2e");
    yield { type: "start", partial: acc.partial };

    if (plan.toolName !== null) {
      const id = `call_${Date.now().toString(36)}_${callCount}`;
      acc.openToolCall(id, plan.toolName);
      const payload = JSON.stringify(plan.toolArgs);
      for (const piece of payload.match(/.{1,12}/g) ?? []) {
        acc.pushToolCallDelta(piece);
        yield { type: "toolcall_delta", delta: piece, partial: acc.partial };
      }
      const closed = acc.closeToolCall();
      if (closed !== null) {
        yield { type: "toolcall_end", toolCall: closed, partial: acc.partial };
      }
    }

    if (plan.closingText.length > 0) {
      for (const piece of plan.closingText.match(/.{1,10}/g) ?? []) {
        acc.pushText(piece);
        yield { type: "text_delta", delta: piece, partial: acc.partial };
      }
    }

    yield {
      type: "done",
      reason: plan.toolName !== null ? "toolUse" : "stop",
      message: acc.finish(plan.toolName !== null ? "toolUse" : "stop"),
    };
    void opts; // 暂时不用 opts，避免 unused 警告
  };
}

async function main(): Promise<void> {
  await prepareInput();

  const runtime = new ConnectorRuntime({ cwd: process.cwd() });
  const loader = new ConnectorLoader({ paths: [path.resolve("./src/connector/connectors")] });
  const { loaded, failed } = await loader.scan();
  if (failed.length > 0) {
    console.error("[e2e] FAIL: connector load:", failed);
    process.exit(1);
  }
  for (const c of loaded) runtime.adopt(c);
  const startFailed = await runtime.start();
  if (startFailed.length > 0) {
    console.error("[e2e] FAIL: connector start:", startFailed);
    process.exit(1);
  }
  console.log(`[e2e] connectors ready: ${runtime.registry.toolNames().join(", ")}`);

  const r = await assembleSession({
    cwd: process.cwd(),
    modelSpec: "mock",
    extraTools: runtime.extraTools(),
  });

  const events: AgentEvent[] = [];
  const agent = new Agent({
    state: r.state,
    queue: r.queue,
    stream: makeStream(),
    onEvent: (e) => events.push(e),
  });

  agent.enqueueUser(`用 video.probe 看看 ${MP4}`);
  await agent.run();

  const toolEnds = events.filter(
    (e): e is Extract<AgentEvent, { type: "tool_end" }> => e.type === "tool_end",
  );
  if (toolEnds.length === 0) {
    console.error("[e2e] FAIL: no tool_end events at all");
    console.error("  events:", events.map((e) => e.type).join(", "));
    process.exit(1);
  }
  const probeEnd = toolEnds.find((e) => e.toolCall.name === "video.probe");
  if (probeEnd === undefined) {
    console.error("[e2e] FAIL: no video.probe tool_end");
    console.error("  tool names called:", toolEnds.map((e) => e.toolCall.name));
    process.exit(1);
  }
  if (probeEnd.result.isError) {
    console.error(
      "[e2e] FAIL: video.probe returned error:",
      probeEnd.result.content[0]?.text.slice(0, 200),
    );
    process.exit(1);
  }
  const text = probeEnd.result.content.map((c) => c.text).join("");
  if (!text.includes("h264")) {
    console.error("[e2e] FAIL: probe output missing 'h264' codec");
    console.error(text.slice(0, 400));
    process.exit(1);
  }

  console.log("[e2e] PASS video.probe → Agent → FFmpeg");
  console.log("  probe output preview:", text.slice(0, 120).replace(/\s+/g, " "), "…");
  console.log("  tool rounds:", events.filter((e) => e.type === "tool_end").length);

  await runtime.dispose();
}

main().catch((err) => {
  console.error("[e2e] FATAL:", err);
  process.exit(1);
});