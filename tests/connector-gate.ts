/**
 * ConnectorLoader 的 manifest.enabledBy 门（默认关闭的插件）用例。
 *
 * 这条门的存在理由是 browser-use：它起独立 Chromium 进程，与桌面端内部浏览器面板
 * 职责重叠，两套同时在场会让模型选错工具、并多弹一个外部浏览器窗口。判定收口在
 * Loader 一处（manifest 声明环境变量名），所以这里用临时 fixture 目录直接测 Loader，
 * 不依赖 connectors-mcp 里任何具体插件。
 *
 * 关键不变量：
 * - 未满足门 → 进 skipped（不是 failed），且**在实例化之前**就短路（entry 不执行）；
 * - 真值口径与 C_AGENT_LOG 同源：非空且不是 0/false/no/off；
 * - 没有 enabledBy 的 connector 完全不受影响；only 白名单先于门生效；
 * - enabledBy 不是非空字符串 → manifest 校验失败（fail-fast，别写个永远打不开的开关）。
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ConnectorLoader } from "../src/connector/loader/connector-loader.js";
import { assert, test } from "./registry.js";

const GATE_ENV = "C_AGENT_TEST_ENABLED_BY_GATE";

/** 正常 connector 入口：满足 Loader 的四方法契约 */
const normalEntry = (id: string): string => `export default class {
  readonly id = ${JSON.stringify(id)};
  async start() {}
  async stop() {}
  getTools() { return []; }
  async execute() { return { content: [], isError: false }; }
}
`;

/** 一被实例化就炸的入口：用来证明门在 import/实例化之前短路 */
const boomEntry = 'throw new Error("entry 在门未满足时不应被执行");\n';

interface Fixture {
  /** 目录名 = connector id */
  id: string;
  /** 直接写进 connector.json 的原始值；undefined = 不写这个字段 */
  enabledBy?: unknown;
  entry?: string;
}

async function fixtureRoot(specs: readonly Fixture[]): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "connector-gate-"));
  for (const spec of specs) {
    const dir = path.join(root, spec.id);
    await fs.mkdir(dir, { recursive: true });
    const manifest: Record<string, unknown> = {
      id: spec.id,
      version: "0.0.1",
      type: "cli",
      capabilities: [],
      entry: "index",
    };
    if (spec.enabledBy !== undefined) manifest["enabledBy"] = spec.enabledBy;
    await fs.writeFile(path.join(dir, "connector.json"), JSON.stringify(manifest, null, 2));
    await fs.writeFile(path.join(dir, "index.ts"), spec.entry ?? normalEntry(spec.id));
  }
  return root;
}

test("connector 门: 未设 enabledBy 环境变量 → 进 skipped，且 entry 不被执行", async () => {
  const root = await fixtureRoot([
    { id: "gated", enabledBy: GATE_ENV, entry: boomEntry },
    { id: "plain" },
  ]);
  delete process.env[GATE_ENV];
  try {
    const { loaded, failed, skipped } = await new ConnectorLoader({ paths: [root] }).scan();
    assert.deepEqual(loaded.map((c) => c.manifest.id), ["plain"], "无门的 connector 照常加载");
    assert.deepEqual(skipped.map((s) => s.manifest.id), ["gated"]);
    assert.match(skipped[0]?.reason ?? "", /C_AGENT_TEST_ENABLED_BY_GATE/);
    assert.equal(failed.length, 0, "被门挡下不是加载失败");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("connector 门: 真值口径（1/true/yes 开；0/false/no/off/空 关）", async () => {
  const root = await fixtureRoot([{ id: "gated", enabledBy: GATE_ENV }]);
  const loader = new ConnectorLoader({ paths: [root] });
  const cases: Array<[string, boolean]> = [
    ["1", true],
    ["true", true],
    ["TRUE", true],
    [" yes ", true],
    ["0", false],
    ["false", false],
    ["no", false],
    ["off", false],
    ["", false],
  ];
  try {
    for (const [value, expectEnabled] of cases) {
      process.env[GATE_ENV] = value;
      const { loaded, skipped } = await loader.scan();
      assert.equal(
        loaded.length === 1,
        expectEnabled,
        `BROWSER 门取值 ${JSON.stringify(value)} 应${expectEnabled ? "启用" : "跳过"}`,
      );
      assert.equal(skipped.length === 1, !expectEnabled);
    }
  } finally {
    delete process.env[GATE_ENV];
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("connector 门: only 白名单先于门生效（被白名单排除的不进 skipped）", async () => {
  const root = await fixtureRoot([
    { id: "gated", enabledBy: GATE_ENV, entry: boomEntry },
    { id: "plain" },
  ]);
  delete process.env[GATE_ENV];
  try {
    const { loaded, skipped } = await new ConnectorLoader({ paths: [root], only: ["plain"] }).scan();
    assert.deepEqual(loaded.map((c) => c.manifest.id), ["plain"]);
    assert.deepEqual(skipped, [], "压根没进白名单的 connector 不该报成「被门跳过」");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("connector 门: enabledBy 不是非空字符串 → manifest 校验失败", async () => {
  const root = await fixtureRoot([
    { id: "bad-number", enabledBy: 123, entry: boomEntry },
    { id: "bad-empty", enabledBy: "", entry: boomEntry },
  ]);
  try {
    const { loaded, failed } = await new ConnectorLoader({ paths: [root] }).scan();
    assert.deepEqual(loaded, []);
    assert.equal(failed.length, 2, "两个非法 enabledBy 都应报加载失败");
    assert.match(failed[0]?.error ?? "", /enabledBy/);
    assert.match(failed[1]?.error ?? "", /enabledBy/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
