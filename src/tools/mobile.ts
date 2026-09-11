/**
 * mobile 工具族：Android 设备（真机 / 模拟器）的感知与操作。
 *
 * 通道分层（与 AGENTS.md「Computer Use & Browser Use & Mobile Use」一致）：
 * - mobile_ui 是**文本层主力**：uiautomator dump 拉回控件树，点击有真实
 *   控件锚点（bounds 中心坐标），不靠像素猜——比电脑端视觉方案还便宜；
 * - mobile_screen 是视觉兜底：adb exec-out screencap 直出 PNG（二进制经
 *   buffer 编码，绝不走 utf8 解码），接 okImage 与 screenshot 同一约定；
 * - mobile_act 是执行端：input tap/swipe/text、keyevent、am start。
 *   任意 adb 命令继续走 bash（env 快照已提示），这里只封装高频三件套。
 *
 * 多 adb 入口（模拟器场景）：MuMu / 雷电 / 夜神 / BlueStacks 都自带独立的
 * adb 可执行文件，且监听各自的 connect 端口——PATH 上的 SDK adb 经常看不到
 * 模拟器设备。三个工具共用一套入口解析：
 * - `adb` 参数选入口：内置别名（mumu / ld / nox / bluestacks / sdk）或
 *   adb.exe 绝对路径；缺省自动探测全部入口并合并设备列表；
 * - `serial` 参数选设备：按设备所属入口路由命令；不给 serial 且只有一台
 *   可用设备时自动选定；
 * - 扫不到设备时对各入口的典型模拟器端口自动 `adb connect` 一轮再重扫。
 *
 * 权限：mobile_act isMutating=true，桌面端过 approvalGate（与 computer 同级）。
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import type { JsonSchema } from "../providers/types.js";
import type { Tool } from "./types.js";
import { fail, ok, okImage } from "./types.js";

const execFileAsync = promisify(execFile);

// ── adb 多入口表 ──

/** 一个 adb 入口：可执行文件 + 该入口的典型模拟器 connect 端口（SDK adb 无需 connect） */
export interface AdbEntry {
  /** 入口名：sdk / mumu / ld / nox / bluestacks / custom */
  name: string;
  /** adb 可执行文件路径（或裸命令名，走 PATH） */
  bin: string;
  /** 自动 connect 时尝试的模拟器端口（127.0.0.1:port） */
  ports: number[];
}

/**
 * 内置模拟器 adb 入口表（Windows 常见安装位置；按序探测第一个存在的文件）。
 * 端口取各家默认值：MuMu 12 = 16384+32n（旧版 7555）、雷电 = 5555+2n、
 * 夜神 = 62001/62025+、BlueStacks = 5555。
 */
export const ADB_ENTRY_TABLE: Record<string, { bins: string[]; ports: number[] }> = {
  mumu: {
    bins: [
      // 实测：国内版安装目录名带空格「MuMu Player 12」（2026-09-11 真机踩坑），
      // 无空格「MuMuPlayer-12.0」是另一套安装器；两套 + 国际版都要探测。
      "C:\\Program Files\\Netease\\MuMu Player 12\\shell\\adb.exe",
      "D:\\Program Files\\Netease\\MuMu Player 12\\shell\\adb.exe",
      "C:\\Program Files\\Netease\\MuMuPlayer-12.0\\shell\\adb.exe",
      "D:\\Program Files\\Netease\\MuMuPlayer-12.0\\shell\\adb.exe",
      "C:\\Program Files\\Netease\\MuMuPlayerGlobal-12.0\\shell\\adb.exe",
      "D:\\Program Files\\Netease\\MuMuPlayerGlobal-12.0\\shell\\adb.exe",
      "C:\\Program Files\\Netease\\MuMu\\emulator\\nemu\\vmonitor\\bin\\adb_server.exe",
      "C:\\Program Files (x86)\\MuMu\\emulator\\nemu\\vmonitor\\bin\\adb_server.exe",
    ],
    ports: [16384, 16416, 7555],
  },
  ld: {
    bins: [
      "C:\\LDPlayer\\LDPlayer9\\adb.exe",
      "D:\\LDPlayer\\LDPlayer9\\adb.exe",
      "C:\\LDPlayer\\LDPlayer4\\adb.exe",
      "C:\\leidian\\LDPlayer9\\adb.exe",
    ],
    ports: [5555, 5557, 5559, 5561],
  },
  nox: {
    bins: [
      "C:\\Program Files (x86)\\Nox\\bin\\nox_adb.exe",
      "C:\\Program Files (x86)\\Nox\\bin\\adb.exe",
      "C:\\Program Files\\Nox\\bin\\nox_adb.exe",
      "D:\\Program Files (x86)\\Nox\\bin\\nox_adb.exe",
    ],
    ports: [62001, 62025, 62026],
  },
  bluestacks: {
    bins: [
      "C:\\Program Files\\BlueStacks_nxt\\HD-Adb.exe",
      "C:\\Program Files\\BlueStacks\\HD-Adb.exe",
      "D:\\Program Files\\BlueStacks_nxt\\HD-Adb.exe",
    ],
    ports: [5555],
  },
};

/** 别名容错：中英文常用叫法 → 内置表键名（sdk = PATH / env 指定的标准 adb） */
const ADB_ALIAS_ALIASES: Record<string, string> = {
  sdk: "sdk",
  adb: "sdk",
  mumu: "mumu",
  网易: "mumu",
  muMuPlayer: "mumu",
  ld: "ld",
  ldplayer: "ld",
  雷电: "ld",
  nox: "nox",
  夜神: "nox",
  bluestacks: "bluestacks",
  bs: "bluestacks",
  蓝叠: "bluestacks",
};

/** 判断给定字符串是否应视为「可执行文件路径」而非别名：含路径分隔符或 .exe/.adb 后缀 */
function looksLikePath(raw: string): boolean {
  return /[/\\]/.test(raw) || /\.(exe|adb)$/i.test(raw);
}

/**
 * 解析 adb 入口集合（纯同步，只做 existsSync 探测，不执行任何命令）。
 * - explicit 为空：默认集合 = sdk 入口（env C_AGENT_ADB || PATH "adb"）+
 *   逐家探测模拟器自带 adb（存在的才收）；
 * - explicit 是别名：只返回该入口（sdk 强制单入口）；
 * - explicit 是路径：校验存在后作为 custom 单入口；
 * - 解析失败返回错误说明字符串（调用方直接 fail）。
 */
export function resolveAdbEntries(explicit: string): AdbEntry[] | string {
  const raw = explicit.trim();
  if (raw.length === 0) {
    // 模拟器入口排在 sdk 前面：同台设备被两者同时发现时先到先得
    // （mergeAdbScans 按顺序去重）——命令应原路走模拟器自带 adb，避开版本战争。
    const entries: AdbEntry[] = [];
    for (const [name, spec] of Object.entries(ADB_ENTRY_TABLE)) {
      const bin = spec.bins.find((p) => existsSync(p));
      if (bin !== undefined) entries.push({ name, bin, ports: spec.ports });
    }
    // sdk 兜底：PATH adb 也 connect 各家典型端口——模拟器装在入口表没盖到的
    // 非标准位置时整条链路不至于断（TCP connect 不挑 adb 版本）。
    // 显式传 "sdk" 别名的单入口分支不做这件事：那是用户点名只信 PATH adb 的逃生口。
    const allPorts = [...new Set(Object.values(ADB_ENTRY_TABLE).flatMap((s) => s.ports))];
    entries.push({ name: "sdk", bin: process.env["C_AGENT_ADB"]?.trim() || "adb", ports: allPorts });
    return entries;
  }
  const aliasKey = ADB_ALIAS_ALIASES[raw.toLowerCase()] ?? ADB_ALIAS_ALIASES[raw];
  if (aliasKey !== undefined) {
    if (aliasKey === "sdk") {
      return [{ name: "sdk", bin: process.env["C_AGENT_ADB"]?.trim() || "adb", ports: [] }];
    }
    const spec = ADB_ENTRY_TABLE[aliasKey]!;
    const bin = spec.bins.find((p) => existsSync(p));
    if (bin === undefined) {
      return `别名 ${raw} 对应的模拟器 adb 未找到（已探测：${spec.bins.join("、")}）。可传 adb.exe 绝对路径。`;
    }
    return [{ name: aliasKey, bin, ports: spec.ports }];
  }
  if (looksLikePath(raw)) {
    if (!existsSync(raw)) return `adb 路径不存在：${raw}`;
    return [{ name: "custom", bin: raw, ports: [] }];
  }
  return `不认识的 adb 入口：${raw}。支持别名 ${["sdk", ...Object.keys(ADB_ENTRY_TABLE)].join(" / ")}（含中文：网易/雷电/夜神/蓝叠）或 adb.exe 绝对路径。`;
}

/** 文本型 adb 调用（utf8 输出）；bin 由入口路由给出 */
async function runAdb(bin: string, args: string[], signal?: AbortSignal, timeoutMs = 20_000): Promise<string> {
  const { stdout } = await execFileAsync(bin, args, {
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
    ...(signal ? { signal } : {}),
  });
  return stdout;
}

/** 二进制型 adb 调用（screencap 用；stdout 必须保持 Buffer，utf8 解码会毁图） */
function runAdbBuffer(bin: string, args: string[], signal?: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      {
        timeout: 30_000,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        encoding: "buffer",
        ...(signal ? { signal } : {}),
      },
      (err, stdout) => (err ? reject(err) : resolve(stdout as Buffer)),
    );
  });
}

/** `adb devices` 输出 → 设备列表（纯函数，可测；与 session.ts 同一套行格式约定） */
export function parseAdbList(stdout: string): Array<{ serial: string; state: string }> {
  const out: Array<{ serial: string; state: string }> = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    const m = line.match(/^(\S+)\t(\S+)$/);
    if (m !== null) out.push({ serial: m[1]!, state: m[2]! });
  }
  return out;
}

// ── 多入口设备发现与路由 ──

export interface MergedDevice {
  serial: string;
  state: string;
  /** 该设备归属的 adb 入口（命令必须发给这个 bin） */
  entry: AdbEntry;
}

/**
 * 合并多个入口的 `adb devices` 结果（纯函数，可测）。
 * 同一 serial 被多个入口看到时按序去重，且优先保留 state=device 的那条。
 */
export function mergeAdbScans(scans: Array<{ entry: AdbEntry; devices: Array<{ serial: string; state: string }> }>): MergedDevice[] {
  const bySerial = new Map<string, MergedDevice>();
  for (const { entry, devices } of scans) {
    for (const d of devices) {
      const prev = bySerial.get(d.serial);
      if (prev === undefined) bySerial.set(d.serial, { serial: d.serial, state: d.state, entry });
      else if (prev.state !== "device" && d.state === "device") bySerial.set(d.serial, { serial: d.serial, state: d.state, entry });
    }
  }
  return [...bySerial.values()];
}

/** 单入口扫描：adb 不可用（未安装/启动失败）→ 空列表，绝不抛 */
async function scanEntry(entry: AdbEntry, signal?: AbortSignal): Promise<{ entry: AdbEntry; devices: Array<{ serial: string; state: string }> }> {
  try {
    return { entry, devices: parseAdbList(await runAdb(entry.bin, ["devices"], signal, 6_000)) };
  } catch {
    return { entry, devices: [] };
  }
}

/** 对各入口的典型模拟器端口做一轮 adb connect（幂等；失败静默） */
async function autoConnectEntries(entries: AdbEntry[], signal?: AbortSignal): Promise<void> {
  await Promise.all(
    entries.flatMap((entry) =>
      entry.ports.slice(0, 4).map((port) =>
        runAdb(entry.bin, ["connect", `127.0.0.1:${String(port)}`], signal, 3_000).catch(() => ""),
      ),
    ),
  );
}

export interface AdbRoute {
  ok: true;
  /** 命令要发给哪个 adb 可执行文件 */
  bin: string;
  /** 选定的设备 serial（总是非空——路由保证） */
  serial: string;
  devices: MergedDevice[];
}

/**
 * 设备发现 + serial 路由。三工具共用的前置步骤：
 * 1. 并发扫描全部入口 → 合并去重；
 * 2. serial 命中 → 按所属入口路由；无 serial 且恰有一台可用设备 → 自动选定；
 * 3. 没选出来 → 自动 connect 模拟器端口后重扫一次；
 * 4. 仍失败 → 返回带设备表与入口列表的补救信息。
 */
export async function routeAdbDevice(entries: AdbEntry[], serial: string, signal?: AbortSignal): Promise<AdbRoute | { ok: false; message: string }> {
  const scan = async (): Promise<MergedDevice[]> =>
    mergeAdbScans(await Promise.all(entries.map((e) => scanEntry(e, signal))));
  const pick = (list: MergedDevice[]): AdbRoute | null => {
    if (serial.length > 0) {
      const hit = list.find((d) => d.serial === serial);
      return hit !== undefined ? { ok: true, bin: hit.entry.bin, serial: hit.serial, devices: list } : null;
    }
    const usable = list.filter((d) => d.state === "device");
    return usable.length === 1 ? { ok: true, bin: usable[0]!.entry.bin, serial: usable[0]!.serial, devices: list } : null;
  };

  let devices = await scan();
  let route = pick(devices);
  if (route === null) {
    await autoConnectEntries(entries, signal);
    devices = await scan();
    route = pick(devices);
  }
  if (route !== null) return route;

  const multi = entries.length > 1;
  const listText = devices.length > 0
    ? devices.map((d) => `${d.serial}(${d.state})${multi ? ` ← ${d.entry.name}` : ""}`).join("、")
    : "（无）";
  const entryHint = `当前 adb 入口：${entries.map((e) => e.name).join("、")}。`;
  if (serial.length > 0) {
    return {
      ok: false,
      message:
        `设备 ${serial} 不在任何 adb 入口的设备列表中（当前设备：${listText}）。` +
        `${entryHint}模拟器若刚启动，稍候重试（本工具会自动 adb connect）；也可先在 bash 执行 adb connect 127.0.0.1:端口。`,
    };
  }
  if (devices.length > 1) {
    return {
      ok: false,
      message: `检测到多台设备：${listText}。请用 serial 参数指定目标设备（blocked/offline 的不能操作）；${entryHint}`,
    };
  }
  if (devices.length === 1) {
    return {
      ok: false,
      message: `设备 ${devices[0]!.serial} 状态为 ${devices[0]!.state}，暂不可操作（未授权需在设备上确认 USB 调试弹窗；offline 重插/重连）。`,
    };
  }
  return {
    ok: false,
    message:
      `没有检测到任何 Android 设备（${entryHint}）。` +
      "真机：USB 连接并开启 USB 调试；模拟器：确认已启动，工具会对常见端口自动 adb connect，" +
      "非默认端口可在 bash 执行 adb connect 127.0.0.1:端口，或用 adb 参数直接指定入口/adb.exe 路径。",
  };
}

/** 从工具参数解析入口集合（三个 mobile_* 工具共用） */
function resolveEntriesFromArgs(args: Record<string, unknown>): AdbEntry[] | string {
  return resolveAdbEntries(String(args["adb"] ?? "").trim());
}

/** 错误信息补充（意外错误路径；正常失败走 routeAdbDevice 的结构化信息） */
async function adbFailDetail(err: unknown, bin: string, signal?: AbortSignal): Promise<string> {
  const msg = err instanceof Error ? err.message : String(err);
  if (/no devices|device not found|offline|closed/i.test(msg)) {
    let list = "";
    try {
      const devices = parseAdbList(await runAdb(bin, ["devices"], signal));
      list = devices.map((d) => `${d.serial}(${d.state})`).join("、");
    } catch {
      // 设备列表查不到就只给原始错误
    }
    if (list.length > 0) return `设备列表：${list}。原始错误：${msg.slice(0, 200)}`;
  }
  return msg.slice(0, 300);
}

/** 三工具共用的 mobile 参数里的 adb/serial 说明文本 */
const ADB_PARAM_DESC =
  "adb 入口：别名（sdk=PATH adb / mumu 网易MuMu / ld 雷电 / nox 夜神 / bluestacks 蓝叠）" +
  "或 adb.exe 绝对路径；缺省自动探测全部入口并合并设备列表。多设备时优先用 serial 选设备。";
const SERIAL_PARAM_DESC = "设备序列号（多设备时必填；单设备可省略）";

// ── mobile_screen ──

export const mobileScreenTool: Tool = {
  name: "mobile_screen",
  description:
    "截取 Android 设备当前画面（adb screencap），返回 PNG 截图与屏幕尺寸。" +
    "用于查看手机界面状态、给 mobile_act 的 tap/swipe 找像素坐标。" +
    "优先用 mobile_ui 的控件树找锚点（更准更省），看视觉效果时才用本工具。" +
    "支持真机与模拟器（MuMu/雷电/夜神/BlueStacks）多 adb 入口自动探测。",
  isMutating: false,
  parameters: {
    type: "object",
    properties: {
      serial: { type: "string", description: SERIAL_PARAM_DESC },
      adb: { type: "string", description: ADB_PARAM_DESC },
    },
  },
  async execute(args, ctx) {
    const entries = resolveEntriesFromArgs(args);
    if (typeof entries === "string") return fail(`adb 入口无效：${entries}`);
    const serial = String(args["serial"] ?? "").trim();
    const routed = await routeAdbDevice(entries, serial, ctx.signal);
    if (!routed.ok) return fail(routed.message);
    const prefix = ["-s", routed.serial];
    try {
      const [buf, sizeOut] = await Promise.all([
        runAdbBuffer(routed.bin, [...prefix, "exec-out", "screencap", "-p"], ctx.signal),
        runAdb(routed.bin, [...prefix, "shell", "wm size"], ctx.signal).catch(() => ""),
      ]);
      if (buf.length < 100) {
        return fail(`screencap 输出异常（${String(buf.length)} 字节）——设备可能未授权或屏幕已关闭。`);
      }
      const sizeLine = sizeOut.split(/\r?\n/).find((l) => /Physical|Override/.test(l))?.trim() ?? "";
      return okImage(
        `data:image/png;base64,${buf.toString("base64")}`,
        `手机截图${sizeLine.length > 0 ? `（${sizeLine}）` : ""}（坐标以图片左上角为 (0,0)，可直接用于 mobile_act 的 tap/swipe）。` +
          "更稳的锚点：先 mobile_ui 拉控件树，用 bounds 中心坐标点击。",
      );
    } catch (err) {
      return fail(`mobile_screen 执行失败：${await adbFailDetail(err, routed.bin, ctx.signal)}`);
    }
  },
};

// ── mobile_ui（uiautomator 控件树 → 文本层） ──

/** uiautomator dump 单节点（扁平化，保序） */
export interface UiaNode {
  text: string;
  desc: string;
  cls: string;
  resId: string;
  clickable: boolean;
  bounds: { x: number; y: number; w: number; h: number };
  /** 中心点（tap/swipe 的推荐锚点） */
  cx: number;
  cy: number;
  /** 树内深度（缩进提示层级） */
  depth: number;
}

/** bounds 属性 "[x1,y1][x2,y2]" → {x,y,w,h}；解析失败返回 null */
export function parseBounds(raw: string): { x: number; y: number; w: number; h: number } | null {
  const m = raw.match(/^\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]\s*\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]$/);
  if (m === null) return null;
  const x1 = Number(m[1]);
  const y1 = Number(m[2]);
  const x2 = Number(m[3]);
  const y2 = Number(m[4]);
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/**
 * uiautomator dump XML → 扁平控件列表（纯函数，可测）。
 * uiautomator 的 XML 属性格式固定且无转义嵌套坑，正则按 <node 属性串切
 * 足够稳；层级用开闭标签栈推深度，不用完整 XML parser（零依赖约定）。
 */
export function parseUiaDump(xml: string): UiaNode[] {
  const nodes: UiaNode[] = [];
  const stack: number[] = [];
  const tagRe = /<(\/?)node\b([^>]*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(xml)) !== null) {
    const [, closing, attrs, selfClose] = m;
    if (closing === "/") {
      stack.pop();
      continue;
    }
    const depth = stack.length;
    if (selfClose !== "/") stack.push(depth);
    if (nodes.length >= 500) continue; // 仍推进栈，只是不收录
    const get = (name: string): string => {
      const am = attrs!.match(new RegExp(`${name}="([^"]*)"`));
      return am !== null ? am[1]! : "";
    };
    const bounds = parseBounds(get("bounds"));
    if (bounds === null) continue;
    nodes.push({
      text: get("text"),
      desc: get("content-desc"),
      cls: get("class"),
      resId: get("resource-id"),
      clickable: get("clickable") === "true",
      bounds,
      cx: Math.round(bounds.x + bounds.w / 2),
      cy: Math.round(bounds.y + bounds.h / 2),
      depth,
    });
  }
  return nodes;
}

/** 控件列表 → 模型可读文本（纯函数，可测） */
export function formatUiaNodes(nodes: UiaNode[]): string {
  if (nodes.length === 0) return "（控件树为空——界面可能是纯图形/游戏，改用 mobile_screen 看图。）";
  const lines = nodes.map((n, i) => {
    const parts: string[] = [`#${String(i)}`, n.cls.split(".").pop() ?? n.cls];
    if (n.text.length > 0) parts.push(`text="${n.text}"`);
    if (n.desc.length > 0) parts.push(`desc="${n.desc}"`);
    if (n.resId.length > 0) parts.push(`id=${n.resId}`);
    if (n.clickable) parts.push("可点击");
    parts.push(`bounds=[${String(n.bounds.x)},${String(n.bounds.y)}][${String(n.bounds.x + n.bounds.w)},${String(n.bounds.y + n.bounds.h)}]`);
    parts.push(`中心=(${String(n.cx)},${String(n.cy)})`);
    return `${"  ".repeat(Math.min(n.depth, 6))}${parts.join(" ")}`;
  });
  return lines.join("\n");
}

const UIA_MAX_NODES = 300;

export const mobileUiTool: Tool = {
  name: "mobile_ui",
  description:
    "读取 Android 设备当前界面的控件树（uiautomator dump），返回带 bounds 中心" +
    "坐标的控件清单——手机 GUI 的**文本通道**：按 text/desc/id 找到目标控件，" +
    "拿中心坐标交给 mobile_act 的 tap/swipe，精准且省 token。" +
    "要求界面在前台且非纯图形（游戏/Canvas 拿不到控件，改用 mobile_screen）。" +
    "支持真机与模拟器（MuMu/雷电/夜神/BlueStacks）多 adb 入口自动探测。",
  isMutating: false,
  parameters: {
    type: "object",
    properties: {
      serial: { type: "string", description: SERIAL_PARAM_DESC },
      adb: { type: "string", description: ADB_PARAM_DESC },
    },
  },
  async execute(args, ctx) {
    const entries = resolveEntriesFromArgs(args);
    if (typeof entries === "string") return fail(`adb 入口无效：${entries}`);
    const serial = String(args["serial"] ?? "").trim();
    const routed = await routeAdbDevice(entries, serial, ctx.signal);
    if (!routed.ok) return fail(routed.message);
    const prefix = ["-s", routed.serial];
    try {
      // dump 落设备端文件再 cat 回来：老版本 uiautomator 的 /dev/tty 输出会混入告警
      await runAdb(routed.bin, [...prefix, "shell", "uiautomator", "dump", "/sdcard/window_dump.xml"], ctx.signal, 30_000);
      const xml = await runAdb(routed.bin, [...prefix, "shell", "cat", "/sdcard/window_dump.xml"], ctx.signal);
      const nodes = parseUiaDump(xml);
      const note = nodes.length > UIA_MAX_NODES
        ? `\n…（共 ${String(nodes.length)} 个控件，只显示前 ${String(UIA_MAX_NODES)} 个；可先操作让目标控件出现在当前屏）`
        : "";
      return ok(formatUiaNodes(nodes.slice(0, UIA_MAX_NODES)) + note);
    } catch (err) {
      return fail(`mobile_ui 执行失败：${await adbFailDetail(err, routed.bin, ctx.signal)}`);
    }
  },
};

// ── mobile_act ──

/** 具名键 → Android keyevent 键码 */
const KEYCODE_MAP: Record<string, number> = {
  back: 4, home: 3, enter: 66, del: 67, delete: 67, tab: 61, escape: 111, esc: 111,
  volume_up: 24, volume_down: 25, volume_mute: 164, power: 26, recent: 187,
  notification: 83, search: 84, camera: 27, menu: 82, app_switch: 187,
  dpad_up: 19, dpad_down: 20, dpad_left: 21, dpad_right: 22, dpad_center: 23,
};

/**
 * 构造设备端 shell 命令并做单引号转义（纯函数，可测）。
 * adb shell 会把后续参数原样拼接交给设备端 sh——引号在这里包一层最稳。
 */
export function buildShellCommand(action: string, args: Record<string, unknown>): string {
  const num = (k: string): number => Math.round(Number(args[k] ?? 0));
  switch (action) {
    case "tap":
      return `input tap ${String(num("x"))} ${String(num("y"))}`;
    case "swipe":
      return `input swipe ${String(num("x"))} ${String(num("y"))} ${String(num("x2"))} ${String(num("y2"))} ${String(Math.max(0, num("durationMs")))}`;
    case "text": {
      const text = String(args["content"] ?? "");
      // 空格在 input text 里是参数分隔符：设备端约定用 %s 代替
      const escaped = text.replace(/'/g, `'\\''`).replace(/ /g, "%s");
      return `input text '${escaped}'`;
    }
    case "key": {
      const raw = String(args["key"] ?? "").trim().toLowerCase();
      const code = /^\d+$/.test(raw) ? raw : String(KEYCODE_MAP[raw] ?? "");
      return `input keyevent ${code.length > 0 ? code : "0"}`;
    }
    case "start": {
      const target = String(args["target"] ?? "").trim();
      // 含 / 视为 component（pkg/.Activity 或 pkg/全限定名）；否则按包名用 monkey 拉起
      return target.includes("/")
        ? `am start -n '${target.replace(/'/g, `'\\''`)}'`
        : `monkey -p '${target.replace(/'/g, `'\\''`)}' -c android.intent.category.LAUNCHER 1`;
    }
    default:
      return "";
  }
}

const ACT_PARAMS: JsonSchema = {
  type: "object",
  properties: {
    action: {
      type: "string",
      description:
        "tap 点击 / swipe 滑动 / text 输入文本（先 tap 聚焦输入框）/ key 按键 / start 启动应用",
    },
    serial: { type: "string", description: SERIAL_PARAM_DESC },
    adb: { type: "string", description: ADB_PARAM_DESC },
    x: { type: "number", description: "tap/swipe 起点 X（屏幕像素坐标，来自 mobile_ui 的 bounds 或 mobile_screen 图片）" },
    y: { type: "number", description: "tap/swipe 起点 Y" },
    x2: { type: "number", description: "swipe 终点 X" },
    y2: { type: "number", description: "swipe 终点 Y" },
    durationMs: { type: "number", description: "swipe 时长毫秒（缺省 0 = 快速滑动；长按拖动给 800+）" },
    content: { type: "string", description: "text：要输入的内容（空格自动转 %s）" },
    key: {
      type: "string",
      description:
        "key：键名（back/home/enter/del/tab/escape/volume_up/volume_down/power/recent/search/" +
        "dpad_* 等）或直接给键码数字",
    },
    target: { type: "string", description: "start：包名（com.example.app）或组件名（com.example.app/.MainActivity）" },
  },
  required: ["action"],
};

export const mobileActTool: Tool = {
  name: "mobile_act",
  description:
    "操作 Android 设备：tap 点击、swipe 滑动、text 输入、key 按键（back/home 等）、" +
    "start 启动应用。坐标用手机屏幕像素（mobile_ui 的 bounds 中心最稳，" +
    "mobile_screen 的图片坐标同坐标系）。任意 adb 命令仍可直接走 bash。" +
    "注意：这是真实设备的真实操作（会点掉确认弹窗、发消息）。" +
    "支持真机与模拟器（MuMu/雷电/夜神/BlueStacks）多 adb 入口自动探测。",
  isMutating: true,
  parameters: ACT_PARAMS,
  async execute(args, ctx) {
    const action = String(args["action"] ?? "");
    const command = buildShellCommand(action, args);
    if (command.length === 0) {
      return fail(`mobile_act 不认识 action=${action}（支持 tap / swipe / text / key / start）`);
    }
    if (action === "text" && String(args["content"] ?? "").length === 0) {
      return fail("action=text 需要 content 参数（要输入的文本）");
    }
    if (action === "start" && String(args["target"] ?? "").trim().length === 0) {
      return fail("action=start 需要 target 参数（包名或组件名）");
    }
    if ((action === "key" && String(args["key"] ?? "").trim().length === 0)) {
      return fail("action=key 需要 key 参数（键名如 back/home，或键码数字）");
    }
    if (action === "key" && !/^\d+$/.test(String(args["key"]).trim()) && !(String(args["key"]).trim().toLowerCase() in KEYCODE_MAP)) {
      return fail(`不认识的键名：${String(args["key"])}（支持 ${Object.keys(KEYCODE_MAP).join(" / ")} 或键码数字）`);
    }
    const entries = resolveEntriesFromArgs(args);
    if (typeof entries === "string") return fail(`adb 入口无效：${entries}`);
    const serial = String(args["serial"] ?? "").trim();
    const routed = await routeAdbDevice(entries, serial, ctx.signal);
    if (!routed.ok) return fail(routed.message);
    const prefix = ["-s", routed.serial];
    try {
      const out = (await runAdb(routed.bin, [...prefix, "shell", command], ctx.signal, 15_000)).trim();
      const detail =
        action === "text" ? `text(${JSON.stringify(String(args["content"]).slice(0, 50))})`
        : action === "key" ? `key(${String(args["key"])})`
        : action === "start" ? `start(${String(args["target"])})`
        : action === "swipe"
          ? `swipe(${String(Math.round(Number(args["x"] ?? 0)))},${String(Math.round(Number(args["y"] ?? 0)))} → ${String(Math.round(Number(args["x2"] ?? 0)))},${String(Math.round(Number(args["y2"] ?? 0)))})`
          : `tap(${String(Math.round(Number(args["x"] ?? 0)))},${String(Math.round(Number(args["y"] ?? 0)))})`;
      const note = out.length > 0 ? `设备输出：${out.slice(0, 200)}` : "如需确认结果，请重新 mobile_screen 或 mobile_ui。";
      return ok(`已执行 ${detail}。${note}`);
    } catch (err) {
      return fail(`mobile_act ${action} 执行失败：${await adbFailDetail(err, routed.bin, ctx.signal)}`);
    }
  },
};
