/**
 * Electron preload 脚本（CommonJS）。
 *
 * 职责：通过 contextBridge 把主进程的 IPC API 暴露给渲染层。
 *
 * 通道名直接在这里写死，不与主进程共享常量 —— preload 不参与 tsc 编译，
 * 让两边的通道名约定靠"双方字符串完全一致"维护（IPC 是个很稳的固定集合）。
 */

const { contextBridge, ipcRenderer } = require("electron");

const CH = {
  INFO: "desktop:info",
  SUBMIT: "desktop:submit",
  STEER: "desktop:steer",
  ABORT: "desktop:abort",
  ANSWER_ASK: "desktop:answerAsk",
  SET_MODEL: "desktop:setModel",
  SET_CUSTOM_MODEL: "desktop:setCustomModel",
  SET_MODE: "desktop:setMode",
  SET_REASONING: "desktop:setReasoning",
  SET_ENDPOINT: "desktop:setEndpoint",
  PLAN_CONTINUE: "desktop:planContinue",
  SET_APPROVAL_MODE: "desktop:setApprovalMode",
  SET_AUTO_COMPACT: "desktop:setAutoCompact",
  SET_MSG_WINDOW: "desktop:setMsgWindow",
  SET_LOCAL_PREVIEW: "desktop:setLocalPreview",
  SET_ALWAYS_ON_TOP: "desktop:setAlwaysOnTop",
  PAUSE: "desktop:pause",
  RESUME: "desktop:resume",
  GET_USAGE: "desktop:getUsage",
  NEW_SESSION: "desktop:newSession",
  LIST_FILES: "desktop:listFiles",
  LIST_MODELS: "desktop:listModels",
  LIST_CUSTOM_MODELS: "desktop:listCustomModels",
  DICTATE_START: "desktop:dictateStart",
  DICTATE_STOP: "desktop:dictateStop",
  RESIZE_WINDOW: "desktop:resizeWindow",
  OPEN_POPOVER: "desktop:openPopover",
  CLOSE_POPOVER: "desktop:closePopover",
  POPOVER_HEIGHT: "desktop:popoverHeight",
  UI_ACTION: "desktop:uiAction",
  SWITCH_SESSION: "desktop:switchSession",
  SWITCH_TO: "desktop:switchTo",
  LIST_SESSIONS: "desktop:listSessions",
  LIST_PERSISTED_SESSIONS: "desktop:listPersistedSessions",
  DELETE_SESSION: "desktop:deleteSession",
  PUSH: "desktop:push",
};

const api = {
  // 当前平台（darwin / win32 / linux）：渲染层按平台适配标题栏
  // （darwin 红绿灯占位 pl-20；win32 走 WCO，用 windowControlsOverlay 拿按钮宽度）。
  platform: process.platform,
  submit(text, attachments) {
    return ipcRenderer.invoke(CH.SUBMIT, text, attachments ?? []);
  },
  steer(text) {
    return ipcRenderer.invoke(CH.STEER, text);
  },
  abort() {
    return ipcRenderer.invoke(CH.ABORT);
  },
  answerAsk(id, answer) {
    return ipcRenderer.invoke(CH.ANSWER_ASK, id, answer);
  },
  setModel(spec) {
    return ipcRenderer.invoke(CH.SET_MODEL, spec);
  },
  setCustomModel(params) {
    return ipcRenderer.invoke(CH.SET_CUSTOM_MODEL, params);
  },
  setMode(mode) {
    return ipcRenderer.invoke(CH.SET_MODE, mode);
  },
  setReasoning(level) {
    return ipcRenderer.invoke(CH.SET_REASONING, level);
  },
  setEndpoint(endpoint) {
    return ipcRenderer.invoke(CH.SET_ENDPOINT, endpoint);
  },
  planContinue() {
    return ipcRenderer.invoke(CH.PLAN_CONTINUE);
  },
  setApprovalMode(on) {
    return ipcRenderer.invoke(CH.SET_APPROVAL_MODE, on === true);
  },
  setAutoCompact(on) {
    return ipcRenderer.invoke(CH.SET_AUTO_COMPACT, on === true);
  },
  setMsgWindow(on) {
    return ipcRenderer.invoke(CH.SET_MSG_WINDOW, on === true);
  },
  setLocalPreview(on) {
    return ipcRenderer.invoke(CH.SET_LOCAL_PREVIEW, on === true);
  },
  setAlwaysOnTop(on) {
    return ipcRenderer.invoke(CH.SET_ALWAYS_ON_TOP, on === true);
  },
  pause() {
    return ipcRenderer.invoke(CH.PAUSE);
  },
  resume() {
    return ipcRenderer.invoke(CH.RESUME);
  },
  getUsage() {
    return ipcRenderer.invoke(CH.GET_USAGE);
  },
  newSession() {
    return ipcRenderer.invoke(CH.NEW_SESSION);
  },
  listFiles(query) {
    return ipcRenderer.invoke(CH.LIST_FILES, query ?? "");
  },
  listModels(endpoint, refresh) {
    return ipcRenderer.invoke(CH.LIST_MODELS, endpoint, refresh === true);
  },
  listCustomModels(params) {
    return ipcRenderer.invoke(CH.LIST_CUSTOM_MODELS, params);
  },
  startDictation() {
    return ipcRenderer.invoke(CH.DICTATE_START);
  },
  stopDictation() {
    return ipcRenderer.invoke(CH.DICTATE_STOP);
  },
  resizeWindow(height) {
    return ipcRenderer.invoke(CH.RESIZE_WINDOW, height);
  },
  openPopover(req) {
    return ipcRenderer.invoke(CH.OPEN_POPOVER, req);
  },
  closePopover() {
    return ipcRenderer.invoke(CH.CLOSE_POPOVER);
  },
  popoverSetHeight(h) {
    return ipcRenderer.invoke(CH.POPOVER_HEIGHT, h);
  },
  uiAction(action) {
    return ipcRenderer.invoke(CH.UI_ACTION, action);
  },
  switchSession(delta) {
    return ipcRenderer.invoke(CH.SWITCH_SESSION, delta);
  },
  switchTo(index) {
    return ipcRenderer.invoke(CH.SWITCH_TO, index);
  },
  listSessions() {
    return ipcRenderer.invoke(CH.LIST_SESSIONS);
  },
  listPersistedSessions() {
    return ipcRenderer.invoke(CH.LIST_PERSISTED_SESSIONS);
  },
  deleteSession(id) {
    return ipcRenderer.invoke(CH.DELETE_SESSION, id);
  },
  info() {
    return ipcRenderer.invoke(CH.INFO);
  },
  onEvent(cb) {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on(CH.PUSH, handler);
    // 返回 unsubscribe
    return () => ipcRenderer.removeListener(CH.PUSH, handler);
  },
};

contextBridge.exposeInMainWorld("api", api);
