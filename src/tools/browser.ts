/**
 * browser_* 工具族：agent 操控内部浏览器面板（桌面端内嵌 WebContentsView）。
 *
 * 与 Computer Use 通道（screenshot/computer）的分工：
 * - 内部浏览器是**结构化通道**：DOM 级读写（browser_evaluate / browser_read）
 *   token 便宜、可精确选元素，优先用；
 * - Computer Use 是**视觉兜底**：只有面板被遮挡、或需要真实鼠标事件轨迹
 *   （hover 悬浮菜单之类）时才对屏幕坐标操作。
 *
 * 通道注入（与 ask-user.ts 同一模式）：工具注册表是静态对象，而「浏览器面板
 * 在哪」是端点能力——只有 Electron 桌面端有面板，main 进程与 Agent 同进程，
 * 启动时 setBrowserBackend 注入控制器；CLI / print 端不注入，优雅 fail。
 *
 * 权限（用户定调：agent 拥有完整操控权限）：
 * - browser_navigate / browser_read / browser_screenshot / browser_network：
 *   isMutating=false，导航可后退、读取与截图纯只读、网络抓包只观察不改动；
 * - browser_evaluate / browser_input：isMutating=true——执行任意 JS 或注入
 *   受信输入事件都等价于「以页面身份做事」（可点击、可提交表单），桌面端过
 *   approvalGate（用户可选「本会话全部允许」一次性放行）。
 *
 * CDP 能力（2026-09-10 扩展）：受信输入事件与网络抓包经 CDP（Chrome
 * DevTools 协议）实现，走 Electron 内置的 webContents.debugger——进程内
 * attach，不开 remote-debugging-port（那个端口本机任意进程都能连，安全红线）。
 * 见 desktop/main/browser-view.ts 的 CDP 会话一节。
 */

import { fail, ok, okImage, type Tool } from "./types.js";

/** 后端读取到的页面快照 */
export interface BrowserPageSnapshot {
  url: string;
  title: string;
  /** document.body.innerText（页面可见文本，不含 script/style） */
  text: string;
}

export interface BrowserScreenshot {
  dataUrl: string;
  width: number;
  height: number;
}

/** 受信输入事件规格（CDP Input 域语义；坐标 = 页面视口 CSS 像素） */
export interface BrowserInputSpec {
  action: "click" | "dblclick" | "rightclick" | "move" | "type" | "key" | "scroll";
  /** click / dblclick / rightclick / move / scroll 的锚点坐标 */
  x?: number;
  y?: number;
  /** type：要输入的文本（逐字符派发真实按键事件） */
  text?: string;
  /** key：按键名（Enter / Tab / Escape / Backspace / Delete / 方向键等） */
  key?: string;
  /** scroll 位移像素：dx 正 = 右移内容，dy 正 = 向下滚 */
  dx?: number;
  dy?: number;
  /** type 每键间隔毫秒（缺省 0，模拟真人时给 30-80） */
  delayMs?: number;
  /** 修饰键（CDP 位标志语义） */
  modifiers?: Array<"alt" | "ctrl" | "meta" | "shift">;
}

/** 网络抓包单条记录（Network 域观察结果） */
export interface NetworkEntry {
  requestId: string;
  url: string;
  method: string;
  /** HTTP 状态码；响应未到时为 null */
  status: number | null;
  mimeType: string | null;
  /** 响应字节数（编码后）；未完成时为 null */
  size: number | null;
}

/** 网络响应体 */
export interface NetworkBody {
  mimeType: string;
  /** 文本型响应解码为 utf8 文本；二进制型为空串（看 binary） */
  body: string;
  binary: boolean;
  /** 二进制时的字节数 */
  size?: number;
}

/** 标签页条目（browser_tabs list 的输出） */
export interface BrowserTabEntry {
  id: string;
  title: string;
  url: string;
  /** 是否为活动标签（browser_* 其余工具作用于它） */
  active: boolean;
  loading: boolean;
}

/**
 * browser_wait 的等待条件（可组合，全部满足即返回；都不给 = 等加载完成）。
 */
export interface BrowserWaitSpec {
  /** 等页面加载完成（isLoading=false） */
  load?: boolean;
  /** 等该 CSS 选择器出现在页面主 frame 的 DOM 里 */
  selector?: string;
  /** 网络静默判定窗口毫秒数（如 500：连续 500ms 无网络事件才算空闲） */
  networkIdleMs?: number;
  /** 总超时毫秒（缺省 15000） */
  timeoutMs?: number;
}

/** 拦截规则（CDP Fetch 域语义；urlPattern 支持 * 通配，大小写不敏感） */
export interface InterceptRule {
  urlPattern: string;
  /** block = 请求直接失败；fulfill = 不发请求直接回给定响应 */
  action: "block" | "fulfill";
  /** fulfill：响应状态码（缺省 200） */
  status?: number;
  /** fulfill：响应体文本（缺省空串） */
  body?: string;
  /** fulfill：Content-Type（缺省 application/json） */
  contentType?: string;
}

/**
 * 桌面端注入的浏览器控制器。所有方法在面板未打开时 throw Error
 * （工具层统一捕获转 fail，提示先 navigate）。
 */
export interface BrowserBackend {
  /** 打开面板并导航；url 缺省 = 已开时保持当前页 / 未开时落 about:blank */
  open(url?: string): Promise<void>;
  /** 导航：像 URL 直开，像搜索词走搜索引擎（语义与桌面端地址栏一致） */
  navigate(input: string): Promise<void>;
  read(): Promise<BrowserPageSnapshot>;
  /** fullPage=true 时经 CDP 截全页（超出视口部分也在内） */
  screenshot(fullPage?: boolean): Promise<BrowserScreenshot>;
  /** 在页面主 frame 执行任意 JS，返回序列化后的结果文本 */
  evaluate(expression: string): Promise<string>;
  /** 派发受信输入事件（isTrusted=true，等价真实键鼠） */
  dispatchInput(spec: BrowserInputSpec): Promise<void>;
  /** 开始记录网络请求（Network.enable；只观察不拦截） */
  networkStart(): Promise<void>;
  networkStop(): Promise<void>;
  /** 当前记录快照（可能跨多次导航累计，调用方自行过滤） */
  networkList(): Promise<NetworkEntry[]>;
  /** 取响应体；二进制型 binary=true（body 为空串） */
  networkBody(requestId: string): Promise<NetworkBody>;
  // ── 多标签管理（list/new/switch/close；close 销毁标签页状态） ──
  tabsList(): Promise<BrowserTabEntry[]>;
  /** 新建标签页并设为活动（url 缺省 = 新标签页提示页）；返回新标签 id */
  tabsNew(url?: string): Promise<string>;
  tabsSwitch(id: string): Promise<void>;
  tabsClose(id: string): Promise<void>;
  /** 等待条件满足（load / selector / networkIdle 可组合），返回已满足条件的描述 */
  wait(spec: BrowserWaitSpec): Promise<string>;
  /** 设置网络拦截规则（累积生效；传空数组清除全部） */
  networkIntercept(rules: InterceptRule[]): Promise<void>;
}

let backend: BrowserBackend | null = null;

/** 桌面端启动时注入；传 null 撤下 */
export function setBrowserBackend(b: BrowserBackend | null): void {
  backend = b;
}

function noBackend(): string {
  return "内部浏览器面板仅在桌面端可用（当前是 CLI / print / 无人值守环境）。" +
    "请改用 read/fetch 类方式获取网页内容，或用 bash + curl。";
}

function backendError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("面板未打开")
    ? `内部浏览器面板未打开：先调 browser_navigate 打开并加载目标页面。`
    : `浏览器面板操作失败：${msg.slice(0, 300)}`;
}

/** 页面文本截断上限：超过给占位 + 提示（完整内容模型可用 evaluate 精取） */
const MAX_READ_CHARS = 20_000;
/** evaluate 结果截断上限 */
const MAX_EVAL_CHARS = 20_000;

// ── browser_navigate ──

export const browserNavigateTool: Tool = {
  name: "browser_navigate",
  description:
    "打开/操控内部浏览器面板并加载页面。参数像 URL（含协议或域名）直接打开，" +
    "像搜索词则走 Bing 搜索。面板支持多标签页，agent 操作一律作用于当前" +
    "活动标签页（browser_navigate 导航的就是它）。面板未开时会先打开面板" +
    "（用户能实时看到页面）。打开后配合 browser_read / browser_screenshot / " +
    "browser_evaluate 读取与操作页面。",
  isMutating: false,
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "目标网址或搜索词。缺省 = 只打开面板不导航（或保持当前页）",
      },
    },
  },
  async execute(args) {
    if (backend === null) return fail(noBackend());
    const url = String(args["url"] ?? "").trim();
    try {
      if (url.length > 0) {
        await backend.navigate(url);
        return ok(`已在内部浏览器面板打开：${url}`);
      }
      await backend.open();
      return ok("内部浏览器面板已打开（未指定目标页面）。");
    } catch (err) {
      return fail(backendError(err));
    }
  },
};

// ── browser_read ──

export const browserReadTool: Tool = {
  name: "browser_read",
  description:
    "读取内部浏览器面板当前页面的 URL、标题与可见文本（body.innerText，" +
    "不含 script/style）。用于提取页面内容做分析。文本超过 2 万字符会截断，" +
    "需要精取时用 browser_evaluate 定点读 DOM。",
  isMutating: false,
  parameters: { type: "object", properties: {} },
  async execute() {
    if (backend === null) return fail(noBackend());
    try {
      const snap = await backend.read();
      const head = `URL: ${snap.url}\n标题: ${snap.title}\n\n`;
      if (snap.text.trim().length === 0) {
        return ok(head + "（页面没有可见文本——可能是空白页、纯图形页或尚未加载完成）");
      }
      if (snap.text.length > MAX_READ_CHARS) {
        return ok(
          head +
            snap.text.slice(0, MAX_READ_CHARS) +
            `\n\n…（已截断，共 ${snap.text.length} 字符。需要更多内容用 browser_evaluate 精取）`,
        );
      }
      return ok(head + snap.text);
    } catch (err) {
      return fail(backendError(err));
    }
  },
};

// ── browser_screenshot ──

export const browserScreenshotTool: Tool = {
  name: "browser_screenshot",
  description:
    "截取内部浏览器面板当前画面，返回 JPEG 截图。坐标约定与 screenshot 一致：" +
    "图片左上角为 (0,0)，坐标可直接用于 browser_input。注意：面板内优先用 " +
    "browser_evaluate 做结构化操作，看视觉渲染效果（canvas / 样式 / 图表）" +
    "或给 browser_input 找坐标时才截图。",
  isMutating: false,
  parameters: {
    type: "object",
    properties: {
      fullPage: {
        type: "boolean",
        description:
          "true = 截整页（含视口外需滚动的部分，页面多长截多长）；" +
          "缺省 = 只截当前视口",
      },
    },
  },
  async execute(args) {
    if (backend === null) return fail(noBackend());
    const fullPage = args["fullPage"] === true;
    try {
      const shot = await backend.screenshot(fullPage);
      return okImage(
        shot.dataUrl,
        `内部浏览器面板截图 ${shot.width}x${shot.height}${fullPage ? "（整页）" : ""}（坐标以图片左上角为 (0,0)）。`,
      );
    } catch (err) {
      return fail(backendError(err));
    }
  },
};

// ── browser_evaluate ──

export const browserEvaluateTool: Tool = {
  name: "browser_evaluate",
  description:
    "在内部浏览器面板的页面主 frame 里执行任意 JavaScript 并返回结果" +
    "（等价于在页面 DevTools Console 里跑代码，拥有该页面身份的完整能力：" +
    "查 DOM、点击、填表单、提交、读 localStorage）。" +
    "表达式可以是返回 Promise 的异步代码，await 后的值作为结果返回；" +
    "对象结果按 JSON 序列化。跨域 iframe 内部无法直接访问。" +
    "注意：这会在真实页面上产生实际效果（可能提交订单/发送消息），请确认意图后再执行。",
  isMutating: true,
  parameters: {
    type: "object",
    properties: {
      expression: {
        type: "string",
        description:
          "要执行的 JS 表达式（不是函数体，直接是表达式或 IIFE）。" +
          '例：document.querySelector("#submit")?.click()、' +
          'await fetch("/api/data").then(r => r.json())',
      },
    },
    required: ["expression"],
  },
  async execute(args) {
    if (backend === null) return fail(noBackend());
    const expression = String(args["expression"] ?? "").trim();
    if (expression.length === 0) return fail("browser_evaluate 需要非空的 expression 参数");
    try {
      const result = await backend.evaluate(expression);
      if (result.length > MAX_EVAL_CHARS) {
        return ok(result.slice(0, MAX_EVAL_CHARS) + `\n…（已截断，共 ${result.length} 字符）`);
      }
      return ok(result.length > 0 ? result : "(无返回值)");
    } catch (err) {
      return fail(backendError(err));
    }
  },
};

// ── browser_input ──

/** CDP 修饰键位标志 */
const MODIFIER_BITS: Record<string, number> = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

/** browser_input 参数缺失时的提示（直接给模型看，带补救路径） */
function inputArgsError(spec: Record<string, unknown>, need: string): string {
  return `browser_input 参数不完整：action=${spec["action"]} 还需要 ${need}`;
}

export const browserInputTool: Tool = {
  name: "browser_input",
  description:
    "向内部浏览器面板的页面派发**受信输入事件**（isTrusted=true，等价真实键鼠，" +
    "能通过反爬检测、触发 hover 悬浮菜单——这是 browser_evaluate 里 " +
    "element.click() 做不到的）。坐标来自 browser_screenshot 的像素坐标" +
    "（两者同一坐标系），或 browser_evaluate 里 getBoundingClientRect 取值。" +
    "典型序列：screenshot 找坐标 → click 聚焦输入框 → type 输入 → key Enter 提交。" +
    "注意：这是真实页面上的真实操作（可能下单/发消息），确认意图后再执行。",
  isMutating: true,
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["click", "dblclick", "rightclick", "move", "type", "key", "scroll"],
        description: "click 单击 / dblclick 双击 / rightclick 右键 / move 移动 / type 输入文本 / key 按键 / scroll 滚动",
      },
      x: { type: "number", description: "锚点 X（页面视口 CSS 像素，同截图坐标）；click/dblclick/rightclick/move 必填" },
      y: { type: "number", description: "锚点 Y；同上必填。scroll 缺省用页面中心" },
      text: { type: "string", description: "type：要输入的文本（逐字符真实按键）" },
      key: {
        type: "string",
        description:
          "key：键名。支持 Enter/Tab/Escape/Backspace/Delete/Home/End/PageUp/PageDown/" +
          "ArrowUp/ArrowDown/ArrowLeft/ArrowRight/Space/单字符",
      },
      dx: { type: "number", description: "scroll：水平位移，正 = 内容右移" },
      dy: { type: "number", description: "scroll：垂直位移，正 = 向下滚" },
      delayMs: { type: "number", description: "type：每键间隔毫秒（缺省 0；模拟真人给 30-80）" },
      modifiers: {
        type: "array",
        items: { type: "string" },
        description: '修饰键，取值 alt/ctrl/meta/shift，如 ["ctrl","shift"]',
      },
    },
    required: ["action"],
  },
  async execute(args) {
    if (backend === null) return fail(noBackend());
    const action = String(args["action"] ?? "");
    const x = typeof args["x"] === "number" ? args["x"] : undefined;
    const y = typeof args["y"] === "number" ? args["y"] : undefined;
    // 参数自检（快速失败，错误信息直接给模型看）
    if (["click", "dblclick", "rightclick", "move"].includes(action) && (x === undefined || y === undefined)) {
      return fail(inputArgsError(args, "x 和 y 坐标（可用 browser_screenshot 查看）"));
    }
    if (action === "type" && String(args["text"] ?? "").length === 0) {
      return fail(inputArgsError(args, "text（要输入的文本）"));
    }
    if (action === "key" && String(args["key"] ?? "").length === 0) {
      return fail(inputArgsError(args, "key（键名，如 Enter）"));
    }
    if (action === "scroll" && typeof args["dx"] !== "number" && typeof args["dy"] !== "number") {
      return fail(inputArgsError(args, "dx 或 dy（滚动位移像素）"));
    }
    const mods = Array.isArray(args["modifiers"])
      ? args["modifiers"].map((m) => String(m)).filter((m) => m in MODIFIER_BITS)
      : undefined;
    try {
      await backend.dispatchInput({
        action: action as "click" | "dblclick" | "rightclick" | "move" | "type" | "key" | "scroll",
        x,
        y,
        text: args["text"] !== undefined ? String(args["text"]) : undefined,
        key: args["key"] !== undefined ? String(args["key"]) : undefined,
        dx: typeof args["dx"] === "number" ? args["dx"] : undefined,
        dy: typeof args["dy"] === "number" ? args["dy"] : undefined,
        delayMs: typeof args["delayMs"] === "number" ? args["delayMs"] : undefined,
        modifiers: mods as BrowserInputSpec["modifiers"],
      });
      return ok(`已派发受信输入事件：${action}`);
    } catch (err) {
      return fail(backendError(err));
    }
  },
};

// ── browser_network ──

/** 响应体截断上限 */
const MAX_BODY_CHARS = 20_000;

export const browserNetworkTool: Tool = {
  name: "browser_network",
  description:
    "观察内部浏览器面板页面的网络流量（CDP Network 域）：开始记录后，" +
    "列出全部请求（URL / 方法 / 状态 / 类型 / 大小），并可读取响应体。" +
    "适合找页面背后的 API 接口：先 start，刷新或操作页面，再 list 找到 " +
    "XHR/fetch 接口，body 拿 JSON 响应——比解析 DOM 更结构化。" +
    "只观察不拦截不改动请求；抓包记录按标签页隔离（作用并读取活动标签页）。" +
    "限制：跨进程 iframe（站点隔离）的流量抓不到；" +
    "响应体依赖浏览器缓存，导航离开后可能已不可取。",
  isMutating: false,
  parameters: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["start", "stop", "list", "body"],
        description: "start 开始记录 / stop 停止 / list 列出已记录请求（缺省）/ body 读某条响应体",
      },
      requestId: { type: "string", description: "body 模式必填：list 输出里的 requestId" },
      urlFilter: { type: "string", description: "list：URL 包含该子串才显示（如 api、/v1/）" },
      limit: { type: "number", description: "list：最多返回条数（缺省 50，取最新的）" },
    },
  },
  async execute(args) {
    if (backend === null) return fail(noBackend());
    const mode = String(args["mode"] ?? "list");
    try {
      if (mode === "start") {
        await backend.networkStart();
        return ok("网络记录已开始。之后刷新/操作页面，再用 mode=list 查看，body 读响应体。");
      }
      if (mode === "stop") {
        await backend.networkStop();
        return ok("网络记录已停止（已有记录保留，仍可 list/body）。");
      }
      if (mode === "body") {
        const requestId = String(args["requestId"] ?? "").trim();
        if (requestId.length === 0) return fail("mode=body 需要 requestId（从 mode=list 的输出里拿）");
        const b = await backend.networkBody(requestId);
        if (b.binary) {
          return ok(`二进制响应（${b.mimeType}，${b.size ?? "?"} 字节），不展示内容。` +
            "需要内容时可用 browser_evaluate 在页面里 fetch 该接口自行处理。");
        }
        const text = b.body.length > MAX_BODY_CHARS
          ? b.body.slice(0, MAX_BODY_CHARS) + `\n…（已截断，共 ${b.body.length} 字符）`
          : b.body;
        return ok(`[${b.mimeType}]\n${text.length > 0 ? text : "（空响应体）"}`);
      }
      // list
      const all = await backend.networkList();
      const filter = String(args["urlFilter"] ?? "").toLowerCase();
      const filtered = filter.length > 0 ? all.filter((e) => e.url.toLowerCase().includes(filter)) : all;
      const limit = typeof args["limit"] === "number" && args["limit"] > 0 ? Math.floor(args["limit"]) : 50;
      const shown = filtered.slice(-limit);
      if (shown.length === 0) {
        return ok("没有匹配的记录。" +
          (all.length === 0 ? "先 mode=start 开始记录，再操作页面。" : "试试放宽 urlFilter。"));
      }
      const lines = shown.map((e) => {
        const status = e.status === null ? "..." : String(e.status);
        const mime = e.mimeType === null ? "?" : e.mimeType.split(";")[0];
        const size = e.size === null ? "?" : `${e.size}B`;
        return `[${status}] ${e.method} ${e.url} (${mime}, ${size}) id=${e.requestId}`;
      });
      const totalNote = filtered.length > shown.length ? `\n…（共 ${filtered.length} 条，只显示最新 ${shown.length} 条）` : "";
      return ok(lines.join("\n") + totalNote);
    } catch (err) {
      return fail(backendError(err));
    }
  },
};

// ── browser_tabs ──

export const browserTabsTool: Tool = {
  name: "browser_tabs",
  description:
    "管理内部浏览器面板的多标签页：list 列出全部（id / 标题 / URL / 活动标记）、" +
    "new 新建并激活（可带 url）、switch 切换活动标签、close 关闭标签。" +
    "browser_* 其余工具（navigate / read / evaluate / input / screenshot / network）" +
    "一律作用于**活动标签**——配合 new + switch 可多站点并行作业（每个标签的页面、" +
    "CDP 会话、网络抓包记录相互独立）。注意 close 会销毁该标签的页面状态（登录态保留）。",
  isMutating: true,
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "new", "switch", "close"],
        description: "list 列出（缺省）/ new 新建并激活 / switch 切换活动 / close 关闭",
      },
      id: { type: "string", description: "switch / close 必填：browser_tabs action=list 输出里的标签 id" },
      url: { type: "string", description: "new：新标签要打开的网址或搜索词（缺省 = 新标签页提示页）" },
    },
  },
  async execute(args) {
    if (backend === null) return fail(noBackend());
    const action = String(args["action"] ?? "list");
    try {
      if (action === "list") {
        const tabs = await backend.tabsList();
        if (tabs.length === 0) {
          return ok("面板当前没有标签页（先 browser_navigate 打开一个）。");
        }
        const lines = tabs.map((t) => {
          const flag = t.active ? "*" : " ";
          const state = t.loading ? " [加载中]" : "";
          return `${flag} id=${t.id}${state} ${t.title.length > 0 ? t.title : "(无标题)"} — ${t.url.length > 0 ? t.url : "(空白页)"}`;
        });
        return ok(`共 ${tabs.length} 个标签页（* = 活动，browser_* 工具作用于它）：\n${lines.join("\n")}`);
      }
      if (action === "new") {
        const url = String(args["url"] ?? "").trim();
        const id = await backend.tabsNew(url.length > 0 ? url : undefined);
        return ok(`已新建标签页并设为活动（id=${id}）${url.length > 0 ? `，正在打开 ${url}` : ""}。`);
      }
      if (action === "switch" || action === "close") {
        const id = String(args["id"] ?? "").trim();
        if (id.length === 0) {
          return fail(`action=${action} 需要 id 参数（从 browser_tabs action=list 的输出里拿）`);
        }
        if (action === "switch") {
          await backend.tabsSwitch(id);
          return ok(`已切换活动标签（id=${id}），后续 browser_* 工具作用于该标签。`);
        }
        await backend.tabsClose(id);
        return ok(`已关闭标签 id=${id}（登录态保留）。`);
      }
      return fail(`browser_tabs 不认识 action=${action}（支持 list / new / switch / close）`);
    } catch (err) {
      return fail(backendError(err));
    }
  },
};

// ── browser_wait ──

export const browserWaitTool: Tool = {
  name: "browser_wait",
  description:
    "等待内部浏览器面板的活动页面满足条件后再继续，替代「盲等 + 反复 screenshot/read " +
    "轮询」。三个条件可组合（全部满足才返回）：load 页面加载完成；selector 等 CSS 选择器" +
    "出现在页面主 frame 的 DOM；networkIdleMs 网络静默 N 毫秒（自动开启网络记录）。" +
    "超时（缺省 15s）会说明哪个条件没满足。典型用法：navigate 后 wait（等加载）；" +
    "点按钮后 wait selector=\"#result\"；等 XHR 完成用 networkIdleMs=800。",
  isMutating: false,
  parameters: {
    type: "object",
    properties: {
      load: { type: "boolean", description: "等页面加载完成；三个条件都不给时缺省为 true" },
      selector: { type: "string", description: '等该 CSS 选择器出现，如 "#result"、"div.list"' },
      networkIdleMs: { type: "number", description: "网络静默判定窗口毫秒数，如 500（自动开启网络记录）" },
      timeoutMs: { type: "number", description: "总超时毫秒（缺省 15000，上限 120000）" },
    },
  },
  async execute(args) {
    if (backend === null) return fail(noBackend());
    const spec: BrowserWaitSpec = {
      load: args["load"] === true,
      selector: args["selector"] !== undefined ? String(args["selector"]) : undefined,
      networkIdleMs: typeof args["networkIdleMs"] === "number" ? args["networkIdleMs"] : undefined,
      timeoutMs: typeof args["timeoutMs"] === "number" ? args["timeoutMs"] : undefined,
    };
    // 缺省语义：什么都不给 = 等加载完成
    if (!spec.load && spec.selector === undefined && spec.networkIdleMs === undefined) {
      spec.load = true;
    }
    try {
      const done = await backend.wait(spec);
      return ok(`等待完成：${done}。`);
    } catch (err) {
      return fail(backendError(err));
    }
  },
};

// ── browser_intercept ──

export const browserInterceptTool: Tool = {
  name: "browser_intercept",
  description:
    "拦截/改写内部浏览器面板活动页面的网络请求（CDP Fetch 域，规则作用于活动标签页并" +
    "**累积**生效直到清除）：action=block 让匹配请求直接失败（屏蔽广告/追踪器、模拟断网）；" +
    "action=fulfill 不真正发请求、直接回给定状态码与响应体（mock 接口、伪造数据调试前端）。" +
    "urlPattern 支持 * 通配；未命中的请求照常放行。配合 browser_network 的 list/body " +
    "观察拦截效果。",
  isMutating: true,
  parameters: {
    type: "object",
    properties: {
      urlPattern: { type: "string", description: 'URL 匹配模式，* 通配，如 "https://api.example.com/v1/*" 或 "*tracker*"' },
      action: { type: "string", enum: ["block", "fulfill"], description: "block 直接失败 / fulfill 伪造响应" },
      status: { type: "number", description: "fulfill：响应状态码（缺省 200）" },
      body: { type: "string", description: "fulfill：响应体文本（缺省空串）" },
      contentType: { type: "string", description: 'fulfill：Content-Type（缺省 "application/json"）' },
      mode: { type: "string", enum: ["set", "clear"], description: "set 追加一条规则（缺省）/ clear 清除全部规则" },
    },
  },
  async execute(args) {
    if (backend === null) return fail(noBackend());
    const mode = String(args["mode"] ?? "set");
    try {
      if (mode === "clear") {
        await backend.networkIntercept([]);
        return ok("已清除全部拦截规则（页面网络恢复直连）。");
      }
      const urlPattern = String(args["urlPattern"] ?? "").trim();
      const action = String(args["action"] ?? "");
      if (urlPattern.length === 0) {
        return fail("browser_intercept 需要 urlPattern（* 通配，如 \"https://api.example.com/v1/*\"；清除规则用 mode=clear）");
      }
      if (action !== "block" && action !== "fulfill") {
        return fail('browser_intercept 需要 action="block" 或 "fulfill"');
      }
      if (action === "fulfill" && typeof args["status"] === "number" && (args["status"] < 100 || args["status"] > 599)) {
        return fail("status 需要是合法 HTTP 状态码（100-599）");
      }
      const rule: InterceptRule = {
        urlPattern,
        action,
        status: typeof args["status"] === "number" ? args["status"] : undefined,
        body: args["body"] !== undefined ? String(args["body"]) : undefined,
        contentType: args["contentType"] !== undefined ? String(args["contentType"]) : undefined,
      };
      await backend.networkIntercept([rule]);
      const desc = action === "block"
        ? `block ${urlPattern}`
        : `fulfill ${urlPattern} → ${rule.status ?? 200} (${rule.contentType ?? "application/json"})`;
      return ok(`拦截规则已生效：${desc}（累积生效，清除用 mode=clear）。`);
    } catch (err) {
      return fail(backendError(err));
    }
  },
};
