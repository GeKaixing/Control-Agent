/**
 * uia_tree 工具：桌面 GUI 的**文本层**——拉取控件树（名称 / 类型 / 屏幕坐标），
 * 让模型「按控件点」而不是「看截图猜坐标」。视觉通道（screenshot + computer）
 * 降级为 UIA 拿不到的场景（游戏、Canvas、自绘控件）兜底——这是 AGENTS.md
 * 「文本通道优先」分层原则在电脑通道的落地。
 *
 * 平台后端（均零 npm 依赖）：
 * - Windows：PowerShell + UIAutomationClient（系统程序集），TreeWalker 走
 *   ControlView，深度 15、节点数封顶（CA_MAX），无位置（不可见）节点跳过。
 * - macOS：osascript JXA + System Events 辅助功能 API，深度 8、节点数封顶；
 *   需辅助功能权限（与 computer 同一套权限，缺权限时 fail 并给路径）。
 *
 * 无 title 参数时输出**索引模式**：只列顶层窗口 / 应用（名称 + 矩形 + pid），
 * 模型先拿索引再按 title 深入某窗口——避免一上来全桌面 dump 撑爆上下文。
 *
 * 安全：只读工具，isMutating=false。返回坐标是**屏幕物理像素**（Windows
 * 物理坐标 = screenshot 虚拟屏坐标系；macOS 逻辑点 = CGEvent 坐标），
 * 可直接喂给 computer 的 click/drag。
 */

import type { JsonSchema } from "../providers/types.js";
import type { Tool } from "./types.js";
import { fail, ok } from "./types.js";
import { runJxa } from "./darwin-cu.js";
import { runPowerShell } from "./screenshot.js";

/** UIA 树节点（TS 侧统一形状，Windows / macOS 输出都归一到这里） */
export interface UiaTreeNode {
  name: string;
  /** 控件类型：Button / Edit / Window / 静态文本 …（macOS 为 AXRole） */
  type: string;
  rect: { x: number; y: number; w: number; h: number } | null;
  enabled: boolean;
  depth: number;
}

/** 后端 JSON 输出的形状（索引模式给 windows，深入模式给 nodes） */
export interface UiaOutput {
  ok: boolean;
  error?: string;
  mode?: "index" | "tree";
  truncated?: boolean;
  window?: string;
  nodes?: UiaTreeNode[];
  windows?: Array<{ name: string; type: string; rect: UiaTreeNode["rect"]; pid?: number }>;
}

/** 解析后端输出的 JSON（纯函数，可测；容忍前后杂散输出，取首个 { 起 JSON） */
export function parseUiaJson(raw: string): UiaOutput | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;
  // 从末尾找最后一个 }——PowerShell 偶发在 JSON 后追加空行/提示
  const end = raw.lastIndexOf("}");
  if (end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1)) as UiaOutput;
  } catch {
    return null;
  }
}

/** 节点列表 → 模型可读文本（纯函数，可测）：编号 + 中心坐标可直接给 computer */
export function formatUiaTree(out: UiaOutput): string {
  if (out.mode === "index") {
    const wins = out.windows ?? [];
    if (wins.length === 0) return "（没有可见的顶层窗口。）";
    const lines = wins.map((w, i) => {
      const r = w.rect;
      const rectText = r !== null ? ` (${r.x},${r.y} ${r.w}x${r.h})` : "";
      const pid = w.pid !== undefined ? ` pid=${w.pid}` : "";
      return `#${i} "${w.name}"${rectText}${pid}`;
    });
    return `顶层窗口索引（挑一个，把名称子串作为 title 再调 uia_tree 深入）：\n${lines.join("\n")}`;
  }
  const nodes = out.nodes ?? [];
  if (nodes.length === 0) {
    return "（控件树为空——窗口可能需要先交互展开，或属于自绘 UI，改用 screenshot + computer 视觉操作。）";
  }
  const lines = nodes.map((n, i) => {
    const parts: string[] = [`#${i}`, n.type];
    if (n.name.length > 0) parts.push(`"${n.name.length > 60 ? n.name.slice(0, 60) + "…" : n.name}"`);
    if (n.rect !== null) {
      parts.push(`(${n.rect.x},${n.rect.y} ${n.rect.w}x${n.rect.h})`);
      parts.push(`中心=(${n.rect.x + Math.round(n.rect.w / 2)},${n.rect.y + Math.round(n.rect.h / 2)})`);
    }
    if (!n.enabled) parts.push("[禁用]");
    return `${"  ".repeat(Math.min(n.depth, 6))}${parts.join(" ")}`;
  });
  const head = out.window !== undefined ? `窗口「${out.window}」的控件树：\n` : "";
  const note = out.truncated === true ? `\n…（已达节点上限；焦点更小的 title 或加 maxNodes 重试）` : "";
  return `${head}${lines.join("\n")}${note}`;
}

const DEFAULT_MAX_NODES = 200;

// ── Windows 后端 ──

const WIN_SCRIPT = `
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$max = [int]$env:CA_MAX
$title = [string]$env:CA_TITLE
$script:count = 0
$script:truncated = $false
$nodes = New-Object System.Collections.Generic.List[object]
function RectObj($r) {
  if ($r -eq $null) { return $null }
  if ($r.IsEmpty) { return $null }
  @{ x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height }
}
function Walk($el, $depth) {
  if ($script:count -ge $max) { $script:truncated = $true; return }
  if ($depth -gt 15) { return }
  try {
    $c = $el.Current
    $t = $c.ControlType.ProgrammaticName
    if ($t.StartsWith("ControlType.")) { $t = $t.Substring(12) }
    $rect = RectObj $c.BoundingRectangle
    if ($rect -ne $null) {
      $nodes.Add(@{ name = $c.Name; type = $t; rect = $rect; enabled = $c.IsEnabled; depth = $depth }) | Out-Null
      $script:count++
    }
  } catch { return }
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  try { $child = $walker.GetFirstChild($el) } catch { return }
  while ($child -ne $null) {
    if ($script:count -ge $max) { $script:truncated = $true; break }
    Walk $child ($depth + 1)
    try { $child = $walker.GetNextSibling($child) } catch { break }
  }
}
$children = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
if ($title.Length -gt 0) {
  $win = $null
  foreach ($c in $children) {
    try {
      if ($c.Current.Name -and $c.Current.Name.ToLower().Contains($title.ToLower())) { $win = $c; break }
    } catch {}
  }
  if ($win -eq $null) {
    $idx = @()
    foreach ($c in $children) {
      try {
        $idx += @{ name = [string]$c.Current.Name; type = "window"; rect = (RectObj $c.Current.BoundingRectangle); pid = $c.Current.ProcessId }
      } catch {}
    }
    @{ ok = $true; mode = "index"; windows = $idx; error = ("未找到标题包含 '" + $title + "' 的窗口，先从索引里挑") } | ConvertTo-Json -Compress -Depth 4
  } else {
    Walk $win 0
    @{ ok = $true; mode = "tree"; window = [string]$win.Current.Name; truncated = $script:truncated; nodes = $nodes } | ConvertTo-Json -Compress -Depth 4
  }
} else {
  $idx = @()
  foreach ($c in $children) {
    try {
      $idx += @{ name = [string]$c.Current.Name; type = "window"; rect = (RectObj $c.Current.BoundingRectangle); pid = $c.Current.ProcessId }
    } catch {}
  }
  @{ ok = $true; mode = "index"; windows = $idx } | ConvertTo-Json -Compress -Depth 4
}
`;

// ── macOS 后端（System Events 辅助功能树） ──

const MAC_SCRIPT = `
ObjC.import("Foundation");
function envStr(k) {
  var v = $.NSProcessInfo.processInfo.environment.objectForKey(k);
  return v === undefined || v.js === undefined ? "" : String(v.js);
}
var title = envStr("CA_TITLE");
var maxN = parseInt(envStr("CA_MAX") || "200", 10);
if (!(maxN > 0)) maxN = 200;
var se = Application("System Events");
var out = { ok: false, mode: "index" };
try {
  if (title.length === 0) {
    var procs = se.processes();
    var wins = [];
    for (var i = 0; i < procs.length && wins.length < 60; i++) {
      try {
        if (procs[i].windows().length === 0) continue;
        var r = procs[i].windows()[0].position();
        var s = procs[i].windows()[0].size();
        wins.push({ name: String(procs[i].name()), type: "window",
          rect: { x: r.x, y: r.y, w: s.w, h: s.h } });
      } catch (e) {}
    }
    out = { ok: true, mode: "index", windows: wins };
  } else {
    var target = null;
    var procs2 = se.processes();
    for (var j = 0; j < procs2.length; j++) {
      try {
        if (String(procs2[j].name()).toLowerCase().indexOf(title.toLowerCase()) !== -1) { target = procs2[j]; break; }
      } catch (e2) {}
    }
    if (target === null) {
      out = { ok: true, mode: "index", windows: [], error: "未找到应用名包含 '" + title + "' 的进程" };
    } else {
      var nodes = [];
      var truncated = false;
      function walk(el, depth) {
        if (nodes.length >= maxN || depth > 8) { if (nodes.length >= maxN) truncated = true; return; }
        try {
          var role = String(el.role());
          var nm = "";
          try { nm = String(el.name()); } catch (e3) {}
          var p = el.position(); var s = el.size();
          nodes.push({ name: nm, type: role, enabled: String(el.enabled()) === "true", depth: depth,
            rect: { x: p.x, y: p.y, w: s.w, h: s.h } });
        } catch (e4) { return; }
        var kids = [];
        try { kids = el.uiElements(); } catch (e5) {}
        for (var k = 0; k < kids.length; k++) {
          if (nodes.length >= maxN) { truncated = true; return; }
          walk(kids[k], depth + 1);
        }
      }
      try {
        var wins2 = target.windows();
        if (wins2.length > 0) walk(wins2[0], 0);
      } catch (e6) {}
      out = { ok: true, mode: "tree", window: String(target.name()), truncated: truncated, nodes: nodes };
    }
  }
} catch (err) {
  out = { ok: false, error: String(err).slice(0, 300) };
}
JSON.stringify(out);
`;

const UIA_PARAMS: JsonSchema = {
  type: "object",
  properties: {
    title: {
      type: "string",
      description:
        "目标窗口标题子串（Windows）/ 应用名子串（macOS）。不给 = 索引模式，" +
        "只列顶层窗口/应用；拿到索引后把名称子串作为 title 再调一次深入控件树",
    },
    maxNodes: { type: "number", description: "控件数量上限（缺省 200，上限 500）" },
  },
};

export const uiaTreeTool: Tool = {
  name: "uia_tree",
  description:
    "读取桌面应用的控件树（UIA 文本层）：返回每个控件的类型、名称与屏幕坐标" +
    "（含中心点），按控件点比看截图猜坐标准得多——先 uia_tree 找控件，再拿中心" +
    "坐标调 computer。不给 title 时只列顶层窗口索引。游戏/自绘 UI 拿不到控件时" +
    "退回 screenshot + computer 视觉方案。Windows 用 UIA；macOS 需辅助功能权限。",
  isMutating: false,
  parameters: UIA_PARAMS,
  async execute(args, ctx) {
    const title = String(args["title"] ?? "").trim();
    const max = Math.min(500, Math.max(20, Math.round(Number(args["maxNodes"] ?? DEFAULT_MAX_NODES))));
    const env = { CA_TITLE: title, CA_MAX: String(max) };
    try {
      let raw: string;
      if (process.platform === "win32") {
        raw = await runPowerShell(WIN_SCRIPT, env, ctx.signal);
      } else if (process.platform === "darwin") {
        raw = await runJxa(MAC_SCRIPT, env, ctx.signal);
      } else {
        return fail("uia_tree 支持 Windows 与 macOS，当前平台不支持。");
      }
      const parsed = parseUiaJson(raw);
      if (parsed === null) {
        return fail(`uia_tree 输出异常：${raw.slice(0, 200)}`);
      }
      if (parsed.ok !== true) {
        return fail(`uia_tree 失败：${parsed.error ?? "未知错误"}`);
      }
      return ok(formatUiaTree(parsed));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/assistive access|辅助功能|not allowed assistive/i.test(msg)) {
        return fail(
          "uia_tree 没有辅助功能权限（Accessibility）：系统设置 → 隐私与安全性 → 辅助功能，" +
            `勾选运行本程序的 App 后重试。原始错误：${msg.slice(0, 200)}`,
        );
      }
      return fail(`uia_tree 执行失败：${msg.slice(0, 300)}`);
    }
  },
};
