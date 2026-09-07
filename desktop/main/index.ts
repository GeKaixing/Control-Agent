/**
 * Electron 主进程入口（CJS emit，tsc -p desktop/tsconfig.main.json 编译）。
 *
 * 职责：
 * 1. 创建 BrowserWindow（dev 时连 vite dev server；build 时 loadFile）
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

import { app, BrowserWindow, dialog, ipcMain, nativeTheme, screen, type IpcMainInvokeEvent } from "electron";
import path from "node:path";

import { ConnectorRuntime } from "../../src/connector/runtime/connector-runtime.js";
import { createDisplayRoute, type DisplayRoute } from "../../src/connector/runtime/display-route.js";
import DesktopDisplayConnector from "../../src/connector/connectors/desktop-display/index.js";
import { dispatchApi } from "./api-dispatcher.js";
import WsDisplayBridge from "./ws-bridge.js";
import TrayStatusBridge from "./tray-status.js";
import { IPC } from "./ipc.js";
import { SessionManager, type SessionDeps } from "./session.js";
import { DictationController } from "./dictation.js";
import { assembleSession } from "../../src/session.js";
import type { WireEvent } from "../shared/api.js";

interface StartDeps {
  __dirname: string;
}

let mainWindow: BrowserWindow | null = null;
let session: SessionManager | null = null;
let dictation: DictationController | null = null;
/** 消息显示的 connector runtime；「默认连接」的 desktop-display connector 也注册在这里 */
let displayRuntime: ConnectorRuntime | null = null;
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
    // 用户可拖到任意角落、可拖大小；不进任务栏（浮窗形态），不随 app 隐藏
    resizable: true,
    movable: true,
    skipTaskbar: true,
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
  if (IS_DEV) {
    void msgWin.loadURL(`${RENDERER_DEV_URL}?${query}`);
  } else {
    const indexHtml = path.join(deps.__dirname, "..", "renderer-dist", "index.html");
    void msgWin.loadFile(indexHtml, { search: query });
  }
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
  // 弹层子窗口里切会话：主窗口靠 sessions-changed 触发 applyRemoteSwitch（reset + 重拉）
  handle(IPC.SWITCH_TO, "switchTo", "sessions-changed");
  handle(IPC.PAUSE, "pause");
  handle(IPC.RESUME, "resume");
  handle(IPC.GET_USAGE, "getUsage");
  handle(IPC.NEW_SESSION, "newSession");
  handle(IPC.SWITCH_SESSION, "switchSession");
  handle(IPC.LIST_SESSIONS, "listSessions");
  handle(IPC.LIST_FILES, "listFiles");
  handle(IPC.LIST_MODELS, "listModels");

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
  ipcMain.handle(IPC.RESIZE_WINDOW, async (_e: IpcMainInvokeEvent, height: unknown) => {
    if (mainWindow === null || mainWindow.isDestroyed()) return;
    const h = typeof height === "number" ? Math.round(height) : NaN;
    if (!Number.isFinite(h)) return;
    const clamped = Math.min(Math.max(h, 120), 800);
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
    if (IS_DEV) {
      await popoverWin.loadURL(`${RENDERER_DEV_URL}?${query}`);
    } else {
      const indexHtml = path.join(deps.__dirname, "..", "renderer-dist", "index.html");
      await popoverWin.loadFile(indexHtml, { search: query });
    }
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
    // 首次排布：下方放不下、且上方更宽裕 → 整体翻到按钮上方
    if (!popoverPos.flipped && height > spaceBelow && spaceAbove > spaceBelow) {
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
 * 三个选项：本次允许 / 本会话全部允许 / 拒绝（cancel/Esc = 拒绝）。
 * 窗口不可用时（已销毁/最小化到托盘）fail-safe 返回 deny。
 */
const approvalPrompt: NonNullable<SessionDeps["approvalPrompt"]> = async ({ toolName, args }) => {
  if (mainWindow === null || mainWindow.isDestroyed()) return "deny";
  mainWindow.show();
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: "warning",
    message: `允许执行 ${toolName}？`,
    detail: args.length > 0 ? args : undefined,
    buttons: ["允许", "本会话全部允许", "拒绝"],
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
    // macOS：隐藏原生标题栏（保留左上角红绿灯浮在页面上），让渲染层的
    // StatusBar 直接充当标题栏 —— 颜色 / 内容完全由 renderer 自定义。
    // 前提：StatusBar 需留出左侧 pl-20 给红绿灯，并标 drag 区域可拖窗口。
    titleBarStyle: "hiddenInset",
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
  });

  if (IS_DEV) {
    await mainWindow.loadURL(RENDERER_DEV_URL);
  } else {
    // 渲染层 vite build 产物在 desktop/renderer-dist/index.html（相对 desktop/main 上一层）
    const indexHtml = path.join(deps.__dirname, "..", "renderer-dist", "index.html");
    await mainWindow.loadFile(indexHtml);
  }
}

async function bootstrap(deps: StartDeps): Promise<void> {
  // 必须放在 app.whenReady() 之前。关掉 Chromium 的 OS-level sandbox（renderer / GPU /
  // network 三个 helper 进程在限制性沙箱里启动时会撞 `sandbox initialization failed:
  // Operation not permitted` 然后连环崩，GPU 报 SIGTRAP 直接拉走主进程）。
  // CI / Docker / 限制性 sandbox 环境的通用修法。只在 darwin 开：这些限制来自
  // macOS 上 WorkBuddy IDE 的注入沙箱；Windows / Linux 正常环境不需要，
  // no-sandbox 在那边纯属白降安全性。
  if (process.platform === "darwin") {
    app.commandLine.appendSwitch("no-sandbox");
    app.commandLine.appendSwitch("disable-gpu");
  }
  await app.whenReady();

  const assembled = await assembleSession({ cwd: process.cwd() });
  // 消息显示通路：SessionManager emit → connector 路由 → desktop-display（默认连接）
  // → Electron IPC → 渲染层。Composer 的提交类 IPC（SUBMIT/STEER/…）不经过 connector。
  const emit = await bootstrapDisplayRoute(deps);
  session = new SessionManager(assembled, { emit, approvalPrompt });
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
    // 显示 connector 里的节流 timer 需要释放
    void displayRuntime?.dispose();
    displayRuntime = null;
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
