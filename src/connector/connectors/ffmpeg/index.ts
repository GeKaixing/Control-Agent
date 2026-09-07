/**
 * FfmpegConnector：把 ffmpeg / ffprobe CLI 收敛成 4 个 Tool 暴露给 Agent。
 *
 * 设计要点：
 * - 不在 start() 里 spawn 常驻进程；FFmpeg 是 stateless CLI，每次 execute 才起子进程。
 *   start() 只做环境探测（ffmpeg/ffprobe --version），失败即 connector 进入 error 状态。
 * - 4 个 Tool 都直接返回 stdout / 简短 stderr 摘要，isError 跟随 ffmpeg 退出码。
 *   Tool 自身不做路径解析——这是和 tools/read.ts 的边界差异：
 *   ffmpeg 接受绝对路径 / URL / pipe:/dev/…，不该被路径归一化强约束。
 * - Connector.execute 路由到 Tool.execute，结果形状与项目内 Tool 完全一致。
 */

import type { Connector, ConnectorContext } from "../../core/types.js";
import type { JsonSchema } from "../../../providers/types.js";
import type { Tool, ToolContext, ToolResult } from "../../../tools/types.js";
import { ok, fail } from "../../../tools/types.js";
import { truncateText } from "../../../tools/fs-utils.js";
import { adapterErrorToText, checkAvailable, probe, runFfmpeg } from "./ffmpeg-api.js";

export default class FfmpegConnector implements Connector {
  readonly id = "ffmpeg";

  async start(ctx: ConnectorContext): Promise<void> {
    try {
      await checkAvailable(ctx.signal);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`ffmpeg environment check failed: ${msg}`);
    }
  }

  async stop(): Promise<void> {
    // stateless CLI：无资源需要释放，幂等 noop
  }

  getTools(): Tool[] {
    return [
      buildProbeTool(),
      buildCutTool(),
      buildExtractAudioTool(),
      buildConvertTool(),
    ];
  }

  async execute(
    toolName: string,
    args: Record<string, unknown>,
    ctx: ConnectorContext,
  ): Promise<ToolResult> {
    const tools = this.getTools();
    const tool = tools.find((t) => t.name === toolName);
    if (!tool) return fail(`unknown ffmpeg tool: ${toolName}`);
    const toolCtx: ToolContext = { cwd: ctx.cwd, signal: ctx.signal };
    try {
      return await tool.execute(args, toolCtx);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }
}

// ---------- Tool 工厂 ----------

function buildProbeTool(): Tool {
  const parameters: JsonSchema = {
    type: "object",
    properties: {
      input: { type: "string", description: "媒体文件路径或 URL" },
    },
    required: ["input"],
  };
  return {
    name: "video.probe",
    description:
      "读取媒体元信息（容器、时长、码率、streams）。返回 ffprobe JSON 摘要（已截断到 100K 字符）。",
    parameters,
    isMutating: false,
    async execute(args, ctx): Promise<ToolResult> {
      const input = requireString(args, "input");
      const r = await probe(input, ctx.signal);
      if (!r.ok) return fail(adapterErrorToText(r));
      return ok(r.data);
    },
  };
}

function buildCutTool(): Tool {
  const parameters: JsonSchema = {
    type: "object",
    properties: {
      input: { type: "string", description: "源媒体文件路径" },
      output: { type: "string", description: "输出文件路径（-y 覆盖已存在）" },
      start: { type: "string", description: "起时间，格式 HH:MM:SS 或秒数" },
      end: { type: "string", description: "止时间，格式 HH:MM:SS 或秒数" },
    },
    required: ["input", "output", "start", "end"],
    additionalProperties: false,
  };
  return {
    name: "video.cut",
    description:
      "按起止时间剪切片段，使用 -c copy 不重编码，速度快但切点精度可能到 GOP。返回末尾摘要。",
    parameters,
    isMutating: true,
    async execute(args, ctx): Promise<ToolResult> {
      const input = requireString(args, "input");
      const output = requireString(args, "output");
      const start = requireString(args, "start");
      const end = requireString(args, "end");
      const r = await runFfmpeg(
        ["-y", "-ss", start, "-to", end, "-i", input, "-c", "copy", output],
        ctx.signal,
      );
      if (!r.ok) return fail(adapterErrorToText(r));
      return ok(`cut ok: ${output}\n${summarizeStderr(r.stderr)}`);
    },
  };
}

function buildExtractAudioTool(): Tool {
  const parameters: JsonSchema = {
    type: "object",
    properties: {
      input: { type: "string", description: "源视频文件路径" },
      output: { type: "string", description: "输出音频文件路径" },
    },
    required: ["input", "output"],
    additionalProperties: false,
  };
  return {
    name: "audio.extract",
    description: "从视频中提取音轨，默认 -acodec copy 不重编码。",
    parameters,
    isMutating: true,
    async execute(args, ctx): Promise<ToolResult> {
      const input = requireString(args, "input");
      const output = requireString(args, "output");
      const r = await runFfmpeg(
        ["-y", "-i", input, "-vn", "-acodec", "copy", output],
        ctx.signal,
      );
      if (!r.ok) return fail(adapterErrorToText(r));
      return ok(`audio extracted: ${output}\n${summarizeStderr(r.stderr)}`);
    },
  };
}

function buildConvertTool(): Tool {
  const parameters: JsonSchema = {
    type: "object",
    properties: {
      input: { type: "string", description: "源媒体文件路径" },
      output: { type: "string", description: "输出文件路径（容器格式由后缀决定）" },
      codec: {
        type: "string",
        description: "可选：视频编码器（默认 copy，仅转封装）。如 libx264 / libvpx 等",
      },
      audioCodec: {
        type: "string",
        description: "可选：音频编码器（默认 copy）",
      },
    },
    required: ["input", "output"],
    additionalProperties: false,
  };
  return {
    name: "video.convert",
    description:
      "转封装或转码。默认 -c:v copy -c:a copy 只换容器；指定 codec/audioCodec 可触发转码。",
    parameters,
    isMutating: true,
    async execute(args, ctx): Promise<ToolResult> {
      const input = requireString(args, "input");
      const output = requireString(args, "output");
      const vc = optionalString(args, "codec") ?? "copy";
      const ac = optionalString(args, "audioCodec") ?? "copy";
      const r = await runFfmpeg(
        ["-y", "-i", input, "-c:v", vc, "-c:a", ac, output],
        ctx.signal,
      );
      if (!r.ok) return fail(adapterErrorToText(r));
      return ok(`converted: ${output}\n${summarizeStderr(r.stderr)}`);
    },
  };
}

// ---------- 小工具 ----------

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`参数 ${key} 必须是非空字符串`);
  }
  return v;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function summarizeStderr(stderr: string | undefined): string {
  if (!stderr) return "(no stderr)";
  const trimmed = stderr.trim();
  if (trimmed.length === 0) return "(no stderr)";
  // ffmpeg 进度输出很多行；只保留最后 6 行 + 头 2 行（早期诊断）
  const lines = trimmed.split("\n");
  if (lines.length <= 8) return trimmed;
  const head = lines.slice(0, 2);
  const tail = lines.slice(-6);
  const truncated = truncateText(trimmed, 2000);
  return [
    ...head,
    `… (省略 ${lines.length - 8} 行) …`,
    ...tail,
    `(stderr truncated to 2000 chars; full length: ${trimmed.length})`,
  ].join("\n") + `\n\n---\n${truncated}`;
}
