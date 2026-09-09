/**
 * ask_user 问答卡：模型经 ask_user 工具提问时渲染在 Composer 上方。
 *  - 有 choices 时渲染成按钮（点了即答），输入框仍可用（自由回答优先于选项）
 *  - 「跳过」= 提交空串，主进程视为中断（工具以 fail「提问被中断」收场）
 *  - 回答后立即进入已答态防重复提交；卡片由 ask_user_done 广播统一撤下
 */

import React, { useState } from "react";
import { useSessionStore, type PendingAsk } from "../store";

export function AskUserCard({ ask }: { ask: PendingAsk }): React.ReactElement {
  const answerAsk = useSessionStore((s) => s.answerAsk);
  const [draft, setDraft] = useState("");
  const [sent, setSent] = useState<string | null>(null);

  const send = (answer: string): void => {
    if (sent !== null) return;
    setSent(answer);
    void answerAsk(ask.id, answer);
  };

  return (
    <div className="rounded-lg border border-primary/40 bg-primary/5 px-4 py-3 shadow-sm">
      <div className="mb-2 flex items-baseline gap-2">
        <span className="shrink-0 text-[11px] font-medium text-primary">模型提问</span>
        <span className="whitespace-pre-wrap break-words text-sm text-foreground">{ask.question}</span>
      </div>

      {sent !== null ? (
        <div className="text-xs text-muted-foreground">
          {sent.length > 0 ? `已回答：${sent}` : "已跳过，等待模型继续…"}
        </div>
      ) : (
        <>
          {ask.choices !== undefined && ask.choices.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {ask.choices.map((c, i) => (
                <button
                  key={i}
                  type="button"
                  title={c}
                  onClick={() => send(c)}
                  className="max-w-full truncate rounded-md border border-border bg-background px-2.5 py-1 text-xs text-foreground transition-colors hover:border-primary/50 hover:bg-primary/10"
                >
                  {c}
                </button>
              ))}
            </div>
          )}
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && draft.trim().length > 0) send(draft);
              }}
              placeholder="输入回答，回车提交…"
              className="min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-primary/50"
            />
            <button
              type="button"
              disabled={draft.trim().length === 0}
              onClick={() => send(draft)}
              className="shrink-0 rounded-md border border-primary/40 bg-primary/10 px-2.5 py-1.5 text-xs text-foreground transition-colors hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-40"
            >
              提交
            </button>
            <button
              type="button"
              onClick={() => send("")}
              className="shrink-0 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
              title="跳过本次提问（模型会收到「提问被中断」）"
            >
              跳过
            </button>
          </div>
        </>
      )}
    </div>
  );
}
