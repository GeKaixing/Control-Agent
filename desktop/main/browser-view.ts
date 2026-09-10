/**
 * 内部浏览器面板（主进程侧）——多标签页。
 *
 * 形态：每个标签页一个 WebContentsView，**活动标签**挂在主窗口 contentView
 * 上、精确贴住渲染层上报的占位区矩形（BrowserRect，CSS px = DIP）；后台标签
 * 只摘不毁（页面 / 历史 / 登录态常驻保活）。标签条 / 地址栏 / 工具条是渲染层
 * 的 HTML（BrowserTabs.tsx / BrowserBar.tsx），面板状态经 PUSH 通道的
 * browser_state 事件回推渲染层（全量快照：open + activeId + tabs[]）。
 *
 * 边界与护栏：
 * - 感知端豁免：index.ts 的 app.on("web-contents-created") 会拦掉所有
 *   will-navigate（那是给 App UI 窗口的），浏览器面板的 webContents 必须豁免——
 *   页内导航是它的本职。用「创建期标志 + WeakSet」识别：构造期间置 creating
 *   （web-contents-created 在构造函数内同步派发，事后注册认不出来），
 *   index.ts 在 handler 里据此 mark，之后 isBrowserContents 查集合。
 * - target=_blank / window.open：不建新 Electron 窗，也不跳系统浏览器——
 *   面板语义是「链接在面板内继续」（本视图加载，原页面留历史可后退）。
 *   非 http(s)（mailto:/下载类）转系统默认；about:blank 弹窗静默拒绝。
 * - UA 去掉 Electron 指纹，避免网站弹「请下载客户端」。
 * - 面板通道双端共享：用户在标签条 / 工具条操作，agent 经 browser_* 工具
 *   操控（agentBackend，实现 src/tools/browser.ts 的 BrowserBackend）。
 *   agent 的操作一律作用于**活动标签**；CDP 会话与网络抓包记录按标签页隔离。
 *
 * 生命周期：关面板（close()）= 只摘下活动视图，标签页全部保活；关标签
 * （closeTab）= 真正销毁该标签；主窗口关闭（destroy()）= 全部销毁。
 * attachTab 挂回时优先用 lastRect 直接贴位（切标签不闪），无 lastRect
 * （首开）才置 0 等渲染层上报。
 */

import { shell, WebContentsView, type BrowserWindow, type Debugger, type WebContents } from "electron";
import type { BrowserBackend, BrowserInputSpec, BrowserTabEntry, BrowserWaitSpec, InterceptRule, NetworkBody, NetworkEntry } from "../../src/tools/browser.js";

/** 单个标签页的折算快照（回推渲染层画标签条 / 工具条用） */
export interface BrowserTabSnapshot {
  id: string;
  title: string;
  /** about:blank 折算成空串：地址栏显示占位提示而不是无意义的协议名 */
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

/** 面板全量快照（browser_state 事件载荷） */
export interface BrowserSnapshot {
  open: boolean;
  activeId: string | null;
  tabs: BrowserTabSnapshot[];
}

export interface BrowserRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ── 面板状态：标签页集合 + 活动/挂载指针 ──

const tabs = new Map<string, Tab>();
const tabOrder: string[] = [];
let activeId: string | null = null;
/** 当前挂在主窗口 contentView 上的标签页（= 面板开合的唯一真相源） */
let attachedTabId: string | null = null;
let owner: BrowserWindow | null = null;
let onState: ((s: BrowserSnapshot) => void) | null = null;
/** 最近一次渲染层上报的占位区矩形（切标签 / 重开面板时直接贴位防闪） */
let lastRect: BrowserRect | null = null;

let tabSeq = 0;
function nextTabId(): string {
  tabSeq += 1;
  return `tab_${Date.now().toString(36)}_${tabSeq}`;
}

// ── 创建期识别（给 index.ts 的全局 web-contents-created 护栏用）──

let creating = false;
const browserContents = new WeakSet<WebContents>();

/** 浏览器视图构造期间为 true（web-contents-created 在构造函数内同步派发）。 */
export function isCreatingBrowserView(): boolean {
  return creating;
}

/** 把 webContents 标记为浏览器面板的（之后 isBrowserContents 认账）。 */
export function markBrowserContents(c: WebContents): void {
  browserContents.add(c);
}

/** 该 webContents 是否属于内部浏览器面板（决定 will-navigate 拦不拦）。 */
export function isBrowserContents(c: WebContents): boolean {
  return browserContents.has(c);
}

// ── 标签页 ──

interface NetRecord {
  requestId: string;
  url: string;
  method: string;
  status: number | null;
  mimeType: string | null;
  size: number | null;
  at: number;
}

const NET_MAX_RECORDS = 500;

/** 浏览器专属持久化 session 分区（persist: 前缀 = 落盘，登录态跨重启保留）。 */
const BROWSER_PARTITION = "persist:browser-panel";

class Tab {
  readonly id = nextTabId();
  readonly view: WebContentsView;
  /** CDP 会话与网络抓包记录按标签页隔离 */
  netEnabled = false;
  netRecords: NetRecord[] = [];
  /** 最近一次网络事件时间戳（browser_wait 的 networkIdle 判定用） */
  lastNetAt = 0;
  /** 拦截规则（CDP Fetch 域，累积生效） */
  interceptRules: InterceptRule[] = [];

  constructor() {
    creating = true;
    this.view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        // 网页是纯浏览内容，不需要 preload / Node 桥
        sandbox: true,
        // 专属持久化分区：登录态（cookie / localStorage / IndexedDB）独立落盘，
        // 与应用主窗口的 default session 互不影响，重启应用后依然保留——
        // 这是显式契约，persist: 前缀 = 持久化（不带前缀才是内存态）。
        partition: BROWSER_PARTITION,
      },
    });
    creating = false;
    markBrowserContents(this.view.webContents);
    this.view.setBackgroundColor("#ffffff");
    // 去掉 UA 里的 Electron 指纹：不少站点见到 Electron 就弹移动端/下载页
    const ua = this.view.webContents.getUserAgent();
    this.view.webContents.setUserAgent(ua.replace(/\s?Electron\/\S+/, ""));
    const wc = this.view.webContents;
    wc.on("did-start-loading", emit);
    wc.on("did-stop-loading", emit);
    wc.on("did-navigate", emit);
    wc.on("did-navigate-in-page", emit);
    wc.on("page-title-updated", emit);
    wc.setWindowOpenHandler(({ url: target }) => {
      if (/^https?:/i.test(target)) {
        void wc.loadURL(target).catch(() => {});
      } else if (!/^about:/i.test(target)) {
        void shell.openExternal(target).catch(() => {});
      }
      return { action: "deny" };
    });
  }

  upsertNetRecord(requestId: string, patch: Partial<NetRecord>): void {
    const existing = this.netRecords.find((r) => r.requestId === requestId);
    if (existing !== undefined) {
      Object.assign(existing, patch);
      return;
    }
    if (patch.url !== undefined) {
      this.netRecords.push({
        requestId,
        url: patch.url,
        method: patch.method ?? "GET",
        status: patch.status ?? null,
        mimeType: patch.mimeType ?? null,
        size: patch.size ?? null,
        at: Date.now(),
      });
      if (this.netRecords.length > NET_MAX_RECORDS) {
        this.netRecords.splice(0, this.netRecords.length - NET_MAX_RECORDS);
      }
    }
  }

  /** 销毁本标签：CDP 显式收尾 + 关闭 webContents。 */
  destroy(): void {
    if (this.view.webContents.debugger.isAttached()) {
      try {
        this.view.webContents.debugger.detach();
      } catch {
        // 已销毁/未 attach 时 detach 会抛：清场路径忽略
      }
    }
    // close() 而非 destroy()：Electron 33 的 WebContents 类型没暴露 destroy，
    // close() 立即触发销毁流程
    this.view.webContents.close();
  }
}

function activeTab(): Tab | null {
  return activeId !== null ? tabs.get(activeId) ?? null : null;
}

// ── 状态广播 ──

export function setBrowserStateListener(fn: ((s: BrowserSnapshot) => void) | null): void {
  onState = fn;
}

function snapshot(): BrowserSnapshot {
  const list = tabOrder.map((id): BrowserTabSnapshot => {
    const wc = tabs.get(id)!.view.webContents;
    const url = wc.getURL();
    return {
      id,
      title: wc.getTitle(),
      url: url === "about:blank" ? "" : url,
      loading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
    };
  });
  return { open: attachedTabId !== null, activeId, tabs: list };
}

function emit(): void {
  onState?.(snapshot());
}

/** 地址栏输入 → 可加载 URL：像网址就直开，像搜索词就走 Bing。 */
function normalizeInput(input: string): string {
  const s = input.trim();
  if (s.length === 0) return "about:blank";
  if (/^https?:\/\//i.test(s)) return s;
  // 无空白且含点（含 localhost:port / IP）→ 当主机名补 https
  if (!/\s/.test(s) && s.includes(".")) return `https://${s}`;
  return `https://www.bing.com/search?q=${encodeURIComponent(s)}`;
}

// 首次打开面板且没有目标时的提示页：URL 仍是 about:blank（地址栏保持空白），
// 但画面是一张说明页而不是一块突兀的白屏（用户曾把纯 about:blank 当成 bug）。
const NEW_TAB_HTML = [
  "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><style>",
  "html,body{margin:0;height:100%;display:flex;align-items:center;justify-content:center;",
  "background:#fafafa;font-family:system-ui,'Segoe UI','Microsoft YaHei',sans-serif;}",
  ".box{text-align:center;max-width:440px;padding:24px;user-select:none;}",
  "h1{font-size:17px;font-weight:600;color:#18181b;margin:0 0 12px;}",
  "p{font-size:13px;line-height:1.8;margin:4px 0;color:#71717a;}",
  "code{background:#e4e4e7;border-radius:4px;padding:1px 6px;font-size:12px;color:#3f3f46;}",
  "</style></head><body><div class=\"box\">",
  "<h1>内部浏览器</h1>",
  "<p>在上方地址栏输入网址或搜索词，回车打开。</p>",
  "<p>也可以直接让 agent 操作：说「打开 example.com」「帮我搜一下 ××」。</p>",
  "</div></body></html>",
].join("\n");

function paintNewTabPage(wc: WebContents): void {
  void wc
    .executeJavaScript(
      `document.open(); document.write(${JSON.stringify(NEW_TAB_HTML)}); document.close();`,
      true,
    )
    .catch(() => {});
}

/** 把标签页视图挂到主窗口 contentView（摘旧挂新）。有 lastRect 直接贴位
 * （切标签不闪），无 lastRect（首开）置 0 等渲染层上报。 */
function attachTab(t: Tab): void {
  if (owner === null || owner.isDestroyed()) return;
  if (attachedTabId === t.id) return;
  if (attachedTabId !== null) {
    const prev = tabs.get(attachedTabId);
    if (prev !== undefined && prev.id !== t.id) owner.contentView.removeChildView(prev.view);
  }
  owner.contentView.addChildView(t.view);
  t.view.setBounds(
    lastRect !== null ? lastRect : { x: 0, y: 0, width: 0, height: 0 },
  );
  attachedTabId = t.id;
}

/** 新建标签页并设为活动。url 给了就导航，没给就铺提示页。 */
function createTab(url?: string): Tab {
  const t = new Tab();
  tabs.set(t.id, t);
  tabOrder.push(t.id);
  activeId = t.id;
  // 面板开着（或 owner 可用）就直接挂上；面板关着仅建档，下次 open 再挂
  if (attachedTabId !== null || owner !== null) attachTab(t);
  if (url !== undefined && url.length > 0) {
    void t.view.webContents.loadURL(normalizeInput(url));
  } else {
    paintNewTabPage(t.view.webContents);
  }
  emit();
  return t;
}

/**
 * 打开面板（幂等）：无标签页则建首个（url 或提示页）；有则重新挂回活动标签
 * ——页面 / 历史常驻，重开就是原样。给 url 时对活动标签导航。
 */
export function open(win: BrowserWindow, url?: string): void {
  owner = win;
  if (activeId === null || activeTab() === null) {
    createTab(url);
    return;
  }
  attachTab(activeTab()!);
  if (url !== undefined && url.length > 0) {
    void activeTab()!.view.webContents.loadURL(normalizeInput(url));
  }
  emit();
}

/** 新建标签页（渲染层 + 按钮）。url 可选；面板未开时仅建档不挂载。 */
export function newTab(url?: string): void {
  createTab(url !== undefined && url.trim().length > 0 ? url.trim() : undefined);
}

/** 切换活动标签页（面板开着时同步换挂载视图）。 */
export function switchTab(id: string): void {
  if (!tabs.has(id)) return;
  activeId = id;
  if (attachedTabId !== null) attachTab(tabs.get(id)!);
  emit();
}

/** 关闭标签页：真正销毁该标签的视图与 CDP 会话。关活动标签时自动右邻
 * （无右邻取左邻）补位；标签全关 = 面板回到关闭态。 */
export function closeTab(id: string): void {
  const t = tabs.get(id);
  if (t === undefined) return;
  const wasVisible = attachedTabId === id;
  if (wasVisible) {
    if (owner !== null && !owner.isDestroyed()) owner.contentView.removeChildView(t.view);
    attachedTabId = null;
  }
  t.destroy();
  tabs.delete(id);
  const idx = tabOrder.indexOf(id);
  if (idx >= 0) tabOrder.splice(idx, 1);
  if (activeId === id) {
    activeId = tabOrder.length > 0 ? tabOrder[Math.min(idx, tabOrder.length - 1)]! : null;
  }
  // 关的是活动标签且还有存货：补位挂载，面板不塌
  if (wasVisible && activeId !== null) {
    const next = tabs.get(activeId);
    if (next !== undefined) attachTab(next);
  }
  emit();
}

/** 面板是否开着（RESIZE_WINDOW 的钳制策略分叉用）。 */
export function isOpen(): boolean {
  return attachedTabId !== null;
}

/** 关闭面板 = 只摘下活动视图，所有标签页常驻保活（重开即原样；幂等）。 */
export function close(): void {
  if (attachedTabId !== null) {
    const t = tabs.get(attachedTabId);
    if (t !== undefined && owner !== null && !owner.isDestroyed()) {
      owner.contentView.removeChildView(t.view);
    }
    attachedTabId = null;
  }
  emit();
}

/** 渲染层占位区矩形上报 → 记录并贴到当前挂载的视图上。 */
export function setRect(rect: unknown): void {
  if (typeof rect !== "object" || rect === null) return;
  const r = rect as Partial<BrowserRect>;
  const x = Math.round(typeof r.x === "number" ? r.x : NaN);
  const y = Math.round(typeof r.y === "number" ? r.y : NaN);
  const width = Math.round(typeof r.width === "number" ? r.width : NaN);
  const height = Math.round(typeof r.height === "number" ? r.height : NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y) || width <= 0 || height <= 0) return;
  lastRect = { x, y, width, height };
  if (attachedTabId !== null) {
    tabs.get(attachedTabId)?.view.setBounds(lastRect);
  }
}

export function navigate(input: string): void {
  const t = activeTab();
  if (t === null) return;
  void t.view.webContents.loadURL(normalizeInput(input));
  emit();
}

export function back(): void {
  const t = activeTab();
  if (t === null) return;
  t.view.webContents.goBack();
  emit();
}

export function forward(): void {
  const t = activeTab();
  if (t === null) return;
  t.view.webContents.goForward();
  emit();
}

export function reload(): void {
  const t = activeTab();
  if (t === null) return;
  t.view.webContents.reload();
  emit();
}

export function stop(): void {
  const t = activeTab();
  if (t === null) return;
  t.view.webContents.stop();
  emit();
}

/** 主窗口关闭时的兜底清场：这里才是真正销毁所有标签的地方（close 只摘不毁）。 */
export function destroy(): void {
  for (const id of tabOrder) {
    tabs.get(id)?.destroy();
  }
  tabs.clear();
  tabOrder.length = 0;
  activeId = null;
  attachedTabId = null;
  owner = null;
  lastRect = null;
  emit();
}

// ── agent 控制通道（src/tools/browser.ts 的 BrowserBackend 实现）──
// Agent 与 main 同进程，工具 execute 直接走这些闭包；面板未开时 throw
// 「面板未打开」，工具层统一转 fail 提示先 navigate。所有操作作用于
// 活动标签页。

function requireActiveTab(): Tab {
  const t = activeTab();
  if (t === null) throw new Error("内部浏览器面板未打开");
  return t;
}

function requireOwner(): BrowserWindow {
  if (owner === null || owner.isDestroyed()) throw new Error("主窗口不可用");
  return owner;
}

/** evaluate 返回值序列化：字符串直返、JSON 优先、循环引用退化为 String() */
function serializeEvalResult(result: unknown): string {
  if (result === undefined) return "undefined";
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result, null, 1) ?? String(result);
  } catch {
    return String(result);
  }
}

// ── 拦截（CDP Fetch 域）──

/** 通配模式（*）→ 正则（除 * 外全字面转义，大小写不敏感） */
function patternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

/** Fetch.requestPaused：查规则 → 放行 / 失败 / 伪造响应。请求随导航失效时忽略。 */
async function handleRequestPaused(t: Tab, params: Record<string, unknown>): Promise<void> {
  const requestId = String(params["requestId"] ?? "");
  const req = (params["request"] ?? {}) as Record<string, unknown>;
  const url = String(req["url"] ?? "");
  const rule = t.interceptRules.find(
    (r) => r.urlPattern.length > 0 && patternToRegex(r.urlPattern).test(url),
  );
  const dbg = t.view.webContents.debugger;
  try {
    if (rule === undefined) {
      await dbg.sendCommand("Fetch.continueRequest", { requestId });
      return;
    }
    if (rule.action === "block") {
      await dbg.sendCommand("Fetch.failRequest", { requestId, errorReason: "Aborted" });
      return;
    }
    await dbg.sendCommand("Fetch.fulfillRequest", {
      requestId,
      responseCode: rule.status ?? 200,
      responseHeaders: [{ name: "content-type", value: rule.contentType ?? "application/json" }],
      body: Buffer.from(rule.body ?? "", "utf8").toString("base64"),
    });
  } catch {
    // 页面已导航走 / 请求已失效：静默放弃这一次
  }
}

// ── 等待（browser_wait）──

const WAIT_POLL_MS = 120;
const WAIT_DEFAULT_TIMEOUT_MS = 15_000;
const WAIT_MAX_TIMEOUT_MS = 120_000;

/** 轮询等待条件满足；超时 throw（说明哪个条件没满足）。 */
async function waitOnTab(t: Tab, spec: BrowserWaitSpec): Promise<string> {
  const timeoutMs = Math.min(Math.max(spec.timeoutMs ?? WAIT_DEFAULT_TIMEOUT_MS, 500), WAIT_MAX_TIMEOUT_MS);
  const deadline = Date.now() + timeoutMs;
  const wantLoad = spec.load === true;
  const selector = spec.selector;
  const idleMs = typeof spec.networkIdleMs === "number" ? Math.max(spec.networkIdleMs, 100) : undefined;
  const wc = t.view.webContents;
  while (true) {
    let selectorOk = true;
    let idleOk = true;
    if (selector !== undefined) {
      const found = await wc
        .executeJavaScript(`document.querySelector(${JSON.stringify(selector)}) !== null`, true)
        .catch(() => false);
      selectorOk = found === true;
    }
    if (idleMs !== undefined) {
      idleOk = Date.now() - t.lastNetAt >= idleMs;
    }
    const loadOk = !wantLoad || !wc.isLoading();
    if (loadOk && selectorOk && idleOk) {
      const parts: string[] = [];
      if (wantLoad) parts.push("页面加载完成");
      if (selector !== undefined) parts.push(`选择器已出现：${selector}`);
      if (idleMs !== undefined) parts.push(`网络静默 ≥${idleMs}ms`);
      return parts.join("，");
    }
    if (Date.now() > deadline) {
      const missing: string[] = [];
      if (!loadOk) missing.push("页面仍在加载");
      if (!selectorOk) missing.push(`选择器未出现：${selector}`);
      if (!idleOk) missing.push("网络仍有请求在跑");
      throw new Error(`等待超时（${timeoutMs}ms）：${missing.join("；") || "条件未满足"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
  }
}

// ── CDP 会话（受信输入 + 网络抓包 + 全页截图，按标签页隔离）──
// 走 Electron 内置的 webContents.debugger：进程内 attach，不开
// remote-debugging-port（那个端口本机任意进程都能连，安全红线）。
// attach 一次常驻；webContents 销毁时自动 detach（detach 事件里收尾）。

const CDP_PROTOCOL = "1.3";
/** 已挂过 message/detach 监听的 Debugger 实例（新标签页是新实例，需重挂） */
const hookedDebuggers = new WeakSet<Debugger>();

/** 取（必要时创建）某标签页的 CDP 会话：attach + Page.enable + 事件监听。 */
function requireDebugger(t: Tab): Debugger {
  const dbg = t.view.webContents.debugger;
  if (!dbg.isAttached()) {
    dbg.attach(CDP_PROTOCOL);
    // Page 域：全页截图（captureBeyondViewport / getLayoutMetrics）要用
    void dbg.sendCommand("Page.enable").catch(() => {});
  }
  if (!hookedDebuggers.has(dbg)) {
    hookedDebuggers.add(dbg);
    dbg.on("message", (_event, method: string, params: unknown) => {
      const p = (params ?? {}) as Record<string, unknown>;
      if (method.startsWith("Network.")) {
        // 任何网络事件都刷新静默时钟（browser_wait networkIdle 判定用）
        t.lastNetAt = Date.now();
      }
      if (method === "Fetch.requestPaused") void handleRequestPaused(t, p);
      if (!t.netEnabled) return;
      if (method === "Network.requestWillBeSent") {
        const req = (p["request"] ?? {}) as Record<string, unknown>;
        t.upsertNetRecord(String(p["requestId"] ?? ""), {
          url: String(req["url"] ?? ""),
          method: String(req["method"] ?? "GET"),
        });
      } else if (method === "Network.responseReceived") {
        const resp = (p["response"] ?? {}) as Record<string, unknown>;
        t.upsertNetRecord(String(p["requestId"] ?? ""), {
          status: typeof resp["status"] === "number" ? resp["status"] : null,
          mimeType: typeof resp["mimeType"] === "string" ? resp["mimeType"] : null,
        });
      } else if (method === "Network.loadingFinished") {
        t.upsertNetRecord(String(p["requestId"] ?? ""), {
          size: typeof p["encodedDataLength"] === "number" ? p["encodedDataLength"] : null,
        });
      }
    });
    dbg.on("detach", () => {
      // webContents 销毁或异常抢占：记录停掉（已存记录保留可查）
      t.netEnabled = false;
    });
  }
  return dbg;
}

/** CDP 修饰键位标志（Alt=1 Ctrl=2 Meta=4 Shift=8） */
function modifierBits(mods?: string[]): number {
  let bits = 0;
  for (const m of mods ?? []) {
    if (m === "alt") bits |= 1;
    else if (m === "ctrl") bits |= 2;
    else if (m === "meta") bits |= 4;
    else if (m === "shift") bits |= 8;
  }
  return bits;
}

/** 具名键 → CDP keyDown 参数（vk = Windows 虚拟键码） */
const KEY_DEFS: Record<string, { code: string; vk: number; text?: string }> = {
  Enter: { code: "Enter", vk: 13, text: "\r" },
  Tab: { code: "Tab", vk: 9 },
  Escape: { code: "Escape", vk: 27 },
  Backspace: { code: "Backspace", vk: 8 },
  Delete: { code: "Delete", vk: 46 },
  Home: { code: "Home", vk: 36 },
  End: { code: "End", vk: 35 },
  PageUp: { code: "PageUp", vk: 33 },
  PageDown: { code: "PageDown", vk: 34 },
  ArrowUp: { code: "ArrowUp", vk: 38 },
  ArrowDown: { code: "ArrowDown", vk: 40 },
  ArrowLeft: { code: "ArrowLeft", vk: 37 },
  ArrowRight: { code: "ArrowRight", vk: 39 },
  Space: { code: "Space", vk: 32, text: " " },
};

/** 一次 press+release 鼠标事件对 */
async function pressRelease(
  dbg: Debugger, x: number, y: number, button: string, buttons: number,
  clickCount: number, mods: number,
): Promise<void> {
  await dbg.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, buttons, clickCount, modifiers: mods });
  await dbg.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, buttons: 0, clickCount, modifiers: mods });
}

const agentBackend: BrowserBackend = {
  async open(url?: string): Promise<void> {
    open(requireOwner(), url);
  },
  // 用户关了面板但 agent 要操作：open 一步到位——无标签页建新的、面板被摘
  // 则重挂活动标签，然后导航；不经过 about:blank 中间页、不双重加载
  async navigate(input: string): Promise<void> {
    open(requireOwner(), input);
  },
  async read(): Promise<{ url: string; title: string; text: string }> {
    const wc = requireActiveTab().view.webContents;
    const text = await wc.executeJavaScript(
      'document.body !== null ? document.body.innerText : ""',
      true,
    );
    return { url: wc.getURL(), title: wc.getTitle(), text: typeof text === "string" ? text : "" };
  },
  async screenshot(fullPage?: boolean): Promise<{ dataUrl: string; width: number; height: number }> {
    // 隐藏（已摘除）的视图 capturePage 会拿空图：先挂回再截
    if (attachedTabId === null) open(requireOwner());
    const t = requireActiveTab();
    if (fullPage === true) {
      // CDP 全页截图：captureBeyondViewport 把视口外内容也截进来
      const dbg = requireDebugger(t);
      const metrics = (await dbg.sendCommand("Page.getLayoutMetrics")) as {
        cssContentSize?: { width?: number; height?: number };
        contentSize?: { width?: number; height?: number };
      };
      const size = metrics.cssContentSize ?? metrics.contentSize;
      const shot = (await dbg.sendCommand("Page.captureScreenshot", {
        format: "jpeg",
        quality: 70,
        captureBeyondViewport: true,
      })) as { data?: string };
      if (shot.data === undefined || shot.data.length === 0) {
        throw new Error("全页截图为空（页面尚未渲染完成，稍后重试）");
      }
      return {
        dataUrl: `data:image/jpeg;base64,${shot.data}`,
        width: Math.round(size?.width ?? 0),
        height: Math.round(size?.height ?? 0),
      };
    }
    const image = await t.view.webContents.capturePage();
    if (image.isEmpty()) throw new Error("截图为空（页面尚未渲染完成，稍后重试）");
    const size = image.getSize();
    return {
      dataUrl: `data:image/jpeg;base64,${image.toJPEG(70).toString("base64")}`,
      width: size.width,
      height: size.height,
    };
  },
  async evaluate(expression: string): Promise<string> {
    const result = await requireActiveTab().view.webContents.executeJavaScript(expression, true);
    return serializeEvalResult(result);
  },

  // ── CDP 能力：受信输入 / 网络抓包（活动标签页） ──

  async dispatchInput(spec: BrowserInputSpec): Promise<void> {
    const t = requireActiveTab();
    const dbg = requireDebugger(t);
    const mods = modifierBits(spec.modifiers);
    if (spec.action === "move") {
      await dbg.sendCommand("Input.dispatchMouseEvent", {
        type: "mouseMoved", x: spec.x, y: spec.y, modifiers: mods,
      });
      return;
    }
    if (spec.action === "click" || spec.action === "dblclick" || spec.action === "rightclick") {
      const button = spec.action === "rightclick" ? "right" : "left";
      const buttons = spec.action === "rightclick" ? 2 : 1;
      const x = spec.x as number;
      const y = spec.y as number;
      await pressRelease(dbg, x, y, button, buttons, 1, mods);
      // 双击 = 第二次 press/release 用 clickCount 2（Chromium 语义）
      if (spec.action === "dblclick") await pressRelease(dbg, x, y, button, buttons, 2, mods);
      return;
    }
    if (spec.action === "scroll") {
      // 锚点缺省用页面中心（视口 CSS 尺寸 = 截图坐标系尺寸）
      let x = spec.x;
      let y = spec.y;
      if (x === undefined || y === undefined) {
        const size = (await t.view.webContents.executeJavaScript(
          "({ w: window.innerWidth, h: window.innerHeight })", true,
        )) as { w?: number; h?: number } | null;
        x = Math.round((size?.w ?? 400) / 2);
        y = Math.round((size?.h ?? 600) / 2);
      }
      await dbg.sendCommand("Input.dispatchMouseEvent", {
        type: "mouseWheel", x, y, deltaX: spec.dx ?? 0, deltaY: spec.dy ?? 0, modifiers: mods,
      });
      return;
    }
    if (spec.action === "key") {
      const name = spec.key ?? "";
      const def = KEY_DEFS[name] ??
        (name.length === 1
          ? { code: `Key${name.toUpperCase()}`, vk: name.toUpperCase().charCodeAt(0), text: name }
          : null);
      if (def === null) {
        throw new Error(`不认识的键名：${name}。支持 ${Object.keys(KEY_DEFS).join(" / ")} 或单字符`);
      }
      await dbg.sendCommand("Input.dispatchKeyEvent", {
        type: "keyDown", key: name, code: def.code,
        windowsVirtualKeyCode: def.vk, nativeVirtualKeyCode: def.vk,
        text: def.text, modifiers: mods,
      });
      await dbg.sendCommand("Input.dispatchKeyEvent", {
        type: "keyUp", key: name, code: def.code,
        windowsVirtualKeyCode: def.vk, nativeVirtualKeyCode: def.vk, modifiers: mods,
      });
      return;
    }
    // type：逐字符 keyDown(+text) / keyUp，产生受信按键序列
    const text = spec.text ?? "";
    const delay = Math.max(0, spec.delayMs ?? 0);
    for (const ch of text) {
      const vk = /[a-zA-Z0-9]/.test(ch) ? ch.toUpperCase().charCodeAt(0) : 0;
      await dbg.sendCommand("Input.dispatchKeyEvent", {
        type: "keyDown", key: ch, text: ch,
        windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods,
      });
      await dbg.sendCommand("Input.dispatchKeyEvent", {
        type: "keyUp", key: ch, modifiers: mods,
      });
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    }
  },

  async networkStart(): Promise<void> {
    const t = requireActiveTab();
    const dbg = requireDebugger(t);
    await dbg.sendCommand("Network.enable", { maxTotalBufferSize: 10_000_000, maxResourceBufferSize: 5_000_000 });
    t.netEnabled = true;
  },

  async networkStop(): Promise<void> {
    const t = requireActiveTab();
    t.netEnabled = false;
    if (t.view.webContents.debugger.isAttached()) {
      await t.view.webContents.debugger.sendCommand("Network.disable").catch(() => {});
    }
  },

  async networkList(): Promise<NetworkEntry[]> {
    return requireActiveTab().netRecords.map((r) => ({
      requestId: r.requestId,
      url: r.url,
      method: r.method,
      status: r.status,
      mimeType: r.mimeType,
      size: r.size,
    }));
  },

  async networkBody(requestId: string): Promise<NetworkBody> {
    const t = requireActiveTab();
    const rec = t.netRecords.find((r) => r.requestId === requestId);
    if (rec === undefined) {
      throw new Error("requestId 不在当前记录里（抓包未开始、缓冲被挤掉、请求太老或不属于活动标签页）");
    }
    const dbg = requireDebugger(t);
    const result = (await dbg.sendCommand("Network.getResponseBody", { requestId })) as {
      body?: string;
      base64Encoded?: boolean;
    };
    const raw = result.body ?? "";
    const mime = rec.mimeType ?? "";
    const textLike = /^(text\/|application\/(json|javascript|xml|rss|xhtml))/i.test(mime) || /\+xml/i.test(mime);
    if (result.base64Encoded === true) {
      if (textLike) {
        return { mimeType: mime, body: Buffer.from(raw, "base64").toString("utf8"), binary: false };
      }
      return {
        mimeType: mime.length > 0 ? mime : "application/octet-stream",
        body: "",
        binary: true,
        size: Buffer.byteLength(raw, "base64"),
      };
    }
    return { mimeType: mime, body: raw, binary: false };
  },

  // ── 多标签管理 ──

  async tabsList(): Promise<BrowserTabEntry[]> {
    return snapshot().tabs.map((s) => ({
      id: s.id,
      title: s.title,
      url: s.url,
      active: s.id === activeId,
      loading: s.loading,
    }));
  },

  async tabsNew(url?: string): Promise<string> {
    const trimmed = url !== undefined ? url.trim() : "";
    if (owner === null || owner.isDestroyed()) {
      // 面板从未开过：open 一步建首个标签（否则 createTab 只建档不挂载）
      open(requireOwner(), trimmed.length > 0 ? trimmed : undefined);
      return activeId ?? "";
    }
    return createTab(trimmed.length > 0 ? trimmed : undefined).id;
  },

  async tabsSwitch(id: string): Promise<void> {
    if (!tabs.has(id)) {
      throw new Error(`标签页不存在：${id}（用 browser_tabs action=list 查看现有标签）`);
    }
    switchTab(id);
  },

  async tabsClose(id: string): Promise<void> {
    if (!tabs.has(id)) {
      throw new Error(`标签页不存在：${id}（用 browser_tabs action=list 查看现有标签）`);
    }
    closeTab(id);
  },

  // ── 等待 ──

  async wait(spec: BrowserWaitSpec): Promise<string> {
    return waitOnTab(requireActiveTab(), spec);
  },

  // ── 拦截（CDP Fetch 域）──

  async networkIntercept(rules: InterceptRule[]): Promise<void> {
    const t = requireActiveTab();
    const dbg = requireDebugger(t);
    if (rules.length === 0) {
      t.interceptRules = [];
      if (dbg.isAttached()) {
        await dbg.sendCommand("Fetch.disable").catch(() => {});
      }
      return;
    }
    t.interceptRules = [...t.interceptRules, ...rules];
    // Fetch.enable 可重复调用刷新 patterns：先 disable 再 enable 保证干净
    await dbg.sendCommand("Fetch.disable").catch(() => {});
    await dbg.sendCommand("Fetch.enable", {
      patterns: t.interceptRules.map((r) => ({ urlPattern: r.urlPattern })),
    });
  },
};

/** agent 浏览器控制后端（闭包实时读活动标签，标签增删/切换无需重注） */
export function browserBackend(): BrowserBackend {
  return agentBackend;
}
