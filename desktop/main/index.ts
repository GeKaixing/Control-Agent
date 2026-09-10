/**
 * Electron 主进程入口（CJS emit，tsc -p desktop/tsconfig.main.json 编译）。
 *
 * 职责：
 * 1. 创建 BrowserWindow（dev 时连 vite dev server；build 时 loadFile；
 *    dev 下 vite 没起自动落回 renderer-dist，见 loadRenderer）
 * 2. 装配 SessionManager + 注册 IPC handler
 * 3. 把 SessionManager 发出的 WireEvent 透给渲染进程
 *
 * 安全：contextIsolation + sandbox + preload；nodeIntegration 关闭。
 *
 * 被 desktop/main/entry.mjs 调用：start({ __dirname })。
 *
 * entry.mjs 是 ESM（文件名带 .mjs 是为了绕开根 package.json 的 "type":"module"，
 * 让 Node 直接按 ESM 解析，不要让 tsc emit 的 .js 被当 ESM 加载）。
 * entry.mjs 里用 `createRequire(import.meta.url)` 同步加载这份 emit —— 不能用
 * `await import(CJS)`，否则 ESM 的 preparse 阶段会去读 Electron 内嵌 CJS 模块的
 * `module.exports`，对 `require('electron')` 那种由 Electron 二进制注入的对象
 * 直接炸 `Cannot read properties of undefined (reading 'exports')`。
 */

import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, screen, shell, type IpcMainInvokeEvent } from "electron";
import { existsSync, readdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ConnectorLoader } from "../../src/connector/loader/connector-loader.js";
import { ConnectorRuntime } from "../../src/connector/runtime/connector-runtime.js";
import { createDisplayRoute, type DisplayRoute } from "../../src/connector/runtime/display-route.js";
import DesktopDisplayConnector from "../../src/connector/connectors/desktop-display/index.js";
import { dispatchApi } from "./api-dispatcher.js";
import * as BrowserPanel from "./browser-view.js";
import * as PhoneMirror from "./phone-mirror.js";
import WsDisplayBridge from "./ws-bridge.js";
import TrayStatusBridge from "./tray-status.js";
import { IPC } from "./ipc.js";
import { SessionManager, type SessionDeps } from "./session.js";
import { DictationController } from "./dictation.js";
import { assembleSession } from "../../src/session.js";
import {
  readSavedCustomModel,
  readSavedModelSpec,
  readSavedWorkspaceCwd,
  saveCustomModel,
  saveModelSpec,
  saveWorkspaceCwd,
  type StoredCustomModel,
} from "../../src/context/index.js";
import type { WireEvent } from "../shared/api.js";
import { setBrowserBackend } from "../../src/tools/browser.js";
import { initFileLogging, log } from "../../src/log/index.js";

interface StartDeps {
  __dirname: string;
}

let mainWindow: BrowserWindow | null = null;
let session: SessionManager | null = null;
/**
 * 当前会话工作目录（resolveSessionCwd 的结果，bootstrap 时赋值；设置弹窗
 * 「工作目录」切换时更新）。模块级：registerIpcHandlers 的 handler 与
 * SessionManager 的 deps.cwd 闭包都要读它。
 */
let sessionCwd = "";
let dictation: DictationController | null = null;
/** 消息显示的 connector runtime；「默认连接」的 desktop-display connector 也注册在这里 */
let displayRuntime: ConnectorRuntime | null = null;
/**
 * 工具型 connector runtime（connectors-mcp：browser-use / mcp-memory / …）。
 * 与 displayRuntime 职责分离：那边只接收事件流（DisplaySink），这边把 connector
 * 的 extraTools 暴露给 Agent。在 bootstrap 里 assembleSession 之前装配。
 */
let toolRuntime: ConnectorRuntime | null = null;
/** 菜单弹层子窗口（无边框小窗浮在触发按钮下方；主窗口高度因此不变） */
let popoverWin: BrowserWindow | null = null;
let popoverId: string | null = null;
/** 独立消息弹窗（设置弹窗开启；不挂 parent、可拖动，独立于主窗口存在） */
let msgWin: BrowserWindow | null = null;
let popoverPos: {
  x: number;
  y: number;
  width: number;
  /** 渲染层请求的原始 y（按钮 bottom + 间距，未夹屏幕边界），算「下方空间」用 */
  rawY: number;
  /** 触发按钮顶边的屏幕 Y；缺省（旧渲染层）时不做向上翻转 */
  triggerTop: number | null;
  /** 已翻转到按钮上方；后续高度变化继续沿上方扩展 */
  flipped: boolean;
} | null = null;
/** 最近一次弹层关闭的时间与 id：给「点击触发按钮 → blur 先关、click 再开」的 toggle 竞态用 */
let popoverClosedAt = 0;
let popoverLastId: string | null = null;

const RENDERER_DEV_URL = process.env["VITE_DEV_SERVER_URL"] ?? "http://127.0.0.1:5173";
const IS_DEV = !app.isPackaged;
/**
 * 内部浏览器面板打开时的窗口高度下限：面板区（min 480）+ 工具条 + 拖动条 +
 * Composer。低于这个高度 Composer 会被占位区挤出视口。RESIZE_WINDOW 的
 * 钳制下限与 BROWSER_OPEN 的窗口保底高度都用这个值。
 */
/** 浏览器面板打开时的窗口保底高度：拖动条 + 标签条 + 工具条 + 占位区最小
 * 480 + Composer——700 会被 Composer 顶出视口裁掉（真实最小内容 ≈ 750+）。 */
const BROWSER_MIN_WINDOW_HEIGHT = 768;

/** 面板需要空间：窗口高度保底（渲染层浏览器区 min 480 + 标签条 + 工具条 +
 * 拖动条 + Composer）。BROWSER_OPEN / BROWSER_NEW_TAB 共用。 */
function ensureBrowserWindowHeight(): void {
  if (mainWindow === null || mainWindow.isDestroyed()) return;
  const [width, height] = mainWindow.getContentSize();
  if (height < BROWSER_MIN_WINDOW_HEIGHT) {
    mainWindow.setContentSize(width, BROWSER_MIN_WINDOW_HEIGHT);
  }
}

/** 渲染层 vite build 产物入口（相对 desktop/main 上一层） */
function indexHtmlPath(deps: StartDeps): string {
  return path.join(deps.__dirname, "..", "renderer-dist", "index.html");
}

/** vite dev server 探活：主进程 Node fetch 不走系统代理，直连语义准确 */
async function devServerAlive(): Promise<boolean> {
  try {
    const resp = await fetch(RENDERER_DEV_URL, { signal: AbortSignal.timeout(1_500) });
    return resp.ok;
  } catch {
    return false;
  }
}

/**
 * 统一的渲染层加载入口。dev 分支不再盲连 dev server：**先探活**，活着走
 * loadURL（热更新），没起就落回 loadFile(renderer-dist) 并打日志。
 *
 * 为什么必须有这层：主窗口是 vite 活着时加载的活页面，vite 死了它还能撑着
 * （HMR 断连只影响热更新）；但弹层 / 消息窗每次都是**新建** BrowserWindow
 * 即时 loadURL——vite 一死就 `ERR_FAILED (-2) loading 'http://127.0.0.1:5173…'`
 * （真实案例：弹「自定义模型」报错，主窗口却一切正常）。落回旧构建最多
 * 是界面落后一版，好过白屏 / 弹层打不开；日志注明原因，不静默装没事。
 */
async function loadRenderer(win: BrowserWindow, deps: StartDeps, opts: { search?: string } = {}): Promise<void> {
  if (IS_DEV) {
    if (await devServerAlive()) {
      await win.loadURL(opts.search !== undefined ? `${RENDERER_DEV_URL}?${opts.search}` : RENDERER_DEV_URL);
      return;
    }
    console.log(
      `[desktop] vite dev server（${RENDERER_DEV_URL}）未响应，本次加载落回 renderer-dist 构建产物（界面可能是旧构建）；要热更新请先启动 vite`,
    );
  }
  await win.loadFile(indexHtmlPath(deps), opts.search !== undefined ? { search: opts.search } : undefined);
}

/** 主进程 → 渲染进程：推 WireEvent 给 BrowserWindow（显示 connector 的默认 transport） */
function pushEvent(e: WireEvent): void {
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.PUSH, e);
  }
  // 弹层子窗口订阅同一条事件流（PopoverHost.onEvent）。设置弹层的开关切换后
  // 不关闭，靠主进程广播的 refresh-info 重拉 info 回显——事件必须同时送达弹层，
  // 否则点了开关视觉上永远不变（旧实现只发主窗口，弹层收不到）。
  if (popoverWin !== null && !popoverWin.isDestroyed()) {
    popoverWin.webContents.send(IPC.PUSH, e);
  }
  // 独立消息弹窗订阅同一条事件流（MessageFloat）：实时显示 agent 回复流
  if (msgWin !== null && !msgWin.isDestroyed()) {
    msgWin.webContents.send(IPC.PUSH, e);
  }
}

/** 关掉菜单弹层子窗口（幂等；没有打开时是 no-op） */
function closePopoverWin(): void {
  if (popoverWin !== null && !popoverWin.isDestroyed()) popoverWin.destroy();
  popoverClosedAt = Date.now();
  popoverLastId = popoverId;
  popoverWin = null;
  popoverId = null;
  popoverPos = null;
}

/**
 * 独立消息弹窗（MessageFloat，设置弹窗开启）：
 * 无边框白底小窗（340×460，可拖动/缩放），初始位置在工作区右下角。
 * 不挂 parent —— 独立于主窗口存在：主窗口关了（darwin 常驻）它还在；
 * blur 不关（与菜单弹层的「失焦即收」相反，用户就是想让它一直挂着追消息）。
 * 事件流经 pushEvent（上面已扩展）到达；关闭走渲染层的 setMsgWindow(false)。
 */
function createMsgWindow(deps: StartDeps): void {
  if (msgWin !== null && !msgWin.isDestroyed()) return; // 已开着：no-op
  if (mainWindow === null || mainWindow.isDestroyed()) return;
  const work = screen.getDisplayMatching(mainWindow.getBounds()).workArea;
  const WIDTH = 340;
  const HEIGHT = 460;
  msgWin = new BrowserWindow({
    x: work.x + work.width - WIDTH - 24,
    y: work.y + work.height - HEIGHT - 24,
    width: WIDTH,
    height: HEIGHT,
    minWidth: 260,
    minHeight: 200,
    frame: false,
    backgroundColor: "#ffffff",
    // 用户可拖到任意角落、可拖大小。
    // **必须进任务栏**：Windows 上 skipTaskbar 会同时把窗口从任务栏和 Alt+Tab
    // 列表里摘掉——切走之后既没有图标也没有切换入口，用户就找不回这个窗了。
    // 「独立消息窗」的定位是可 Alt+Tab 回来，所以要留任务栏条目。
    resizable: true,
    movable: true,
    skipTaskbar: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: "c-agent messages",
    webPreferences: {
      preload: path.join(deps.__dirname, "..", "preload", "preload.cjs"),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  });
  const win = msgWin;
  win.on("closed", () => {
    // 只清自己：destroyMsgWindow 已把 msgWin 置 null，这里兜底用户侧的窗口关闭
    if (msgWin === win) msgWin = null;
  });
  const query = "msg-window=1";
  void loadRenderer(msgWin, deps, { search: query });
}

/** 销毁独立消息弹窗（幂等）。setImmediate 延迟：从渲染层 setMsgWindow(false) 的
 *  invoke 链路里同步 destroy 自己会撞 "Object has been destroyed"。 */
function destroyMsgWindow(): void {
  const win = msgWin;
  msgWin = null;
  if (win !== null && !win.isDestroyed()) setImmediate(() => win.destroy());
}

/**
 * 装配消息显示通路（connector 化）：
 *
 * 1. 创建 ConnectorRuntime，注册三个 DisplaySink connector：
 *    - desktop-display：「默认连接」，transport = pushEvent（Electron IPC，本地窗口）
 *    - ws-display：独立 UI 接入桥（WebSocket，事件下行 + RPC 上行）
 *    - tray-status：macOS 菜单栏状态区实时输出（窗口在后台也能看到），
 *      同时经 onTitle 把「当前会话标题」旁路推给渲染层的顶部标题栏
 * 2. SessionManager 的 emit 走 createDisplayRoute()：事件广播给 runtime 里所有
 *    DisplaySink connector；一个都没有时 fallback 直连 pushEvent（保底）。
 *
 * 各 sink 并存：本地窗口与独立 UI（浏览器 / Electron 薄壳）收到相同的事件流。
 */
async function bootstrapDisplayRoute(deps: StartDeps): Promise<DisplayRoute> {
  displayRuntime = new ConnectorRuntime({ cwd: process.cwd() });
  const display = new DesktopDisplayConnector({ transport: pushEvent });
  displayRuntime.adopt({
    manifest: {
      id: "desktop-display",
      version: "0.1.0",
      type: "desktop",
      description: "桌面端消息显示 connector（默认连接）",
      permissions: [],
      capabilities: [],
      entry: "index.ts",
    },
    instance: display,
    state: "loaded",
    rootDir: path.join(__dirname, "desktop-display"),
  });

  // 独立 UI 的 WS 接入桥。端口可 env 覆盖；设为 0 时禁用。
  // 注意：bootstrapDisplayRoute 在 SessionManager 创建之前调用（session 需要
  // emit），所以 dispatch/getInfo 都用惰性判空——bridge start 后、session 赋值前
  // 这个窗口期里进来的 RPC 会得到 ok:false，hello 会拿到兜底快照，不会崩。
  const wsPort = Number(process.env["CAGENT_WS_PORT"] ?? "8787");
  if (Number.isFinite(wsPort) && wsPort > 0) {
    const bridge = new WsDisplayBridge({
      port: wsPort,
      dispatch: async (method, args) => {
        // 听写不走 dispatchApi（独立 helper 进程，与 IPC handler 同逻辑）
        if (method === "startDictation") {
          if (dictation === null) return;
          if (dictation.isDictating) dictation.stop();
          dictation.start();
          return undefined;
        }
        if (method === "stopDictation") {
          dictation?.stop();
          return undefined;
        }
        if (session === null) throw new Error("会话尚未初始化，请稍后重试");
        return dispatchApi(session, method, args);
      },
      getInfo: () => {
        if (session === null) throw new Error("会话尚未初始化");
        return session.info();
      },
      onLog: (message) => console.log(`[ws-display] ${message}`),
    });
    displayRuntime.adopt({
      manifest: {
        id: "ws-display",
        version: "0.1.0",
        type: "desktop",
        description: "独立 UI 的 WebSocket 接入桥（下行事件流 + 上行 RPC）",
        permissions: [],
        capabilities: [],
        entry: "index.ts",
      },
      instance: bridge,
      state: "loaded",
      rootDir: path.join(__dirname, "ws-display"),
    });
  }
  // macOS 菜单栏状态区：窗口切后台/关闭后仍能看到实时输出摘要。
  // onShowWindow 在窗口已关（红绿灯）时走 createWindow 重建，与 activate 同一套逻辑。
  // onTitle：把同一段标题经 IPC 推给渲染层，显示在窗口顶部标题栏（拖动条）。
  const trayBridge = new TrayStatusBridge({
    onShowWindow: () => {
      if (mainWindow === null || mainWindow.isDestroyed()) {
        void createWindow(deps);
        return;
      }
      mainWindow.show();
      mainWindow.focus();
    },
    onTitle: (text) => pushEvent({ t: "session_title", text }),
  });
  displayRuntime.adopt({
    manifest: {
      id: "tray-status",
      version: "0.1.0",
      type: "desktop",
      description: "macOS 菜单栏状态区实时输出（Tray 纯文字）",
      permissions: [],
      capabilities: [],
      entry: "index.ts",
    },
    instance: trayBridge,
    state: "loaded",
    rootDir: path.join(__dirname, "tray-status"),
  });
  const failed = await displayRuntime.start();
  if (failed.length > 0) {
    console.error("[display] connector start failed; falling back to direct IPC");
  }
  return createDisplayRoute(displayRuntime, (event) => pushEvent(event as WireEvent));
}

/**
 * 预热 /models 元数据；当前模型的 contextWindow 由此「从无到有 / 变了值」时
 * 广播 refresh-info，UI 重拉 info 刷新上下文使用量的分母。fire-and-forget。
 */
function warmModelsCacheAndNotify(): void {
  if (session === null) return;
  void session.warmModelsCache().then((changed) => {
    if (changed) pushEvent({ t: "ui_action", action: "refresh-info" });
  });
}

/**
 * IPC handler 全部是 dispatchApi 的薄封装——业务逻辑（参数校验、错误包装）
 * 只有一份，IPC 与 WS 两条传输通道行为完全一致。
 */
function registerIpcHandlers(deps: StartDeps): void {
  if (session === null) throw new Error("session 尚未初始化");

  const handle = (channel: string, method: string, notify?: string, warm = false): void => {
    ipcMain.handle(channel, async (_e: IpcMainInvokeEvent, ...args: unknown[]) => {
      const result = await dispatchApi(session!, method, args);
      // mutating 调用成功后主进程主动广播 ui_action。渲染层弹窗里「改完再通知」
      // 有 destroy 竞态：弹层 onClose 触发主进程销毁子窗口，若通知依赖前一个 invoke
      // 的返回（.then），子窗口 JS 可能先被销毁——通知丢失，主窗口停在旧状态
      // （曾表现为：选了「自动」状态栏仍显示「均衡」；切了会话仍显示上一会话内容）。
      // 状态变更方（主进程）自己广播。dispatchApi 抛错不会走到这里，只成功才推。
      if (notify !== undefined) pushEvent({ t: "ui_action", action: notify });
      // 切了模型 / 端点后预热新目标的 /models 元数据（contextWindow 真值来源）
      if (warm) warmModelsCacheAndNotify();
      return result;
    });
  };

  handle(IPC.INFO, "info");
  handle(IPC.SUBMIT, "submit");
  handle(IPC.STEER, "steer");
  handle(IPC.ABORT, "abort");
  handle(IPC.ANSWER_ASK, "answerAsk");
  handle(IPC.SET_MODEL, "setModel", "refresh-info", true);
  handle(IPC.SET_CUSTOM_MODEL, "setCustomModel", "refresh-info", true);
  handle(IPC.SET_MODE, "setMode", "refresh-info");
  handle(IPC.SET_REASONING, "setReasoning", "refresh-info");
  handle(IPC.SET_ENDPOINT, "setEndpoint", undefined, true);
  handle(IPC.PLAN_CONTINUE, "planContinue");
  handle(IPC.SET_APPROVAL_MODE, "setApprovalMode", "refresh-info");
  handle(IPC.SET_AUTO_COMPACT, "setAutoCompact", "refresh-info");
  // 独立消息弹窗：偏好落 SessionManager（dispatcher），窗口创建/销毁在这里做
  ipcMain.handle(IPC.SET_MSG_WINDOW, async (_e: IpcMainInvokeEvent, on: unknown) => {
    await dispatchApi(session!, "setMsgWindow", [on === true]);
    if (on === true) {
      createMsgWindow(deps);
    } else {
      destroyMsgWindow();
    }
    pushEvent({ t: "ui_action", action: "refresh-info" });
  });
  // agent 本地服务预览开关：只落偏好 + refresh-info 回显（服务列表照常收集，
  // 开关只控制状态栏入口与预览弹窗的可见性，无需窗口副作用）
  ipcMain.handle(IPC.SET_LOCAL_PREVIEW, async (_e: IpcMainInvokeEvent, on: unknown) => {
    await dispatchApi(session!, "setLocalPreview", [on === true]);
    pushEvent({ t: "ui_action", action: "refresh-info" });
  });
  // 窗口置顶开关：偏好落 SessionManager（dispatcher），setAlwaysOnTop 在这里做。
  // Windows / macOS 都是系统级 always-on-top（macOS 默认 "floating" 级别，
  // 普通应用之上；不抢全屏空间和系统 UI）。
  ipcMain.handle(IPC.SET_ALWAYS_ON_TOP, async (_e: IpcMainInvokeEvent, on: unknown) => {
    await dispatchApi(session!, "setAlwaysOnTop", [on === true]);
    if (mainWindow !== null && !mainWindow.isDestroyed()) {
      mainWindow.setAlwaysOnTop(on === true);
    }
    pushEvent({ t: "ui_action", action: "refresh-info" });
  });
  // 设置弹窗「工作目录」：目录选择对话框在这里开（SessionManager 不碰
  // Electron UI），目录可创建性先行校验，然后走 dispatcher 改 state.cwd + 落盘。
  // 成功后同步 sessionCwd（deps.cwd 闭包的取值源）并广播 refresh-info 回显。
  ipcMain.handle(IPC.CHOOSE_WORKSPACE_CWD, async () => {
    const picked = await dialog.showOpenDialog(mainWindow!, {
      title: "选择工作目录",
      defaultPath: sessionCwd,
      properties: ["openDirectory", "createDirectory"],
    });
    if (picked.canceled || picked.filePaths.length === 0) {
      return { ok: false, error: "已取消" };
    }
    const dir = picked.filePaths[0]!;
    try {
      await mkdir(dir, { recursive: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `目录不可用（${msg}）` };
    }
    const result = await dispatchApi(session!, "setWorkspaceCwd", [dir]);
    const r = result as { ok?: boolean; error?: string };
    if (r?.ok !== true) {
      return { ok: false, error: r?.error ?? "切换失败" };
    }
    sessionCwd = dir;
    console.log(`[session] 工作目录已切换：${dir}`);
    pushEvent({ t: "ui_action", action: "refresh-info" });
    return { ok: true, path: dir };
  });
  // 弹层子窗口里切会话：主窗口靠 sessions-changed 触发 applyRemoteSwitch（reset + 重拉）
  handle(IPC.SWITCH_TO, "switchTo", "sessions-changed");
  handle(IPC.PAUSE, "pause");
  handle(IPC.RESUME, "resume");
  handle(IPC.GET_USAGE, "getUsage");
  handle(IPC.NEW_SESSION, "newSession");
  handle(IPC.SWITCH_SESSION, "switchSession");
  handle(IPC.LIST_SESSIONS, "listSessions");
  // 「历史会话」：磁盘持久化清单只读、删除无窗口副作用，直接走 dispatcher
  handle(IPC.LIST_PERSISTED_SESSIONS, "listPersistedSessions");
  handle(IPC.DELETE_SESSION, "deleteSession");
  handle(IPC.LIST_FILES, "listFiles");
  handle(IPC.LIST_MODELS, "listModels");
  handle(IPC.LIST_CUSTOM_MODELS, "listCustomModels");

  // ── 内部浏览器面板 ──
  // 不走 dispatchApi（SessionManager 不碰 Electron UI，与弹层同一归类）。
  // 状态变化由 browser-view 的 listener 经 PUSH 通道 browser_state 回推渲染层。
  BrowserPanel.setBrowserStateListener((s) => {
    pushEvent({ t: "browser_state", ...s });
  });
  // ── 手机镜像面板 ──
  // 与浏览器面板同一归类：不碰 SessionManager，事件经 PUSH 通道回推。
  // 面板间互斥（原生 WebContentsView 会盖住渲染层 DOM 面板）在这里做，
  // 渲染层只管自己的开关意图。
  PhoneMirror.setPhoneStateListener((s) => {
    pushEvent({ t: "phone_state", ...s });
  });
  PhoneMirror.setPhoneFrameListener((f) => {
    pushEvent({ t: "phone_frame", ...f });
  });
  ipcMain.handle(IPC.PHONE_OPEN, async () => {
    if (mainWindow === null || mainWindow.isDestroyed()) return;
    BrowserPanel.close();
    PhoneMirror.open();
    ensureBrowserWindowHeight();
  });
  ipcMain.handle(IPC.PHONE_CLOSE, async () => {
    PhoneMirror.close();
  });
  ipcMain.handle(IPC.PHONE_TAP, async (_e: IpcMainInvokeEvent, x: unknown, y: unknown) => {
    await PhoneMirror.tap(x, y);
  });
  ipcMain.handle(
    IPC.PHONE_SWIPE,
    async (_e: IpcMainInvokeEvent, x1: unknown, y1: unknown, x2: unknown, y2: unknown, durationMs: unknown) => {
      await PhoneMirror.swipe(x1, y1, x2, y2, durationMs);
    },
  );
  ipcMain.handle(IPC.PHONE_KEY, async (_e: IpcMainInvokeEvent, keycode: unknown) => {
    await PhoneMirror.key(keycode);
  });
  ipcMain.handle(IPC.PHONE_REFRESH, async () => {
    PhoneMirror.refresh();
  });
  ipcMain.handle(IPC.BROWSER_OPEN, async (_e: IpcMainInvokeEvent, url: unknown) => {
    if (mainWindow === null || mainWindow.isDestroyed()) return;
    BrowserPanel.open(mainWindow, typeof url === "string" && url.length > 0 ? url : undefined);
    ensureBrowserWindowHeight();
  });
  ipcMain.handle(IPC.BROWSER_NEW_TAB, async (_e: IpcMainInvokeEvent, url: unknown) => {
    if (mainWindow === null || mainWindow.isDestroyed()) return;
    BrowserPanel.newTab(typeof url === "string" && url.trim().length > 0 ? url.trim() : undefined);
    ensureBrowserWindowHeight();
  });
  ipcMain.handle(IPC.BROWSER_CLOSE_TAB, async (_e: IpcMainInvokeEvent, id: unknown) => {
    if (typeof id === "string") BrowserPanel.closeTab(id);
  });
  ipcMain.handle(IPC.BROWSER_SWITCH_TAB, async (_e: IpcMainInvokeEvent, id: unknown) => {
    if (typeof id === "string") BrowserPanel.switchTab(id);
  });
  ipcMain.handle(IPC.BROWSER_CLOSE, async () => {
    BrowserPanel.close();
  });
  ipcMain.handle(IPC.BROWSER_NAVIGATE, async (_e: IpcMainInvokeEvent, input: unknown) => {
    if (typeof input === "string") BrowserPanel.navigate(input);
  });
  ipcMain.handle(IPC.BROWSER_BACK, async () => BrowserPanel.back());
  ipcMain.handle(IPC.BROWSER_FORWARD, async () => BrowserPanel.forward());
  ipcMain.handle(IPC.BROWSER_RELOAD, async () => BrowserPanel.reload());
  ipcMain.handle(IPC.BROWSER_STOP, async () => BrowserPanel.stop());
  ipcMain.handle(IPC.BROWSER_SET_RECT, async (_e: IpcMainInvokeEvent, rect: unknown) => {
    BrowserPanel.setRect(rect);
  });

  // 听写不属于 SessionManager（独立 helper 进程），不走 dispatchApi：
  ipcMain.handle(IPC.DICTATE_START, async () => {
    if (dictation === null) return;
    // 已在听写：先停旧的再开新的（避免双进程抢麦克风）
    if (dictation.isDictating) dictation.stop();
    dictation.start();
  });
  ipcMain.handle(IPC.DICTATE_STOP, async () => {
    dictation?.stop();
  });

  // 窗口自适应高度（Composer-only 布局）：渲染层量出内容高度后调这里，
  // 主进程把窗口收到正好包住内容。宽度保持用户当前值；高度夹在合理区间防抖。
  // 浏览器面板打开时渲染层根容器是 100vh、面板区 flex-1：RO 上报的是视口高度，
  // 下限提到 BROWSER_MIN_WINDOW_HEIGHT（防 Composer 被挤出视口），上限放开到
  // 2000（用户最大化时上报视口高度，不能被 800 钳回去跟用户抢窗口）。
  ipcMain.handle(IPC.RESIZE_WINDOW, async (_e: IpcMainInvokeEvent, height: unknown) => {
    if (mainWindow === null || mainWindow.isDestroyed()) return;
    const h = typeof height === "number" ? Math.round(height) : NaN;
    if (!Number.isFinite(h)) return;
    const browserOpen = BrowserPanel.isOpen();
    const minH = browserOpen ? BROWSER_MIN_WINDOW_HEIGHT : 120;
    const maxH = browserOpen ? 2000 : 800;
    const clamped = Math.min(Math.max(h, minH), maxH);
    const [width] = mainWindow.getContentSize();
    const [, currentHeight] = mainWindow.getContentSize();
    if (Math.abs(currentHeight - clamped) >= 1) {
      mainWindow.setContentSize(width, clamped);
    }
  });

  // ── 菜单弹层子窗口 ──
  // 弹层渲染在独立无边框窗口里，浮在触发按钮下方 → 主窗口（白底）高度完全不动。
  // 同一 id 已打开时再次调用 = toggle 关闭；首次显示等渲染层上报高度后再 show，
  // 避免闪一个空窗口。showInactive 不抢主窗口焦点，用户可以继续打字。
  ipcMain.handle(IPC.OPEN_POPOVER, async (_e: IpcMainInvokeEvent, req: unknown) => {
    const r = req as { id?: unknown; x?: unknown; y?: unknown; width?: unknown; triggerTop?: unknown };
    const id = typeof r?.id === "string" ? r.id : null;
    const x = typeof r?.x === "number" ? Math.round(r.x) : NaN;
    const y = typeof r?.y === "number" ? Math.round(r.y) : NaN;
    const width = typeof r?.width === "number" ? Math.round(r.width) : NaN;
    if (id === null || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width)) return;
    // toggle：同一按钮再点一次 = 关
    if (popoverWin !== null && popoverId === id) {
      closePopoverWin();
      return;
    }
    // toggle 竞态宽限：弹层获得过焦点时，点触发按钮会先走 popover blur（关闭），
    // 随后的 click 又请求打开同一 id —— 300ms 内视为同一次 toggle，不再重开。
    if (id === popoverLastId && Date.now() - popoverClosedAt < 300) return;
    closePopoverWin();
    if (mainWindow === null || mainWindow.isDestroyed()) return;
    // 位置夹到屏幕工作区内（弹层不能飘出屏幕）。这里只定初始 stub（40px 高）；
    // 真实高度在 POPOVER_HEIGHT 上报时才定，届时下方放不下会翻到按钮上方。
    const display = screen.getDisplayMatching({ x, y, width, height: 40 });
    const work = display.workArea;
    const cx = Math.min(Math.max(x, work.x), work.x + work.width - width);
    const cy = Math.min(Math.max(y, work.y), work.y + work.height - 80);
    popoverId = id;
    popoverPos = {
      x: cx,
      y: cy,
      width,
      rawY: y,
      triggerTop: typeof r?.triggerTop === "number" ? Math.round(r.triggerTop) : null,
      flipped: false,
    };
    const win = new BrowserWindow({
      x: cx,
      y: cy,
      width,
      height: 40,
      // 无边框 + 白底面板（用户定调：窗口保持白底，不用透明）。
      // hasShadow 默认 true，frameless 矩形白板 + 系统投影，观感接近原生菜单。
      frame: false,
      backgroundColor: "#ffffff",
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      title: "c-agent popover",
      parent: mainWindow,
      webPreferences: {
        preload: path.join(deps.__dirname, "..", "preload", "preload.cjs"),
        contextIsolation: true,
        sandbox: false,
        nodeIntegration: false,
      },
    });
    popoverWin = win;
    win.on("closed", () => {
      // 只清自己：弹层内换弹层时 destroy 旧窗的 closed 可能晚于新窗赋值到达，
      // 无条件清空会把新弹层的跟踪状态抹掉（高度上报从此 no-op，窗口永远不显示）。
      if (popoverWin === win) {
        popoverWin = null;
        popoverId = null;
        popoverPos = null;
      }
    });
    // 失焦即关：点主窗口 / 点桌面 / 点别的 app 都收起（showInactive 下一般不触发，双保险）
    win.on("blur", () => {
      if (popoverWin === win) closePopoverWin();
    });
    const query = `popover=${id}`;
    await loadRenderer(popoverWin, deps, { search: query });
  });

  ipcMain.handle(IPC.CLOSE_POPOVER, async () => {
    closePopoverWin();
  });

  ipcMain.handle(IPC.POPOVER_HEIGHT, async (_e: IpcMainInvokeEvent, h: unknown) => {
    if (popoverWin === null || popoverWin.isDestroyed() || popoverPos === null) return;
    const height = typeof h === "number" ? Math.round(h) : NaN;
    if (!Number.isFinite(height) || height <= 0) return;
    const GAP = 6; // 与渲染层 openPopoverAt 的按钮-弹层间距一致
    const work = screen.getDisplayMatching({ ...popoverPos, height }).workArea;
    const workBottom = work.y + work.height;
    // 下方空间：从渲染层请求的原始 y（按钮 bottom + 间距）到工作区底部。
    // 用 rawY 而非夹过的 popoverPos.y——主窗口贴屏幕底时 cy 被上夹，会虚增下方空间。
    const spaceBelow = Math.max(40, workBottom - popoverPos.rawY);
    // 上方空间：按钮顶边上方到工作区顶
    const spaceAbove =
      popoverPos.triggerTop !== null ? Math.max(0, popoverPos.triggerTop - GAP - work.y) : 0;
    // 首次排布：下方放不下、且上方更宽裕 → 整体翻到按钮上方。
    // 只在窗口显示前决策一次：显示后再改方向 = 整个弹层从按钮下方跳到上方。
    // 表单类弹层内容高度会动态变化（如自定义模型拉到模型列表后变高），
    // 后续高度增长一律沿当前方向伸缩 + 夹屏幕边界，超出部分由渲染层内部滚动。
    if (
      !popoverPos.flipped &&
      !popoverWin.isVisible() &&
      height > spaceBelow &&
      spaceAbove > spaceBelow
    ) {
      popoverPos.flipped = true;
    }
    if (popoverPos.flipped && popoverPos.triggerTop !== null) {
      // 上方排布：窗口底边固定在按钮顶上方 GAP 处，高度向上扩展
      const flipH = Math.min(height, Math.max(40, spaceAbove));
      const flipY = popoverPos.triggerTop - GAP - flipH;
      popoverPos.y = flipY;
      popoverWin.setBounds({
        x: popoverPos.x,
        y: flipY,
        width: popoverPos.width,
        height: flipH,
      });
    } else {
      // 下方排布：高度不能超出屏幕底部（popoverPos.y 就是弹层窗口顶部）
      const maxH = Math.max(40, workBottom - popoverPos.y);
      popoverWin.setContentSize(popoverPos.width, Math.min(height, maxH));
    }
    if (!popoverWin.isVisible()) {
      if (popoverId === "custom-model") {
        // 表单类弹层要打字：show + focus 拿键盘焦点（autoFocus 的输入框直接可输入）；
        // 菜单类弹层 showInactive 不抢主窗口焦点，用户可以继续打字。
        popoverWin.show();
        popoverWin.focus();
      } else {
        popoverWin.showInactive();
      }
    }
  });

  // 弹层子窗口 → 主进程 → 主窗口渲染层的 UI 动作（refresh-info 刷新头部信息等）
  ipcMain.handle(IPC.UI_ACTION, async (_e: IpcMainInvokeEvent, action: unknown) => {
    if (typeof action !== "string") return;
    pushEvent({ t: "ui_action", action });
  });
}

/**
 * Permission 支柱：审批弹窗（原生 modal dialog，主窗口内模态）。
 * 三个选项：本次允许 / 本会话内该工具不再询问 / 拒绝（cancel/Esc = 拒绝）。
 * 窗口不可用时（已销毁/最小化到托盘）fail-safe 返回 deny。
 */
const approvalPrompt: NonNullable<SessionDeps["approvalPrompt"]> = async ({ toolName, args }) => {
  if (mainWindow === null || mainWindow.isDestroyed()) return "deny";
  mainWindow.show();
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: "warning",
    message: `允许执行 ${toolName}？`,
    detail: args.length > 0 ? args : undefined,
    buttons: ["允许", `本会话内 ${toolName} 不再询问`, "拒绝"],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });
  return response === 0 ? "allow" : response === 1 ? "always" : "deny";
};

async function createWindow(deps: StartDeps): Promise<void> {
  // 关窗常驻时 dock 图标被收起（见 window-all-closed），重开窗口要还回来，
  // 否则应用退到纯菜单栏形态后没有 Dock 入口
  if (process.platform === "darwin" && app.dock !== undefined && !app.dock.isVisible()) {
    void app.dock.show();
  }
  // 渲染层只有浅色主题（globals.css 没有 .dark 切换），强制 nativeTheme 跟浅色，
  // 避免系统深色模式下原生标题栏发黑、跟白色 UI 割裂。
  nativeTheme.themeSource = "light";
  mainWindow = new BrowserWindow({
    // 默认宽度跟 minWidth 一致（720），窄一点更像 Composer；用户可拖宽
    width: 720,
    // 初始高度≈拖动条(40)+Composer 自然高度；渲染层挂载后会经 RESIZE_WINDOW 精调
    height: 240,
    minWidth: 720,
    minHeight: 120,
    title: "c-agent desktop",
    // 标题栏底色跟渲染层浅色主题保持一致（白）。试过 transparent: true 让弹层区域
    // 透出桌面，用户实测后不要——保持白底；弹层空间由渲染层 spacer 撑高窗口解决。
    backgroundColor: "#ffffff",
    // 标题栏：两侧平台各走各的方案，渲染层 StatusBar 统一兼任标题栏内容——
    // - macOS：hiddenInset 隐藏原生标题栏，红绿灯浮在 StatusBar 左侧（pl-20 留位）。
    // - Windows：hidden + titleBarOverlay（WCO，Window Controls Overlay）——左侧整块
    //   交给渲染层自定义（logo / 文字 / 底色随便改），右侧保留原生 最小化/最大化/关闭。
    //   注意 hiddenInset 在 Windows 上不生效（会回退成原生标题栏），必须用这组。
    //   height 需跟 StatusBar 实际高度对齐（py-2 + text-xs ≈ 33px），按钮才垂直居中。
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" as const }
      : {
          titleBarStyle: "hidden" as const,
          titleBarOverlay: { color: "#ffffff", symbolColor: "#000000", height: 33 },
        }),
    webPreferences: {
      // deps.__dirname = desktop/main（entry.mjs 所在目录）；preload 源在 desktop/preload，
      // 只上一层 .. 即 desktop/，再进 preload/。之前误用两层 .. 会退到仓库根 g/，加载失败。
      preload: path.join(deps.__dirname, "..", "preload", "preload.cjs"),
      contextIsolation: true,
      // 关掉 JS 层 sandbox：OS 层 sandbox 已经被 appendSwitch('no-sandbox') 干掉；
      // 这里保留 false 配套，避免 renderer 进程启动时 Chromium 再尝试走 OS sandbox。
      // v1 不分发，单机开发用不上 OS sandbox 的隔离保证 —— 等需要打包分发时再开。
      sandbox: false,
      nodeIntegration: false,
    },
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    closePopoverWin();
    // 浏览器面板视图挂在主窗口 contentView 上：窗口没了视图必须跟着拆，
    // 否则 close() 里的 owner.isDestroyed 保护虽然不炸，但快照/事件还挂着
    BrowserPanel.destroy();
    // 手机镜像轮询随窗口关闭停止（防止后台空转 adb）
    PhoneMirror.shutdown();
  });

  await loadRenderer(mainWindow, deps);
}

/**
 * 定位编译产物里的 connectors-mcp 目录。
 *
 * rootDir 布局决定产物深嵌一层「仓库所在目录名」：`dist/<仓库目录名>/connectors-mcp`。
 * 这个目录名是环境的产物（项目在 g/ 下就叫 g，搬到 c/ 下就叫 c），不能写死——
 * 以前写死 ["dist/g/connectors-mcp", "dist/connectors-mcp"] 两个候选，项目搬到 c/
 * 后两个都落空，connector manifest 复制与桌面端加载全部静默跳过（0 工具无人报错）。
 * 改成扫 dist/ 下各子目录找真正存在的 connectors-mcp（与 entry.mjs resolveDistMain 同坑同修）。
 */
function resolveDistConnectorsDir(distRoot: string): string | null {
  const direct = path.join(distRoot, "connectors-mcp");
  if (existsSync(direct)) return direct;
  try {
    for (const entry of readdirSync(distRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(distRoot, entry.name, "connectors-mcp");
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // dist 不存在（未编译）或读不了，按没有 connector 处理
  }
  return null;
}

/**
 * 解析会话工作目录（与配置锚点 app home 解耦）：
 * 1. config.json 的 `cwd` 字段（用户显式指定的项目文件夹）优先——目录不存在
 *    就 mkdir（recursive 对已存在目录是 no-op），用户指定的意图就是让它可用；
 * 2. 缺省 = 桌面上的中性工作区文件夹 workspace（没有则创建）——刻意不叫
 *    c-agent，避免 agent 把工作区误认成 c-agent 项目本身；MEMORY.md、
 *    相对路径产物都落在这个独立目录，不污染 app home。
 * 缺省只是兜底，不写死：灵活性由 config.json 的 cwd 字段承接。
 * 创建失败不阻断启动——回落 app home 并 console 留痕（与 connectors start
 * 失败同一策略：跳过但不崩）。
 */
async function resolveSessionCwd(): Promise<string> {
  const appHome = process.cwd();
  const configured = await readSavedWorkspaceCwd(appHome);
  const target = configured ?? path.join(os.homedir(), "Desktop", "workspace");
  try {
    await mkdir(target, { recursive: true });
    return target;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[session] 工作目录 ${target} 不可用（${msg}），回落 ${appHome}`);
    return appHome;
  }
}

async function bootstrap(deps: StartDeps): Promise<void> {
  // 文件日志：与 CLI 入口（src/index.ts）接同一条落盘通道。锚 process.cwd()
  // （app home）而非 sessionCwd——会话工作目录可在运行中切换，app home 稳定，
  // 且 config.json / connectors 已锚这里，日志跟它们同址便于排障。
  // initFileLogging 自身绝不抛错，磁盘不可写时静默禁用，不影响启动。
  initFileLogging(process.cwd());
  log.info("desktop", `启动 cwd=${process.cwd()}`);
  // 桌面端没有常驻终端，顶层异常如果不落盘就彻底消失——CLI 有同款兜底。
  process.on("uncaughtException", (err) => log.error("desktop", "uncaughtException", err));
  process.on("unhandledRejection", (reason) => log.error("desktop", "unhandledRejection", reason));

  // 必须放在 app.whenReady() 之前。关掉 Chromium 的 OS-level sandbox（renderer / GPU /
  // network 三个 helper 进程在限制性沙箱里启动时会撞 `sandbox initialization failed:
  // Operation not permitted` 然后连环崩，GPU 报 SIGTRAP 直接拉走主进程）。
  // macOS：WorkBuddy IDE 的注入沙箱导致，CI / Docker 同理，通用修法。
  // Windows：实测（2026-09）本机 GPU 进程也会连环 `exited unexpectedly: exit_code=1`
  // 后 FATAL `GPU process isn't usable. Goodbye.` 退出——GPU 驱动 / 环境注入都可能
  // 触发，且发生在命令行参数够不到的主进程内部，必须在代码里追加。
  // 单机开发工具，v1 不分发，放弃 GPU 加速与 OS sandbox 换「任何启动方式都能起」。
  if (process.platform === "darwin" || process.platform === "win32") {
    app.commandLine.appendSwitch("no-sandbox");
    app.commandLine.appendSwitch("disable-gpu");
  }
  await app.whenReady();

  // 移除默认 ApplicationMenu。Electron 在没显式设置菜单时，会给无菜单应用注入一个
  // 只含 placeholder 的菜单栏（File/Edit/View/Window/Help）——在 macOS 上是顶部全局
  // 菜单，在 Windows 上会嵌进 frameless 窗口的拖动条旁边。c-agent 的 Composer 是
  // 720 宽无边框小窗，不需要这条占位栏；tray 状态菜单（tray-status.ts）走的是
  // Tray.setContextMenu，不受这条影响。
  Menu.setApplicationMenu(null);

  // 全窗口的外链与导航护栏（markdown 渲染后 <a> 可点，必须有这一层）：
  // - window.open / target=_blank 一律拒绝建新 Electron 窗，http(s) 转系统默认浏览器；
  // - 页内导航（will-navigate）一律拦掉——三个窗口都是单页应用，任何导航企图都是异常。
  // 例外：内部浏览器面板的 webContents——页内导航是它的本职，必须豁免（见 browser-view.ts）。
  // 识别靠「创建期标志」：web-contents-created 在 WebContentsView 构造函数内同步派发，
  // 那一刻 isCreatingBrowserView() 为 true，事后 WeakSet 认账。
  // 挂在 web-contents-created 上：主窗口、弹层、消息弹窗（及未来新窗）全覆盖。
  app.on("web-contents-created", (_event, contents) => {
    if (BrowserPanel.isCreatingBrowserView()) {
      BrowserPanel.markBrowserContents(contents);
    }
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    if (BrowserPanel.isBrowserContents(contents)) return; // 浏览器面板：放行页内导航
    contents.on("will-navigate", (e) => e.preventDefault());
  });

  // 模型持久化（与 CLI 共用 .c-agent/config.json，单一持久化出口）：
  // MODEL env 显式设置时不读持久值（优先级与 CLI 一致）；spec 与自定义模型
  // 完整参数互斥存同一文件（最后一次的选择是唯一真相），读到的交给
  // SessionManager 恢复，缺 key 会降级 mock，UI 的模型标签如实显示。
  const desktopCwd = process.cwd();
  const modelEnvSet = process.env.MODEL !== undefined;
  const savedModelSpec = modelEnvSet ? null : await readSavedModelSpec(desktopCwd);
  const savedCustomModel =
    modelEnvSet || savedModelSpec !== null ? null : await readSavedCustomModel(desktopCwd);

  // 会话工作目录与配置锚点分离：agent 干活的地方（见 resolveSessionCwd），
  // config / connectors 仍锚在 app home（process.cwd()）——持久化路径不随会话漂移。
  // 赋给模块级 sessionCwd：deps.cwd 闭包与「工作目录」IPC handler 都读它。
  sessionCwd = await resolveSessionCwd();
  console.log(`[session] 工作目录：${sessionCwd}`);

  // 工具型 connector：扫描编译产物里的 connectors-mcp（Loader 会动态 import 编译后的
  // .js；源码 .ts 只有 tsx 运行时能加载，Electron main 里不行），start 后把
  // extraTools 喂给 assembleSession。单个 connector start 失败不阻断启动——
  // 跳过它的工具，console 留痕（与 CLI --connectors 行为一致）。
  // deps.__dirname 是 entry.mjs 所在目录（desktop/main），编译产物在
  // dist/<仓库目录名>/connectors-mcp（rootDir 布局）。必须扫 dist——
  // Loader 动态 import 的是编译后 .js，源码 .ts 在 Electron main 里加载不了
  // （tsx 运行时才行），扫到源码目录只会刷一屏 "Cannot find module .../index.ts"。
  toolRuntime = new ConnectorRuntime({ cwd: desktopCwd });
  const connectorsDir = resolveDistConnectorsDir(path.join(deps.__dirname, "dist"));
  let connectorTools: ReturnType<ConnectorRuntime["extraTools"]> = [];
  if (connectorsDir !== null) {
    const { loaded, failed } = await new ConnectorLoader({ paths: [connectorsDir] }).scan();
    for (const f of failed) {
      console.warn(`[connectors] load failed: ${f.rootDir} -> ${f.error}`);
    }
    for (const c of loaded) toolRuntime.adopt(c);
    const startFailed = await toolRuntime.start();
    if (startFailed.length > 0) {
      console.warn(`[connectors] start failed: ${startFailed.join(", ")}`);
    }
    connectorTools = toolRuntime.extraTools();
    console.log(
      `[connectors] ready: ${connectorTools.length} tools from ${loaded.length} connector(s) (${connectorsDir})`,
    );
  }

  const assembled = await assembleSession({
    cwd: sessionCwd,
    ...(savedModelSpec !== null ? { modelSpec: savedModelSpec } : {}),
    ...(connectorTools.length > 0 ? { extraTools: connectorTools } : {}),
  });
  // 消息显示通路：SessionManager emit → connector 路由 → desktop-display（默认连接）
  // → Electron IPC → 渲染层。Composer 的提交类 IPC（SUBMIT/STEER/…）不经过 connector。
  const emit = await bootstrapDisplayRoute(deps);
  session = new SessionManager(assembled, {
    emit,
    approvalPrompt,
    // cwd 与 state.cwd 同源（resolveSessionCwd 的结果）：info 回传、审批详情、
    // @ 引用 popover 的文件列表都靠它，不能回落 process.cwd() 造成两套 cwd
    cwd: () => sessionCwd,
    // 模型选择落盘（setModel / setEndpoint 触发 spec 版；setCustomModel 触发
    // customModel 版，两者互斥）。写失败只留痕不阻断——与 CLI 同一策略。
    persistModel: (spec) => {
      void saveModelSpec(desktopCwd, spec).catch((err: unknown) => {
        console.error(
          `[session] 模型配置保存失败（${spec}）：${err instanceof Error ? err.message : String(err)}`,
        );
      });
    },
    persistCustomModel: (custom: StoredCustomModel) => {
      void saveCustomModel(desktopCwd, custom).catch((err: unknown) => {
        console.error(
          `[session] 自定义模型保存失败（${custom.id}）：${err instanceof Error ? err.message : String(err)}`,
        );
      });
    },
    // 工作目录变更落盘（setWorkspaceCwd 成功后触发）；写失败只留痕不阻断
    persistWorkspaceCwd: (dir: string) => {
      void saveWorkspaceCwd(desktopCwd, dir).catch((err: unknown) => {
        console.error(
          `[session] 工作目录保存失败（${dir}）：${err instanceof Error ? err.message : String(err)}`,
        );
      });
    },
  });
  // 恢复上次的自定义模型（完整参数重建 ModelRef）。走 setCustomModel 复用
  // 同一条校验/构造/state 同步链路；回写同值幂等，无害。
  if (savedCustomModel !== null) {
    const protocol =
      savedCustomModel.provider === "openai-responses"
        ? ("responses" as const)
        : (savedCustomModel.provider as "openai" | "anthropic" | "gemini");
    try {
      session.setCustomModel({
        baseURL: savedCustomModel.baseUrl,
        apiKey: savedCustomModel.apiKey,
        model: savedCustomModel.id,
        protocol,
        ...(savedCustomModel.contextWindow !== undefined
          ? { contextWindow: String(savedCustomModel.contextWindow) }
          : {}),
      });
      console.error(`提示：模型沿用持久配置（自定义模型 ${savedCustomModel.id}，.c-agent/config.json）`);
    } catch (err: unknown) {
      console.error(
        `[session] 恢复自定义模型失败，回退默认：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  // 预热 /models 元数据：info() 的 contextWindow 优先取提供商给的值，
  // 但 info() 是同步的——不预热的话上下文使用量分母一直停在内置粗表。
  // 拉到新值后广播 refresh-info，UI 重拉 info 刷新进度条分母。
  warmModelsCacheAndNotify();
  // macOS 听写：事件也走显示路由（dictation WireEvent），与 session 事件同一通道
  dictation = new DictationController(
    {
      onEvent: (kind, text, seq) => emit({ t: "dictation", kind, text, seq }),
    },
    // baseDir：entry.mjs 的 desktop/main。resolveHelper 靠它解析 ../native/dictate ——
    // 模块自身 __dirname 在 dist 深嵌目录里（rootDir=仓库根），../native 是错的。
    deps.__dirname,
  );
  registerIpcHandlers(deps);

  // agent 的内部浏览器控制通道：browser_* 工具的后端。闭包实时读当前面板，
  // 面板开关多次无需重注。CLI / print 端不注入 → 工具优雅 fail。
  setBrowserBackend(BrowserPanel.browserBackend());

  await createWindow(deps);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow(deps);
    }
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
    // 显示 connector 里的节流 timer 需要释放；工具型 connector 的 MCP 子进程同样
    void displayRuntime?.dispose();
    displayRuntime = null;
    void toolRuntime?.dispose();
    toolRuntime = null;
  }
  // darwin：app 常驻（tray-status 菜单栏输出还在跑），窗口由 activate / tray 菜单重建。
  // 此前 darwin 也会落到下面的 dispose，导致关窗即拆掉整条显示通路
  // （tray 消失、WS 桥关闭），重新开窗后事件流也接不回来。
  // dock 图标同步收起：关窗 = 退到纯菜单栏形态，Dock 里不再挂着一个没有窗口的 app
  // （用户反馈「x 掉窗口了 Dock 还在」）。重开窗口时 createWindow 里 dock.show() 还回来。
  if (process.platform === "darwin" && app.dock !== undefined) {
    app.dock.hide();
  }
});

/** 由 entry.cjs 调用 */
export function start(deps: StartDeps): void {
  // fail-visible：bootstrap 半途抛错（如 IPC handler 重复注册）不能落成 unhandled
  // rejection 静默继续——应用会带着残缺的 handler 集合跑，表现为「部分功能莫名失效」
  void bootstrap(deps).catch((err) => {
    console.error("[main] bootstrap 失败，退出:", err);
    app.quit();
    process.exitCode = 1;
  });
}
