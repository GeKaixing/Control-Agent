import React, { useEffect, useRef, useState } from "react";
import { MessagesSquare } from "lucide-react";
import { cn } from "../lib/utils";
import { openPopoverAt } from "./ToolsPanel";
import type { ListSessionsResult } from "../../../shared/api";

/**
 * 「选择会话」触发按钮：显示「会话 N/M」角标，点击打开弹层子窗口（与其他菜单弹层同构）。
 * 角标数据独立拉 listSessions：挂载时 + 收到 ui_action("sessions-changed")
 * （弹层子窗口里切完会话后主窗口会收到广播）+ 每次点击时兜底刷新。
 */
export function SessionPicker(): React.ReactElement {
  const ref = useRef<HTMLButtonElement | null>(null);
  const [data, setData] = useState<ListSessionsResult | null>(null);

  const refresh = (): void => {
    void window.api.listSessions().then(setData);
  };

  useEffect(() => {
    refresh();
    return window.api.onEvent((e) => {
      if (e.t === "ui_action" && e.action === "sessions-changed") refresh();
    });
  }, []);

  return (
    <button
      type="button"
      ref={ref}
      data-popover-trigger="sessions"
      onClick={() => {
        refresh();
        openPopoverAt("sessions", ref.current, 288);
      }}
      title="选择会话"
      className="flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 text-[12px] text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
    >
      <MessagesSquare className="h-3.5 w-3.5" />
      <span className="font-medium text-foreground">
        {data !== null ? `会话 ${data.index + 1}/${data.total}` : "会话"}
      </span>
    </button>
  );
}

/**
 * 「选择会话」弹层内容，渲染在弹层子窗口里（PopoverHost）。
 * 点任一条跳转过去：switchTo 成功后主进程广播 ui_action("sessions-changed")，
 * 主窗口收到后重置视图、重拉 info/usage 并刷新触发按钮角标。
 */
export function SessionPickerContent({ onClose }: { onClose: () => void }): React.ReactElement {
  const [data, setData] = useState<ListSessionsResult | null>(null);

  useEffect(() => {
    void window.api.listSessions().then(setData);
  }, []);

  const pick = (i: number): void => {
    // switchTo 成功后主进程广播 sessions-changed（弹层随时被 onClose 销毁，
    // 事后通知依赖 .then 会随窗口一起丢）
    if (data === null || i !== data.index) void window.api.switchTo(i);
    onClose();
  };

  return (
    <div className="max-h-72 w-full overflow-y-auto rounded-md border border-border bg-popover py-1 text-popover-foreground shadow-md">
      {data === null ? (
        <div className="px-3 py-2 text-xs text-muted-foreground">加载中…</div>
      ) : data.total === 0 ? (
        <div className="px-3 py-2 text-xs text-muted-foreground">还没有会话</div>
      ) : (
        data.titles.map((t, i) => (
          <button
            key={i}
            type="button"
            onClick={() => pick(i)}
            className={cn(
              "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent/40",
              i === data.index && "bg-primary/10",
            )}
          >
            <span className="w-6 shrink-0 font-mono text-[10px] text-muted-foreground">{i + 1}</span>
            <span className="min-w-0 flex-1 truncate">{t}</span>
            {i === data.index && <span className="shrink-0 text-[10px] text-primary">当前</span>}
          </button>
        ))
      )}
    </div>
  );
}
