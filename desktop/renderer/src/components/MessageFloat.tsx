import React, { useEffect, useRef, useState } from "react";
import { Check, Copy, X } from "lucide-react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn, copyText } from "../lib/utils";
import type { InfoPayload, WireEvent } from "../../../shared/api";

/**
 * 独立消息弹窗（MessageFloat）：设置弹窗开启后，主进程用 ?msg-window=1
 * 加载同一个 bundle 渲染本组件。独立无边框白底小窗，不挂 parent——
 * 独立于主窗口存在（可拖到屏幕任意角落，主窗口关了仍保留）。
 *
 * 顶部 32px 是拖动条（app-region: drag）：会话标题 + 运行状态点 + 关闭按钮；
 * 正文实时聚合 agent 回复流（user_text / text delta / 工具行），自动滚底。
 * assistant 消息按 markdown 渲染（react-markdown + gfm 表格）；user 消息是用户
 * 原话，保持纯文本。每条消息 hover 出现「复制」按钮（复制的是原始 markdown
 * 源文本——粘到别处还能再编辑）；工具行只有工具名，不给按钮。
 * 关闭按钮调 setMsgWindow(false)：主进程销毁窗口并回写偏好（info 回显到设置弹层）。
 */

interface FloatMsg {
  /** 稳定行 id：消息列表封顶 200 条后会从头丢弃，用下标做「复制成功」标记会错位 */
  id: number;
  role: "user" | "assistant" | "tool";
  text: string;
  /** 工具行专用：ok 状态（pending / ok / fail） */
  ok?: boolean | "pending";
}

const MAX_MSGS = 200;

let seq = 0;
const nextId = (): number => ++seq;

/**
 * 小窗专用的 markdown 组件样式映射：340px 宽下的紧凑排版。
 * 气泡基准 text-[12px]，代码/表格降一档到 11px；链接点开走系统浏览器
 * （主进程 setWindowOpenHandler 已接管，不会弹 Electron 新窗）。
 * 注意必须把 react-markdown 塞进 props 的 node 解构掉，否则 spread 到
 * DOM 元素会报 unknown attribute。
 */
const mdComponents: Components = {
  p: ({ node, ...props }) => <p className="my-1 first:mt-0 last:mb-0" {...props} />,
  h1: ({ node, ...props }) => <h1 className="my-1.5 text-[13px] font-semibold" {...props} />,
  h2: ({ node, ...props }) => <h2 className="my-1.5 text-[13px] font-semibold" {...props} />,
  h3: ({ node, ...props }) => <h3 className="my-1.5 text-[12px] font-semibold" {...props} />,
  h4: ({ node, ...props }) => <h4 className="my-1 text-[12px] font-semibold" {...props} />,
  h5: ({ node, ...props }) => <h5 className="my-1 text-[12px] font-semibold" {...props} />,
  h6: ({ node, ...props }) => <h6 className="my-1 text-[12px] font-semibold" {...props} />,
  ul: ({ node, ...props }) => <ul className="my-1 list-disc space-y-0.5 pl-4" {...props} />,
  ol: ({ node, ...props }) => <ol className="my-1 list-decimal space-y-0.5 pl-4" {...props} />,
  li: ({ node, ...props }) => <li className="leading-relaxed" {...props} />,
  blockquote: ({ node, ...props }) => (
    <blockquote className="my-1 border-l-2 border-border pl-2 text-muted-foreground" {...props} />
  ),
  hr: ({ node, ...props }) => <hr className="my-2 border-border" {...props} />,
  strong: ({ node, ...props }) => <strong className="font-semibold" {...props} />,
  del: ({ node, ...props }) => <del className="line-through" {...props} />,
  a: ({ node, ...props }) => (
    <a
      target="_blank"
      rel="noreferrer"
      className="break-all text-blue-600 underline underline-offset-2"
      {...props}
    />
  ),
  // 行内 code 与围栏 code 块都走这里：块级的带 language-* 前缀，背景由 <pre> 出
  code: ({ node, className, ...props }) => {
    const block = /language-/.test(className ?? "");
    return (
      <code
        className={cn(
          "font-mono",
          block ? "text-[11px]" : "rounded bg-muted px-1 py-0.5 text-[11px]",
        )}
        {...props}
      />
    );
  },
  pre: ({ node, ...props }) => (
    <pre
      className="my-1 overflow-x-auto rounded-md bg-muted/60 p-2 text-[11px] leading-relaxed"
      {...props}
    />
  ),
  // 340px 放不下宽表格，包一层横向滚动；表头淡底，单元格细边框
  table: ({ node, ...props }) => (
    <div className="my-1 overflow-x-auto">
      <table className="w-full border-collapse text-[11px]" {...props} />
    </div>
  ),
  th: ({ node, ...props }) => (
    <th className="border border-border bg-muted/40 px-1.5 py-1 text-left font-medium" {...props} />
  ),
  td: ({ node, ...props }) => <td className="border border-border px-1.5 py-1 align-top" {...props} />,
};

export function MessageFloat(): React.ReactElement {
  const [title, setTitle] = useState("新会话");
  const [running, setRunning] = useState(false);
  const [msgs, setMsgs] = useState<FloatMsg[]>([]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** 刚复制成功的行 id（打勾反馈）；1.2s 后自动清掉 */
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const copiedTimer = useRef<number | null>(null);

  // 卸载时清掉打勾定时器（组件销毁后 setState 无意义）
  useEffect(
    () => () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    },
    [],
  );

  /** 复制单条消息：成功才给反馈，失败静默（剪贴板不可用时不打断阅读） */
  const copy = async (m: FloatMsg): Promise<void> => {
    const ok = await copyText(m.text);
    if (!ok) return;
    setCopiedId(m.id);
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopiedId(null), 1200);
  };

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
          setMsgs((prev) => [
            ...prev.slice(-(MAX_MSGS - 1)),
            { id: nextId(), role: "assistant", text: `⚠ ${e.message}` },
          ]);
        }
        return;
      }
      if (e.t === "user_text") {
        setMsgs((prev) => [
          ...prev.slice(-(MAX_MSGS - 1)),
          { id: nextId(), role: "user", text: e.text },
        ]);
        return;
      }
      if (e.t === "text") {
        // delta 追加到最后一条 assistant（没有就新建）；追加沿用原 id，
        // 这样正在流式输出的消息被复制时，打勾标记不会跳到别的行上
        setMsgs((prev) => {
          const last = prev[prev.length - 1];
          if (last !== undefined && last.role === "assistant" && last.ok === undefined) {
            return [...prev.slice(0, -1), { ...last, text: last.text + e.delta }];
          }
          return [...prev.slice(-(MAX_MSGS - 1)), { id: nextId(), role: "assistant", text: e.delta }];
        });
        return;
      }
      if (e.t === "tool_start") {
        setMsgs((prev) => [
          ...prev.slice(-(MAX_MSGS - 1)),
          { id: nextId(), role: "tool", text: e.name, ok: "pending" },
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
        {msgs.map((m) => {
          if (m.role === "user") {
            return (
              <div key={m.id} className="group flex items-start justify-end gap-1">
                <CopyButton copied={copiedId === m.id} onClick={() => void copy(m)} />
                <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-md rounded-br-sm bg-primary/10 px-2.5 py-1.5 text-[12px] leading-relaxed">
                  {m.text}
                </div>
              </div>
            );
          }
          if (m.role === "tool") {
            return (
              <div key={m.id} className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
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
            <div key={m.id} className="group flex items-start justify-start gap-1">
              {/* assistant 走 markdown：去掉外层的 whitespace-pre-wrap（不然源文本
                  换行和 <p> 的 margin 叠出双倍空行）；min-w-0 让代码块能横向滚动 */}
              <div className="max-w-[92%] min-w-0 break-words rounded-md rounded-bl-sm border border-border px-2.5 py-1.5 text-[12px] leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                  {m.text}
                </Markdown>
              </div>
              <CopyButton copied={copiedId === m.id} onClick={() => void copy(m)} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 单条消息的复制按钮：平时透明，hover 所在行才显形（小窗只有 340 宽，常显太吵）；
 * 复制成功后 1.2s 内强制显形并切成绿色对勾，作为「已复制」的唯一反馈。
 */
function CopyButton({
  copied,
  onClick,
}: {
  copied: boolean;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      title={copied ? "已复制" : "复制这条消息"}
      onClick={onClick}
      className={cn(
        "flex h-5 w-5 shrink-0 items-center justify-center rounded transition-opacity hover:bg-accent/40",
        copied
          ? "text-emerald-500 opacity-100"
          : "text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100",
      )}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}
