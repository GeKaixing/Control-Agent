/**
 * 一次性验证：从桌面主进程编译产物（CJS .js + 复制的 manifest）加载 connector——
 * 即 desktop/main/index.ts 的实际加载路径。
 *
 * 缺省跑「桌面端真实形态」：browser-use 因 enabledBy 门被跳过（与桌面端一致）。
 * 加 `--with-browser-use` 则设 C_AGENT_BROWSER_USE=1，验证显式点名路径。
 *
 * 跑法：`npx tsx scripts/dist-connectors-check.ts [--with-browser-use]`
 */

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import { ConnectorLoader } from "../src/connector/loader/connector-loader.js";
import { ConnectorRuntime } from "../src/connector/runtime/connector-runtime.js";

/** dist 布局是 dist/<仓库目录名>/connectors-mcp（目录名随工作区变），动态找 */
function resolveDistConnectorsDir(): string | null {
  const distRoot = path.resolve(import.meta.dirname, "../desktop/main/dist");
  if (!existsSync(distRoot)) return null;
  const direct = path.join(distRoot, "connectors-mcp");
  if (existsSync(direct)) return direct;
  for (const entry of readdirSync(distRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(distRoot, entry.name, "connectors-mcp");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function main(): Promise<void> {
  const withBrowserUse = process.argv.includes("--with-browser-use");
  if (withBrowserUse) process.env["C_AGENT_BROWSER_USE"] = "1";

  const dir = resolveDistConnectorsDir();
  if (dir === null) {
    console.error("[dist-check] dist 里没有 connectors-mcp（先跑 npm run desktop:build:main）");
    process.exit(1);
  }
  console.log(`[dist-check] scanning ${dir}${withBrowserUse ? "（C_AGENT_BROWSER_USE=1）" : ""}`);

  const loader = new ConnectorLoader({ paths: [dir] });
  const { loaded, failed, skipped } = await loader.scan();
  for (const f of failed) console.error("[dist-check] load failed:", f.rootDir, f.error);
  for (const s of skipped) console.log(`[dist-check] skipped: ${s.manifest.id}（${s.reason}）`);

  const rt = new ConnectorRuntime({ cwd: process.cwd() });
  for (const c of loaded) rt.adopt(c);
  const sf = await rt.start();
  if (sf.length > 0) console.error("[dist-check] start failed:", sf.join(", "));

  const tools = rt.extraTools();
  console.log(
    `[dist-check] OK: ${loaded.length} connectors, ${tools.length} tools; ` +
      `skipped ${skipped.length}; start failed: ${sf.length}`,
  );
  const bu = tools
    .filter((t) => t.name.startsWith("browser_") || t.name.startsWith("retry_"))
    .map((t) => `${t.name}${t.isMutating ? "*" : ""}`);
  console.log(`[dist-check] browser-use tools (${bu.length}): ${bu.join(", ") || "（无）"}`);
  await rt.dispose();
}

main().catch((err: unknown) => {
  console.error("[dist-check] fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
