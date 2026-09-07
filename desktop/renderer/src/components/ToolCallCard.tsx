import React, { useRef, useState, useEffect } from "react";
import { Check, Copy } from "lucide-react";
import type { ToolCallState } from "../store";

interface Props {
  toolCalls: ToolCallState[];
}

/**
 * 工具调用卡片：折叠式，名字 + 状态徽标 + 用时，点击展开看参数与结果。
 * v1 一律用 <pre> 把对象 / 文本按字面显示，不调 markdown 库。
 *
 * 显示层截断到 8000 字符（带「…[已截断 N 字符]…」占位），但「复制完整结果」
 * 按钮复制的是 tc.text 原文——完整、无截断占位符。
 */
export function ToolCallCard({ toolCalls }: Props): React.ReactElement | null {
  if (toolCalls.length === 0) return null;
  return (
    <>
      {toolCalls.map((tc) => (
        <ToolCallCardItem key={tc.id} tc={tc} />
      ))}
    </>
  );
}

function ToolCallCardItem({ tc }: { tc: ToolCallState }): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    },
    [],
  );

  const copyResult = async (): Promise<void> => {
    if (tc.status !== "done") return; // 复制按钮只在 done 态渲染，这里收窄给 tc.text
    try {
      await navigator.clipboard.writeText(tc.text);
      setCopied(true);
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // 剪贴板不可用：静默失败
    }
  };

  return (
    <details
      className={`group my-2 overflow-hidden rounded-md border border-border bg-card/60 text-sm ${
        tc.status === "done" && !tc.ok ? "border-destructive/60" : ""
      }`}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 hover:bg-accent/40 select-none">
        <span className="text-muted-foreground">→</span>
        <span
          className={
            tc.status === "done" && !tc.ok
              ? "font-semibold text-destructive"
              : tc.status === "pending"
                ? "font-semibold text-muted-foreground"
                : "font-semibold text-primary"
          }
        >
          {tc.name}
        </span>
        <span className="ml-auto text-xs text-muted-foreground">
          {tc.status === "done" ? `${tc.ms}ms` : "…"}
        </span>
      </summary>
      <div className="border-t border-border px-3 py-2">
        <pre className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
          {JSON.stringify(tc.args, null, 2)}
        </pre>
        {tc.status === "done" && (
          <div className="mt-2 border-t border-dashed border-border pt-2">
            <div className="mb-1 flex items-center justify-end gap-2">
              <span className="text-[10px] text-muted-foreground">
                {tc.text.length > 8000 ? `显示已截断，完整 ${tc.text.length} 字符` : ""}
              </span>
              <button
                type="button"
                title="复制完整结果（无截断）"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  void copyResult();
                }}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
              >
                {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                {copied ? "已复制" : "复制完整结果"}
              </button>
            </div>
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs">
              {truncate(tc.text, 8000)}
            </pre>
          </div>
        )}
      </div>
    </details>
  );
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2) - 32;
  const hidden = text.length - half * 2;
  return `${text.slice(0, half)}\n…[已截断 ${hidden} 字符]…\n${text.slice(text.length - half)}`;
}
