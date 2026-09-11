/**
 * 三通道（手机 / 电脑 / 浏览器）扩展的工具层测试：
 * - 手机：uiautomator XML 解析、bounds、adb 设备列表、shell 命令构造（含转义）
 * - 电脑：UIA JSON 解析与树格式化
 * - 浏览器：browser_input drag、browser_cookie、browser_file 走 fake 后端全链路
 *
 * 纯函数直接单测；有后端依赖的走 makeFakeBackend 同款注入模式。
 */

import assert from "node:assert/strict";
import { promises as fs, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ADB_ENTRY_TABLE,
  buildShellCommand,
  formatUiaNodes,
  mergeAdbScans,
  mobileActTool,
  mobileScreenTool,
  mobileUiTool,
  parseAdbList,
  parseBounds,
  parseUiaDump,
  resolveAdbEntries,
  type AdbEntry,
} from "../src/tools/mobile.js";
import { formatUiaTree, parseUiaJson } from "../src/tools/uia.js";
import { parseProcedures, upsertProcedure, formatProcedureIndex, procedureTool } from "../src/tools/procedure.js";
import { migrateDataDir, DATA_DIR, LEGACY_DATA_DIR } from "../src/paths.js";
import { phonePanelTool, setPhonePanelBackend, type PhonePanelBackend } from "../src/tools/index.js";
import {
  browserCookieTool,
  browserFileTool,
  browserInputTool,
  setBrowserBackend,
  type BrowserBackend,
} from "../src/tools/index.js";
import { test } from "./registry.js";

const noSignal = (): AbortSignal => new AbortController().signal;
const ctx = { cwd: ".", signal: noSignal() };

function resultText(content: { type: string; text?: string }[]): string {
  return content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
}

/** BrowserBackend 的全默认 fake（与 tests/run.ts 同款；新方法给默认实现） */
function makeFakeBackend(overrides: Partial<BrowserBackend> = {}): BrowserBackend {
  return {
    async open() {},
    async navigate() {},
    async read() {
      return { url: "", title: "", text: "" };
    },
    async screenshot() {
      return { dataUrl: "data:image/jpeg;base64,AA", width: 1, height: 1 };
    },
    async evaluate() {
      return "";
    },
    async dispatchInput() {},
    async networkStart() {},
    async networkStop() {},
    async networkList() {
      return [];
    },
    async networkBody() {
      return { mimeType: "application/json", body: "{}", binary: false };
    },
    async tabsList() {
      return [];
    },
    async tabsNew() {
      return "tab_fake";
    },
    async tabsSwitch() {},
    async tabsClose() {},
    async wait() {
      return "页面加载完成";
    },
    async networkIntercept() {},
    async cookiesList() {
      return [];
    },
    async cookieSet() {},
    async cookieDelete() {},
    async upload() {},
    async downloadsList() {
      return [];
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------- mobile: 解析

test("mobile: parseBounds 解析 [x1,y1][x2,y2]", () => {
  assert.deepEqual(parseBounds("[40,900][320,980]"), { x: 40, y: 900, w: 280, h: 80 });
  assert.deepEqual(parseBounds("[0,0][1080,2400]"), { x: 0, y: 0, w: 1080, h: 2400 });
  assert.equal(parseBounds("garbage"), null);
  assert.equal(parseBounds(""), null);
});

test("mobile: parseUiaDump 解析层级与属性，self-close 与嵌套栈正确", () => {
  const xml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>',
    '<hierarchy rotation="0">',
    '  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.x" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,2400]">',
    '    <node index="0" text="登录" resource-id="com.x:id/login" class="android.widget.Button" package="com.x" content-desc="进入应用" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[40,900][320,980]"/>',
    '    <node index="1" text="" resource-id="" class="android.widget.EditText" package="com.x" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[40,300][1040,380]">',
    '      <node index="0" text="用户名" resource-id="" class="android.widget.TextView" package="com.x" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[52,320][1028,360]"/>',
    '    </node>',
    '  </node>',
    '</hierarchy>',
  ].join("\n");
  const nodes = parseUiaDump(xml);
  assert.equal(nodes.length, 4);
  const root = nodes[0]!;
  assert.equal(root.cls, "android.widget.FrameLayout");
  assert.equal(root.depth, 0);
  const login = nodes[1]!;
  assert.equal(login.text, "登录");
  assert.equal(login.desc, "进入应用");
  assert.equal(login.resId, "com.x:id/login");
  assert.equal(login.clickable, true);
  assert.equal(login.cx, 180);
  assert.equal(login.cy, 940);
  assert.equal(login.depth, 1);
  const editText = nodes[2]!;
  assert.equal(editText.depth, 1);
  const label = nodes[3]!;
  assert.equal(label.depth, 2, "嵌套 node 的深度由开闭标签栈推出");

  const formatted = formatUiaNodes(nodes);
  assert.match(formatted, /#1 Button text="登录" desc="进入应用" id=com\.x:id\/login 可点击/);
  assert.match(formatted, /中心=\(180,940\)/);
});

test("mobile: parseAdbList 认 serial+state 行，过滤 daemon 告警与表头", () => {
  const out = parseAdbList(
    [
      "List of devices attached",
      "* daemon not running; starting now at tcp:5037",
      "emulator-5554\tdevice",
      "1A2B3C\tunauthorized",
      "",
    ].join("\n"),
  );
  assert.deepEqual(out, [
    { serial: "emulator-5554", state: "device" },
    { serial: "1A2B3C", state: "unauthorized" },
  ]);
});

// ---------------------------------------------------------------- mobile: 命令构造

test("mobile: buildShellCommand 构造与转义", () => {
  assert.equal(buildShellCommand("tap", { x: 100.4, y: 200.6 }), "input tap 100 201");
  assert.equal(buildShellCommand("swipe", { x: 1, y: 2, x2: 3, y2: 4, durationMs: 500 }), "input swipe 1 2 3 4 500");
  // 空格转 %s，单引号转义
  assert.equal(buildShellCommand("text", { content: "hello world" }), "input text 'hello%sworld'");
  assert.equal(buildShellCommand("text", { content: "it's" }), "input text 'it'\\''s'");
  assert.equal(buildShellCommand("key", { key: "back" }), "input keyevent 4");
  assert.equal(buildShellCommand("key", { key: "66" }), "input keyevent 66");
  assert.equal(buildShellCommand("start", { target: "com.x/.MainActivity" }), "am start -n 'com.x/.MainActivity'");
  assert.equal(
    buildShellCommand("start", { target: "com.example.app" }),
    "monkey -p 'com.example.app' -c android.intent.category.LAUNCHER 1",
  );
  assert.equal(buildShellCommand("nope", {}), "");
});

// ---------------------------------------------------------------- mobile: 工具参数校验

test("mobile_act: 未知 action / 缺参数 fail 且不触达 adb", async () => {
  const bad = await mobileActTool.execute({ action: "fly" }, ctx);
  assert.equal(bad.isError, true);
  assert.match(resultText(bad.content), /不认识 action/);
  const noContent = await mobileActTool.execute({ action: "text" }, ctx);
  assert.equal(noContent.isError, true);
  assert.match(resultText(noContent.content), /content/);
  const noTarget = await mobileActTool.execute({ action: "start" }, ctx);
  assert.equal(noTarget.isError, true);
  const badKey = await mobileActTool.execute({ action: "key", key: "warp" }, ctx);
  assert.equal(badKey.isError, true);
  assert.match(resultText(badKey.content), /不认识的键名/);
});

test("mobile_screen / mobile_ui: adb 不可用时优雅失败", async () => {
  // 测试环境一般没有 adb；就算有，输出也不会是合法截图/控件树，
  // 所以两种结果都可接受——只验证不抛异常、返回结构化结果
  const shot = await mobileScreenTool.execute({}, ctx);
  assert.equal(typeof shot.isError, "boolean");
  const ui = await mobileUiTool.execute({}, ctx);
  assert.equal(typeof ui.isError, "boolean");
});

// ---------------------------------------------------------------- mobile: adb 多入口

test("mobile: ADB_ENTRY_TABLE 内置四家模拟器入口，路径与端口齐全", () => {
  for (const key of ["mumu", "ld", "nox", "bluestacks"]) {
    const spec = ADB_ENTRY_TABLE[key]!;
    assert.ok(spec.bins.length > 0, `${key} 应有 adb 路径候选`);
    assert.ok(spec.ports.length > 0, `${key} 应有典型 connect 端口`);
    assert.ok(spec.bins.every((b) => /adb/i.test(b)), `${key} 的候选都应是 adb 可执行文件`);
  }
});

test("mobile: resolveAdbEntries 别名 / 路径 / 非法值三分支", () => {
  // sdk 别名：单入口，bin 走 env 覆盖或 PATH
  const sdk = resolveAdbEntries("sdk");
  assert.ok(Array.isArray(sdk) && sdk.length === 1 && sdk[0]!.name === "sdk");

  // 中文别名与英文别名映射到同一入口（未安装该模拟器时都是同型错误）
  const cn = resolveAdbEntries("雷电");
  const en = resolveAdbEntries("ld");
  assert.equal(typeof cn, typeof en);
  assert.match(cn as string, /雷电|未找到|可传 adb\.exe/);

  // 未知别名 → 错误说明（含支持的别名列表）
  const bad = resolveAdbEntries("夜神模拟器plus");
  assert.equal(typeof bad, "string");
  assert.match(bad as string, /不认识的 adb 入口/);

  // 路径不存在 → 错误说明
  const missing = resolveAdbEntries("C:/no/such/dir/adb.exe");
  assert.equal(typeof missing, "string");
  assert.match(missing as string, /路径不存在/);
});

test("mobile: resolveAdbEntries 存在的路径 → custom 入口；缺省探测含 sdk", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "c-agent-adb-"));
  const fakeBin = path.join(dir, "myadb.exe");
  await fs.writeFile(fakeBin, "");
  try {
    const custom = resolveAdbEntries(fakeBin);
    assert.ok(Array.isArray(custom) && custom.length === 1);
    assert.equal(custom[0]!.name, "custom");
    assert.equal(custom[0]!.bin, fakeBin);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
  // 缺省：sdk 恒在末位兜底（带典型 connect 端口，覆盖非标准安装位置）；
  // 模拟器入口按机器实际情况排在前面（先到先得，命令原路走模拟器自带 adb）
  const def = resolveAdbEntries("");
  assert.ok(Array.isArray(def) && def.length >= 1);
  const last = def[def.length - 1]!;
  assert.equal(last.name, "sdk");
  assert.ok(last.ports.length > 0, "sdk 兜底应带典型 connect 端口");
});

test("mobile: mergeAdbScans 多入口去重，同 serial 优先保留 device 状态", () => {
  const sdk: AdbEntry = { name: "sdk", bin: "adb", ports: [] };
  const mumu: AdbEntry = { name: "mumu", bin: "C:/m/adb.exe", ports: [7555] };
  const merged = mergeAdbScans([
    { entry: sdk, devices: [{ serial: "1A2B", state: "unauthorized" }] },
    { entry: mumu, devices: [{ serial: "1A2B", state: "device" }, { serial: "127.0.0.1:7555", state: "device" }] },
    { entry: { name: "ld", bin: "C:/l/adb.exe", ports: [5555] }, devices: [] },
  ]);
  assert.equal(merged.length, 2);
  // 同 serial：后到的 device 状态覆盖先到的 unauthorized
  const first = merged.find((d) => d.serial === "1A2B")!;
  assert.equal(first.state, "device");
  assert.equal(first.entry.name, "mumu");
  assert.equal(merged[1]!.entry.name, "mumu");
});

test("mobile: adb 参数非法别名 → fail 且不触达任何 adb", async () => {
  const res = await mobileScreenTool.execute({ adb: "不存在的东西" }, ctx);
  assert.equal(res.isError, true);
  assert.match(resultText(res.content), /adb 入口无效/);
});

// ---------------------------------------------------------------- phone_panel

test("phone_panel: open/close/status 走注入后端；未注入优雅 fail", async () => {
  // 未注入（CLI / print 端）
  const noBackend = await phonePanelTool.execute({ action: "open" }, ctx);
  assert.equal(noBackend.isError, true);
  assert.match(resultText(noBackend.content), /仅在桌面端可用/);
  assert.match(resultText(noBackend.content), /mobile_/);

  const log: string[] = [];
  let state = { open: false, connected: false, device: null as string | null };
  const fake: PhonePanelBackend = {
    async open() {
      log.push("open");
      state = { open: true, connected: true, device: "127.0.0.1:16384" };
    },
    async close() {
      log.push("close");
      state = { open: false, connected: false, device: null };
    },
    async status() {
      return state;
    },
  };
  setPhonePanelBackend(fake);
  try {
    const opened = await phonePanelTool.execute({ action: "open" }, ctx);
    assert.equal(opened.isError, false);
    assert.match(resultText(opened.content), /已连接设备 127\.0\.0\.1:16384/);

    const st = await phonePanelTool.execute({ action: "status" }, ctx);
    assert.match(resultText(st.content), /面板打开中，已连接设备/);

    const closed = await phonePanelTool.execute({ action: "close" }, ctx);
    assert.equal(closed.isError, false);
    assert.deepEqual(log, ["open", "close"]);
  } finally {
    setPhonePanelBackend(null);
  }

  // 未知 action
  setPhonePanelBackend(fake);
  try {
    const bad = await phonePanelTool.execute({ action: "fly" }, ctx);
    assert.equal(bad.isError, true);
    assert.match(resultText(bad.content), /不认识 action/);
  } finally {
    setPhonePanelBackend(null);
  }
});

// ---------------------------------------------------------------- uia: 解析

test("uia: parseUiaJson 取杂散输出里的 JSON；坏输出返回 null", () => {
  const good = parseUiaJson('some noise\n{"ok":true,"mode":"index","windows":[{"name":"记事本","type":"window","rect":{"x":0,"y":0,"w":800,"h":600}}]}');
  assert.equal(good?.ok, true);
  assert.equal(good?.windows?.[0]?.name, "记事本");
  assert.equal(parseUiaJson("not json at all"), null);
  assert.equal(parseUiaJson("{broken"), null);
});

test("uia: formatUiaTree 索引模式与树模式", () => {
  const indexText = formatUiaTree({
    ok: true,
    mode: "index",
    windows: [{ name: "记事本", type: "window", rect: { x: 10, y: 20, w: 800, h: 600 }, pid: 1234 }],
  });
  assert.match(indexText, /#0 "记事本" \(10,20 800x600\) pid=1234/);
  assert.match(indexText, /title 再调 uia_tree/);

  const treeText = formatUiaTree({
    ok: true,
    mode: "tree",
    window: "计算器",
    nodes: [
      { name: "", type: "Window", rect: { x: 0, y: 0, w: 300, h: 500 }, enabled: true, depth: 0 },
      { name: "等于", type: "Button", rect: { x: 200, y: 400, w: 80, h: 60 }, enabled: true, depth: 2 },
      { name: "", type: "Button", rect: null, enabled: false, depth: 2 },
    ],
  });
  assert.match(treeText, /窗口「计算器」/);
  assert.match(treeText, /#1 Button "等于" \(200,400 80x60\) 中心=\(240,430\)/);
  assert.match(treeText, /\[禁用\]/);
  // 无 rect 的节点不出现中心坐标
  assert.ok(!/#2/.test(treeText.replace("#2 [禁用]", "")) || !/中心=/.test(treeText.split("#2")[1] ?? ""));

  const empty = formatUiaTree({ ok: true, mode: "tree", nodes: [] });
  assert.match(empty, /screenshot \+ computer/);
});

// ---------------------------------------------------------------- browser: drag

test("browser_input: drag 透传 x/y/x2/y2；缺终点 fail", async () => {
  const received: unknown[] = [];
  setBrowserBackend(makeFakeBackend({
    async dispatchInput(spec) {
      received.push(spec);
    },
  }));
  try {
    const missing = await browserInputTool.execute({ action: "drag", x: 1, y: 2 }, ctx);
    assert.equal(missing.isError, true);
    assert.match(resultText(missing.content), /x2\/y2/);

    const good = await browserInputTool.execute({ action: "drag", x: 10, y: 20, x2: 100, y2: 200 }, ctx);
    assert.equal(good.isError, false);
    assert.deepEqual(received[0], { action: "drag", x: 10, y: 20, x2: 100, y2: 200, text: undefined, key: undefined, dx: undefined, dy: undefined, delayMs: undefined, modifiers: undefined });
  } finally {
    setBrowserBackend(null);
  }
});

// ---------------------------------------------------------------- browser: cookie

test("browser_cookie: list 展示；set 缺 url/domain 拒绝；delete 透传", async () => {
  const log: string[] = [];
  setBrowserBackend(makeFakeBackend({
    async cookiesList() {
      return [
        { name: "session", value: "abc123", domain: ".example.com", path: "/", expires: -1, httpOnly: true, secure: false },
      ];
    },
    async cookieSet(spec) {
      log.push(`set:${spec.name}=${spec.value}@${spec.domain ?? spec.url}`);
    },
    async cookieDelete(name, domain) {
      log.push(`delete:${name}@${domain ?? ""}`);
    },
  }));
  try {
    const list = await browserCookieTool.execute({ mode: "list" }, ctx);
    assert.equal(list.isError, false);
    const listText = resultText(list.content);
    assert.match(listText, /session=abc123/);
    assert.match(listText, /httpOnly/);
    assert.match(listText, /会话/);

    const noTarget = await browserCookieTool.execute({ mode: "set", name: "a", value: "b" }, ctx);
    assert.equal(noTarget.isError, true);
    assert.match(resultText(noTarget.content), /url 或 domain/);

    const okSet = await browserCookieTool.execute({ mode: "set", name: "token", value: "t1", domain: ".example.com" }, ctx);
    assert.equal(okSet.isError, false);
    const okDel = await browserCookieTool.execute({ mode: "delete", name: "token", domain: ".example.com" }, ctx);
    assert.equal(okDel.isError, false);
    assert.deepEqual(log, ["set:token=t1@.example.com", "delete:token@.example.com"]);

    const noName = await browserCookieTool.execute({ mode: "delete" }, ctx);
    assert.equal(noName.isError, true);
  } finally {
    setBrowserBackend(null);
  }
});

// ---------------------------------------------------------------- browser: file

test("browser_file: upload 校验参数并透传；downloads 空与有记录", async () => {
  const log: string[] = [];
  setBrowserBackend(makeFakeBackend({
    async upload(selector, filePaths) {
      log.push(`upload:${selector}:${filePaths.join("|")}`);
    },
    async downloadsList() {
      return [
        { url: "https://a.com/x.csv", filename: "x.csv", savePath: "C:/Downloads/x.csv", receivedBytes: 100, totalBytes: 100, state: "completed" },
      ];
    },
  }));
  try {
    const noSel = await browserFileTool.execute({ action: "upload", paths: ["C:/a.png"] }, ctx);
    assert.equal(noSel.isError, true);
    const noPath = await browserFileTool.execute({ action: "upload", selector: "input[type=file]" }, ctx);
    assert.equal(noPath.isError, true);

    const okUp = await browserFileTool.execute({ action: "upload", selector: "input[type=file]", paths: ["C:/a.png"] }, ctx);
    assert.equal(okUp.isError, false);
    assert.match(resultText(okUp.content), /提交/);
    assert.deepEqual(log, ["upload:input[type=file]:C:/a.png"]);

    // 空记录
    setBrowserBackend(makeFakeBackend());
    const empty = await browserFileTool.execute({ action: "downloads" }, ctx);
    assert.match(resultText(empty.content), /还没有下载记录/);

    // 有记录：状态、大小与落盘路径都要展示
    setBrowserBackend(makeFakeBackend({
      async downloadsList() {
        return [
          { url: "https://a.com/x.csv", filename: "x.csv", savePath: "C:/Downloads/x.csv", receivedBytes: 100, totalBytes: 100, state: "completed" },
        ];
      },
    }));
    const listed = await browserFileTool.execute({ action: "downloads" }, ctx);
    assert.match(resultText(listed.content), /\[completed\] x\.csv/);
    assert.match(resultText(listed.content), /C:\/Downloads\/x\.csv/);
  } finally {
    setBrowserBackend(null);
  }
});

// ---------------------------------------------------------------- paths: 数据目录迁移

test("paths: migrateDataDir 旧 .c-agent 一次性改名，新目录已存在时 no-op", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "c-agent-migrate-"));
  try {
    // 旧目录存在 → 整目录改名，内部结构原样保留
    const inner = path.join(dir, LEGACY_DATA_DIR, "sessions");
    mkdirSync(inner, { recursive: true });
    writeFileSync(path.join(inner, "s1.json"), "{}", "utf8");
    migrateDataDir(dir);
    assert.ok(existsSync(path.join(dir, DATA_DIR, "sessions", "s1.json")));
    assert.ok(!existsSync(path.join(dir, LEGACY_DATA_DIR)));

    // 新目录已存在 → no-op（旧目录即使还在也不动，避免覆盖新数据）
    mkdirSync(path.join(dir, LEGACY_DATA_DIR), { recursive: true });
    writeFileSync(path.join(dir, DATA_DIR, "marker"), "new", "utf8");
    migrateDataDir(dir);
    assert.equal(readFileSync(path.join(dir, DATA_DIR, "marker"), "utf8"), "new");
    assert.ok(existsSync(path.join(dir, LEGACY_DATA_DIR)));

    // 两者都不存在 → 静默 no-op 不抛
    const empty = path.join(dir, "empty");
    mkdirSync(empty);
    migrateDataDir(empty);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- procedure: 程序性记忆

test("procedure: upsert 同 app+平台覆盖更新，其余条目原序保留", () => {
  const first = upsertProcedure("", "微信", "desktop", "1. 点左下角三条杠\n2. 点设置", "改设置的路径", "微信 3.9.12；窗口 1200x800", "2026-09-11 16:50");
  assert.match(first, /## 微信 @desktop/);
  assert.match(first, /- 更新: 2026-09-11 16:50/);
  assert.match(first, /- 摘要: 改设置的路径/);
  // 模型补充的环境 + 系统自动盖章都要在条目里
  assert.match(first, /- 环境: 微信 3\.9\.12；窗口 1200x800；系统: /);
  assert.match(first, /(Windows|macOS|Linux) \S+ (x64|arm64|ia32)/);

  // 同 key 再存：不追加新条目，整条替换（更新时间与步骤都换新）
  const second = upsertProcedure(first, "微信", "desktop", "1. 新版步骤", "新版摘要", "", "2026-09-12 09:00");
  assert.equal(parseProcedures(second).length, 1);
  assert.match(second, /新版步骤/);
  assert.doesNotMatch(second, /点左下角三条杠/);
  // env 缺省也有系统盖章兜底
  assert.match(second, /- 环境: (Windows|macOS|Linux) \S+ (x64|arm64|ia32)/);

  // 不同 app / 不同平台：并存
  const third = upsertProcedure(second, "微信", "mobile", "1. 我-设置", "", "", "2026-09-12 09:01");
  const fourth = upsertProcedure(third, "抖音", "mobile", "1. 长按视频", "", "", "2026-09-12 09:02");
  const all = parseProcedures(fourth);
  assert.equal(all.length, 3);
  assert.deepEqual(all.map((e) => `${e.app}@${e.platform}`), ["微信@desktop", "微信@mobile", "抖音@mobile"]);
});

test("procedure: parseProcedures 提取摘要/环境（摘要行优先，否则步骤首行去序号）与索引格式", () => {
  const raw = [
    "## 微信 @desktop",
    "- 更新: 2026-09-11 16:50",
    "- 环境: 微信 3.9.12；窗口 1200x800；系统: Windows 10.0.22631 x64",
    "- 摘要: 改设置的路径",
    "1. 点左下角三条杠",
    "2. 点设置",
    "",
    "## 抖音 @mobile",
    "- 更新: 2026-09-11 17:00",
    "- 环境: MuMu 实例1 900x1600",
    "1. 长按视频出现不感兴趣",
  ].join("\n");
  const entries = parseProcedures(raw);
  assert.equal(entries.length, 2);
  assert.equal(entries[0]!.summary, "改设置的路径");
  assert.equal(entries[0]!.updatedAt, "2026-09-11 16:50");
  assert.equal(entries[0]!.env, "微信 3.9.12；窗口 1200x800；系统: Windows 10.0.22631 x64");
  // 无摘要行 → 步骤首行去序号兜底
  assert.equal(entries[1]!.summary, "长按视频出现不感兴趣");
  assert.equal(entries[1]!.env, "MuMu 实例1 900x1600");

  const index = formatProcedureIndex(raw);
  assert.match(index, /操作记忆/);
  assert.match(index, /核对条目的环境/);
  assert.match(index, /- 微信 @desktop：改设置的路径〔微信 3\.9\.12；窗口 1200x800；系统: Windows 10\.0\.22631 x64〕/);
  assert.match(index, /- 抖音 @mobile：长按视频出现不感兴趣〔MuMu 实例1 900x1600〕/);
  assert.equal(formatProcedureIndex(""), "");
});

test("procedure 工具: save → search → forget 全链路（隔离存储文件）", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "c-agent-proc-"));
  const file = path.join(dir, "procedures.md");
  const prev = process.env["C_AGENT_PROCEDURES"];
  process.env["C_AGENT_PROCEDURES"] = file;
  try {
    // 空库 list
    const empty = await procedureTool.execute({ action: "list" }, ctx);
    assert.match(resultText(empty.content), /还没有任何操作记忆/);

    // save：非法 platform / 空 steps 都 fail
    const badPlat = await procedureTool.execute({ action: "save", app: "微信", platform: "watch", steps: "x" }, ctx);
    assert.equal(badPlat.isError, true);
    const noSteps = await procedureTool.execute({ action: "save", app: "微信", platform: "desktop" }, ctx);
    assert.equal(noSteps.isError, true);

    const saved = await procedureTool.execute({ action: "save", app: "微信", platform: "desktop", title: "改设置", env: "微信 3.9.12；窗口 1200x800", steps: "1. 点三条杠\n2. 点设置" }, ctx);
    assert.equal(saved.isError, false);
    assert.match(resultText(saved.content), /已保存/);
    assert.match(resultText(saved.content), /环境：微信 3\.9\.12；窗口 1200x800；系统: /);

    // 再存同 key → 更新语义
    const updated = await procedureTool.execute({ action: "save", app: "微信", platform: "desktop", steps: "1. 新路径" }, ctx);
    assert.match(resultText(updated.content), /已更新/);

    // search 命中 / 不命中（注意：第二次 save 已整条覆盖旧步骤，旧关键字「设置」不再存在）
    const stale = await procedureTool.execute({ action: "search", query: "三条杠" }, ctx);
    assert.match(resultText(stale.content), /还没操作过/);
    const hit = await procedureTool.execute({ action: "search", query: "新路径" }, ctx);
    assert.match(resultText(hit.content), /新路径/);
    // search 结果带环境行（env 缺省时也有系统盖章兜底），模型据此核对环境是否一致
    assert.match(resultText(hit.content), /- 环境: .*(Windows|macOS|Linux)/);
    const miss = await procedureTool.execute({ action: "search", query: "photoshop图层蒙版" }, ctx);
    assert.match(resultText(miss.content), /还没操作过/);

    // forget 指定平台；未命中时如实报告
    const forgotten = await procedureTool.execute({ action: "forget", app: "微信", platform: "desktop" }, ctx);
    assert.match(resultText(forgotten.content), /已删除 1 条/);
    const again = await procedureTool.execute({ action: "forget", app: "微信", platform: "desktop" }, ctx);
    assert.match(resultText(again.content), /没有找到/);
  } finally {
    if (prev === undefined) delete process.env["C_AGENT_PROCEDURES"];
    else process.env["C_AGENT_PROCEDURES"] = prev;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
