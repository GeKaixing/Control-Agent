/**
 * computer 工具：鼠标 / 键盘操作端（Computer Use 通道的执行器）。
 * 设计对标 UI-TARS-desktop SDK 的 Operator.execute()：
 * 模型看 screenshot 输出像素坐标（相对截图左上角），本工具负责换算成
 * 虚拟屏物理坐标并执行。动作空间收敛为 6 个：click / doubleClick /
 * rightClick / type / hotkey / scroll。
 *
 * 仅支持 Windows（PowerShell P/Invoke user32，零 npm 依赖）。
 * 安全边界：isMutating=true，桌面端过 approvalGate；CLI 无审批门，
 * 靠「操作即留痕」（返回值记录每次动作）+ 用户可见的屏幕变化兜底。
 * type 用剪贴板粘贴（与 UI-TARS pyautogui input_swap 同策略），
 * 会覆盖当前剪贴板内容——副作用在工具描述里明示。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { JsonSchema } from "../providers/types.js";
import type { Tool } from "./types.js";
import { fail, ok } from "./types.js";

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
    "输入文本会覆盖剪贴板。仅支持 Windows。",
  parameters: PARAMETERS,
  isMutating: true,
  async execute(args, ctx) {
    if (process.platform !== "win32") {
      return fail("computer 目前仅支持 Windows（PowerShell + user32）。");
    }
    const action = String(args["action"] ?? "");
    const x = Number(args["x"] ?? 0);
    const y = Number(args["y"] ?? 0);

    try {
      let script: string;
      const env: Record<string, string> = { CA_X: String(Math.round(x)), CA_Y: String(Math.round(y)) };
      switch (action) {
        case "click":
        case "doubleClick":
        case "rightClick": {
          if (args["x"] === undefined || args["y"] === undefined) {
            return fail(`${action} 需要 x/y 坐标（来自 screenshot 图片）。`);
          }
          script = mouseScript(action === "rightClick" ? "right" : "left", action === "doubleClick");
          break;
        }
        case "type": {
          const content = String(args["content"] ?? "");
          if (content.length === 0) return fail("type 需要 content 参数。");
          env["CA_CONTENT"] = content;
          env["CA_ENTER"] = /\n$/.test(content) ? "1" : "0";
          script = TYPE_SCRIPT;
          break;
        }
        case "hotkey": {
          const sendkeys = toSendKeys(String(args["keys"] ?? ""));
          if (sendkeys === null) {
            return fail("hotkey 的 keys 无法映射（不支持 win 键与多字符键名）。");
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
          return fail(`未知 action：${action}`);
      }

      await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
        {
          timeout: 20_000,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          env: { ...process.env, ...env },
        },
      );
      const detail =
        action === "type"
          ? `type(${JSON.stringify(String(args["content"]).slice(0, 50))})`
          : action === "hotkey"
            ? `hotkey(${String(args["keys"])})`
            : action === "scroll"
              ? `scroll(${String(args["direction"] ?? "down")}, x=${x}, y=${y})`
              : `${action}(x=${x}, y=${y})`;
      return ok(`已执行 ${detail}。如需确认结果，请重新 screenshot。`);
    } catch (err) {
      return fail(`computer ${action} 执行失败：${String(err).slice(0, 300)}`);
    }
  },
};
