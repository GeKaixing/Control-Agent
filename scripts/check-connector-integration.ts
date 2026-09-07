import path from "node:path";
import { ConnectorLoader } from "../src/connector/loader/connector-loader.js";
import { ConnectorRuntime } from "../src/connector/runtime/connector-runtime.js";
import { assembleSession } from "../src/session.js";

const runtime = new ConnectorRuntime({ cwd: process.cwd() });
const loader = new ConnectorLoader({ paths: [path.resolve("./src/connector/connectors")] });
const { loaded, failed } = await loader.scan();
for (const f of failed) console.error(`load failed: ${f.rootDir} -> ${f.error}`);
for (const c of loaded) runtime.adopt(c);
const startFailed = await runtime.start();
for (const id of startFailed) console.error(`start failed: ${id}`);

const r = await assembleSession({
  cwd: process.cwd(),
  modelSpec: "mock",
  extraTools: runtime.extraTools(),
});

console.log("=== tool names ===");
console.log(r.state.tools.map((t) => t.name).join("\n"));
console.log("\n=== system prompt (last 20 lines) ===");
const lines = r.state.systemPrompt.split("\n");
console.log(lines.slice(-20).join("\n"));

await runtime.dispose();