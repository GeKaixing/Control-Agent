/**
 * Connector Runtime 演示入口。
 *
 * 跑法：`tsx src/connector/demo.ts [--connectors <dir>...]`
 *
 * 流程：
 *   1. 解析 CLI 参数（默认扫描 src/connector/connectors）
 *   2. ConnectorLoader.scan() 加载所有 manifest + index.ts
 *   3. ConnectorRuntime.adopt + start
 *   4. 启动 McpServer.serve()（阻塞读 stdin，按行返回 JSON-RPC 响应）
 *
 * 退出：stdin EOF（Ctrl-D） 或 SIGINT。
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { ConnectorLoader } from "./loader/connector-loader.js";
import { McpServer } from "./protocol/mcp-server.js";
import { ConnectorRuntime } from "./runtime/connector-runtime.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultConnectorsDir = path.resolve(here, "connectors");

interface CliArgs {
  connectorsPaths: string[];
  verbose: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const paths: string[] = [];
  let verbose = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--connectors" && i + 1 < argv.length) {
      paths.push(argv[++i]);
    } else if (a === "-v" || a === "--verbose") {
      verbose = true;
    } else if (a === "-h" || a === "--help") {
      printUsage();
      process.exit(0);
    } else {
      process.stderr.write(`unknown arg: ${a}\n`);
      printUsage();
      process.exit(2);
    }
  }
  if (paths.length === 0) paths.push(defaultConnectorsDir);
  return { connectorsPaths: paths, verbose };
}

function printUsage(): void {
  process.stderr.write(
    `usage: connector-demo [--connectors <dir>]... [--verbose]\n` +
      `  默认扫描 ${defaultConnectorsDir}\n`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  process.stderr.write(`[demo] scanning: ${args.connectorsPaths.join(", ")}\n`);

  const runtime = new ConnectorRuntime({
    cwd: process.cwd(),
    env: process.env as Record<string, string | undefined>,
    onLog: args.verbose
      ? (e) => process.stderr.write(`[${e.level}] ${e.connectorId}: ${e.message}\n`)
      : () => {},
  });

  const loader = new ConnectorLoader({ paths: args.connectorsPaths });
  const { loaded, failed } = await loader.scan();
  for (const f of failed) {
    process.stderr.write(`[demo] load failed: ${f.rootDir} -> ${f.error}\n`);
  }
  if (loaded.length === 0) {
    process.stderr.write("[demo] no connectors loaded, exit\n");
    process.exit(1);
  }
  for (const c of loaded) runtime.adopt(c);

  const startFailed = await runtime.start();
  if (startFailed.length > 0) {
    process.stderr.write(`[demo] start failed: ${startFailed.join(", ")}\n`);
  }
  process.stderr.write(
    `[demo] ready: ${runtime.registry.size()} connectors, ${runtime.extraTools().length} tools\n` +
      `  tools: ${runtime.registry.toolNames().join(", ")}\n`,
  );

  const server = new McpServer({ runtime });
  process.on("SIGINT", () => {
    process.stderr.write("\n[demo] SIGINT, shutting down\n");
    server.stop();
  });
  await server.serve();
  await runtime.dispose();
  process.stderr.write("[demo] bye\n");
}

main().catch((err) => {
  process.stderr.write(`[demo] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
