/**
 * ConnectorLoader：从本地目录扫描 connector 并把它们注入到 Runtime。
 *
 * 约定：
 * - 每个 connector 是一个独立目录，目录里必须有 connector.json（manifest）。
 * - 入口文件相对目录的路径默认 "index"（Loader 自动探测 .ts/.tsx/.js/.mjs 后缀）。
 * - manifest.id 与入口默认导出类的 instance.id 必须一致，否则加载失败。
 * - 入口默认导出必须是可 new 的类（无参构造），Loader 立即实例化。
 * - manifest.enabledBy 给出环境变量名时，该变量未取真值 → 计入 skipped 直接不加载
 *   （默认关闭的插件：判定在 Loader 一处收口，各入口不必各自维护黑名单）。
 *
 * Phase 1 范围：
 * - 仅扫描本地目录；不实现 npm install / 远程包（Phase 3 才做）。
 * - 不动 Runtime 状态：Loader 只产出 LoadedConnector[]，由调用方决定何时 adopt + start。
 *
 * 用法：
 * ```ts
 * const loader = new ConnectorLoader({ paths: ["./src/connector/connectors"] });
 * const { loaded, failed } = await loader.scan();
 * for (const c of loaded) runtime.adopt(c);
 * await runtime.start();
 * ```
 */

import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type {
  ConnectorClass,
  ConnectorManifest,
  LoadedConnector,
  LoaderOptions,
  LoaderResult,
  ToolCapability,
} from "../core/types.js";

const ENTRY_CANDIDATES = [".ts", ".tsx", ".js", ".mjs"] as const;
const MANIFEST_FILE = "connector.json";

export class ConnectorLoader {
  constructor(private readonly options: LoaderOptions) {}

  async scan(): Promise<LoaderResult> {
    const loaded: LoadedConnector[] = [];
    const failed: LoaderResult["failed"] = [];
    const skipped: LoaderResult["skipped"] = [];

    for (const dir of this.options.paths) {
      if (!existsSync(dir)) continue;
      const entries = await safeReaddir(dir);
      for (const name of entries) {
        const rootDir = path.resolve(dir, name);
        const manifestPath = path.join(rootDir, MANIFEST_FILE);
        if (!existsSync(manifestPath)) continue;
        try {
          const manifest = parseManifest(await readFile(manifestPath, "utf8"), manifestPath);
          if (this.options.only && !this.options.only.includes(manifest.id)) continue;
          // 显式启用门。判定放在实例化之前——入口模块可能有副作用（探测路径、
          // console.warn），被挡下的 connector 不该付出这份代价。
          const gate = manifest.enabledBy;
          if (gate !== undefined && !envEnabled(gate)) {
            skipped.push({ rootDir, manifest, reason: `默认关闭，需 ${gate}=1 启用` });
            continue;
          }
          loaded.push(await this.loadOne(rootDir, manifest));
        } catch (err) {
          failed.push({ rootDir, error: errToMessage(err) });
        }
      }
    }
    return { loaded, failed, skipped };
  }

  private async loadOne(rootDir: string, manifest: ConnectorManifest): Promise<LoadedConnector> {
    const entryRel = manifest.entry ?? "index";
    const entryAbs = resolveEntry(rootDir, entryRel);
    if (entryAbs === null) {
      throw new Error(
        `entry file not found for "${manifest.id}": tried ${entryRel}{${ENTRY_CANDIDATES.join(",")}}`,
      );
    }

    // 双端加载：同一份 loader 源码要跑在两种模块体制下——
    //  - CJS（Electron main 编译产物）：tsc 会把动态 import() 改写成 require()，
    //    而 require() 不认 file:// URL（报 Cannot find module 'file:///...'），
    //    必须走 createRequire + POSIX 绝对路径。
    //  - ESM（tsx / NodeNext 直跑 TS）：动态 import 必须用 file:// URL 且路径绝对。
    // typeof 探测避开 ESM 下的 ReferenceError（__filename/module 未定义）与
    // CJS emit 下的 import.meta 编译错误。
    const mod =
      typeof __filename === "string" && typeof module !== "undefined"
        ? (createRequire(__filename)(entryAbs) as { default?: unknown })
        : ((await import(pathToFileURL(entryAbs).href)) as { default?: unknown });
    if (typeof mod.default !== "function") {
      throw new Error(
        `connector "${manifest.id}" default export is not a class/function (got ${typeof mod.default})`,
      );
    }
    const Klass = mod.default as ConnectorClass;
    const instance = new Klass();
    if (typeof instance.id !== "string" || instance.id === "") {
      throw new Error(`connector "${manifest.id}" instance.id is missing`);
    }
    if (instance.id !== manifest.id) {
      throw new Error(
        `connector id mismatch: manifest says "${manifest.id}", instance says "${instance.id}"`,
      );
    }
    for (const m of ["start", "stop", "getTools", "execute"] as const) {
      if (typeof instance[m] !== "function") {
        throw new Error(`connector "${manifest.id}" missing method: ${m}`);
      }
    }
    validateCapabilities(manifest.capabilities, instance.getTools(), manifest.id);

    return {
      manifest,
      instance,
      state: "loaded",
      rootDir,
    };
  }
}

function parseManifest(raw: string, manifestPath: string): ConnectorManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid JSON in ${manifestPath}: ${errToMessage(err)}`);
  }
  if (!isObject(parsed)) throw new Error(`manifest must be an object: ${manifestPath}`);
  if (typeof parsed["id"] !== "string" || parsed["id"].length === 0) {
    throw new Error(`manifest.id missing or empty: ${manifestPath}`);
  }
  if (typeof parsed["version"] !== "string" || parsed["version"].length === 0) {
    throw new Error(`manifest.version missing or empty: ${manifestPath}`);
  }
  const type = parsed["type"];
  if (typeof type !== "string" || !isConnectorType(type)) {
    throw new Error(`manifest.type invalid: ${String(type)} (${manifestPath})`);
  }
  const caps = parsed["capabilities"];
  if (!Array.isArray(caps)) {
    throw new Error(`manifest.capabilities must be an array: ${manifestPath}`);
  }
  const capabilities = caps.map((c, i) => parseCapability(c, i, manifestPath));

  const permissionsRaw = parsed["permissions"];
  const permissions = Array.isArray(permissionsRaw)
    ? permissionsRaw.filter((p): p is string => typeof p === "string")
    : undefined;

  const description = typeof parsed["description"] === "string" ? parsed["description"] : undefined;
  const entry = typeof parsed["entry"] === "string" ? parsed["entry"] : undefined;
  const enabledByRaw = parsed["enabledBy"];
  if (enabledByRaw !== undefined && (typeof enabledByRaw !== "string" || enabledByRaw.length === 0)) {
    throw new Error(`manifest.enabledBy must be a non-empty string (env var name): ${manifestPath}`);
  }
  const enabledBy = typeof enabledByRaw === "string" ? enabledByRaw : undefined;

  return {
    id: parsed["id"],
    version: parsed["version"],
    type,
    description,
    permissions,
    capabilities,
    entry,
    enabledBy,
  };
}

/**
 * 环境变量真值判定（与 `C_AGENT_LOG` 的「非空即开」口径一致，额外认 0/false/no/off 为关）。
 * 只读 process.env：门是进程级开关，读 Runtime 快照反而会让「启动后再设」失效。
 */
function envEnabled(name: string): boolean {
  const raw = process.env[name];
  if (raw === undefined) return false;
  return !["", "0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

function parseCapability(raw: unknown, index: number, manifestPath: string): ToolCapability {
  if (!isObject(raw)) throw new Error(`capabilities[${index}] must be an object: ${manifestPath}`);
  const name = raw["name"];
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`capabilities[${index}].name missing: ${manifestPath}`);
  }
  const description = typeof raw["description"] === "string" ? raw["description"] : "";
  const mutating = typeof raw["mutating"] === "boolean" ? raw["mutating"] : undefined;
  const parameters = isObject(raw["parameters"])
    ? (raw["parameters"] as unknown as ToolCapability["parameters"])
    : undefined;
  return { name, description, mutating, parameters };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isConnectorType(t: string): t is ConnectorManifest["type"] {
  return t === "api" || t === "cli" || t === "python" || t === "gui" || t === "desktop";
}

/**
 * 检查 getTools() 暴露的 tool 是不是都登记在 manifest.capabilities 里。
 * 严格策略：tool 名 ⊇ capabilities 名 = 通过；tool 多出 warn（log 一行）但仍加载。
 * 缺登记 = throw（fail-fast，避免上线后才发现不一致）。
 */
function validateCapabilities(
  caps: ToolCapability[],
  tools: { name: string }[],
  connectorId: string,
): void {
  const capNames = new Set(caps.map((c) => c.name));
  const toolNames = new Set(tools.map((t) => t.name));
  const missing: string[] = [];
  for (const cn of capNames) {
    if (!toolNames.has(cn)) missing.push(cn);
  }
  if (missing.length > 0) {
    throw new Error(
      `connector "${connectorId}" capabilities declare but not implemented: ${missing.join(", ")}`,
    );
  }
  const extras = [...toolNames].filter((n) => !capNames.has(n));
  if (extras.length > 0) {
    // Phase 1：未登记的 tool 不阻塞加载，但记 console.warn 提示开发者补 manifest
    console.warn(`[connector:${connectorId}] tools not declared in manifest: ${extras.join(", ")}`);
  }
}

function resolveEntry(rootDir: string, entryRel: string): string | null {
  if (path.extname(entryRel) !== "") {
    const abs = path.resolve(rootDir, entryRel);
    return existsSync(abs) ? abs : null;
  }
  for (const ext of ENTRY_CANDIDATES) {
    const abs = path.resolve(rootDir, `${entryRel}${ext}`);
    if (existsSync(abs)) return abs;
  }
  return null;
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir, { withFileTypes: false });
  } catch {
    return [];
  }
}

function errToMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
