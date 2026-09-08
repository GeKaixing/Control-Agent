/**
 * computer 工具：鼠标 / 键盘操作端（Computer Use 通道的执行器）。
 * 设计对标 UI-TARS-desktop SDK 的 Operator.execute()：
 * 模型看 screenshot 输出像素坐标（相对截图左上角），本工具负责换算成
 * 屏幕坐标并执行。动作空间收敛为 6 个：click / doubleClick /
 * rightClick / type / hotkey / scroll。
 *
 * 平台后端（均零 npm 依赖）：
 * - Windows：PowerShell P/Invoke user32；坐标 = 虚拟屏物理像素（加原点偏移）。
 * - macOS：osascript JXA + CoreGraphics CGEvent（见 darwin-cu.ts）；
 *   screenshot 已把图归一到逻辑点坐标，此处 x/y 直接可用。需辅助功能权限。
 *
 * 安全边界：isMutating=true，桌面端过 approvalGate；CLI 无审批门，
 * 靠「操作即留痕」（返回值记录每次动作）+ 用户可见的屏幕变化兜底。
 * type 用剪贴板粘贴（Windows SendKeys ^v / macOS pbcopy+cmd+v，
 * 与 UI-TARS pyautogui input_swap 同策略），会覆盖当前剪贴板——副作用在
 * 工具描述里明示。
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { JsonSchema } from "../providers/types.js";
import type { Tool } from "./types.js";
import { fail, ok } from "./types.js";
import { macClickScript, macHotkeyScript, macPasteScript, macScrollScript, mapMacHotkey, runJxa } from "./darwin-cu.js";

const execFileAsync = promisify(execFile);

const COMMON_PRELUDE = `
$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition "using System; using System.Runtime.InteropServices; public class NativeInput { [DllImport(\\"user32.dll\\")] public static extern bool SetCursorPos(int x, int y); [DllImport(\\"user32.dll\\")] public static extern void mouse_event(uint f, uint dx, uint dy, int d, UIntPtr e); [DllImport(\\"user32.dll\\")] public static extern bool SetProcessDPIAware(); }"
[NativeInput]::SetProcessDPIAware() | Out-Null
Add-Type -AssemblyName System.Windows.Forms
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$px = [int]$env:CA_X + $b.X
$py = [int]$env:CA_Y + $b.Y
`;

function mouseScript(button: "left" | "right", double: boolean): string {
  const down = button === "left" ? "2" : "8";
  const up = button === "left" ? "4" : "16";
  const once = `[NativeInput]::mouse_event(${down},0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 40; [NativeInput]::mouse_event(${up},0,0,0,[UIntPtr]::Zero)`;
  const clicks = double ? `1..2 | ForEach-Object { ${once}; Start-Sleep -Milliseconds 60 }` : once;
  return `${COMMON_PRELUDE}
[NativeInput]::SetCursorPos($px, $py) | Out-Null
Start-Sleep -Milliseconds 80
${clicks}`;
}

const SCROLL_SCRIPT = `${COMMON_PRELUDE}
[NativeInput]::SetCursorPos($px, $py) | Out-Null
Start-Sleep -Milliseconds 80
[NativeInput]::mouse_event(0x0800, 0, 0, [int]$env:CA_DELTA, [UIntPtr]::Zero)`;

const TYPE_SCRIPT = `${COMMON_PRELUDE}
if ($env:CA_CONTENT.Length -gt 0) {
  Set-Clipboard -Value $env:CA_CONTENT
  Start-Sleep -Milliseconds 100
  [System.Windows.Forms.SendKeys]::SendWait("^v")
}
if ($env:CA_ENTER -eq "1") {
  Start-Sleep -Milliseconds 120
  [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
}`;

const HOTKEY_SCRIPT = `
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Start-Sleep -Milliseconds 60
[System.Windows.Forms.SendKeys]::SendWait($env:CA_SENDKEYS)`;

/** SendKeys 组合键映射：修饰符前缀 + 特殊键名 */
const KEY_MAP: Record<string, string> = {
  ctrl: "^", alt: "%", shift: "+",
  enter: "{ENTER}", tab: "{TAB}", esc: "{ESC}", escape: "{ESC}",
  backspace: "{BS}", delete: "{DEL}", del: "{DEL}", insert: "{INS}",
  space: " ", up: "{UP}", down: "{DOWN}", left: "{LEFT}", right: "{RIGHT}",
  pageup: "{PGUP}", pagedown: "{PGDN}", home: "{HOME}", end: "{END}",
  capslock: "{CAPSLOCK}",
};

/** "ctrl shift t" → "^+t"；未知键名 fail（SendKeys 无 win 键，明确不支持） */
function toSendKeys(keys: string): string | null {
  let out = "";
  for (const raw of keys.trim().toLowerCase().split(/\s+/).filter(Boolean)) {
    if (/^f(?:[1-9]|1[0-2])$/.test(raw)) {
      out += `{${raw.toUpperCase()}}`;
      continue;
    }
    const mapped = KEY_MAP[raw];
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    if (/^[a-z0-9]$/.test(raw)) {
      out += raw;
      continue;
    }
    return null;
  }
  return out.length > 0 ? out : null;
}

const PARAMETERS: JsonSchema = {
  type: "object",
  properties: {
    action: {
      type: "string",
      description:
        "click / doubleClick / rightClick / type / hotkey / scroll。type 前先 click 输入框；type 使用剪贴板粘贴，会覆盖当前剪贴板。",
    },
    x: { type: "number", description: "像素横坐标（相对最近一次 screenshot 图片的左上角）" },
    y: { type: "number", description: "像素纵坐标（同上）" },
    content: { type: "string", description: "type 的输入内容；以 \\n 结尾时输入后按回车" },
    keys: { type: "string", description: "hotkey 的组合键，空格分隔小写，如 'ctrl c'、'alt tab'、'ctrl shift t'。最多 3 键。" },
    direction: { type: "string", enum: ["up", "down"], description: "scroll 方向" },
    amount: { type: "number", description: "scroll 滚动格数，默认 3" },
  },
  required: ["action"],
};

export const computerTool: Tool = {
  name: "computer",
  description:
    "操作电脑：鼠标点击/双击/右键、文本输入、快捷键、滚动。坐标必须来自最近一次 screenshot 的图片像素。" +
    "输入文本会覆盖剪贴板。支持 Windows 与 macOS（macOS 需辅助功能权限）。",
  parameters: PARAMETERS,
  isMutating: true,
  async execute(args, ctx) {
    if (process.platform !== "win32" && process.platform !== "darwin") {
      return fail("computer 支持 Windows 与 macOS，当前平台不支持。");
    }
    const action = String(args["action"] ?? "");
    const x = Number(args["x"] ?? 0);
    const y = Number(args["y"] ?? 0);

    try {
      const detail =
        action === "type"
          ? `type(${JSON.stringify(String(args["content"]).slice(0, 50))})`
          : action === "hotkey"
            ? `hotkey(${String(args["keys"])})`
            : action === "scroll"
              ? `scroll(${String(args["direction"] ?? "down")}, x=${x}, y=${y})`
              : `${action}(x=${x}, y=${y})`;

      if (process.platform === "darwin") {
        await execMacAction(action, args, ctx.signal);
      } else {
        await execWinAction(action, args, x, y, ctx.signal);
      }
      return ok(`已执行 ${detail}。如需确认结果，请重新 screenshot。`);
    } catch (err) {
      const msg = String(err);
      if (/assistive access|辅助功能|not allowed to send/i.test(msg)) {
        return fail(
          "computer 没有辅助功能权限（Accessibility）：系统设置 → 隐私与安全性 → 辅助功能，" +
            `勾选运行本程序的 App 后重试。原始错误：${msg.slice(0, 200)}`,
        );
      }
      return fail(`computer ${action} 执行失败：${msg.slice(0, 300)}`);
    }
  },
};

/** macOS 路径：osascript JXA + CGEvent（脚本与键码映射在 darwin-cu.ts） */
async function execMacAction(
  action: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<void> {
  const x = Math.round(Number(args["x"] ?? 0));
  const y = Math.round(Number(args["y"] ?? 0));
  const coordEnv = { CA_X: String(x), CA_Y: String(y) };
  switch (action) {
    case "click":
    case "doubleClick":
    case "rightClick": {
      if (args["x"] === undefined || args["y"] === undefined) {
        throw new Error(`${action} 需要 x/y 坐标（来自 screenshot 图片）。`);
      }
      const kind = action === "doubleClick" ? "double" : action === "rightClick" ? "right" : "left";
      await runJxa(macClickScript(kind), coordEnv, signal);
      return;
    }
    case "type": {
      const content = String(args["content"] ?? "");
      if (content.length === 0) throw new Error("type 需要 content 参数。");
      const hasEnter = /\n$/.test(content);
      await setClipboard(content.replace(/\n$/, ""), signal);
      await runJxa(macPasteScript(), { CA_ENTER: hasEnter ? "1" : "0" }, signal);
      return;
    }
    case "hotkey": {
      const combo = mapMacHotkey(String(args["keys"] ?? ""));
      if (combo === null) {
        throw new Error("hotkey 的 keys 无法映射（最多 3 键；修饰键后须跟一个普通键）。");
      }
      await runJxa(
        macHotkeyScript(),
        { CA_CODES: combo.codes.join(","), CA_FLAGS: String(combo.flags) },
        signal,
      );
      return;
    }
    case "scroll": {
      const amount = Math.max(1, Math.round(Number(args["amount"] ?? 3)));
      const dir = args["direction"] === "up" ? 1 : -1;
      await runJxa(macScrollScript(), { CA_LINES: String(dir * 3 * amount) }, signal);
      return;
    }
    default:
      throw new Error(`未知 action：${action}`);
  }
}

/** pbcopy：stdin 写入避免 shell 转义/注入 */
function setClipboard(text: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn("pbcopy", [], { ...(signal ? { signal } : {}) });
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`pbcopy 退出码 ${code}`)),
    );
    p.stdin.end(text, "utf8");
  });
}

/** Windows 路径：PowerShell + user32 P/Invoke（原实现，逻辑不变） */
async function execWinAction(
  action: string,
  args: Record<string, unknown>,
  x: number,
  y: number,
  signal?: AbortSignal,
): Promise<void> {
  let script: string;
  const env: Record<string, string> = { CA_X: String(Math.round(x)), CA_Y: String(Math.round(y)) };
  switch (action) {
    case "click":
    case "doubleClick":
    case "rightClick": {
      if (args["x"] === undefined || args["y"] === undefined) {
        throw new Error(`${action} 需要 x/y 坐标（来自 screenshot 图片）。`);
      }
      script = mouseScript(action === "rightClick" ? "right" : "left", action === "doubleClick");
      break;
    }
    case "type": {
      const content = String(args["content"] ?? "");
      if (content.length === 0) throw new Error("type 需要 content 参数。");
      env["CA_CONTENT"] = content;
      env["CA_ENTER"] = /\n$/.test(content) ? "1" : "0";
      script = TYPE_SCRIPT;
      break;
    }
    case "hotkey": {
      const sendkeys = toSendKeys(String(args["keys"] ?? ""));
      if (sendkeys === null) {
        throw new Error("hotkey 的 keys 无法映射（不支持 win 键与多字符键名）。");
      }
      env["CA_SENDKEYS"] = sendkeys;
      script = HOTKEY_SCRIPT;
      break;
    }
    case "scroll": {
      const amount = Number(args["amount"] ?? 3);
      env["CA_DELTA"] = String(args["direction"] === "up" ? 120 * amount : -120 * amount);
      script = SCROLL_SCRIPT;
      break;
    }
    default:
      throw new Error(`未知 action：${action}`);
  }

  await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      ...(signal ? { signal } : {}),
      env: { ...process.env, ...env },
    },
  );
}
