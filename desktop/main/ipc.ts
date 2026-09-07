/**
 * IPC 通道常量集中地。渲染层通过 preload 暴露的 api 间接调用 ipcMain.handle，
 * 通道名约定：`desktop:<动词>`，避免与潜在外部 schema 冲突。
 *
 * 注：原在这里的 TextFlusher（text_delta 节流）已迁移到
 * `src/connector/connectors/desktop-display/`——消息 UI 的实现归 connector，
 * 本文件只保留 IPC 通道名这类「传输约定」。
 */

export const IPC = {
  INFO: "desktop:info",
  SUBMIT: "desktop:submit",
  STEER: "desktop:steer",
  ABORT: "desktop:abort",
  SET_MODEL: "desktop:setModel",
  /** 「自定义模型」弹窗：接口地址 + API KEY + 模型名称（OpenAI 兼容） */
  SET_CUSTOM_MODEL: "desktop:setCustomModel",
  SET_MODE: "desktop:setMode",
  SET_REASONING: "desktop:setReasoning",
  SET_ENDPOINT: "desktop:setEndpoint",
  PLAN_CONTINUE: "desktop:planContinue",
  /** Permission 支柱：审批模式开关（mutating 工具执行前逐次询问） */
  SET_APPROVAL_MODE: "desktop:setApprovalMode",
  /** Context 支柱：自动压缩上下文（compact）开关 */
  SET_AUTO_COMPACT: "desktop:setAutoCompact",
  /** 独立消息弹窗开关（默认不开启）：开启时主进程创建独立小窗实时显示回复流 */
  SET_MSG_WINDOW: "desktop:setMsgWindow",
  PAUSE: "desktop:pause",
  RESUME: "desktop:resume",
  GET_USAGE: "desktop:getUsage",
  NEW_SESSION: "desktop:newSession",
  LIST_FILES: "desktop:listFiles",
  /** 拉取端点可用模型列表（OpenAI 兼容 /models；URL 可由 env 配置覆盖） */
  LIST_MODELS: "desktop:listModels",
  /** macOS 听写：开始 / 停止（结果经 PUSH 通道的 dictation 事件流回） */
  DICTATE_START: "desktop:dictateStart",
  DICTATE_STOP: "desktop:dictateStop",
  /** 渲染层内容高度变化 → 主进程把窗口高度收缩到正好包住内容（Composer-only 布局） */
  RESIZE_WINDOW: "desktop:resizeWindow",
  /** 菜单弹层子窗口：打开（同 id 再调 = toggle 关）/ 关闭 / 内容高度上报 */
  OPEN_POPOVER: "desktop:openPopover",
  CLOSE_POPOVER: "desktop:closePopover",
  POPOVER_HEIGHT: "desktop:popoverHeight",
  /** 弹层子窗口 → 主窗口渲染层的 UI 动作（经 PUSH 通道转发 { t:"ui_action" }） */
  UI_ACTION: "desktop:uiAction",
  SWITCH_SESSION: "desktop:switchSession",
  /** 「选择会话」popover：跳转到指定下标的会话 / 拉会话清单（含标题） */
  SWITCH_TO: "desktop:switchTo",
  LIST_SESSIONS: "desktop:listSessions",
  /** 主进程 → 渲染进程：流式推送 WireEvent（由 desktop-display connector 产生） */
  PUSH: "desktop:push",
} as const;
