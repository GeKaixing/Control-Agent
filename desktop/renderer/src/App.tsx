import React, { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { useSessionStore } from "./store";
import { Composer } from "./components/Composer";
import { MessageList } from "./components/MessageList";
import { StatusBar } from "./components/StatusBar";
import type { Attachment } from "../../shared/api";

/**
 * 顶层壳：挂载订阅，按入口分流渲染。
 *
 * `showComposer=true`（本地 Electron 窗口，默认）：整个界面只有 Composer（超级输入框），
 * 不渲染 StatusBar / 消息区 / 错误横幅。
 *
 * `showComposer=false`（remote-ui 独立只读 UI）：StatusBar + 消息区，输入走 Composer 应用。
 */
export function App({ showComposer = true }: { showComposer?: boolean }): React.ReactElement {
  const info = useSessionStore((s) => s.info);
  const usage = useSessionStore((s) => s.usage);
  const turns = useSessionStore((s) => s.turns);
  const status = useSessionStore((s) => s.status);
  const errorMessage = useSessionStore((s) => s.errorMessage);
  const notice = useSessionStore((s) => s.notice);
  const sessionTitle = useSessionStore((s) => s.sessionTitle);
  const handleEvent = useSessionStore((s) => s.handleEvent);
  const setInfo = useSessionStore((s) => s.setInfo);
  const newSession = useSessionStore((s) => s.newSession);

  useEffect(() => {
    void window.api.info().then(setInfo);
    const off = window.api.onEvent((e) => handleEvent(e));
    return () => off();
  }, [handleEvent, setInfo]);

  const handleSubmit = async (text: string, attachments: Attachment[]) => {
    // 用户消息不在这里本地插入：host 在 submit 时广播 user_text 事件，
    // 本地窗口与独立 UI 都靠事件流渲染（多端一致、不重复）
    const result = await window.api.submit(text, attachments);
    if (!result.ok && result.error !== undefined) {
      handleEvent({ t: "error", message: result.error });
    }
    // 首条消息会把会话标题从「新会话」锁定为消息摘要——重拉 info 让标题栏跟上
    void window.api.info().then(setInfo);
  };

  const handleAbort = async () => {
    await window.api.abort();
  };

  const handleNewSession = async () => {
    await newSession();
  };

  const handlePlanContinue = async () => {
    await window.api.planContinue();
  };

  // ── 标题栏复制按钮 ──
  // 优先复制 store 里最后一条 assistant turn 的完整回答正文（流式 delta 累积，
  // 全文无截断）；没有正文（纯工具轮 / 刚开新会话）时回退到状态文字剥装饰。
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (copyTimer.current !== null) clearTimeout(copyTimer.current);
  }, []);

  const handleCopyTitle = async (): Promise<void> => {
    const turns = useSessionStore.getState().turns;
    const lastAssistant = [...turns].reverse().find((t) => t.role === "assistant");
    const answer = lastAssistant?.text ?? "";
    const text =
      answer.length > 0
        ? answer
        : (sessionTitle ?? "")
            .replace(/^[✓✗] /, "")
            .replace(/ · [\d.]+k? token$/, "");
    if (text.length === 0) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // 剪贴板不可用（权限/非安全上下文）：静默失败，按钮无反馈
    }
  };

  // Composer-only 布局：窗口高度自适应内容。根容器不再 h-full（内容高），
  // ResizeObserver 量到高度变化就报给主进程收缩窗口（宽度不变）。
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!showComposer) return;
    const el = rootRef.current;
    if (el === null) return;
    let last = -1;
    const ro = new ResizeObserver(() => {
      const h = Math.ceil(el.getBoundingClientRect().height);
      if (h > 0 && h !== last) {
        last = h;
        void window.api.resizeWindow(h);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [showComposer]);

  // 菜单弹层是独立子窗口（不占主窗口空间）。主窗口内点击非触发区域时收起弹层：
  // 捕获阶段监听，命中 [data-popover-trigger] 的点击交给触发按钮自己 toggle。
  // （弹层子窗口获得焦点后，主进程靠 popover blur 自动收起，不走这条。）
  useEffect(() => {
    if (!showComposer) return;
    const onDocDown = (e: MouseEvent): void => {
      const el = e.target as HTMLElement | null;
      if (el !== null && el.closest("[data-popover-trigger]") !== null) return;
      void window.api.closePopover();
    };
    document.addEventListener("mousedown", onDocDown, true);
    return () => document.removeEventListener("mousedown", onDocDown, true);
  }, [showComposer]);

  // 弹层子窗口里改了 model / endpoint / reasoning 后通知刷新 info（触发按钮的显示要跟着变）；
  // 「选择会话」弹层里切完会话后重置视图、重拉 info/usage（switchTo 发生在子窗口）。
  useEffect(() => {
    if (!showComposer) return;
    const off = window.api.onEvent((e) => {
      if (e.t === "ui_action" && e.action === "refresh-info") {
        void window.api.info().then(setInfo);
      } else if (e.t === "ui_action" && e.action === "sessions-changed") {
        void useSessionStore.getState().applyRemoteSwitch();
      }
    });
    return off;
  }, [showComposer, setInfo]);

  if (showComposer) {
    return (
      <div ref={rootRef} className="flex flex-col bg-background text-foreground">
        {/* 顶部拖动条：无原生标题栏（hiddenInset），兼任「会话标题 + 实时状态」栏——
            pl-20 给 macOS 红绿灯留位，文字不可选中、不挡拖动。 */}
        <div className="flex h-10 shrink-0 items-center gap-2 pr-4 pl-20 [-webkit-app-region:drag]">
          {info !== null && info.sessionTitle.length > 0 && (
            <span
              className="max-w-[16rem] truncate text-xs font-medium text-foreground select-none"
              title={info.sessionTitle}
            >
              {info.sessionTitle}
            </span>
          )}
          {sessionTitle !== null && sessionTitle.length > 0 && (
            <div
              className="min-w-0 flex-1 overflow-x-auto text-xs text-muted-foreground select-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              title={sessionTitle}
            >
              <span className="whitespace-nowrap">
                {info !== null && info.sessionTitle.length > 0 ? "· " : ""}
                {sessionTitle}
              </span>
            </div>
          )}
          {sessionTitle !== null && sessionTitle.length > 0 && (
            <button
              type="button"
              title="复制回答"
              onClick={handleCopyTitle}
              className="shrink-0 text-muted-foreground transition-colors hover:text-foreground [-webkit-app-region:no-drag]"
            >
              {copied ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </button>
          )}
        </div>
        {/* 不留消息区空白：Composer 直接贴在拖动条下方，窗口高度=内容高度 */}
        <Composer
          status={status}
          onSubmit={handleSubmit}
          onAbort={handleAbort}
          onPlanContinue={handlePlanContinue}
          onNewSession={handleNewSession}
        />
      </div>
    );
  }

  return (
    <div className="relative flex h-full flex-col bg-background text-foreground">
      <StatusBar info={info} usage={usage} notice={notice} title={sessionTitle} />
      {errorMessage !== null && (
        <div className="border-b border-destructive/50 bg-destructive/15 px-4 py-2 text-xs text-destructive">
          ⚠ {errorMessage}
        </div>
      )}
      <MessageList turns={turns} />
    </div>
  );
}
