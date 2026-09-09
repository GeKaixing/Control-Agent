import React, { useEffect, useRef, useState } from "react";
import { ToolsPanelContent, openPopoverSelf } from "./components/ToolsPanel";
import { EndpointModelMenuContent } from "./components/EndpointModelMenu";
import { CustomModelContent } from "./components/CustomModelPopover";
import { ReasoningContent, UsageContent } from "./components/ContextBar";
import { ModeToggleContent } from "./components/ModeToggle";
import { SettingsContent } from "./components/SettingsPopover";
import { LocalServicesContent } from "./components/LocalServicesPopover";
import { SessionPickerContent } from "./components/SessionPicker";
import type { InfoPayload, UsagePayload } from "../../shared/api";

/**
 * 弹层子窗口宿主：主进程用 ?popover=<id> 加载同一个 renderer bundle，
 * 这里按 id 渲染对应菜单内容（工具面板 / 模型菜单 / 上下文 / 模式）。
 *
 * 窗口由主进程创建：无边框、白底、不抢焦点（showInactive）、浮在触发按钮下方。
 * 内容高度经 ResizeObserver 量出后 popoverSetHeight 上报，主进程 setContentSize
 * 并在首次上报后显示——所以主窗口（白底）高度始终不变。
 *
 * 数据独立拉取（子窗口有自己的 store）：info / usage 一次拉取 + 事件流增量更新。
 */
export function PopoverHost({ id }: { id: string }): React.ReactElement {
  const [info, setInfo] = useState<InfoPayload | null>(null);
  const [usage, setUsage] = useState<UsagePayload>({ input: 0, output: 0, total: 0 });
  const rootRef = useRef<HTMLDivElement | null>(null);

  const close = (): void => {
    void window.api.closePopover();
  };

  // 数据：拉一次 + 事件流增量更新（turn_usage 刷用量；turn_end 重拉 info，
  // 让「上下文构成」里的对话消息段跟着轮次增长）
  useEffect(() => {
    void window.api.info().then(setInfo);
    void window.api.getUsage().then(setUsage);
    return window.api.onEvent((e) => {
      if (e.t === "turn_usage") {
        setUsage({ input: e.input, output: e.output, total: e.total });
      } else if (e.t === "end") {
        void window.api.info().then(setInfo);
      } else if (e.t === "ui_action" && e.action === "refresh-info") {
        // 设置弹层切换开关后不关闭，靠主进程广播重拉 info 回显开关状态
        void window.api.info().then(setInfo);
      }
    });
  }, []);

  // 内容高度上报（info 到位后内容才真正成型，依赖里带上）。
  // 量 scrollHeight（内容自然高度）而不是容器实际高度：窗口被屏幕边界夹矮时，
  // 根容器会被 max-h-screen 压扁，报压扁值会和窗口高度互锁（初始 stub 40px
  // 永远长不大）；报自然高度则夹紧后数值稳定，超出窗口的部分内部滚动。
  useEffect(() => {
    const el = rootRef.current;
    if (el === null) return;
    const report = (): void => {
      void window.api.popoverSetHeight(Math.ceil(el.scrollHeight));
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [info]);

  // 未知 id：直接关掉，避免留一个空窗口
  useEffect(() => {
    if (
      id !== "tools" &&
      id !== "model" &&
      id !== "reasoning" &&
      id !== "usage" &&
      id !== "mode" &&
      id !== "sessions" &&
      id !== "custom-model" &&
      id !== "settings" &&
      id !== "local-services"
    )
      close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  let content: React.ReactNode = null;
  if (info !== null) {
    switch (id) {
      case "tools":
        content = <ToolsPanelContent info={info} />;
        break;
      case "model":
        content = (
          <EndpointModelMenuContent
            info={info}
            onClose={close}
            onOpenCustomModel={() => openPopoverSelf("custom-model", 344)}
          />
        );
        break;
      case "custom-model":
        content = <CustomModelContent info={info} onClose={close} />;
        break;
      case "reasoning":
        content = <ReasoningContent onClose={close} />;
        break;
      case "usage":
        content = (
          <UsageContent
            usage={usage}
            contextWindow={info.contextWindow}
            breakdown={info.contextBreakdown}
          />
        );
        break;
      case "mode":
        content = (
          <ModeToggleContent
            mode={info.mode}
            onChange={(m) => {
              // refresh-info 由主进程在 setMode 成功后广播（弹层随时被销毁，事后通知有竞态）
              void window.api.setMode(m);
              close();
            }}
          />
        );
        break;
      case "settings":
        content = (
          <SettingsContent
            approvalMode={info.approvalMode}
            autoCompact={info.autoCompact}
            msgWindow={info.msgWindow}
            onApprovalModeChange={(on) => {
              // 不关弹层：主进程成功后广播 refresh-info，info 重拉开关自然回显
              void window.api.setApprovalMode(on);
            }}
            onAutoCompactChange={(on) => {
              void window.api.setAutoCompact(on);
            }}
            onMsgWindowChange={(on) => {
              // 创建/销毁窗口在主进程；refresh-info 广播后回显开关
              void window.api.setMsgWindow(on);
            }}
            localPreview={info.localPreview}
            onLocalPreviewChange={(on) => {
              // 只落偏好；refresh-info 广播后回显开关
              void window.api.setLocalPreview(on);
            }}
            alwaysOnTop={info.alwaysOnTop}
            onAlwaysOnTopChange={(on) => {
              // 窗口置顶在主进程；refresh-info 广播后回显开关
              void window.api.setAlwaysOnTop(on);
            }}
          />
        );
        break;
      case "local-services":
        content = <LocalServicesContent />;
        break;
      case "sessions":
        content = <SessionPickerContent onClose={close} />;
        break;
      default:
        content = null;
    }
  }

  return (
    // max-h-screen + 内部滚动：窗口高度被主进程夹到屏幕边界时（如主窗口贴屏幕底），
    // 弹层不再整体跳位，超出部分在这里滚——底部按钮始终可达
    <div ref={rootRef} className="max-h-screen overflow-y-auto bg-background text-foreground">
      {content}
    </div>
  );
}
