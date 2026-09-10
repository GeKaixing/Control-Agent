import React, { useRef, useState } from "react";
import { Settings } from "lucide-react";
import { cn } from "../lib/utils";
import { openPopoverAt } from "./ToolsPanel";

/** 输入提示行开关的 localStorage key（渲染层本地偏好，Composer 与设置弹层共用） */
export const COMPOSER_HINTS_KEY = "c-agent.composer.hints";

/** 读输入提示行开关；缺省/读取失败视为显示（默认行为不变） */
export function readComposerHints(): boolean {
  try {
    return localStorage.getItem(COMPOSER_HINTS_KEY) !== "0";
  } catch {
    return true;
  }
}

/**
 * 「设置」触发按钮（齿轮）：渲染在 Composer 底部状态栏（模型 / 模式 / 上下文
 * 那一排）左簇末尾，点击打开弹层子窗口。尺寸与其余触发按钮一致。
 */
export function SettingsButton(): React.ReactElement {
  const ref = useRef<HTMLButtonElement | null>(null);
  return (
    <button
      type="button"
      ref={ref}
      data-popover-trigger="settings"
      onClick={() => openPopoverAt("settings", ref.current, 288)}
      title="设置"
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
    >
      <Settings className="h-4 w-4" />
    </button>
  );
}

/** 开关行的共用视觉（与运行模式弹层的审批开关同一套）。 */
function ToggleRow({
  on,
  label,
  desc,
  onClick,
}: {
  on: boolean;
  label: string;
  desc: string;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] hover:bg-accent/40"
    >
      <span
        className={cn(
          "flex h-3.5 w-6 shrink-0 items-center rounded-full px-0.5 transition-colors",
          on ? "bg-emerald-600" : "bg-muted-foreground/30",
        )}
      >
        <span className={cn("h-2.5 w-2.5 rounded-full bg-white transition-transform", on && "translate-x-2.5")} />
      </span>
      <span className="flex-1">
        <div className={cn("font-medium", on && "text-emerald-700")}>{label}</div>
        <div className="text-[10px] text-muted-foreground">{desc}</div>
      </span>
    </button>
  );
}

/**
 * 「输入提示行」开关：控制 Composer 底部快捷键提示 footer 的显隐。
 * 纯渲染层偏好，localStorage 持久化——弹层子窗口与主窗口同源共享同一份
 * localStorage，主窗口 Composer 靠 storage 事件感知变化。
 */
function ComposerHintsToggle(): React.ReactElement {
  const [on, setOn] = useState<boolean>(() => readComposerHints());
  return (
    <ToggleRow
      on={on}
      label="输入提示行"
      desc={on ? "已开启：输入框底部显示快捷键与字数" : "关闭中：隐藏快捷键提示 footer"}
      onClick={() => {
        const next = !on;
        setOn(next);
        try {
          localStorage.setItem(COMPOSER_HINTS_KEY, next ? "1" : "0");
        } catch {
          // localStorage 不可用：仅本次会话内无效，不阻塞开关
        }
      }}
    />
  );
}

/**
 * 「工作目录」行：显示当前会话工作目录（info.cwd），「更改」按钮打开系统
 * 目录选择对话框（主进程 dialog），选中即切换并落盘。切换失败（任务运行中 /
 * 目录不可创建 / 取消）时在描述行就地显示原因，不打断弹层。
 */
function WorkspaceDirRow({
  cwd,
  onPick,
}: {
  cwd: string;
  /** 返回 null = 成功（refresh-info 广播后 cwd 回显）；返回字符串 = 失败原因 */
  onPick: () => Promise<string | null>;
}): React.ReactElement {
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px]">
      <span className="min-w-0 flex-1">
        <div className="font-medium">工作目录</div>
        <div className="truncate text-[10px] text-muted-foreground" title={error ?? cwd}>
          {error ?? cwd}
        </div>
      </span>
      <button
        type="button"
        onClick={() => {
          setError(null);
          void onPick().then((err) => {
            if (err !== null) setError(err);
          });
        }}
        className="shrink-0 rounded-md border border-border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
      >
        更改
      </button>
    </div>
  );
}

/**
 * 「设置」弹层内容，渲染在弹层子窗口里（PopoverHost）。
 * 与运行模式弹层不同：切换后不关弹层（开关有回显，refresh-info 由主进程
 * 广播、PopoverHost 重拉 info），用户可以连续调多项再点别处收起。
 */
export function SettingsContent({
  approvalMode,
  autoCompact,
  msgWindow,
  localPreview,
  alwaysOnTop,
  workspaceCwd,
  onApprovalModeChange,
  onAutoCompactChange,
  onMsgWindowChange,
  onLocalPreviewChange,
  onAlwaysOnTopChange,
  onPickWorkspaceCwd,
}: {
  approvalMode: boolean;
  autoCompact: boolean;
  /** 独立消息弹窗开关状态（info.msgWindow） */
  msgWindow: boolean;
  /** agent 本地服务预览开关状态（info.localPreview），默认关闭 */
  localPreview: boolean;
  /** 窗口置顶开关状态（info.alwaysOnTop），默认关闭 */
  alwaysOnTop: boolean;
  /** 当前会话工作目录（info.cwd），「工作目录」行的显示值 */
  workspaceCwd: string;
  onApprovalModeChange: (on: boolean) => void;
  onAutoCompactChange: (on: boolean) => void;
  /** 切换独立消息弹窗：主进程创建/销毁小窗 + refresh-info 广播回显 */
  onMsgWindowChange: (on: boolean) => void;
  /** 切换本地服务预览：refresh-info 广播后回显开关 */
  onLocalPreviewChange: (on: boolean) => void;
  /** 切换窗口置顶：主进程 setAlwaysOnTop + refresh-info 广播回显 */
  onAlwaysOnTopChange: (on: boolean) => void;
  /** 打开目录选择对话框切换工作目录；返回失败原因（成功返回 null） */
  onPickWorkspaceCwd: () => Promise<string | null>;
}): React.ReactElement {
  return (
    <div className="w-full overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md">
      <div className="border-b border-border bg-muted/40 px-3 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        设置
      </div>
      <div className="py-1">
        {/* Permission 支柱：审批模式。开启后 write/edit/bash 等改动型工具每次
            执行前弹原生 dialog 询问（含「本会话内该工具不再询问」快捷选项）。 */}
        <ToggleRow
          on={approvalMode}
          label="执行前询问（审批模式）"
          desc={approvalMode ? "write / edit / bash 执行前弹窗放行" : "关闭中：改动型工具直接执行，不询问"}
          onClick={() => onApprovalModeChange(!approvalMode)}
        />
        {/* Context 支柱：自动压缩。关闭后上下文越线只做机械裁剪，
            不再让模型花 token 写摘要（长会话想省 token / 不想被摘要丢信息时关）。 */}
        <ToggleRow
          on={autoCompact}
          label="自动压缩上下文"
          desc={autoCompact ? "上下文越线时模型自动摘要续写" : "关闭中：越线只做机械裁剪，不摘要"}
          onClick={() => onAutoCompactChange(!autoCompact)}
        />
        {/* 独立消息弹窗：独立无边框小窗实时显示 agent 回复流，默认不开启。
            与上面两个开关不同：切换会创建/销毁窗口（偏好同存 SessionManager）。 */}
        <ToggleRow
          on={msgWindow}
          label="独立消息弹窗"
          desc={msgWindow ? "已开启：小窗实时显示回复，可拖动、独立存在" : "关闭中：开启后可单独查看消息流"}
          onClick={() => onMsgWindowChange(!msgWindow)}
        />
        {/* agent 本地服务预览：开启后状态栏出现「本地服务」入口，列出 agent 在
            bash 里启动的本地服务（localhost 地址），默认不开启。 */}
        <ToggleRow
          on={localPreview}
          label="agent开启的本地服务预览"
          desc={
            localPreview
              ? "已开启：状态栏显示本地服务入口，可预览服务页面"
              : "关闭中：不显示 agent 启动的本地服务"
          }
          onClick={() => onLocalPreviewChange(!localPreview)}
        />
        {/* 窗口置顶：开启后主窗口始终浮在所有窗口之上，默认不开启。
            Windows / macOS 都是系统级 always-on-top（macOS floating 级别）。 */}
        <ToggleRow
          on={alwaysOnTop}
          label="窗口置顶"
          desc={
            alwaysOnTop
              ? "已开启：窗口始终显示在其他窗口前面"
              : "关闭中：开启后窗口保持最前显示"
          }
          onClick={() => onAlwaysOnTopChange(!alwaysOnTop)}
        />
        {/* 工作目录：agent 干活的地方（工具相对路径 / 产物 / MEMORY.md 的落点）。
            缺省 = 桌面上的 workspace；「更改」走系统目录对话框，立即生效并落盘。 */}
        <WorkspaceDirRow cwd={workspaceCwd} onPick={onPickWorkspaceCwd} />
        {/* 输入提示行：纯渲染层偏好（localStorage），不走主进程——
            与上面的开关不同，不需要 refresh-info 回显（组件自有 state）。 */}
        <ComposerHintsToggle />
      </div>
    </div>
  );
}
