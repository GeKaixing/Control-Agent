/**
 * browser-use connector 冒烟测试（一次性脚本，不进 run.ts 测试链）。
 *
 * 跑法：`tsx scripts/browser-use-smoke.ts [--headless=false]`
 * 流程：只加载 connectors-mcp/browser-use → start（MCP 握手 + tools/list）
 *   → browser_navigate(example.com) → browser_get_state → dispose。
 * 有头模式调试用：`BROWSER_USE_HEADLESS=false tsx scripts/browser-use-smoke.ts`
 */

import path from "node:path";

import { ConnectorLoader } from "../src/connector/loader/connector-loader.js";
import { ConnectorRuntime } from "../src/connector/runtime/connector-runtime.js";

const CONNECTORS_DIR = path.resolve(import.meta.dirname, "../connectors-mcp");

async function main(): Promise<void> {
  process.stderr.write(`[smoke] scanning: ${CONNECTORS_DIR} (only=browser-use)\n`);
  const loader = new ConnectorLoader({ paths: [CONNECTORS_DIR], only: ["browser-use"] });
  const { loaded, failed } = await loader.scan();
  for (const f of failed) process.stderr.write(`[smoke] load failed: ${f.rootDir} -> ${f.error}\n`);
  if (loaded.length === 0) {
    process.stderr.write("[smoke] FAIL: browser-use connector not loaded\n");
    process.exit(1);
  }
  for (const c of loaded) console.log(`[smoke] loaded: ${c.manifest.id} v${c.manifest.version}`);

  const runtime = new ConnectorRuntime({
    cwd: process.cwd(),
    env: process.env as Record<string, string | undefined>,
    onLog: (e) => process.stderr.write(`[smoke:${e.connectorId}] ${e.level}: ${e.message}\n`),
  });
  for (const c of loaded) runtime.adopt(c);

  const startFailed = await runtime.start();
  if (startFailed.length > 0) {
    process.stderr.write(`[smoke] FAIL: start failed: ${startFailed.join(", ")}\n`);
    await runtime.dispose();
    process.exit(1);
  }

  const tools = runtime.extraTools();
  process.stderr.write(`[smoke] ready: ${tools.length} tools\n`);
  for (const t of tools) {
    process.stderr.write(`[smoke]   - ${t.name}${t.isMutating ? " (mutating)" : ""}: ${t.description.slice(0, 80)}\n`);
  }

  // 冒烟 1：导航到 example.com
  const nav = await runtime.execute("browser_navigate", { url: "https://example.com" });
  const navText = nav.content.map((c) => ("text" in c ? c.text : JSON.stringify(c))).join("\n");
  process.stderr.write(`[smoke] browser_navigate isError=${nav.isError}\n${navText.slice(0, 500)}\n`);
  if (nav.isError) {
    process.stderr.write("[smoke] FAIL: browser_navigate returned error\n");
    await runtime.dispose();
    process.exit(1);
  }

  // 冒烟 2：读页面状态
  const state = await runtime.execute("browser_get_state", {});
  const stateText = state.content.map((c) => ("text" in c ? c.text : JSON.stringify(c))).join("\n");
  process.stderr.write(`[smoke] browser_get_state isError=${state.isError}\n${stateText.slice(0, 800)}\n`);
  if (state.isError) {
    process.stderr.write("[smoke] FAIL: browser_get_state returned error\n");
    await runtime.dispose();
    process.exit(1);
  }

  await runtime.dispose();
  process.stderr.write("[smoke] PASS ✓\n");
}

main().catch((err) => {
  process.stderr.write(`[smoke] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
