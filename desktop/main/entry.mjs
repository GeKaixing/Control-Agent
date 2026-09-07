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

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

// tsc emit 因为 rootDir 是仓库根，路径会深嵌 `<repo>/g/desktop/main/index.js`
const distMain = path.join(
  __dirname,
  "dist",
  "g",
  "desktop",
  "main",
  "index.js",
);
const { start } = require(distMain);
if (typeof start !== "function") {
  throw new Error(`主进程入口 ${distMain} 没有导出 start()`);
}
start({ __dirname });
