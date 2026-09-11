/**
 * ManualSession —— 手动式测试的核心工具。
 *
 * 设计目标：让"subprocess CLI"和"in-process REPL"用同一套断言 API 跑测试。
 * 测试写起来像在和真的终端交互：
 *
 *   const s = await ManualSession.spawn({ entry: 'src/index.ts', args: ['-p', 'hi'] });
 *   await s.expectExit(0, 10_000);
 *   assert.match(s.stdout(), /hi/);
 *
 *   const s = ManualSession.inProcess({ driver, factory: () => runLoop(...) });
 *   await s.expect('编码代理已启动');
 *   await s.send('/help');
 *   await s.expect('命令：');
 *   await s.send('/exit');
 *   await s.expectExit(0);
 *
 * 内部用 Node 原生的 child_process / Readable 做底层 IO，不引入新依赖。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";

import { sleep, stripAnsi } from "./registry.js";

// 用 require.resolve 拿到绝对路径，因为子进程的 cwd 可能在 /tmp 子目录里，
// 从那里 `--import tsx` 找不到 node_modules/tsx。
// require 从当前进程跑的测试出发解析，正好走到仓库的 node_modules。
//
// 必须转成 file:// URL：`--import` 走 ESM 解析，Windows 上的裸绝对路径
// （C:\...\tsx\dist\loader.mjs）会被当成协议为 "c:" 的 URL 而抛
// ERR_UNSUPPORTED_ESM_URL_SCHEME。POSIX 上 /a/b.mjs 恰好能被解析，所以这个坑
// 只在 Windows 暴露。
const requireFromHere = createRequire(import.meta.url);
const TSX_LOADER = pathToFileURL(requireFromHere.resolve("tsx")).href;

// -------------------------------------------------------------- 配置项

export interface SpawnOptions {
  /**
   * CLI 入口相对 cwd 的路径。比如 `'src/index.ts'`。
   * 实际执行时会用 `node --import tsx <entry> <args>` 启动，与 `npm start` 等价。
   */
  entry: string;
  /** 传给 CLI 的参数；逐项拼到 entry 后面 */
  args?: string[];
  /** 工作目录；默认继承当前进程的 cwd */
  cwd?: string;
  /** 环境变量；默认继承 + 清空所有 _API_KEY（不让网络模型污染） */
  env?: NodeJS.ProcessEnv;
  /**
   * 通过 stdin 喂入的初始内容；用于模拟「管道 echo 'x' | Control-Agent」。
   * 喂完会自动关 stdin，无需手动 sendEof。
   */
  stdinPayload?: string;
  /** 是否去掉 stdout/stderr 中的 ANSI 转义再做断言；默认 true */
  stripAnsi?: boolean;
}

export interface InProcessOptions {
  /**
   * 启动 REPL 循环的工厂。ManualSession 会在 factory() 返回的 Promise resolve 后
   * 视为"启动完成"，并开始等待断言。Promise reject 时整条用例失败。
   */
  factory: () => Promise<number>;
  /**
   * 喂入文本的回调。ManualSession.send() 会调用此函数，相当于模拟用户敲回车。
   * 由 `LoopDriver`（见 tests/repl-loop.ts）实现：它管理一个 readline 兼容接口，
   * send 就是把文本交给 readline 的 line 事件。
   */
  deliver: (text: string) => void;
  /**
   * 关闭 readline 的回调（模拟 Ctrl-D → 发出 close 事件）。
   * 默认实现：调 `deliver('/exit')`，让 REPL 走正常退出路径。
   */
  shutdown?: () => void;
  /** 是否把 ANSI 转义脱掉再断言；默认 true */
  stripAnsi?: boolean;
}

// -------------------------------------------------------------- 主类

type OutputSource = "stdout" | "stderr" | "both";

/**
 * 一条会话。构造后 stdout/stderr 还在持续累积；调用方用 expect/expectExit 等待。
 *
 * 设计原则：
 * - 不解析结构（"看到 › 就当成 prompt"），只做流式 substring 匹配 —— 真在交互的人也是
 *   这么做的，眼睛盯着一行行字判断「命令是不是被吃了」。
 * - `kill()` 用 SIGTERM 不要 SIGKILL，给进程一次清理 stderr 的机会；窗口是 500ms。
 * - `close()` 显式调，否则子进程可能让 tsx loader 报错（"stdin closed unexpectedly"）。
 */
export class ManualSession {
  private readonly child: ChildProcess | undefined;
  private readonly inProc: boolean;
  private stdoutBuf = "";
  private stderrBuf = "";
  private readonly stripAnsiEnabled: boolean;
  private readonly outputEmitter = new EventEmitter();
  private exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;

  private readonly inProcOptions: InProcessOptions | undefined;

  constructor(opts: { child?: ChildProcess; inProcOptions?: InProcessOptions; stripAnsi?: boolean }) {
    this.child = opts.child;
    this.inProc = opts.inProcOptions !== undefined;
    this.inProcOptions = opts.inProcOptions;
    this.stripAnsiEnabled = opts.stripAnsi ?? true;
  }

  // ------------------------------------------------------ 工厂

  /** spawn 真实子进程；exit 时 Promise 完成 */
  static async spawn(opts: SpawnOptions): Promise<ManualSession> {
    const cwd = opts.cwd ?? process.cwd();
    const env = makeCleanEnv(opts.env);

    // 用 process.execPath + --import <tsx 绝对路径>，等价于 npx tsx，但更轻、不走 npx 缓存。
    // 用绝对路径而非 bare specifier 'tsx'：子进程的 cwd 在 /tmp 子目录里，
    // 从那里模块解析找不到 tsx；绝对路径就 OK 了。
    const finalArgs = [`--import=${TSX_LOADER}`, opts.entry, ...(opts.args ?? [])];
    const child = spawn(process.execPath, finalArgs, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const session = new ManualSession({
      child,
      stripAnsi: opts.stripAnsi,
    });
    session.wireChild(child);

    if (opts.stdinPayload !== undefined) {
      // 同步写入 + 关 stdin，避免 tsx loader 在 close 时抱怨
      child.stdin?.end(opts.stdinPayload);
    }

    // 给 child.on('data') 一次 tick，否则断言写得早会丢最开始几行
    await sleep(0);
    return session;
  }

  /** in-process 模式：不 spawn 进程，由 factory() 驱动循环 */
  static inProcess(opts: InProcessOptions): ManualSession {
    const session = new ManualSession({
      inProcOptions: opts,
      stripAnsi: opts.stripAnsi,
    });
    // factory 调用方应通过 appendOutput 把输出喂回 session
    // 启动 factory，但要 fire-and-forget：失败时把 exit code 设成 1
    const exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }> =
      opts
        .factory()
        .then((code): { code: number | null; signal: NodeJS.Signals | null } => ({
          code,
          signal: null,
        }))
        .catch(
          (err: unknown): { code: number | null; signal: NodeJS.Signals | null } => {
            session.stderrBuf += `\n[in-process error] ${err instanceof Error ? err.message : String(err)}\n`;
            session.outputEmitter.emit("data");
            return { code: 1, signal: null };
          },
        );
    session.exitPromise = exitPromise;
    // 用 setImmediate 让 factory 有机会先跑出第一段输出
    setImmediate(() => session.outputEmitter.emit("data"));
    return session;
  }

  // ------------------------------------------------------ 子进程接线

  private wireChild(child: ChildProcess): void {
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    child.stdout?.on("data", (chunk: string) => {
      this.stdoutBuf += chunk;
      this.outputEmitter.emit("data");
    });
    child.stderr?.on("data", (chunk: string) => {
      this.stderrBuf += chunk;
      this.outputEmitter.emit("data");
    });
    child.on("error", (err) => {
      this.stderrBuf += `\n[spawn error] ${err.message}\n`;
      this.outputEmitter.emit("data");
    });

    this.exitPromise = new Promise((resolve) => {
      child.on("exit", (code, signal) => resolve({ code, signal }));
    });
  }

  /** 通知 in-process 模式把 stdout/stderr 写入自己（factory 应当通过此钩子写） */
  pumpOutput(chunk: string, stream: "stdout" | "stderr"): void {
    if (!this.inProc) return;
    if (stream === "stdout") this.stdoutBuf += chunk;
    else this.stderrBuf += chunk;
    this.outputEmitter.emit("data");
  }

  // ------------------------------------------------------ API

  /** 积累的 stdout（按 stripAnsi 选项脱码或不脱） */
  stdout(): string {
    return this.stripAnsiEnabled ? stripAnsi(this.stdoutBuf) : this.stdoutBuf;
  }

  /** 积累的 stderr */
  stderr(): string {
    return this.stripAnsiEnabled ? stripAnsi(this.stderrBuf) : this.stderrBuf;
  }

  /**
   * 等待 stdout/stderr 任意一处出现 substring。最长 timeoutMs 毫秒。
   * 默认订阅 stdout——要看 stderr 用 expectStderr。
   */
  async expect(
    substring: string,
    opts: { timeoutMs?: number; source?: OutputSource } = {},
  ): Promise<void> {
    const timeoutMs = opts.timeoutMs ?? 5_000;
    const source = opts.source ?? "stdout";
    await this.waitForMatch(
      (buf) => buf.includes(substring),
      source,
      timeoutMs,
      `substring: ${JSON.stringify(substring)}`,
    );
  }

  async expectStdout(substring: string, timeoutMs?: number): Promise<void> {
    await this.expect(substring, { timeoutMs, source: "stdout" });
  }

  async expectStderr(substring: string, timeoutMs?: number): Promise<void> {
    await this.expect(substring, { timeoutMs, source: "stderr" });
  }

  /**
   * 等进程退出，且 code 匹配。`code = null` 表示任意退出码。
   * 超时抛错——通常意味着代理卡死，比挂在那里等到天荒地老好。
   */
  async expectExit(code: number | null, timeoutMs = 10_000): Promise<void> {
    if (this.exitPromise === undefined) {
      throw new Error("ManualSession.expectExit: 没有 spawn/启动任何东西");
    }
    const timer = setTimeout(() => {
      void this.kill("SIGTERM");
    }, timeoutMs);
    const result = await this.exitPromise;
    clearTimeout(timer);

    if (this.inProc && code === 0 && result.code !== 0) {
      throw new Error(
        `in-process 退出码=${result.code}，期望 0\nstdout:\n${this.stdout()}\nstderr:\n${this.stderr()}`,
      );
    }
    if (code !== null && result.code !== code) {
      throw new Error(
        `退出码=${result.code}（signal=${result.signal ?? "无"}），期望 ${code}\nstdout:\n${this.stdout()}\nstderr:\n${this.stderr()}`,
      );
    }
  }

  /**
   * 等"安静 X 毫秒"——最近 X 毫秒内 stdout/stderr 没新内容。
   * 对"代理正在跑但还没出 token"那种场景特别有用：sleep 固定时长既慢又快不到。
   */
  async expectIdle(idleMs = 200, overallTimeoutMs = 5_000): Promise<void> {
    const start = Date.now();
    let lastChange = start;
    let lastSize = this.stdoutBuf.length + this.stderrBuf.length;

    while (Date.now() - start < overallTimeoutMs) {
      await sleep(20);
      const cur = this.stdoutBuf.length + this.stderrBuf.length;
      if (cur !== lastSize) {
        lastChange = Date.now();
        lastSize = cur;
        continue;
      }
      if (Date.now() - lastChange >= idleMs) return;
    }
    throw new Error(
      `expectIdle(${idleMs}) 超时：最后 ${overallTimeoutMs}ms 内输出一直在变化\n` +
        `stdout: ${JSON.stringify(this.stdout().slice(-200))}\n` +
        `stderr: ${JSON.stringify(this.stderr().slice(-200))}`,
    );
  }

  /** 模拟用户按回车输入一行 */
  async send(text: string): Promise<void> {
    if (this.child?.stdin?.writable === true) {
      this.child.stdin.write(`${text}\n`);
      await sleep(0);
      return;
    }
    if (this.inProcOptions !== undefined) {
      this.inProcOptions.deliver(text);
      await sleep(0);
      return;
    }
    throw new Error("ManualSession.send: 既没子进程也没 in-process 配置");
  }

  /** 模拟 Ctrl-D（关闭 stdin 触发 readline 'close' 事件） */
  async sendEof(): Promise<void> {
    if (this.child?.stdin?.writable === true) {
      this.child.stdin.end();
      return;
    }
    if (this.inProcOptions !== undefined) {
      const sh =
        this.inProcOptions.shutdown ??
        ((): void => {
          this.inProcOptions?.deliver("/exit");
        });
      sh();
      return;
    }
  }

  /** 强制结束（SIGTERM；500ms 后升 SIGKILL） */
  async kill(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (this.child !== undefined && this.child.exitCode === null) {
      this.child.kill(signal);
      await sleep(500);
      if (this.child.exitCode === null) this.child.kill("SIGKILL");
    } else if (this.inProcOptions !== undefined) {
      this.inProcOptions.shutdown?.();
    }
  }

  // ------------------------------------------------------ 内部：等待

  private async waitForMatch(
    pred: (buf: string) => boolean,
    source: OutputSource,
    timeoutMs: number,
    what: string,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const initialStdout = this.stdoutBuf;
    const initialStderr = this.stderrBuf;
    const target = (): string => {
      if (source === "stderr") return this.stderrBuf;
      if (source === "both") return this.stdoutBuf + this.stderrBuf;
      return this.stdoutBuf;
    };

    // 即时检查（已经有内容了的话）
    if (pred(this.applyStripAnsi(target()))) return;

    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      await new Promise<void>((resolve) => {
        const onData = (): void => {
          this.outputEmitter.off("data", onData);
          resolve();
        };
        this.outputEmitter.once("data", onData);
        setTimeout(() => {
          this.outputEmitter.off("data", onData);
          resolve();
        }, Math.min(remaining, 250));
      });
      if (pred(this.applyStripAnsi(target()))) return;

      // 子进程已退出，但还没匹配上：早失败
      if (this.exitPromise !== undefined) {
        const exited = await Promise.race([
          this.exitPromise.then(() => true),
          Promise.resolve(false),
        ]);
        if (exited) {
          throw new Error(
            `等待 ${what} 超时且子进程已退出\nstdout:\n${this.stdout()}\nstderr:\n${this.stderr()}`,
          );
        }
      }
    }

    throw new Error(
      `等待 ${what}（${timeoutMs}ms）超时\nstdout新增长度=${this.stdoutBuf.length - initialStdout.length}\nstderr新增长度=${this.stderrBuf.length - initialStderr.length}\n` +
        `stdout: ${JSON.stringify(this.stdout().slice(-400))}\n` +
        `stderr: ${JSON.stringify(this.stderr().slice(-400))}`,
    );
  }

  private applyStripAnsi(s: string): string {
    return this.stripAnsiEnabled ? stripAnsi(s) : s;
  }
}

// -------------------------------------------------------------- helpers

/**
 * 起一个干净的环境。
 *
 * 默认策略：继承现进程的环境（让 PATH/HOME 这些保留），但把所有 *_API_KEY 清掉，
 * 保证测试用的就是 mock 降级路径。如果用户显式传 env，则只在那个 env 上叠加。
 *
 * NODE_OPTIONS 也要清：WorkBuddy IDE 会注入
 * `--require=.../node-language-shim.cjs`，实测它让 tsx 子进程冷启动从 ~1.1s
 * 涨到 ~7.6s，直接超过 help 用例 5s 的 expectExit 超时（SIGTERM 假失败）。
 * 测试子进程不需要任何外部 NODE_OPTIONS 注入。
 */
function makeCleanEnv(override?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(base)) {
    if (k.endsWith("_API_KEY") || k === "MODEL" || k === "NODE_OPTIONS") delete base[k];
  }
  if (override !== undefined) return { ...base, ...override };
  return base;
}
