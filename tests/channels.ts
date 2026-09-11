/**
 * 三通道（手机 / 电脑 / 浏览器）扩展的工具层测试：
 * - 手机：uiautomator XML 解析、bounds、adb 设备列表、shell 命令构造（含转义）
 * - 电脑：UIA JSON 解析与树格式化
 * - 浏览器：browser_input drag、browser_cookie、browser_file 走 fake 后端全链路
 *
 * 纯函数直接单测；有后端依赖的走 makeFakeBackend 同款注入模式。
 */

import assert from "node:assert/strict";
import {
  buildShellCommand,
  formatUiaNodes,
  mobileActTool,
  mobileScreenTool,
  mobileUiTool,
  parseAdbList,
  parseBounds,
  parseUiaDump,
} from "../src/tools/mobile.js";
import { formatUiaTree, parseUiaJson } from "../src/tools/uia.js";
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
