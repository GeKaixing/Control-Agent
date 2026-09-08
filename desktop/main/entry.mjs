/**
 * Electron 主进程 ESM 入口。
 *
 * 整个项目是 ESM (`"type":"module"`)，根 `package.json` 里没有 `"type": "commonjs"` 覆盖。
 * Electron 28+ 用 `process.resourcesPath` + `main` 字段定位入口，本文件命名成 `.mjs`
 * 让 Node 直接当 ESM 解析，免得和"项目默认 .js = ESM"打架。
 *
 * 主进程 TS 代码本身（`desktop/main/index.ts` 等）按 CommonJS emit（见 `tsconfig.main.json`）。
 * 这里**不能**用 `await import(CJS)` —— Electron 主进程里 `require('electron')`
 * 走的是 Electron 内嵌的特殊 loader，而 ESM 翻译层在加载 CJS 时会 "preparse exports"
 * （看 `node:internal/modules/esm/translators:379`），对 Electron 内嵌模块返回的对象
 * 这个 preparse 会炸 `Cannot read properties of undefined (reading 'exports')`。
 *
 * 用 `createRequire(import.meta.url)` 拿一份同步 require，绕过 ESM 的 preparse，
 * 让 Electron 主进程的内嵌 loader 直接被走到。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

/**
 * 定位 tsc emit 出来的主进程入口。
 *
 * `tsconfig.main.json` 的 rootDir 是仓库根（因为要一起编译 ../src），所以产物会
 * 深嵌一层「仓库所在目录名」：`dist/<仓库目录名>/desktop/main/index.js`。
 * 这个目录名是**环境的产物**（项目在 g/ 下就叫 g，搬到 c/ 下就叫 c），所以不能
 * 硬编码——以前写死 "g" 时，项目换目录后 Electron 一启动就 MODULE_NOT_FOUND。
 * 改成扫 dist/ 下各子目录找真正存在的入口，目录叫什么都能跑。
 */
function resolveDistMain() {
  const distRoot = path.join(__dirname, "dist");
  let entries;
  try {
    entries = fs.readdirSync(distRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(distRoot, entry.name, "desktop", "main", "index.js");
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const distMain = resolveDistMain();
if (distMain === null) {
  throw new Error(
    `找不到主进程产物：${path.join(__dirname, "dist", "<仓库目录名>", "desktop", "main", "index.js")}。` +
      `请先跑 npm run desktop:build:main`,
  );
}
const { start } = require(distMain);
if (typeof start !== "function") {
  throw new Error(`主进程入口 ${distMain} 没有导出 start()`);
}
start({ __dirname });
