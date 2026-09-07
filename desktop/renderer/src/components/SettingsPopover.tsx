import React, { useRef } from "react";
import { Settings } from "lucide-react";
import { cn } from "../lib/utils";
import { openPopoverAt } from "./ToolsPanel";

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
 * 「设置」弹层内容，渲染在弹层子窗口里（PopoverHost）。
 * 与运行模式弹层不同：切换后不关弹层（开关有回显，refresh-info 由主进程
 * 广播、PopoverHost 重拉 info），用户可以连续调多项再点别处收起。
 */
export function SettingsContent({
  approvalMode,
  autoCompact,
  msgWindow,
  onApprovalModeChange,
  onAutoCompactChange,
  onMsgWindowChange,
}: {
  approvalMode: boolean;
  autoCompact: boolean;
  /** 独立消息弹窗开关状态（info.msgWindow） */
  msgWindow: boolean;
  onApprovalModeChange: (on: boolean) => void;
  onAutoCompactChange: (on: boolean) => void;
  /** 切换独立消息弹窗：主进程创建/销毁小窗 + refresh-info 广播回显 */
  onMsgWindowChange: (on: boolean) => void;
}): React.ReactElement {
  return (
    <div className="w-full overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md">
      <div className="border-b border-border bg-muted/40 px-3 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        设置
      </div>
      <div className="py-1">
        {/* Permission 支柱：审批模式。开启后 write/edit/bash 等改动型工具每次
            执行前弹原生 dialog 询问（含「本会话全部允许」快捷选项）。 */}
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
      </div>
    </div>
  );
}
