/**
 * FFmpeg / FFprobe 适配层。
 *
 * 把两个 CLI 收敛成 promise API，错误一律用返回值表达（与项目 Tool 风格一致）：
 *   - 成功：{ ok: true, stdout, stderr?, code }
 *   - 失败：{ ok: false, error, code?, stderr? }
 *
 * 取消语义：调用方传 AbortSignal；signal abort 时立即 kill 子进程（libuv 透传 SIGTERM），
 * 失败原因携带 "aborted" 字样，便于上层区分用户取消与真异常。
 *
 * 输出截断：ffprobe 在 streams 字段多时容易爆，MAX_OUTPUT_CHARS 上限保护。
 * 这是 Tool 层的额外护栏，与 tools/bash.ts 的策略一致。
 */

import { spawn } from "node:child_process";
import { truncateText } from "../../../tools/fs-utils.js";

const MAX_OUTPUT_CHARS = 100_000;

export type AdapterResult<T = string> =
  | { ok: true; data: T; stderr?: string; code: number }
  | { ok: false; error: string; code?: number; stderr?: string };

/** 探测 ffmpeg / ffprobe 是否可用，返回各自的 --version 输出 */
export async function checkAvailable(signal: AbortSignal): Promise<{
  ffmpeg: string;
  ffprobe: string;
}> {
  const ff = await runOnce("ffmpeg", ["-version"], signal);
  if (!ff.ok) throw new Error(`ffmpeg not available: ${ff.error}`);
  const fp = await runOnce("ffprobe", ["-version"], signal);
  if (!fp.ok) throw new Error(`ffprobe not available: ${fp.error}`);
  // --version 第一行就是版本号
  return {
    ffmpeg: firstLine(ff.data),
    ffprobe: firstLine(fp.data),
  };
}

/** ffprobe -v quiet -print_format json -show_format -show_streams <input> */
export async function probe(input: string, signal: AbortSignal): Promise<AdapterResult> {
  return runOnce(
    "ffprobe",
    ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", input],
    signal,
  );
}

/** 执行任意 ffmpeg 命令，args 是除 `ffmpeg` 之外的完整参数数组 */
export async function runFfmpeg(args: readonly string[], signal: AbortSignal): Promise<AdapterResult> {
  return runOnce("ffmpeg", args, signal);
}

/** 把上面的 ProbeError / 通用错误格式化为 ToolResult 友好的文本 */
export function adapterErrorToText(result: Extract<AdapterResult, { ok: false }>): string {
  const parts: string[] = [`ffmpeg 失败：${result.error}`];
  if (result.code !== undefined) parts.push(`exit code: ${result.code}`);
  if (result.stderr && result.stderr.trim().length > 0) {
    parts.push(`stderr:\n${truncateText(result.stderr.trim(), 4000)}`);
  }
  return parts.join("\n");
}

/** ---------- 内部：薄薄一层 spawn + 收集 stdout/stderr ---------- */

interface SpawnResult {
  stdout: string;
  stderr: string;
  code: number | null;
  killed: boolean;
}

function runOnce(file: string, args: readonly string[], signal: AbortSignal): Promise<AdapterResult> {
  return new Promise<AdapterResult>((resolve) => {
    if (signal.aborted) {
      resolve({ ok: false, error: "aborted before start" });
      return;
    }
    const proc = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    const onAbort = (): void => {
      try {
        proc.kill("SIGTERM");
      } catch {
        // 已经退出，忽略
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });

    proc.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve({ ok: false, error: `spawn failed: ${err.message}` });
    });

    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      const result: SpawnResult = {
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        code,
        killed: signal.aborted,
      };
      if (signal.aborted) {
        resolve({ ok: false, error: "aborted", stderr: result.stderr, code: code ?? undefined });
        return;
      }
      if (code !== 0) {
        resolve({
          ok: false,
          error: `non-zero exit`,
          code: code ?? undefined,
          stderr: result.stderr,
        });
        return;
      }
      resolve({
        ok: true,
        data: truncateText(result.stdout, MAX_OUTPUT_CHARS),
        stderr: result.stderr.length > 0 ? result.stderr : undefined,
        code: 0,
      });
    });
  });
}

function firstLine(s: string): string {
  const i = s.indexOf("\n");
  return i === -1 ? s.trim() : s.slice(0, i).trim();
}
