import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { truncateText } from "./fs-utils.js";
import type { Tool } from "./types.js";
import { fail, ok } from "./types.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_CHARS = 100_000;

/** 跨平台 shell 描述：file 是可执行路径，args 把命令拼成 argv 数组 */
export interface ShellSpec {
  file: string;
  args: (cmd: string) => string[];
}

/** Git Bash 在 Windows 上常见的安装路径，按推荐顺序排 */
function gitBashCandidates(): string[] {
  const candidates: string[] = [];
  const programFiles = process.env["ProgramFiles"];
  const programFilesX86 = process.env["ProgramFiles(x86)"];
  const localAppData = process.env["LOCALAPPDATA"];
  if (programFiles !== undefined) {
    candidates.push(path.join(programFiles, "Git", "bin", "bash.exe"));
    candidates.push(path.join(programFiles, "Git", "usr", "bin", "bash.exe"));
  }
  if (programFilesX86 !== undefined) {
    candidates.push(path.join(programFilesX86, "Git", "bin", "bash.exe"));
  }
  if (localAppData !== undefined) {
    candidates.push(path.join(localAppData, "Programs", "Git", "bin", "bash.exe"));
  }
  return candidates;
}

let cachedShell: ShellSpec | null = null;

/**
 * 决定 bash 工具该用哪个 shell：
 * - 非 win32 → bash -lc（行为与改造前字节级一致）
 * - win32 → 优先 Git Bash（语义最贴近 POSIX），找不到再降级 PowerShell
 *
 * 注意 Windows 下 `child.kill("SIGTERM")` 由 libuv 退化为 TerminateProcess，
 * 仍可中止子进程，但孙进程可能残留——属于 Node 在 Windows 的固有限制。
 */
export function resolveShell(): ShellSpec {
  if (cachedShell !== null) return cachedShell;
  if (process.platform !== "win32") {
    cachedShell = { file: "bash", args: (cmd) => ["-lc", cmd] };
    return cachedShell;
  }
  for (const candidate of gitBashCandidates()) {
    if (existsSync(candidate)) {
      cachedShell = { file: candidate, args: (cmd) => ["-lc", cmd] };
      return cachedShell;
    }
  }
  cachedShell = {
    file: "powershell.exe",
    args: (cmd) => ["-NoProfile", "-NonInteractive", "-Command", cmd],
  };
  return cachedShell;
}

/** 仅供测试：清掉模块级缓存，让 resolveShell 重新探测 */
export function _resetShellForTests(): void {
  cachedShell = null;
}

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
    const shell = resolveShell();
    const child = spawn(shell.file, shell.args(command), {
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
