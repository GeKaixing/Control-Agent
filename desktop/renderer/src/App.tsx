import React, { useEffect, useRef, useState } from "react";
import { Check, Copy, Globe, Smartphone } from "lucide-react";
import { useSessionStore } from "./store";
import { AskUserCard } from "./components/AskUserCard";
import { BrowserBar } from "./components/BrowserBar";
import { BrowserTabs } from "./components/BrowserTabs";
import { PhonePanel } from "./components/PhonePanel";
import { Composer } from "./components/Composer";
import { MessageList } from "./components/MessageList";
import { StatusBar } from "./components/StatusBar";
import { isMacPlatform, useWcoButtonWidth } from "./lib/wco";
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
  const pendingAsks = useSessionStore((s) => s.pendingAsks);
  const browser = useSessionStore((s) => s.browser);
  const phone = useSessionStore((s) => s.phone);
  const handleEvent = useSessionStore((s) => s.handleEvent);
  const setInfo = useSessionStore((s) => s.setInfo);
  const newSession = useSessionStore((s) => s.newSession);
  const browserOpen = browser?.open === true;
  const phoneOpen = phone?.open === true;
  // 工具条 / 地址栏的状态源 = 活动标签页（无标签或未开面板时为 null）
  const activeBrowserTab =
    browser !== null ? browser.tabs.find((t) => t.id === browser.activeId) ?? null : null;

  useEffect(() => {
    void window.api.info().then(setInfo);
    const off = window.api.onEvent((e) => handleEvent(e));
    return () => off();
  }, [handleEvent, setInfo]);

  const handleSubmit = async (text: string, attachments: Attachment[]) => {
    // 运行中提交 = 中途插话：走 steer 立即生效（Agent 当前轮结束后作为新输入消费）；
    // 带附件时 steer 不支持，降级 submit 入 followUp 队列（当前任务结束后带上）。
    // 用户消息都不在这里本地插入：host 广播 user_text 事件，多端统一靠事件流渲染。
    if (status === "running" && attachments.length === 0) {
      await window.api.steer(text);
      return;
    }
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

  // 标题栏拖动条的平台留位：macOS 红绿灯 80px；Windows WCO 原生按钮区宽度避让
  // （不留的话右上角的「复制回答」图标会被 最小化/最大化/关闭 盖住——真踩过的坑）
  const isMac = isMacPlatform();
  const wcoWidth = useWcoButtonWidth();

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
  // 浏览器面板打开时不做收缩上报：根容器是 100vh，报出去就是视口高，
  // 会跟「面板最小高度保障」（下方 useEffect）互相打架、还跟最大化抢窗口。
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!showComposer) return;
    const el = rootRef.current;
    if (el === null) return;
    let last = -1;
    const ro = new ResizeObserver(() => {
      if (browserOpen || phoneOpen) return;
      const h = Math.ceil(el.getBoundingClientRect().height);
      if (h > 0 && h !== last) {
        last = h;
        void window.api.resizeWindow(h);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [showComposer, browserOpen, phoneOpen]);

  // 浏览器面板打开时的窗口高度保障：真实最小内容 = 拖动条 + 标签条 + 工具条 +
  // Composer + 占位区最小 480。视口不够就把窗口撑大（只撑不缩——用户最大化
  // 或手动调大时不抢）。Composer 增高（多行输入 / ask_user 卡片）跟着再撑。
  useEffect(() => {
    if (!showComposer || !browserOpen) return;
    const el = rootRef.current;
    if (el === null) return;
    const ensureMin = (): void => {
      let fixed = 0;
      for (const child of Array.from(el.children)) {
        if (child === browserHostRef.current) continue;
        fixed += child.getBoundingClientRect().height;
      }
      const needed = Math.ceil(fixed) + 480;
      if (needed > window.innerHeight) {
        void window.api.resizeWindow(needed);
      }
    };
    ensureMin();
    const ro = new ResizeObserver(ensureMin);
    ro.observe(el);
    return () => ro.disconnect();
  }, [showComposer, browserOpen]);

  // 内部浏览器面板：占位区矩形上报。原生 WebContentsView 由主进程精确贴到
  // 这个矩形上（CSS px = DIP）。观察占位区自身（窗口缩放 / flex 伸缩）+
  // 根容器（上方内容高度变化会平移占位区但不一定改变其尺寸）。
  const browserHostRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!showComposer || !browserOpen) return;
    const el = browserHostRef.current;
    if (el === null) return;
    const report = (): void => {
      const r = el.getBoundingClientRect();
      void window.api.browserSetRect({
        x: r.left,
        y: r.top,
        width: r.width,
        height: r.height,
      });
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    if (el.parentElement !== null) ro.observe(el.parentElement);
    return () => ro.disconnect();
  }, [showComposer, browserOpen]);

  const handleToggleBrowser = (): void => {
    if (browserOpen) {
      void window.api.browserClose();
    } else {
      // 互斥：手机镜像与浏览器面板不共存（原生视图会盖住镜像 DOM 面板；
      // 反方向的互斥在主进程 PHONE_OPEN 里做）
      if (phoneOpen) void window.api.phoneClose();
      void window.api.browserOpen();
    }
  };

  const handleTogglePhone = (): void => {
    if (phoneOpen) {
      void window.api.phoneClose();
    } else {
      void window.api.phoneOpen();
    }
  };

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
      } else if (e.t === "tool_end" && e.name === "bash") {
        // bash 跑完：主进程可能刚从输出里检测到新的本地服务，重拉 info
        // 让状态栏「本地服务」角标实时跟上（info() 是本地计算，代价可忽略）
        void window.api.info().then(setInfo);
      }
    });
    return off;
  }, [showComposer, setInfo]);

  if (showComposer) {
    return (
      <div
        ref={rootRef}
        className="flex flex-col bg-background text-foreground"
        // 浏览器面板打开时根容器撑满视口：面板区 flex-1 吸收剩余空间（窗口
        // 最大化时面板跟着长高）；关闭时回到内容高度自适应（RO 上报收缩窗口）。
        // 手机镜像面板同款布局（互斥，二者不同时出现）。
        style={browserOpen || phoneOpen ? { height: "100vh" } : undefined}
      >
        {/* 顶部拖动条：无原生标题栏，兼任「会话标题 + 实时状态」栏——
            macOS 左侧留红绿灯位；Windows（WCO）右侧留原生按钮区。
            文字不可选中、不挡拖动。 */}
        <div
          className="flex h-10 shrink-0 items-center gap-2 [-webkit-app-region:drag]"
          style={{
            paddingLeft: isMac ? "5rem" : "0.75rem",
            paddingRight: `calc(${wcoWidth}px + 1rem)`,
          }}
        >
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
          {/* 内部浏览器面板开关：始终可见（不挂在 sessionTitle 上），
              开启时高亮。原生视图贴在拖动条下方的占位区上。 */}
          <button
            type="button"
            title={browserOpen ? "关闭浏览器面板" : "打开浏览器面板"}
            onClick={handleToggleBrowser}
            className={`shrink-0 transition-colors [-webkit-app-region:no-drag] ${
              browserOpen ? "text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Globe className="h-3.5 w-3.5" />
          </button>
          {/* 手机镜像面板开关（Mobile 控制通道入口）：与 Globe 并排，同款交互 */}
          <button
            type="button"
            title={phoneOpen ? "关闭手机镜像面板" : "打开手机镜像面板"}
            onClick={handleTogglePhone}
            className={`shrink-0 transition-colors [-webkit-app-region:no-drag] ${
              phoneOpen ? "text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Smartphone className="h-3.5 w-3.5" />
          </button>
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
        {/* 模型提问（ask_user 工具）：置顶在 Composer 上方，答完由 ask_user_done 撤下 */}
        {pendingAsks.length > 0 && (
          <div className="flex flex-col gap-2 px-3 pb-1">
            {pendingAsks.map((a) => (
              <AskUserCard key={a.id} ask={a} />
            ))}
          </div>
        )}
        {/* 内部浏览器面板：标签条 + 工具条 + 占位区（原生 WebContentsView 贴在
            占位区上，占位区本身只兜底显示底色）。Composer 留在底部——边聊边看两不误。 */}
        {browserOpen && browser !== null && (
          <>
            <BrowserTabs browser={browser} />
            <BrowserBar tab={activeBrowserTab} />
            <div
              ref={browserHostRef}
              className="min-h-[480px] flex-1 bg-muted"
              title="浏览器区域"
            />
          </>
        )}
        {/* 手机镜像面板：帧 + 手势都在渲染层（主进程 adb 桥推流），与浏览器面板互斥 */}
        {phoneOpen && <PhonePanel />}
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
      {pendingAsks.length > 0 && (
        <div className="flex flex-col gap-2 px-4 py-2">
          {pendingAsks.map((a) => (
            <AskUserCard key={a.id} ask={a} />
          ))}
        </div>
      )}
      <MessageList turns={turns} />
    </div>
  );
}
