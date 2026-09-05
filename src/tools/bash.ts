import { spawn } from "node:child_process";
import { truncateText } from "./fs-utils.js";
import type { Tool } from "./types.js";
import { fail, ok } from "./types.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_CHARS = 100_000;

interface CollectedResult {
  code: number | null;
  stdout: string;
  stderr: string;
  killed: boolean;
}

function run(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<CollectedResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-lc", command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let killed = false;
    let settled = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
    }, timeoutMs);

    const finish = (result: CollectedResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const onAbort = (): void => {
      killed = true;
      child.kill("SIGTERM");
    };

    signal.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      stdout += c;
    });
    child.stderr.on("data", (c: string) => {
      stderr += c;
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => finish({ code, stdout, stderr, killed }));
  });
}

export const bashTool: Tool = {
  name: "bash",
  description:
    "在 cwd 下执行 shell 命令，用于运行测试、构建、git 操作等。输出过长会被截断。",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "要执行的 shell 命令" },
      timeout: { type: "integer", description: "超时毫秒数，默认 120000，上限 600000" },
    },
    required: ["command"],
    additionalProperties: false,
  },
  isMutating: true,

  async execute(args, ctx) {
    const command = String(args["command"] ?? "");
    if (command.trim().length === 0) return fail("command 不能为空");
    if (ctx.signal.aborted) return fail("已被用户中断");

    const requested = Number(args["timeout"] ?? DEFAULT_TIMEOUT_MS);
    const timeoutMs = Math.min(
      MAX_TIMEOUT_MS,
      Math.max(1000, Number.isFinite(requested) ? requested : DEFAULT_TIMEOUT_MS),
    );

    let result: CollectedResult;
    try {
      result = await run(command, ctx.cwd, timeoutMs, ctx.signal);
    } catch (err) {
      return fail(`无法启动命令：${String(err)}`);
    }

    const parts: string[] = [];
    if (result.stdout.length > 0) parts.push(result.stdout);
    if (result.stderr.length > 0) parts.push(`[stderr]\n${result.stderr}`);
    const body = truncateText(parts.join("\n"), MAX_OUTPUT_CHARS);

    if (result.killed) {
      const label = ctx.signal.aborted ? "被用户中断" : `超时 ${timeoutMs}ms 被终止`;
      return fail(`${label}\n${body}`);
    }
    if (result.code !== 0) {
      return fail(`退出码 ${result.code ?? "未知"}\n${body}`);
    }
    return ok(body.length > 0 ? body : "（命令执行成功，无输出）");
  },
};
