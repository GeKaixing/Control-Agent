/**
 * 一次性验证：从桌面主进程编译产物（CJS .js + 复制的 manifest）加载 connector——
 * 即 desktop/main/index.ts 的实际加载路径。跑完即删。
 */

import { ConnectorLoader } from "../src/connector/loader/connector-loader.js";
import { ConnectorRuntime } from "../src/connector/runtime/connector-runtime.js";

async function main(): Promise<void> {
  const loader = new ConnectorLoader({ paths: ["desktop/main/dist/g/connectors-mcp"] });
  const { loaded, failed } = await loader.scan();
  for (const f of failed) console.error("[dist-check] load failed:", f.rootDir, f.error);
  const rt = new ConnectorRuntime({ cwd: process.cwd() });
  for (const c of loaded) rt.adopt(c);
  const sf = await rt.start();
  if (sf.length > 0) console.error("[dist-check] start failed:", sf.join(", "));
  const tools = rt.extraTools();
  console.log(
    `[dist-check] OK: ${loaded.length} connectors, ${tools.length} tools; start failed: ${sf.length}`,
  );
  const bu = tools
    .filter((t) => t.name.startsWith("browser_") || t.name.startsWith("retry_"))
    .map((t) => `${t.name}${t.isMutating ? "*" : ""}`);
  console.log(`[dist-check] browser-use tools (${bu.length}): ${bu.join(", ")}`);
  await rt.dispose();
}

void main();
