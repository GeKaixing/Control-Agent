/**
 * browser-use：桥接官方 browser-use MCP server（https://github.com/browser-use/browser-use）。
 *
 * 定位是**兜底通道，默认关闭**。浏览器控制的主通道是内置能力：
 * - 桌面端：内部浏览器面板（desktop/main/browser-view.ts + src/tools/browser.ts），
 *   Electron 内嵌 WebContentsView，CDP 受控、多标签、抓包/拦截、登录态持久，不弹外部窗口；
 * - 其它端：read / bash+curl 这类文本通道（见 src/tools/browser.ts 的 noBackend 提示）。
 *
 * 本 connector 起独立 Python + Chromium 进程，与面板职责重叠：两套工具同时进模型
 * 工具表时模型会选错（拿 browser_click 去操作面板页面），而且会多出一个外部浏览器
 * 窗口。所以 manifest 里挂了 `enabledBy: C_AGENT_BROWSER_USE` —— 不显式点名就不加载。
 * 需要它的时候（无面板的无人值守场景、面板搞不定的站点、想跑 browser-use 自带
 * autonomous agent）：
 *
 *     C_AGENT_BROWSER_USE=1 npx tsx src/index.ts --connectors ./connectors-mcp ...
 *
 * 启动命令两级：
 * 1. 首选项目根 browser-use-venv 里的 console script（持久 venv，绝对 shebang 最稳；
 *    BROWSER_USE_COMMAND 可覆盖路径，显式指定但不存在时告警并退化 uvx）；
 * 2. 兜底官方形态：`uvx --from 'browser-use[cli]' browser-use --mcp`（stdio）。
 *
 * 工具集来自运行时 tools/list（manifest capabilities 留空，与 mcp-everything 同策略）：
 * - 直接控制（15 个，无需 LLM key——c-agent 自己的模型就是大脑，browser-use 只当手）：
 *   browser_navigate / browser_click / browser_type / browser_get_state / browser_scroll /
 *   browser_go_back / browser_list_tabs / browser_switch_tab / browser_close_tab /
 *   browser_extract_content / browser_get_html / browser_screenshot / browser_list_sessions /
 *   browser_close_session / browser_close_all
 *   （browser_navigate / browser_screenshot 与内置工具同名，会被 src/session.ts 的
 *     mergeTools 按「保留内置」跳过——这是有意的，别为它改名）
 * - autonomous 兜底（1 个）：retry_with_browser_use_agent——起 browser-use 内部 agent 跑整任务，
 *   需要 LLM key；c-agent 进程环境里的 OPENAI_API_KEY / ANTHROPIC_API_KEY /
 *   GOOGLE_API_KEY（.env 经 loadDotEnv 注入）会被 McpStdioClient 自动继承，无需在此写死。
 *
 * 注意：
 * - 为什么不直接用 uvx：WorkBuddy IDE 会往 PATH 塞 brokered shim（realpath 等），
 *   uvx 生成的 venv sh 包装脚本里 `realpath -- "$0"` 解析失败，会退化成相对 cwd 找
 *   `<cwd>/python`（code=126）。持久 venv 的 console script 是绝对 shebang，不踩这个坑。
 *   uvx 仅作 venv 缺失时的兜底（BROWSER_USE_UVX 可覆盖其路径）。
 * - 默认无头：browser-use 自己的默认是「有屏幕就有头」（browser/profile.py 的
 *   _get_headless_default() 返回 None → headless = not has_screen_available），
 *   在有显示器的机器上等于每次弹一个 Chromium 窗口。这里翻转成无头，要开窗看真实
 *   渲染就显式 `BROWSER_USE_HEADLESS=false`。
 * - 项目根用 _shared/project-root.ts 的 cwd 向上探测：本文件会被 tsx（ESM 源码）
 *   与桌面主进程（tsc CJS emit）两种运行时加载，不能用 import.meta（CJS 编译报错）。
 * - 冷启动：venv 缺失时 uvx 现场下载依赖可能超过 1 分钟，connectTimeoutMs 放宽到 10 分钟。
 * - 安全开关走环境变量：BROWSER_USE_DISABLE_SECURITY=true 关安全特性（子进程自动继承）。
 * - 浏览器操作改变外部真实状态，除只读观测类外全部标 mutating 走审批门。
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createMcpBridgeClass } from "../_shared/mcp-bridge.js";
import { projectRoot } from "../_shared/project-root.js";

/** 除 command/args 外两级启动方式共用 */
const MUTATING_TOOLS = [
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_scroll",
  "browser_go_back",
  "browser_switch_tab",
  "browser_close_tab",
  "browser_close_session",
  "browser_close_all",
  "retry_with_browser_use_agent",
] as const;

/** 兜底：按 BROWSER_USE_UVX → ~/.local/bin → homebrew 顺序探测 uvx，最后退化裸命令 */
function resolveUvx(): string {
  const candidates = [
    process.env["BROWSER_USE_UVX"],
    path.join(homedir(), ".local/bin/uvx"),
    "/opt/homebrew/bin/uvx",
    "/usr/local/bin/uvx",
  ].filter((p): p is string => typeof p === "string" && p.length > 0);
  for (const p of candidates) {
    if (p.endsWith("uvx") && existsSync(p)) return p;
  }
  return "uvx";
}

/** 项目根持久 venv 的 console script：POSIX 在 bin/、Windows 在 Scripts/ 且带 .exe */
function resolveVenvBin(): string | null {
  const root = projectRoot();
  const candidates = [
    path.join(root, "browser-use-venv/bin/browser-use"),
    path.join(root, "browser-use-venv/Scripts/browser-use.exe"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function resolveServerCommand(): { command: string; args: string[] } {
  // 1. 持久 venv。BROWSER_USE_COMMAND 显式指定则只认它，不存在不静默换道（告警后退化）
  const explicit = process.env["BROWSER_USE_COMMAND"];
  if (explicit !== undefined && explicit.length > 0) {
    if (existsSync(explicit)) return { command: explicit, args: ["--mcp"] };
    console.warn(`[browser-use] BROWSER_USE_COMMAND 指向的文件不存在，退化 uvx: ${explicit}`);
  } else {
    const venvBin = resolveVenvBin();
    if (venvBin !== null) return { command: venvBin, args: ["--mcp"] };
  }
  // 2. uvx 兜底（官方形态）
  return { command: resolveUvx(), args: ["--from", "browser-use[cli]", "browser-use", "--mcp"] };
}

/**
 * 默认无头（见文件头）。只补缺省值：用户显式设过 BROWSER_USE_HEADLESS 就原样透传，
 * 不做「猜用户想要什么」的覆盖——与 McpStdioClient 的 extraEnv 语义一致。
 */
const DEFAULT_ENV: Record<string, string> = {};
if (process.env["BROWSER_USE_HEADLESS"] === undefined) {
  DEFAULT_ENV["BROWSER_USE_HEADLESS"] = "true";
}

const server = resolveServerCommand();

export default createMcpBridgeClass({
  serverId: "browser-use",
  command: server.command,
  args: server.args,
  connectTimeoutMs: 600_000,
  mutatingToolNames: MUTATING_TOOLS,
  env: DEFAULT_ENV,
});
