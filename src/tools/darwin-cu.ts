/**
 * darwin-cu：Computer Use 通道的 macOS 后端（与 Windows 的 PowerShell 方案对等）。
 * 零 npm 依赖：截屏用系统自带 `screencapture`，鼠标/键盘用 `osascript` JXA +
 * ObjC bridge 调 CoreGraphics CGEvent。
 *
 * 坐标约定（与 Windows 对齐）：screenshot 把 Retina 截图降采样到「逻辑点」尺寸，
 * 使图片像素 == CGEvent 全局坐标（主显示器左上角为 (0,0)，y 向下），
 * computer 端无需任何换算。MVP 只覆盖主显示器（Windows 覆盖多屏并集）。
 *
 * 系统权限（TCC，缺了直接 fail 并给出路径，不静默降级）：
 * - 屏幕录制（screencapture 无权限时 exit 1，截不出窗口内容）
 * - 辅助功能（CGEventPost 无权限时事件被静默丢弃 / osascript 报 assistive access）
 */

import { execFile } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** 执行一段 JXA 脚本；参数一律走 env 传（防注入），脚本本身是固定字符串 */
export async function runJxa(
  script: string,
  env: Record<string, string>,
  signal?: AbortSignal,
): Promise<string> {
  const { stdout } = await execFileAsync(
    "osascript",
    ["-l", "JavaScript", "-e", script],
    {
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
      ...(signal ? { signal } : {}),
      env: { ...process.env, ...env },
    },
  );
  return stdout;
}

/** JXA 里读 env 的固定前缀 */
const ENV = (k: string): string =>
  `Number($.NSProcessInfo.processInfo.environment.objectForKey("${k}").js)`;

const PRELUDE = `
ObjC.import("CoreGraphics");
ObjC.import("Foundation");
function post(ev) { $.CGEventPost($.kCGHIDEventTap, ev); }
function keyEv(code, down, flags) {
  var e = $.CGEventCreateKeyboardEvent($(), code, down);
  if (flags) $.CGEventSetFlags(e, flags);
  post(e);
}
`;

// ------------------------------------------------------- 截屏（感知端）

/** 主显示器逻辑尺寸（CGEvent 坐标系），JXA 读 NSScreen.mainScreen.frame */
async function getMainDisplayPoints(signal?: AbortSignal): Promise<{ w: number; h: number }> {
  const out = await runJxa(
    `ObjC.import("AppKit");
     var f = $.NSScreen.mainScreen.frame;
     JSON.stringify({w: f.size.width, h: f.size.height});`,
    {},
    signal,
  );
  const m = out.match(/\{\s*"w"\s*:\s*(\d+)\s*,\s*"h"\s*:\s*(\d+)\s*\}/);
  if (m === null) throw new Error(`无法读取显示器尺寸：${out.slice(0, 120)}`);
  return { w: Number(m[1]), h: Number(m[2]) };
}

/**
 * 截主显示器 → JPEG base64。用 screencapture（无屏幕录制权限时 exit≠0，
 * 恰好作为权限探测）；Retina 下把图降采样到逻辑点尺寸，保证图上像素 == 点击坐标。
 */
export async function captureMainDisplay(
  signal?: AbortSignal,
): Promise<{ dataUrl: string; w: number; h: number }> {
  const tmp = join(tmpdir(), `c-agent-shot-${process.pid}-${Date.now()}.jpg`);
  try {
    await execFileAsync("screencapture", ["-x", "-o", "-t", "jpg", tmp], {
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      ...(signal ? { signal } : {}),
    });
    const { stdout } = await execFileAsync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", tmp]);
    const w = Number(stdout.match(/pixelWidth:\s*(\d+)/)?.[1]);
    const h = Number(stdout.match(/pixelHeight:\s*(\d+)/)?.[1]);
    if (!(w > 0) || !(h > 0)) throw new Error(`sips 输出异常：${stdout.slice(0, 120)}`);

    const pt = await getMainDisplayPoints(signal);
    // Retina（像素 > 逻辑点）→ 重采样到逻辑尺寸，坐标 1:1，上下文 token 也省 4 倍
    if (w !== pt.w || h !== pt.h) {
      await execFileAsync("sips", ["-z", String(pt.h), String(pt.w), tmp]);
    }
    const b64 = (await readFile(tmp)).toString("base64");
    return { dataUrl: `data:image/jpeg;base64,${b64}`, w: pt.w, h: pt.h };
  } catch (err) {
    const msg = String(err);
    if (/could not create image|屏幕录制|Screen Capture/i.test(msg)) {
      throw new Error(
        "没有屏幕录制权限：系统设置 → 隐私与安全性 → 屏幕录制，" +
          "勾选运行本程序的 App（终端 / WorkBuddy / Electron），然后重试。",
      );
    }
    throw err;
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

// ------------------------------------------------------- 鼠标 / 键盘（执行端）

const MOUSE_HELPERS = `
function mouse(type, btn, x, y, state) {
  var e = $.CGEventCreateMouseEvent($(), type, {x: x, y: y}, btn);
  if (state) $.CGEventSetIntegerValueField(e, $.kCGMouseEventClickState, state);
  post(e);
}
function clickAt(x, y, btn, downType, upType, state) {
  mouse($.kCGEventMouseMoved, btn, x, y, 0);
  $.NSThread.sleepForTimeInterval(0.08);
  mouse(downType, btn, x, y, state);
  $.NSThread.sleepForTimeInterval(0.04);
  mouse(upType, btn, x, y, state);
  $.NSThread.sleepForTimeInterval(0.06);
}
`;

/** 单击 / 双击 / 右键（左右键共用左键类型常量，右键用 kCGEventRightDown/Up=3/4） */
export function macClickScript(kind: "left" | "right" | "double"): string {
  const x = ENV("CA_X");
  const y = ENV("CA_Y");
  if (kind === "double") {
    return `${PRELUDE}${MOUSE_HELPERS}
clickAt(${x}, ${y}, $.kCGMouseButtonLeft, $.kCGEventLeftMouseDown, $.kCGEventLeftMouseUp, 1);
clickAt(${x}, ${y}, $.kCGMouseButtonLeft, $.kCGEventLeftMouseDown, $.kCGEventLeftMouseUp, 2);`;
  }
  const right = kind === "right";
  const down = right ? "$.kCGEventRightMouseDown" : "$.kCGEventLeftMouseDown";
  const up = right ? "$.kCGEventRightMouseUp" : "$.kCGEventLeftMouseUp";
  const btn = right ? "$.kCGMouseButtonRight" : "$.kCGMouseButtonLeft";
  return `${PRELUDE}${MOUSE_HELPERS}
clickAt(${x}, ${y}, ${btn}, ${down}, ${up}, 1);`;
}

/** 滚轮：kCGScrollEventUnitLine，正=向上，负=向下；每格 ≈ 3 行 */
export function macScrollScript(): string {
  return `${PRELUDE}
var lines = ${ENV("CA_LINES")};
var e = $.CGEventCreateScrollWheelEvent($(), 1, 1, lines);
post(e);`;
}

/** 拖拽：左键按下 → 14 步插值移动（kCGEventLeftMouseDragged）→ 终点松开 */
export function macDragScript(): string {
  return `${PRELUDE}${MOUSE_HELPERS}
var x1 = ${ENV("CA_X")}, y1 = ${ENV("CA_Y")};
var x2 = ${ENV("CA_X2")}, y2 = ${ENV("CA_Y2")};
mouse($.kCGEventMouseMoved, $.kCGMouseButtonLeft, x1, y1, 0);
$.NSThread.sleepForTimeInterval(0.08);
mouse($.kCGEventLeftMouseDown, $.kCGMouseButtonLeft, x1, y1, 1);
$.NSThread.sleepForTimeInterval(0.12);
for (var i = 1; i <= 14; i++) {
  mouse($.kCGEventLeftMouseDragged, $.kCGMouseButtonLeft,
        x1 + (x2 - x1) * i / 14, y1 + (y2 - y1) * i / 14, 1);
  $.NSThread.sleepForTimeInterval(0.02);
}
mouse($.kCGEventLeftMouseDragged, $.kCGMouseButtonLeft, x2, y2, 1);
$.NSThread.sleepForTimeInterval(0.1);
mouse($.kCGEventLeftMouseUp, $.kCGMouseButtonLeft, x2, y2, 1);`;
}

/** 激活应用：System Events 按进程名子串（不区分大小写）匹配，置 frontmost */
export function macFocusScript(): string {
  return `ObjC.import("Foundation");
var t = $.NSProcessInfo.processInfo.environment.objectForKey("CA_TITLE").js.toLowerCase();
var se = Application("System Events");
var matches = se.processes.whose({ name: { _contains: t } })();
if (matches.length === 0) throw new Error("未找到名称包含 '" + t + "' 的应用进程");
matches[0].frontmost = true;
"activated: " + matches[0].name();`;
}

/** 粘贴粘贴板内容（cmd+v），CA_ENTER=1 时补一个回车 */
export function macPasteScript(): string {
  return `${PRELUDE}
keyEv(9, true, 1048576);   // v（cmd 按住）
$.NSThread.sleepForTimeInterval(0.03);
keyEv(9, false, 1048576);
if (${ENV("CA_ENTER")} === 1) {
  $.NSThread.sleepForTimeInterval(0.1);
  keyEv(36, true, 0);      // return
  keyEv(36, false, 0);
}`;
}

/** 组合键：CA_CODES = 修饰键码+末位触发键（逗号分隔），CA_FLAGS = CGEventFlags 掩码 */
export function macHotkeyScript(): string {
  return `${PRELUDE}
var codes = $.NSProcessInfo.processInfo.environment.objectForKey("CA_CODES").js.split(",").map(Number);
var flags = ${ENV("CA_FLAGS")};
for (var i = 0; i < codes.length - 1; i++) keyEv(codes[i], true, flags);
$.NSThread.sleepForTimeInterval(0.03);
keyEv(codes[codes.length - 1], true, flags);
$.NSThread.sleepForTimeInterval(0.03);
keyEv(codes[codes.length - 1], false, flags);
for (var i = codes.length - 2; i >= 0; i--) keyEv(codes[i], false, flags);`;
}

// ------------------------------------------------------- 键码与组合键映射

/** macOS 虚拟键码（kVK_*），只收录模型会用到的键 */
const MAC_KEYCODES: Record<string, number> = {
  enter: 36, return: 36, tab: 48, space: 49, esc: 53, escape: 53,
  backspace: 51, delete: 51, del: 51, forwarddelete: 117,
  up: 126, down: 125, left: 123, right: 124,
  pageup: 116, pagedown: 121, home: 115, end: 119,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100,
  f9: 101, f10: 109, f11: 103, f12: 111,
};

/** 修饰键：键码（用于 keydown）+ CGEventFlags 掩码 */
const MAC_MODIFIERS: Record<string, { code: number; flag: number }> = {
  cmd: { code: 55, flag: 1 << 20 },
  command: { code: 55, flag: 1 << 20 },
  ctrl: { code: 59, flag: 1 << 18 },
  alt: { code: 58, flag: 1 << 19 },
  option: { code: 58, flag: 1 << 19 },
  shift: { code: 56, flag: 1 << 17 },
};

/** a-z 键码（kVK ANSI_*，非字母序，显式列出）；0-9 键码 */
const MAC_LETTER_CODES: Record<string, number> = {
  a: 0, b: 11, c: 8, d: 2, e: 14, f: 3, g: 5, h: 4, i: 34, j: 38,
  k: 40, l: 37, m: 46, n: 45, o: 31, p: 35, q: 12, r: 15, s: 1, t: 17,
  u: 32, v: 9, w: 13, x: 7, y: 16, z: 6,
};
const MAC_DIGIT_CODES: Record<string, number> = {
  "0": 29, "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26, "8": 28, "9": 25,
};

/** 单字符 → 键码（供 mapMacHotkey 内部使用） */
function charCode(raw: string): number | null {
  if (/^[a-z]$/.test(raw)) return MAC_LETTER_CODES[raw];
  if (/^[0-9]$/.test(raw)) return MAC_DIGIT_CODES[raw];
  return MAC_KEYCODES[raw] ?? null;
}

/**
 * "ctrl shift t" → { codes: [59,56,17], flags: ctrl|shift 掩码 }。
 * 与 Windows 的 toSendKeys 同语义：未知键名 fail；win 键 mac 上即 cmd。
 */
export function mapMacHotkey(keys: string): { codes: number[]; flags: number } | null {
  const tokens = keys.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 3) return null;
  const codes: number[] = [];
  let flags = 0;
  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i];
    const mod = MAC_MODIFIERS[raw];
    if (mod !== undefined) {
      codes.push(mod.code);
      flags |= mod.flag;
      continue;
    }
    if (raw === "win" || raw === "meta") {
      codes.push(55);
      flags |= 1 << 20;
      continue;
    }
    // 只有最后一个 token 允许是普通键；win 键之外的映射失败 → null
    if (i !== tokens.length - 1) return null;
    const code = charCode(raw);
    if (code === null) return null;
    codes.push(code);
  }
  // 纯修饰键组合（如只有 "ctrl"）没有触发键，拒绝
  const lastIsMod = MAC_MODIFIERS[tokens[tokens.length - 1]] !== undefined ||
    tokens[tokens.length - 1] === "win" || tokens[tokens.length - 1] === "meta";
  if (lastIsMod || codes.length === 0) return null;
  return { codes, flags };
}
