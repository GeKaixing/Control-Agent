import React, { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { cn } from "../lib/utils";
import type { InfoPayload, WireEvent } from "../../shared/api";

/**
 * 独立消息弹窗（MessageFloat）：设置弹窗开启后，主进程用 ?msg-window=1
 * 加载同一个 bundle 渲染本组件。独立无边框白底小窗，不挂 parent——
 * 独立于主窗口存在（可拖到屏幕任意角落，主窗口关了仍保留）。
 *
 * 顶部 32px 是拖动条（app-region: drag）：会话标题 + 运行状态点 + 关闭按钮；
 * 正文实时聚合 agent 回复流（user_text / text delta / 工具行），自动滚底。
 * 关闭按钮调 setMsgWindow(false)：主进程销毁窗口并回写偏好（info 回显到设置弹层）。
 */

interface FloatMsg {
  role: "user" | "assistant" | "tool";
  text: string;
  /** 工具行专用：ok 状态（pending / ok / fail） */
  ok?: boolean | "pending";
}

const MAX_MSGS = 200;

export function MessageFloat(): React.ReactElement {
  const [title, setTitle] = useState("新会话");
  const [running, setRunning] = useState(false);
  const [msgs, setMsgs] = useState<FloatMsg[]>([]);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // 拉一次会话标题；此后 session_title / refresh-info 事件增量更新
  useEffect(() => {
    void window.api.info().then((info: InfoPayload) => setTitle(info.sessionTitle));
    return window.api.onEvent((e: WireEvent) => {
      if (e.t === "session_title") {
        setTitle(e.text);
        return;
      }
      if (e.t === "ui_action") {
        if (e.action === "refresh-info") void window.api.info().then((i) => setTitle(i.sessionTitle));
        return;
      }
      if (e.t === "start") {
        setRunning(true);
        return;
      }
      if (e.t === "end" || e.t === "error") {
        setRunning(false);
        if (e.t === "error") {
          setMsgs((prev) => [...prev.slice(-(MAX_MSGS - 1)), { role: "assistant", text: `⚠ ${e.message}` }]);
        }
        return;
      }
      if (e.t === "user_text") {
        setMsgs((prev) => [...prev.slice(-(MAX_MSGS - 1)), { role: "user", text: e.text }]);
        return;
      }
      if (e.t === "text") {
        // delta 追加到最后一条 assistant（没有就新建）
        setMsgs((prev) => {
          const last = prev[prev.length - 1];
          if (last !== undefined && last.role === "assistant" && last.ok === undefined) {
            return [...prev.slice(0, -1), { role: "assistant", text: last.text + e.delta }];
          }
          return [...prev.slice(-(MAX_MSGS - 1)), { role: "assistant", text: e.delta }];
        });
        return;
      }
      if (e.t === "tool_start") {
        setMsgs((prev) => [
          ...prev.slice(-(MAX_MSGS - 1)),
          { role: "tool", text: e.name, ok: "pending" },
        ]);
        return;
      }
      if (e.t === "tool_end") {
        setMsgs((prev) =>
          prev.map((m) =>
            m.role === "tool" && m.text === e.name && m.ok === "pending"
              ? { ...m, ok: e.ok }
              : m,
          ),
        );
      }
    });
  }, []);

  // 自动滚底：消息变化时贴住底部
  useEffect(() => {
    const el = scrollRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [msgs]);

  const close = (): void => {
    // 主进程销毁窗口 + 回写偏好 + 广播 refresh-info（设置弹层开关回显）
    void window.api.setMsgWindow(false);
  };

  return (
    <div className="flex h-screen w-full flex-col overflow-hidden bg-background text-foreground">
      {/* 拖动条：整个区域可拖窗口，按钮标 no-drag */}
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border bg-muted/40 pl-3 pr-1.5 [-webkit-app-region:drag]">
        <span
          className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            running ? "animate-pulse bg-emerald-500" : "bg-muted-foreground/30",
          )}
        />
        <span className="flex-1 truncate text-[11px] text-muted-foreground">{title}</span>
        <button
          type="button"
          title="关闭消息弹窗"
          onClick={close}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground [-webkit-app-region:no-drag]"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {/* 正文：聚合的回复流 */}
      <div ref={scrollRef} className="flex-1 space-y-2 overflow-y-auto px-3 py-2.5">
        {msgs.length === 0 && (
          <div className="pt-8 text-center text-[11px] text-muted-foreground">
            等待消息…发送后回复会实时显示在这里
          </div>
        )}
        {msgs.map((m, i) => {
          if (m.role === "user") {
            return (
              <div key={i} className="flex justify-end">
                <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-md rounded-br-sm bg-primary/10 px-2.5 py-1.5 text-[12px] leading-relaxed">
                  {m.text}
                </div>
              </div>
            );
          }
          if (m.role === "tool") {
            return (
              <div key={i} className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <span
                  className={cn(
                    "h-1 w-1 rounded-full",
                    m.ok === "pending" && "animate-pulse bg-amber-500",
                    m.ok === true && "bg-emerald-500",
                    m.ok === false && "bg-red-500",
                  )}
                />
                <span>⚙ {m.text}</span>
              </div>
            );
          }
          return (
            <div key={i} className="flex justify-start">
              <div className="max-w-[92%] whitespace-pre-wrap break-words rounded-md rounded-bl-sm border border-border px-2.5 py-1.5 text-[12px] leading-relaxed">
                {m.text}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
