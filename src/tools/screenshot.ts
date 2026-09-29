/**
 * screenshot 工具：截取当前屏幕，返回 JPEG 截图（dataUrl）+ 元信息。
 * Computer Use 通道的感知端：模型直接看图输出像素坐标（相对截图左上角），
 * harness 不做坐标换算；UI-TARS 系模型（smart_resize 坐标系）的换算在
 * uitars-coords.ts，由 computer 的 uitarsBox 参数消费（见 AGENTS.md）。
 *
 * 平台后端（均零 npm 依赖）：
 * - Windows：PowerShell + System.Drawing，覆盖多显示器并集，物理像素 1:1。
 * - macOS：screencapture 截主显示器，Retina 图降采样到逻辑点尺寸使
 *   图片像素 == CGEvent 坐标（见 darwin-cu.ts）；需屏幕录制权限。
 * 其他平台 fail 并说明。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Tool } from "./types.js";
import { fail, okImage } from "./types.js";
import { captureMainDisplay } from "./darwin-cu.js";

/**
 * 最近一次成功截图的尺寸（模块级共享，computer 的 uitarsBox 换算要读）。
 * 没截过图时为 0——此时 uitarsBox 参数 fail 并提示先 screenshot。
 */
export const lastScreenshot = { w: 0, h: 0 };

const execFileAsync = promisify(execFile);

/** 与 computer.ts 共享的 PowerShell 执行辅助：env 传参避免注入 */
export async function runPowerShell(
  script: string,
  env: Record<string, string>,
  signal?: AbortSignal,
): Promise<string> {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      timeout: 30_000,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      ...(signal ? { signal } : {}),
      env: { ...process.env, ...env },
    },
  );
  return stdout;
}

const SCRIPT = `
$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition "using System.Runtime.InteropServices; public class DpiBoot { [DllImport(\\"user32.dll\\")] public static extern bool SetProcessDPIAware(); }"
[DpiBoot]::SetProcessDPIAware() | Out-Null
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
$ms = New-Object System.IO.MemoryStream
$enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" }
$ep = New-Object System.Drawing.Imaging.EncoderParameters 1
$ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]70)
$bmp.Save($ms, $enc, $ep)
$w = $bmp.Width; $h = $bmp.Height
$bmp.Dispose(); $g.Dispose(); $ms.Position = 0
Write-Output (($w).ToString() + "x" + ($h).ToString() + "|" + $b.X + "|" + $b.Y)
Write-Output ([Convert]::ToBase64String($ms.ToArray()))
`;

export const screenshotTool: Tool = {
  name: "screenshot",
  description:
    "截取当前屏幕，返回 JPEG 截图与尺寸信息。用于查看 GUI 界面状态、" +
    "确认操作结果。坐标约定：图片左上角为 (0,0)，后续 click 等操作使用相对图片的像素坐标。" +
    "Windows 覆盖所有显示器的并集区域；macOS 仅主显示器，需要屏幕录制权限。",
  parameters: {
    type: "object",
    properties: {},
  },
  isMutating: false,
  async execute(_args, ctx) {
    if (process.platform === "win32") {
      try {
        const stdout = await runPowerShell(SCRIPT, {}, ctx.signal);
        const lines = stdout.split(/\r?\n/).filter((l) => l.length > 0);
        const meta = lines[0] ?? "";
        const b64 = lines[1] ?? "";
        const m = meta.match(/^(\d+)x(\d+)\|(-?\d+)\|(-?\d+)$/);
        if (b64.length === 0 || m === null) {
          return fail(`screenshot 输出异常：${stdout.slice(0, 200)}`);
        }
        const [, w, h, ox, oy] = m;
        return okImage(
          `data:image/jpeg;base64,${b64}`,
          `屏幕截图 ${w}x${h}（虚拟屏原点 ${ox},${oy}；坐标以图片左上角为 (0,0)）。` +
            `多屏时图片覆盖所有显示器的并集区域。`,
        );
      } catch (err) {
        return fail(`screenshot 执行失败：${String(err).slice(0, 300)}`);
      }
    }
    if (process.platform === "darwin") {
      try {
        const shot = await captureMainDisplay(ctx.signal);
        lastScreenshot.w = shot.w;
        lastScreenshot.h = shot.h;
        return okImage(
          shot.dataUrl,
          `屏幕截图 ${shot.w}x${shot.h}（主显示器；坐标以图片左上角为 (0,0)。` +
            `多屏时只覆盖主显示器。`,
        );
      } catch (err) {
        return fail(`screenshot 执行失败：${String(err).slice(0, 400)}`);
      }
    }
    return fail("screenshot 支持 Windows 与 macOS，当前平台不支持。");
  },
};
