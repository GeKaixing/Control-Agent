import React, { useEffect, useMemo, useRef, useState } from "react";
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
 * 正文实时聚合 agent 回复流（user_text / text / 工具行），自动滚底。
 * 与主窗口 store 同一套 turn 模型：start 建一个 assistant turn（live），
 * thinking / text delta 都挂进这个 turn——思考折叠段和「思考中」状态
 * 渲染在 assistant 气泡内部，而非独立行。思考流按 hermes TUI 的交互：
 * 流式期间自动展开灰字跟随滚动，思考结束（正文/工具接棒）自动收起。
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
  /** assistant 专用：本轮累计思考过程（thinking delta 顺序拼接） */
  thinking?: string;
  /** assistant 专用：本轮是否仍在流式（end / error 时翻转） */
  live?: boolean;
  /** assistant 专用：思考阶段是否已结束（正文 / 工具接棒），驱动思考块自动收起 */
  thinkingDone?: boolean;
  /** 工具行专用：ok 状态（pending / ok / fail） */
  ok?: boolean | "pending";
}

const MAX_MSGS = 200;

let seq = 0;
const nextId = (): number => ++seq;

/** 新建一个流式中的 assistant turn（start 事件 / 兜底惰性创建共用） */
function newAssistantTurn(patch: Partial<FloatMsg> = {}): FloatMsg {
  return {
    id: nextId(),
    role: "assistant",
    text: "",
    thinking: "",
    live: true,
    thinkingDone: false,
    ...patch,
  };
}

/**
 * 改写最后一个流式中的 assistant turn（倒序找，中间隔着工具行也能命中——
 * 工具行是独立线性行，不打断 turn 归属）。找不到返回 null，调用方自行建新 turn。
 */
function mutateLastLiveAssistant(
  prev: FloatMsg[],
  fn: (m: FloatMsg) => FloatMsg,
): FloatMsg[] | null {
  for (let i = prev.length - 1; i >= 0; i -= 1) {
    const m = prev[i];
    if (m !== undefined && m.role === "assistant" && m.live === true) {
      const out = [...prev];
      out[i] = fn(m);
      return out;
    }
  }
  return null;
}

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
        // 与主窗口 store 同款：start 即建本轮 assistant turn，后续
        // thinking / text delta 都挂进去——「思考中」因此落在气泡内部
        setRunning(true);
        setMsgs((prev) => [...prev.slice(-(MAX_MSGS - 1)), newAssistantTurn()]);
        return;
      }
      if (e.t === "end" || e.t === "error") {
        setRunning(false);
        setMsgs((prev) => {
          const closed = prev.map((m, i, arr) =>
            i === arr.length - 1 && m.role === "assistant" && m.live === true
              ? { ...m, live: false }
              : m,
          );
          // 整轮空转的 turn（没等到任何 thinking / text 就结束）不留空壳气泡
          const pruned = closed.filter(
            (m) => !(m.role === "assistant" && m.live === false && m.text.length === 0 && (m.thinking ?? "").length === 0),
          );
          if (e.t === "error") {
            return [
              ...pruned.slice(-(MAX_MSGS - 1)),
              { id: nextId(), role: "assistant", text: `⚠ ${e.message}`, thinking: "", live: false, thinkingDone: true },
            ];
          }
          return pruned;
        });
        return;
      }
      if (e.t === "user_text") {
        setMsgs((prev) => [
          ...prev.slice(-(MAX_MSGS - 1)),
          { id: nextId(), role: "user", text: e.text },
        ]);
        return;
      }
      if (e.t === "thinking") {
        // 思考流挂进本轮 assistant turn 的 thinking 字段（气泡内的折叠段）
        setMsgs((prev) => {
          const updated = mutateLastLiveAssistant(prev, (m) => ({
            ...m,
            thinking: (m.thinking ?? "") + e.delta,
          }));
          if (updated !== null) return updated;
          // 弹窗中途打开、没赶上 start 时惰性补建
          return [...prev.slice(-(MAX_MSGS - 1)), newAssistantTurn({ thinking: e.delta })];
        });
        return;
      }
      if (e.t === "text") {
        // 正文接棒 = 思考阶段结束（thinkingDone 置位让思考块自动收起）；
        // 追加沿用原 turn id，复制打勾标记不会跳行
        setMsgs((prev) => {
          const updated = mutateLastLiveAssistant(prev, (m) => ({
            ...m,
            text: m.text + e.delta,
            thinkingDone: true,
          }));
          if (updated !== null) return updated;
          return [...prev.slice(-(MAX_MSGS - 1)), newAssistantTurn({ text: e.delta, thinkingDone: true })];
        });
        return;
      }
      if (e.t === "tool_start") {
        setMsgs((prev) => {
          // 工具执行同样宣告思考阶段结束
          const marked = mutateLastLiveAssistant(prev, (m) => ({ ...m, thinkingDone: true }));
          return [
            ...(marked ?? prev).slice(-(MAX_MSGS - 1)),
            { id: nextId(), role: "tool", text: e.name, ok: "pending" },
          ];
        });
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
                  换行和 <p> 的 margin 叠出双倍空行）；min-w-0 让代码块能横向滚动。
                  思考折叠段与「思考中」占位都在气泡内部（对齐主窗口的 turn 布局） */}
              <div className="max-w-[92%] min-w-0 break-words rounded-md rounded-bl-sm border border-border px-2.5 py-1.5 text-[12px] leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                {(m.thinking ?? "").length > 0 && (
                  <FloatThinkingBlock
                    text={m.thinking ?? ""}
                    live={m.live === true && m.thinkingDone !== true}
                  />
                )}
                {m.text.length > 0 ? (
                  <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                    {m.text}
                  </Markdown>
                ) : (
                  m.live === true && (
                    <span className="text-[11px] text-muted-foreground">💭 思考中…</span>
                  )
                )}
              </div>
              {m.text.length > 0 && <CopyButton copied={copiedId === m.id} onClick={() => void copy(m)} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 思考过程折叠段（渲染在 assistant 气泡内部，交互对齐 hermes TUI 的
 * Thinking 面板）：
 *  - live（本轮思考阶段流式中）：自动展开，灰字跟随滚动；正文 / 工具接棒
 *    （thinkingDone）或本轮结束（live 翻转）后自动收起只留一行摘要；
 *  - 收起态摘要行带 ▸/▾ chevron + 思考正文首行预览（compactPreview 风格），
 *    提示「可以点开看思考了什么」；点击任意位置开合；
 *  - 340px 小窗下高度封顶 40，超出内部滚动，不撑爆弹窗。
 * 用受控 details + preventDefault 手动翻转，是因为要随 live 自动开合——
 * 非受控 <details> 的展开状态吃不到 props 更新。
 */
function FloatThinkingBlock({ text, live }: { text: string; live: boolean }): React.ReactElement {
  const [open, setOpen] = useState(live);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => setOpen(live), [live]);

  // 收起态的标题预览：思考正文第一个非空行，截到 48 字符（compactPreview 风格）
  const preview = useMemo(() => {
    const first = text.split("\n").find((l) => l.trim().length > 0) ?? "";
    return first.length > 48 ? `${first.slice(0, 48)}…` : first;
  }, [text]);

  // 展开且流式中：跟随滚动贴底，模仿终端「尾巴一直在视野里」的阅读体验
  useEffect(() => {
    if (!(open && live)) return;
    const el = bodyRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [text, open, live]);

  return (
    <details open={open}>
      <summary
        title={open ? "收起思考过程" : "展开看思考了什么"}
        onClick={(ev) => {
          ev.preventDefault();
          setOpen((v) => !v);
        }}
        className={
          live
            ? "flex cursor-pointer select-none items-center gap-1 text-[10px] text-foreground"
            : "flex cursor-pointer select-none items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
        }
      >
        <span className="w-2 shrink-0 text-center">{open ? "▾" : "▸"}</span>
        <span className={live ? "animate-pulse" : undefined}>💭</span>
        <span className="shrink-0">{live ? "思考中…" : "思考过程"}</span>
        {!open && preview.length > 0 && (
          <span className="truncate opacity-60">{preview}</span>
        )}
      </summary>
      {open && (
        <div
          ref={bodyRef}
          className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-muted/30 px-2 py-1.5 text-[11px] leading-relaxed text-muted-foreground"
        >
          {text}
        </div>
      )}
    </details>
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
