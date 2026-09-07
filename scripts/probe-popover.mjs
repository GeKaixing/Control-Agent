/* eslint-disable */
/**
 * 弹层内容渲染探针：用 puppeteer 加载 vite dev 的 ?popover=settings 页面，
 * mock 掉 window.api（Electron preload 在无头浏览器里不存在），
 * 抓 console / pageerror / 渲染结果，验证设置弹层内容是否能正常成型。
 * 用法：NODE_PATH=<repo>/bot-deps/node_modules node scripts/probe-popover.mjs [popoverId]
 */
import puppeteer from "puppeteer";
import { execSync } from "node:child_process";

const id = process.argv[2] ?? "settings";
const url = `http://127.0.0.1:5173?popover=${id}`;

const fakeInfo = {
  cwd: "/tmp/fake",
  model: "mock-model",
  modelSpec: "mock:mock-1",
  tools: ["read"],
  contextWindow: 128000,
  baseURL: "http://localhost",
  mode: "full",
  paused: false,
  reasoning: "auto",
  endpoint: "mock",
  maxTokens: 0,
  planPending: false,
  approvalMode: true,
  autoCompact: false,
  sessionTitle: "探针会话",
  lastUserPrompt: null,
  toolsByCategory: { skill: [], tool: [], mcp: [], plugin: [], extension: [] },
  contextBreakdown: { systemPrompt: 0, tools: 0, connectors: 0, skills: 0, messages: 0 },
  baseUrlPresets: [],
};

const browser = await puppeteer.launch({
  headless: "new",
  executablePath:
    "/Users/kaixing/Desktop/g/bot-deps/node_modules/puppeteer/.local-chromium/mac-982053/chrome-mac/Chromium.app/Contents/MacOS/Chromium",
  args: ["--no-sandbox", "--disable-gpu"],
});
try {
  const page = await browser.newPage();
  const logs = [];
  page.on("console", (m) => logs.push(`[console.${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));

  // 在页面脚本运行前注入 window.api mock（preload 的替代品）
  await page.evaluateOnNewDocument((info) => {
    window.api = {
      info: async () => info,
      getUsage: async () => ({ input: 1, output: 2, total: 3 }),
      onEvent: () => () => {},
      popoverSetHeight: (h) => { window.__reportedHeight = h; },
      closePopover: async () => {},
      openPopover: async () => {},
      setApprovalMode: async () => {},
      setAutoCompact: async () => {},
      setMode: async () => {},
    };
  }, fakeInfo);

  await page.goto(url, { waitUntil: "networkidle2", timeout: 20000 });
  await new Promise((r) => setTimeout(r, 1200)); // 等 React 提交 + ResizeObserver

  const result = await page.evaluate(() => ({
    reportedHeight: window.__reportedHeight ?? null,
    bodyHeight: document.body ? Math.ceil(document.body.getBoundingClientRect().height) : -1,
    text: document.body ? document.body.innerText.slice(0, 400) : "(no body)",
  }));

  console.log(`=== probe ${id} ===`);
  console.log("reportedHeight:", result.reportedHeight, "| bodyHeight:", result.bodyHeight);
  console.log("--- visible text ---");
  console.log(result.text || "(empty)");
  console.log("--- logs ---");
  console.log(logs.length ? logs.join("\n") : "(no console/page errors)");
  const ok =
    result.reportedHeight !== null && result.reportedHeight > 20 && logs.every((l) => !l.startsWith("[pageerror]"));
  console.log(ok ? "[e2e] PASS" : "[e2e] FAIL");
  process.exitCode = ok ? 0 : 1;
} finally {
  await browser.close();
}
