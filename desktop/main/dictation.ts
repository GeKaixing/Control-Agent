/**
 * macOS 听写控制器（open 模式）：管理 SFSpeechRecognizer helper 的生命周期。
 *
 * helper 源码在 desktop/native/dictate.swift（AVAudioEngine + Speech framework），
 * 以 **dictate.app bundle** 形态经 LaunchServices（`open -n`）启动——这是关键：
 * 由 Electron 直接 spawn 裸二进制时，TCC 责任进程沿进程树归属（落到 WorkBuddy
 * 或终端），缺 NSSpeechRecognitionUsageDescription 的宿主会让 helper 在第一次
 * 权限请求时直接 SIGABRT（__TCC_CRASHING_DUE_TO_PRIVACY_VIOLATION__）、零输出。
 * 经 `open` 启动后 TCC 归属到 dictate.app 自己的 Info.plist，正常弹权限框。
 *
 * `open` 的代价：父进程拿不到子进程句柄和管道，且这台 macOS 26 上 `open` 的
 * `--args/--env/--stdout` 实测均不生效。通信全部走**配置文件**：
 *  - controller 写 `~/Library/Application Support/c-agent-dictate.json`
 *    （pidfile / out / err / locale 路径）；
 *  - helper 启动读它，把 JSON 行事件追加写进 out 文件；
 *  - 停止 = 读 pidfile → SIGTERM（helper 内有优雅停机 handler），800ms 未退 SIGKILL。
 *
 * 协议（stdout 每行一个 JSON 对象）：
 *   {"kind":"ready"}              麦克风+识别器就绪
 *   {"kind":"partial","text":"…"} 中间结果（helper 侧 150ms 节流）
 *   {"kind":"final","text":"…"}   最终结果（收到后 helper 自行退出）
 *   {"kind":"error","message":"…"} 失败（权限被拒 / 引擎错误 / 无可用识别器）
 *
 * 事件序号 seq：全局递增，渲染层用来区分「新事件」。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 单个 JSON 行 → 结构化结果；无法解析时返回 null（静默丢弃，不打断流） */
export function parseDictationLine(line: string): { kind: string; text: string } | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  const kind = rec["kind"];
  if (typeof kind !== "string") return null;
  // helper 的 error 行用 message 字段（dictate.swift emitError），其余用 text——
  // 这里统一收敛成 text，否则错误原因到 UI 就成了空串（曾导致听写失败无任何提示）。
  const text =
    typeof rec["text"] === "string"
      ? rec["text"]
      : typeof rec["message"] === "string"
        ? rec["message"]
        : "";
  return { kind, text };
}

export interface DictationEvents {
  onEvent(kind: "ready" | "partial" | "final" | "error", text: string, seq: number): void;
}

/** SIGTERM 优雅停机后等 helper 退出（输出 final）的兜底窗口（毫秒）。
 * helper 内部要先等 800ms 引擎 final 再落盘，窗口必须明显大于它。 */
const FINAL_GRACE_MS = 2500;
/** pidfile 轮询上限：`open` + helper 启动一般 <1s */
const PIDFILE_TIMEOUT_MS = 5000;
/** ready 超时：超过仍未就绪大概率是权限弹窗没人点 / 引擎起不来 */
const READY_TIMEOUT_MS = 15000;
/** stdout 文件轮询间隔 */
const POLL_INTERVAL_MS = 150;

/** 一次听写会话的运行时状态 */
interface DictationSession {
  pid: number;
  dir: string;
  outPath: string;
  errPath: string;
  /** out 文件已消费到的字节偏移（追加读，不用整文件重解析） */
  consumed: number;
  timer: ReturnType<typeof setInterval>;
  gotReady: boolean;
  gotFinal: boolean;
  startedAt: number;
}

export class DictationController {
  private session: DictationSession | null = null;
  private seq = 0;
  private readonly events: DictationEvents;
  /** 解析 helper 的基准目录：desktop/main（entry.mjs 所在目录）。 */
  private readonly baseDir: string | undefined;

  constructor(events: DictationEvents, baseDir?: string) {
    this.events = events;
    this.baseDir = baseDir;
  }

  get isDictating(): boolean {
    return this.session !== null;
  }

  /**
   * 解析 dictate.app bundle 路径。候选：baseDir/../native（entry.mjs 的 desktop/main
   * → desktop/native）→ process.cwd()/desktop/native（dev 从仓库根启动的兜底）。
   * 必须是完整 bundle（有 Info.plist）——裸二进制直接 spawn 会被 TCC 秒杀。
   */
  resolveHelper(): string | undefined {
    const candidates: string[] = [];
    if (this.baseDir !== undefined) {
      candidates.push(path.join(this.baseDir, "..", "native", "dictate.app"));
    }
    candidates.push(path.join(process.cwd(), "desktop", "native", "dictate.app"));
    for (const bundle of candidates) {
      if (fs.existsSync(path.join(bundle, "Contents", "Info.plist"))) return bundle;
    }
    return undefined;
  }

  start(): void {
    if (this.session !== null) return;
    if (process.platform !== "darwin") {
      // helper 是 swiftc 编译的 macOS bundle（SFSpeechRecognizer + TCC），
      // Windows/Linux 上直接给明确提示，别让用户看到「找不到 helper」的误导信息
      this.events.onEvent("error", "听写目前仅支持 macOS", this.nextSeq());
      return;
    }
    const bundle = this.resolveHelper();
    if (bundle === undefined) {
      this.events.onEvent(
        "error",
        "找不到听写 helper（desktop/native/dictate.app，需要 swiftc 编译 dictate.swift）",
        this.nextSeq(),
      );
      return;
    }

    // open 模式：这台 macOS 26 上 `open --args/--env/--stdout` 实测均不生效，
    // 通信全部走配置文件：controller 写 config → helper 读 → 事件追加写 out 文件。
    const supportDir = path.join(os.homedir(), "Library", "Application Support");
    fs.mkdirSync(supportDir, { recursive: true });
    this.configPath = path.join(supportDir, "c-agent-dictate.json");

    const dir = fs.mkdtempSync(path.join(supportDir, "c-agent-dictate-"));
    const outPath = path.join(dir, "out.jsonl");
    const errPath = path.join(dir, "err.log");
    const pidPath = path.join(dir, "pid");
    fs.writeFileSync(outPath, "");
    const locale = process.env["DICTATE_LOCALE"] ?? "zh-CN";
    fs.writeFileSync(
      this.configPath,
      JSON.stringify({ pidfile: pidPath, out: outPath, err: errPath, locale }),
    );

    try {
      spawn("/usr/bin/open", ["-n", bundle], { stdio: "ignore" }).unref();
    } catch (err) {
      this.clearConfig();
      fs.rmSync(dir, { recursive: true, force: true });
      this.events.onEvent(
        "error",
        `启动听写 helper 失败：${err instanceof Error ? err.message : String(err)}`,
        this.nextSeq(),
      );
      return;
    }

    // 等 pidfile（open 本身很快，helper 入口第一件事就是写 pid）
    const deadline = Date.now() + PIDFILE_TIMEOUT_MS;
    const tick = (): void => {
      let pid = NaN;
      try {
        pid = Number.parseInt(fs.readFileSync(pidPath, "utf8").trim(), 10);
      } catch {
        // 还没写出来
      }
      if (Number.isFinite(pid) && pid > 0) {
        this.attachSession(pid, dir, outPath, errPath);
        return;
      }
      if (Date.now() > deadline) {
        this.clearConfig();
        fs.rmSync(dir, { recursive: true, force: true });
        this.events.onEvent("error", "听写 helper 启动超时（pidfile 未出现）", this.nextSeq());
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  }

  private configPath: string | null = null;

  private clearConfig(): void {
    if (this.configPath === null) return;
    try {
      fs.rmSync(this.configPath, { force: true });
    } catch {
      // 忽略
    }
    this.configPath = null;
  }

  /** pidfile 就绪后：建会话状态 + 开始轮询 stdout 文件 */
  private attachSession(pid: number, dir: string, outPath: string, errPath: string): void {
    const session: DictationSession = {
      pid,
      dir,
      outPath,
      errPath,
      consumed: 0,
      timer: setInterval(() => this.poll(), POLL_INTERVAL_MS),
      gotReady: false,
      gotFinal: false,
      startedAt: Date.now(),
    };
    this.session = session;
    this.poll();
  }

  /** 轮询：消费 out 文件新增字节 + 检查 helper 存活 + ready 超时 */
  private poll(): void {
    const session = this.session;
    if (session === null) return;

    // 追加读 out 文件，逐行 dispatch
    let data = "";
    try {
      const buf = fs.readFileSync(session.outPath);
      data = buf.subarray(session.consumed).toString("utf8");
      session.consumed = buf.length;
    } catch {
      // 文件暂不可读，下一轮再试
    }
    let idx = data.indexOf("\n");
    while (idx !== -1) {
      const parsed = parseDictationLine(data.slice(0, idx));
      if (parsed !== null) this.dispatch(session, parsed.kind, parsed.text);
      idx = data.indexOf("\n", idx + 1);
    }

    // helper 存活检查（kill -0）。拿到 final 后由 dispatch 收尾，不在这里判
    if (!session.gotFinal && !this.alive(session.pid)) {
      this.fail(session, this.diagnose(session) || `听写 helper 退出（pid=${session.pid}）`);
      return;
    }
    if (!session.gotReady && Date.now() - session.startedAt > READY_TIMEOUT_MS) {
      this.fail(
        session,
        "听写 helper 未就绪（可能在等待麦克风/语音识别权限弹窗，或引擎启动失败）",
      );
    }
  }

  dispatch(session: DictationSession, kind: string, text: string): void {
    if (kind !== "ready" && kind !== "partial" && kind !== "final" && kind !== "error") return;
    if (kind === "ready") session.gotReady = true;
    if (kind === "final") session.gotFinal = true;
    this.events.onEvent(kind, text, this.nextSeq());
    if (kind === "final" || kind === "error") this.teardown(session);
  }

  /** 优雅停止：SIGTERM（helper 有停机 handler → 输出 final → exit 0），超时 SIGKILL */
  stop(): void {
    const session = this.session;
    if (session === null) return;
    try {
      process.kill(session.pid, "SIGTERM");
    } catch {
      // 进程已死
    }
    setTimeout(() => {
      if (this.session === session && !session.gotFinal && this.alive(session.pid)) {
        try {
          process.kill(session.pid, "SIGKILL");
        } catch {
          // 进程已死
        }
        this.fail(session, "听写 helper 停止超时，已强制结束");
      }
    }, FINAL_GRACE_MS);
  }

  private fail(session: DictationSession, message: string): void {
    if (this.session !== session) return;
    try {
      process.kill(session.pid, "SIGKILL");
    } catch {
      // 进程已死
    }
    this.session = null;
    clearInterval(session.timer);
    this.clearConfig();
    this.cleanupFiles(session);
    this.events.onEvent("error", message, this.nextSeq());
  }

  private teardown(session: DictationSession): void {
    if (this.session !== session) return;
    this.session = null;
    clearInterval(session.timer);
    this.clearConfig();
    // final 已落盘；延迟一点让 helper 的 exit 走完再删临时目录
    setTimeout(() => this.cleanupFiles(session), 500);
  }

  private cleanupFiles(session: DictationSession): void {
    try {
      fs.rmSync(session.dir, { recursive: true, force: true });
    } catch {
      // 临时目录删不掉就留给系统清理
    }
  }

  private alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /** error 事件附带 stderr 摘要，便于用户排查（权限/引擎问题） */
  diagnose(session: DictationSession): string {
    try {
      return fs
        .readFileSync(session.errPath, "utf8")
        .trim()
        .split("\n")
        .slice(-3)
        .join(" | ")
        .slice(0, 300);
    } catch {
      return "";
    }
  }

  /** 全局递增序号：正常事件与 error 事件共用，渲染层据此区分新事件 */
  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  currentSeq(): number {
    return this.seq;
  }
}
