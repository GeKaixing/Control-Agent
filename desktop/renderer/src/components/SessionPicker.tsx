import React, { useEffect, useRef, useState } from "react";
import { MessagesSquare, Trash2 } from "lucide-react";
import { cn } from "../lib/utils";
import { openPopoverAt } from "./ToolsPanel";
import type { DeleteSessionResult, ListSessionsResult, PersistedSessionInfo } from "../../../shared/api";

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
 * 两段结构：
 *  - 「打开的会话」：内存标签页，点任一条跳转过去（switchTo 成功后主进程广播
 *    ui_action("sessions-changed")，主窗口收到后重置视图、重拉 info/usage）
 *  - 「历史会话」：磁盘上的持久化会话（.control-agent/sessions/，含 CLI 与之前退出
 *    时落盘的），每条带删除按钮——两步确认防误删；使用中的条目由主进程标
 *    locked，禁删。
 */
export function SessionPickerContent({ onClose }: { onClose: () => void }): React.ReactElement {
  const [data, setData] = useState<ListSessionsResult | null>(null);
  const [history, setHistory] = useState<PersistedSessionInfo[] | null>(null);
  // 两步确认：第一次点记下 id（按钮变「确认删除」），再点同一条才真删；点别处重置
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    void window.api.listSessions().then(setData);
    void window.api.listPersistedSessions().then(setHistory);
  }, []);

  const refreshHistory = (): void => {
    void window.api.listPersistedSessions().then(setHistory);
  };

  const pick = (i: number): void => {
    // switchTo 成功后主进程广播 sessions-changed（弹层随时被 onClose 销毁，
    // 事后通知依赖 .then 会随窗口一起丢）
    if (data === null || i !== data.index) void window.api.switchTo(i);
    onClose();
  };

  const remove = (id: string): void => {
    if (confirmId !== id) {
      setConfirmId(id);
      setDeleteError(null);
      return;
    }
    setConfirmId(null);
    void window.api.deleteSession(id).then((r: DeleteSessionResult) => {
      if (r.ok) refreshHistory();
      else setDeleteError(r.error ?? "删除失败");
    });
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

      {/* 历史会话：磁盘落盘清单，只读浏览 + 删除 */}
      <div className="mt-1 border-t border-border/60 pt-1">
        <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
          历史会话（磁盘）
        </div>
        {history === null ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">加载中…</div>
        ) : history.length === 0 ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">还没有已持久化的会话</div>
        ) : (
          history.map((s) => {
            const when = new Date(s.savedAt).toLocaleString("zh-CN", { hour12: false });
            return (
              <div
                key={s.id}
                className="group flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent/40"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[11px]">{s.id}</span>
                  <span className="block text-[10px] text-muted-foreground">
                    {when} · {s.nodeCount} 节点{s.locked && " · 使用中"}
                  </span>
                </span>
                {s.locked ? (
                  <span className="shrink-0 text-[10px] text-muted-foreground">当前</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => remove(s.id)}
                    title={confirmId === s.id ? "再点一次确认删除" : "删除此会话"}
                    className={cn(
                      "flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-[10px] transition-colors",
                      confirmId === s.id
                        ? "bg-destructive/15 text-destructive"
                        : "text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100",
                    )}
                  >
                    <Trash2 className="h-3 w-3" />
                    {confirmId === s.id ? "确认删除" : "删除"}
                  </button>
                )}
              </div>
            );
          })
        )}
        {deleteError !== null && (
          <div className="px-3 pb-1.5 text-[10px] text-destructive">{deleteError}</div>
        )}
      </div>
    </div>
  );
}
