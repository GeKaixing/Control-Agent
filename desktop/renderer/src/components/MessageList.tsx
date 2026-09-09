import React, { useEffect, useRef } from "react";
import { ScrollArea } from "./ui/scroll-area";
import type { Turn } from "../store";
import { ToolCallCard } from "./ToolCallCard";

interface Props {
  turns: Turn[];
}

/**
 * 消息列表：滚动到底。
 * user / assistant / 工具调用都直接渲染；v1 不解析 markdown，
 * 用 white-space: pre-wrap 让代码块 / 列表自然显示。
 */
export function MessageList({ turns }: Props): React.ReactElement {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    el.scrollTop = el.scrollHeight;
  }, [turns]);

  if (turns.length === 0) {
    return (
      <ScrollArea className="flex-1">
        <div className="p-16 text-center text-sm text-muted-foreground">
          还没有消息——在下方输入框里发第一条消息吧。
        </div>
      </ScrollArea>
    );
  }

  return (
    <ScrollArea className="flex-1">
      <div ref={ref} className="flex flex-col gap-3 p-4">
        {turns.map((t) => {
          if (t.role === "user") {
            return (
              <div
                key={t.id}
                className="flex max-w-[92%] flex-col items-end gap-1.5 self-end"
              >
                {t.images !== undefined && t.images.length > 0 && (
                  <div className="flex max-w-full flex-wrap justify-end gap-1.5">
                    {t.images.map((img, i) => (
                      <img
                        key={i}
                        src={img.dataUrl}
                        alt={`附件 ${i + 1}`}
                        className="max-h-40 max-w-[16rem] rounded-lg border border-border object-cover"
                      />
                    ))}
                  </div>
                )}
                {t.text.length > 0 && (
                  <div className="whitespace-pre-wrap break-words rounded-lg border border-primary/30 bg-primary/10 px-4 py-2 text-foreground">
                    {t.text}
                  </div>
                )}
              </div>
            );
          }
          const isEmpty =
            t.text.length === 0 && t.toolCalls.length === 0 && t.thinking.length === 0;
          return (
            <div key={t.id} className="max-w-[92%] self-start">
              {t.thinking.length > 0 && <ThinkingBlock text={t.thinking} live={t.live} />}
              <div
                className={`whitespace-pre-wrap break-words leading-relaxed ${
                  isEmpty ? "text-muted-foreground" : "text-foreground"
                } ${t.live ? "live-cursor" : ""}`}
              >
                {isEmpty ? (t.live ? "（思考中…）" : "") : t.text}
              </div>
              <ToolCallCard toolCalls={t.toolCalls} />
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );
}

/**
 * 思考过程折叠块：默认收起不打扰，点开展开灰色小字全文。
 * 流式期间 delta 高频到达——<details> 非受控展开状态不受重渲染影响，
 * 收起时浏览器只保留 summary 高度，滚动也不会跳。
 */
function ThinkingBlock({ text, live }: { text: string; live: boolean }): React.ReactElement {
  return (
    <details className="mb-1.5 group/think">
      <summary className="cursor-pointer select-none text-[11px] text-muted-foreground hover:text-foreground">
        {live ? "💭 思考中…（点开查看）" : "💭 思考过程"}
      </summary>
      <div className="mt-1 max-h-60 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
        {text}
      </div>
    </details>
  );
}
