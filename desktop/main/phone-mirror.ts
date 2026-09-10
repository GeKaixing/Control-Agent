/**
 * phone-mirror.ts：手机镜像面板的主进程端（Mobile 控制通道）。
 *
 * 职责：adb 桥 + 帧轮询 + 动作注入。与 browser-view.ts 的分工：
 * 浏览器面板是原生 WebContentsView（DOM 之上的原生层）；手机镜像反过来，
 * 是**纯渲染层 DOM 面板**——主进程只负责把设备截图压成 JPEG 帧经 PUSH
 * 通道推下去，手势由渲染层换算成设备坐标经 IPC 回传注入。两者互斥
 * （原生视图会盖住 DOM 面板，见 index.ts 的 PHONE_OPEN / BROWSER_OPEN）。
 *
 * 零 npm 依赖：PNG 解码 / JPEG 压缩用 Electron 自带 nativeImage（toJPEG），
 * adb 走 execFile 子进程。真机 USB 接入时把其序列号纳入 pickSerial 的选择顺序即可复用整条链路。
 *
 * 实测踩过的坑（对策已固化在代码里，不要「优化」掉）：
 * ① adb 版本战争——platform-tools 与 MuMu 自带 adb 并存时互相杀 server，
 *    adb 路径探测必须 MuMu 安装目录优先，PATH 兜底；
 * ② MuMu 的 adb 管理会话随调用结束失效——**每次命令前都先 connect**（幂等）；
 * ③ 模拟器横竖屏翻转分辨率会变——帧尺寸永远以截图实测为准，不许缓存。
 * ④ 端口漂移——多开/换实例后 MuMu 的 adb 端口不是固定的 16384（16384+32n），
 *    且设备可能只以 emulator-<n> 传输注册、TCP connect 拒绝。序列号必须动态
 *    探测（MUMU_PORTS 预 connect + `adb devices` 解析），不许写死。
 */

import { execFile } from "node:child_process";
import { nativeImage } from "electron";
import type { PhoneFrameInfo, PhoneStateInfo } from "../shared/api.js";

/**
 * 目标设备解析。MuMu 12 实例 n 的 adb 端口惯例是 16384 + 32*n，但多开、
 * 换实例、emulator-<n> 型传输都会让写死的序列号失效（实测：实例 0 关闭、
 * 实例 1 运行时监听 16416，且 `adb devices` 只认 emulator-5556）。
 * 对策：先按端口惯例预 connect（幂等、未监听秒拒），再从 `adb devices`
 * 现拿现用——优先 MuMu TCP 口，其次任意 127.0.0.1:，最后 emulator-*。
 */
const MUMU_PORTS = [16384, 16416, 16448, 16480];
const PROBE_INTERVAL_MS = 3_000;

let cachedSerial: string | null = null;
let currentSerial: string | null = null;
let lastProbeAt = 0;

/** 从 `adb devices` 输出里挑设备：只认 device 状态，跳过 offline/unauthorized。 */
function pickSerial(devicesOutput: string): string | null {
  const found: string[] = [];
  for (const line of devicesOutput.split(/\r?\n/).slice(1)) {
    const m = line.trim().match(/^(\S+)\s+device\s*$/);
    if (m !== null) found.push(m[1]);
  }
  if (found.length === 0) return null;
  return (
    found.find((s) => /^127\.0\.0\.1:16\d{3}$/.test(s)) ??
    found.find((s) => s.startsWith("127.0.0.1:")) ??
    found.find((s) => s.startsWith("emulator-")) ??
    found[0]
  );
}

/** 解析当前设备序列号（带缓存；探测节流 3s，避免 600ms 轮询被放大）。 */
async function resolveSerial(exe: string): Promise<string | null> {
  if (cachedSerial !== null && Date.now() - lastProbeAt < PROBE_INTERVAL_MS) return cachedSerial;
  lastProbeAt = Date.now();
  for (const port of MUMU_PORTS) {
    try {
      await run(exe, ["connect", `127.0.0.1:${port}`], 1_000);
    } catch {
      // 未监听的端口秒拒，忽略即可
    }
  }
  try {
    cachedSerial = pickSerial(await run(exe, ["devices"], ADB_TIMEOUT_MS));
  } catch {
    cachedSerial = null;
  }
  if (cachedSerial !== null) currentSerial = cachedSerial;
  return cachedSerial;
}

/** 已缓存序列号失效时立即作废（下一轮重新探测，不等节流窗口）。 */
function invalidateSerial(): void {
  cachedSerial = null;
  lastProbeAt = 0;
}

/** 帧轮询间隔。600ms ≈ 1.7fps：镜像观感够用，IPC 带宽 ~0.3MB/s 量级。 */
const POLL_INTERVAL_MS = 600;

/** 单条 adb 命令超时；截图（大负载）单独放宽。 */
const ADB_TIMEOUT_MS = 6_000;
const CAPTURE_TIMEOUT_MS = 10_000;

/** adb 可执行文件探测候选（按优先级）。环境变量 PHONE_ADB 可插队置顶。 */
function adbCandidates(): string[] {
  const list = [
    process.env.PHONE_ADB,
    "D:/Program Files/Netease/MuMu Player 12/shell/adb.exe",
    "C:/Program Files/Netease/MuMu Player 12/shell/adb.exe",
  ].filter((p): p is string => typeof p === "string" && p.length > 0);
  list.push("adb");
  return list;
}

let resolvedAdb: string | null = null;

/** 探测并缓存可用的 adb（每条候选跑一次 version，第一个成功者胜出）。 */
async function resolveAdb(): Promise<string> {
  if (resolvedAdb !== null) return resolvedAdb;
  let lastErr: unknown = null;
  for (const exe of adbCandidates()) {
    try {
      await run(exe, ["version"], ADB_TIMEOUT_MS);
      resolvedAdb = exe;
      return exe;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("找不到可用的 adb（未安装 MuMu 且 PATH 里没有 adb）");
}

/** 裸 execFile Promise 封装（文本输出）。 */
function run(exe: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(exe, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err !== undefined && err !== null) reject(err);
      else resolve(String(stdout));
    });
  });
}

/** 裸 execFile Promise 封装（二进制输出，截图专用）。 */
function runBuffer(exe: string, args: string[], timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(exe, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: "buffer" }, (err, stdout) => {
      if (err !== undefined && err !== null) reject(err);
      else resolve(stdout as Buffer);
    });
  });
}

/**
 * 执行一条设备命令。每次都先解析序列号（TCP 序列号额外 connect，幂等）：
 * MuMu 的 adb server 会被外部 adb 调用顶掉，会话不保活——实测结论。
 */
async function adb(args: string[], timeoutMs: number = ADB_TIMEOUT_MS): Promise<string> {
  const exe = await resolveAdb();
  const serial = await resolveSerial(exe);
  if (serial === null) throw new Error("未检测到设备（请启动 MuMu 模拟器）");
  if (serial.includes(":")) {
    try {
      await run(exe, ["connect", serial], 3_000);
    } catch {
      // connect 失败不致命：后面的 -s 命令会给出真实错误
    }
  }
  return run(exe, ["-s", serial, ...args], timeoutMs);
}

let stateListener: ((s: PhoneStateInfo) => void) | null = null;
let frameListener: ((f: PhoneFrameInfo) => void) | null = null;

export function setPhoneStateListener(fn: ((s: PhoneStateInfo) => void) | null): void {
  stateListener = fn;
}

export function setPhoneFrameListener(fn: ((f: PhoneFrameInfo) => void) | null): void {
  frameListener = fn;
}

let openFlag = false;
let connected = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let polling = false;

function snapshot(): PhoneStateInfo {
  return { open: openFlag, connected, device: connected ? currentSerial : null };
}

function pushState(): void {
  stateListener?.(snapshot());
}

/** 截一帧并压缩。设备不可达 / 图像为空时返回 null（connected 随之翻转）。 */
async function captureFrame(): Promise<PhoneFrameInfo | null> {
  const exe = await resolveAdb();
  const serial = await resolveSerial(exe);
  if (serial === null) return null;
  if (serial.includes(":")) {
    try {
      await run(exe, ["connect", serial], 3_000);
    } catch {
      // 同 adb()：交给 screencap 报真实错误
    }
  }
  const png = await runBuffer(exe, ["-s", serial, "exec-out", "screencap", "-p"], CAPTURE_TIMEOUT_MS);
  const img = nativeImage.createFromBuffer(png);
  if (img.isEmpty()) return null;
  const { width, height } = img.getSize();
  const jpeg = img.toJPEG(55);
  return { dataUrl: `data:image/jpeg;base64,${jpeg.toString("base64")}`, width, height };
}

async function pollOnce(): Promise<void> {
  try {
    const frame = await captureFrame();
    connected = frame !== null;
    if (frame !== null) frameListener?.(frame);
  } catch {
    connected = false;
    invalidateSerial();
  }
  pushState();
}

function schedule(): void {
  timer = setTimeout(() => {
    void (async () => {
      if (polling) return;
      polling = true;
      try {
        await pollOnce();
      } finally {
        polling = false;
      }
      if (openFlag) schedule();
    })();
  }, POLL_INTERVAL_MS);
}

/** 打开镜像：开始轮询（幂等）。互斥逻辑（关浏览器面板）在 index.ts 的 IPC handler 里。 */
export function open(): void {
  if (openFlag) return;
  openFlag = true;
  pushState();
  schedule();
}

/** 关闭镜像：停轮询、标记断开（幂等）。已截帧留在渲染层自然过期。 */
export function close(): void {
  if (!openFlag && timer === null) return;
  openFlag = false;
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  connected = false;
  pushState();
}

export function isOpen(): boolean {
  return openFlag;
}

/** 手动补一帧（渲染层面板挂载 / 用户点刷新时调用；面板未开时忽略）。 */
export function refresh(): void {
  if (!openFlag || polling) return;
  polling = true;
  void pollOnce().finally(() => {
    polling = false;
  });
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 注入点击。坐标为设备物理像素（渲染层按帧尺寸换算，此处不二次校验范围）。 */
export async function tap(x: unknown, y: unknown): Promise<void> {
  const px = num(x);
  const py = num(y);
  if (px === null || py === null) return;
  await adb(["shell", "input", "tap", String(Math.round(px)), String(Math.round(py))]);
}

/** 注入滑动（按下 → 平移 → 松开，duration 毫秒）。 */
export async function swipe(x1: unknown, y1: unknown, x2: unknown, y2: unknown, durationMs: unknown): Promise<void> {
  const a = [num(x1), num(y1), num(x2), num(y2)];
  if (a.some((v) => v === null)) return;
  const ms = Math.min(Math.max(Math.round(num(durationMs) ?? 200), 50), 2_000);
  await adb(["shell", "input", "swipe", ...a.map((v) => String(Math.round(v as number))), String(ms)]);
}

/** 注入按键（Android keycode：3=HOME、4=返回、187=最近任务）。 */
export async function key(keycode: unknown): Promise<void> {
  const code = num(keycode);
  if (code === null || code < 0 || code > 1_000) return;
  await adb(["shell", "input", "keyevent", String(Math.round(code))]);
}

/** 主窗口关闭时调用：停轮询（进程随即退出，无持久资源）。 */
export function shutdown(): void {
  close();
}
