/**
 * browser-use：桥接官方 browser-use MCP server（https://github.com/browser-use/browser-use）。
 * 启动命令两级：
 * 1. 首选项目根 browser-use-venv/bin/browser-use --mcp（持久 venv，绝对 shebang 最稳；
 *    BROWSER_USE_COMMAND 可覆盖路径，显式指定但不存在时告警并退化 uvx）；
 * 2. 兜底官方形态：`uvx --from 'browser-use[cli]' browser-use --mcp`（stdio）。
 *
 * 工具集来自运行时 tools/list（manifest capabilities 留空，与 mcp-everything 同策略）：
 * - 直接控制（15 个，无需 LLM key——c-agent 自己的模型就是大脑，browser-use 只当手）：
 *   browser_navigate / browser_click / browser_type / browser_get_state / browser_scroll /
 *   browser_go_back / browser_list_tabs / browser_switch_tab / browser_close_tab /
 *   browser_extract_content / browser_get_html / browser_screenshot / browser_list_sessions /
 *   browser_close_session / browser_close_all
 * - autonomous 兜底（1 个）：retry_with_browser_use_agent——起 browser-use 内部 agent 跑整任务，
 *   需要 LLM key；c-agent 进程环境里的 OPENAI_API_KEY / ANTHROPIC_API_KEY /
 *   GOOGLE_API_KEY（.env 经 loadDotEnv 注入）会被 McpStdioClient 自动继承，无需在此写死。
 *
 * 注意：
 * - 为什么不直接用 uvx：WorkBuddy IDE 会往 PATH 塞 brokered shim（realpath 等），
 *   uvx 生成的 venv sh 包装脚本里 `realpath -- "$0"` 解析失败，会退化成相对 cwd 找
 *   `<cwd>/python`（code=126）。持久 venv 的 console script 是绝对 shebang，不踩这个坑。
 *   uvx 仅作 venv 缺失时的兜底（BROWSER_USE_UVX 可覆盖其路径）。
 * - 项目根用 _shared/project-root.ts 的 cwd 向上探测：本文件会被 tsx（ESM 源码）
 *   与桌面主进程（tsc CJS emit）两种运行时加载，不能用 import.meta（CJS 编译报错）。
 * - 冷启动：venv 缺失时 uvx 现场下载依赖可能超过 1 分钟，connectTimeoutMs 放宽到 10 分钟。
 * - 无头/安全开关走环境变量：BROWSER_USE_HEADLESS=false 显示窗口、
 *   BROWSER_USE_DISABLE_SECURITY=true 关安全特性（子进程自动继承）。
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

function resolveServerCommand(): { command: string; args: string[] } {
  // 1. 持久 venv。BROWSER_USE_COMMAND 显式指定则只认它，不存在不静默换道（告警后退化）
  const explicit = process.env["BROWSER_USE_COMMAND"];
  if (explicit !== undefined && explicit.length > 0) {
    if (existsSync(explicit)) return { command: explicit, args: ["--mcp"] };
    console.warn(`[browser-use] BROWSER_USE_COMMAND 指向的文件不存在，退化 uvx: ${explicit}`);
  } else {
    const venvBin = path.join(projectRoot(), "browser-use-venv/bin/browser-use");
    if (existsSync(venvBin)) return { command: venvBin, args: ["--mcp"] };
  }
  // 2. uvx 兜底（官方形态）
  return { command: resolveUvx(), args: ["--from", "browser-use[cli]", "browser-use", "--mcp"] };
}

const server = resolveServerCommand();

export default createMcpBridgeClass({
  serverId: "browser-use",
  command: server.command,
  args: server.args,
  connectTimeoutMs: 600_000,
  mutatingToolNames: MUTATING_TOOLS,
});
