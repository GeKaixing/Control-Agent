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
 * 多设备：serial 参数选设备；不给 serial 且 adb 报 "more than one device"
 * 时，回查 `adb devices` 把设备列表放进 fail 信息让模型自己补 serial。
 * 权限：mobile_act isMutating=true，桌面端过 approvalGate（与 computer 同级）。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { JsonSchema } from "../providers/types.js";
import type { Tool } from "./types.js";
import { fail, ok, okImage } from "./types.js";

const execFileAsync = promisify(execFile);

/** 文本型 adb 调用（utf8 输出） */
async function runAdb(args: string[], signal?: AbortSignal, timeoutMs = 20_000): Promise<string> {
  const { stdout } = await execFileAsync("adb", args, {
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
    ...(signal ? { signal } : {}),
  });
  return stdout;
}

/** 二进制型 adb 调用（screencap 用；stdout 必须保持 Buffer，utf8 解码会毁图） */
function runAdbBuffer(args: string[], signal?: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      "adb",
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

/** 错误信息里带设备列表（多设备未指定 serial 时的补救路径） */
async function adbFailDetail(err: unknown, serial: string | undefined, signal?: AbortSignal): Promise<string> {
  const msg = err instanceof Error ? err.message : String(err);
  if (/more than one device|doesn't match this device/i.test(msg) && (serial === undefined || serial.length === 0)) {
    try {
      const devices = parseAdbList(await runAdb(["devices"], signal));
      const list = devices.map((d) => `${d.serial}(${d.state})`).join("、");
      return `检测到多台设备：${list}。请用 serial 参数指定目标设备后重试。`;
    } catch {
      // 连 devices 都查不到就回落到原始错误
    }
  }
  if (/no devices|device not found|offline/i.test(msg)) {
    return "没有可用的 Android 设备（真机需 USB 连接并开启 USB 调试；模拟器可 adb connect 127.0.0.1:端口）。原始错误：" + msg.slice(0, 200);
  }
  return msg.slice(0, 300);
}

// ── mobile_screen ──

export const mobileScreenTool: Tool = {
  name: "mobile_screen",
  description:
    "截取 Android 设备当前画面（adb screencap），返回 PNG 截图与屏幕尺寸。" +
    "用于查看手机界面状态、给 mobile_act 的 tap/swipe 找像素坐标。" +
    "优先用 mobile_ui 的控件树找锚点（更准更省），看视觉效果时才用本工具。",
  isMutating: false,
  parameters: {
    type: "object",
    properties: {
      serial: { type: "string", description: "设备序列号（多设备时必填；单设备可省略）" },
    },
  },
  async execute(args, ctx) {
    const serial = String(args["serial"] ?? "").trim();
    const prefix = serial.length > 0 ? ["-s", serial] : [];
    try {
      const [buf, sizeOut] = await Promise.all([
        runAdbBuffer([...prefix, "exec-out", "screencap", "-p"], ctx.signal),
        runAdb([...prefix, "shell", "wm size"], ctx.signal).catch(() => ""),
      ]);
      if (buf.length < 100) {
        return fail(`screencap 输出异常（${buf.length} 字节）——设备可能未授权或屏幕已关闭。`);
      }
      const sizeLine = sizeOut.split(/\r?\n/).find((l) => /Physical|Override/.test(l))?.trim() ?? "";
      return okImage(
        `data:image/png;base64,${buf.toString("base64")}`,
        `手机截图${sizeLine.length > 0 ? `（${sizeLine}）` : ""}（坐标以图片左上角为 (0,0)，可直接用于 mobile_act 的 tap/swipe）。` +
          "更稳的锚点：先 mobile_ui 拉控件树，用 bounds 中心坐标点击。",
      );
    } catch (err) {
      return fail(`mobile_screen 执行失败：${await adbFailDetail(err, serial, ctx.signal)}`);
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
    const parts: string[] = [`#${i}`, n.cls.split(".").pop() ?? n.cls];
    if (n.text.length > 0) parts.push(`text="${n.text}"`);
    if (n.desc.length > 0) parts.push(`desc="${n.desc}"`);
    if (n.resId.length > 0) parts.push(`id=${n.resId}`);
    if (n.clickable) parts.push("可点击");
    parts.push(`bounds=[${n.bounds.x},${n.bounds.y}][${n.bounds.x + n.bounds.w},${n.bounds.y + n.bounds.h}]`);
    parts.push(`中心=(${n.cx},${n.cy})`);
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
    "要求界面在前台且非纯图形（游戏/Canvas 拿不到控件，改用 mobile_screen）。",
  isMutating: false,
  parameters: {
    type: "object",
    properties: {
      serial: { type: "string", description: "设备序列号（多设备时必填；单设备可省略）" },
    },
  },
  async execute(args, ctx) {
    const serial = String(args["serial"] ?? "").trim();
    const prefix = serial.length > 0 ? ["-s", serial] : [];
    try {
      // dump 落设备端文件再 cat 回来：老版本 uiautomator 的 /dev/tty 输出会混入告警
      await runAdb([...prefix, "shell", "uiautomator", "dump", "/sdcard/window_dump.xml"], ctx.signal, 30_000);
      const xml = await runAdb([...prefix, "shell", "cat", "/sdcard/window_dump.xml"], ctx.signal);
      const nodes = parseUiaDump(xml);
      const note = nodes.length > UIA_MAX_NODES
        ? `\n…（共 ${nodes.length} 个控件，只显示前 ${UIA_MAX_NODES} 个；可先操作让目标控件出现在当前屏）`
        : "";
      return ok(formatUiaNodes(nodes.slice(0, UIA_MAX_NODES)) + note);
    } catch (err) {
      return fail(`mobile_ui 执行失败：${await adbFailDetail(err, serial, ctx.signal)}`);
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
      return `input tap ${num("x")} ${num("y")}`;
    case "swipe":
      return `input swipe ${num("x")} ${num("y")} ${num("x2")} ${num("y2")} ${Math.max(0, num("durationMs"))}`;
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
    serial: { type: "string", description: "设备序列号（多设备时必填；单设备可省略）" },
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
    "注意：这是真实设备的真实操作（会点掉确认弹窗、发消息）。",
  isMutating: true,
  parameters: ACT_PARAMS,
  async execute(args, ctx) {
    const action = String(args["action"] ?? "");
    const serial = String(args["serial"] ?? "").trim();
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
      return fail(`不认识的键名：${args["key"]}（支持 ${Object.keys(KEYCODE_MAP).join(" / ")} 或键码数字）`);
    }
    const prefix = serial.length > 0 ? ["-s", serial] : [];
    try {
      const out = (await runAdb([...prefix, "shell", command], ctx.signal, 15_000)).trim();
      const detail =
        action === "text" ? `text(${JSON.stringify(String(args["content"]).slice(0, 50))})`
        : action === "key" ? `key(${String(args["key"])})`
        : action === "start" ? `start(${String(args["target"])})`
        : action === "swipe"
          ? `swipe(${Math.round(Number(args["x"] ?? 0))},${Math.round(Number(args["y"] ?? 0))} → ${Math.round(Number(args["x2"] ?? 0))},${Math.round(Number(args["y2"] ?? 0))})`
          : `tap(${Math.round(Number(args["x"] ?? 0))},${Math.round(Number(args["y"] ?? 0))})`;
      const note = out.length > 0 ? `设备输出：${out.slice(0, 200)}` : "如需确认结果，请重新 mobile_screen 或 mobile_ui。";
      return ok(`已执行 ${detail}。${note}`);
    } catch (err) {
      return fail(`mobile_act ${action} 执行失败：${await adbFailDetail(err, serial, ctx.signal)}`);
    }
  },
};
