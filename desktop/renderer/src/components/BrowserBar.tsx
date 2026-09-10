/**
 * 内部浏览器面板的工具条（渲染层 HTML）：后退 / 前进 / 刷新或停止 + 地址栏 +
 * 系统浏览器外开 + 关闭面板。原生网页由主进程的 WebContentsView 渲染，
 * 这条工具条渲染在标签条与占位区之间（占位区下移留给原生视图）。
 * 状态取自**活动标签页**（BrowserTabs 里当前选中的那个）。
 */

import React, { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, ExternalLink, RotateCw, X } from "lucide-react";
import type { BrowserTabInfo } from "../../../shared/api";

interface Props {
  tab: BrowserTabInfo | null;
}

export function BrowserBar({ tab }: Props): React.ReactElement {
  const url = tab?.url ?? "";
  // 地址栏输入框的本地草稿：url 变化（页内点击链接、导航完成、切标签）时同步，
  // 用户正在输入时不覆盖（只在外部 url 变化时写回）
  const [draft, setDraft] = useState(url);
  useEffect(() => {
    setDraft(url);
  }, [url]);

  const none = tab === null;

  const handleSubmit = (): void => {
    const value = draft.trim();
    if (value.length === 0) return;
    void window.api.browserNavigate(value);
  };

  const handleExternal = (): void => {
    const value = url.trim();
    if (value.length > 0) void window.open(value, "_blank");
  };

  const btn =
    "shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40";

  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-border bg-background px-2 py-1">
      <button
        type="button"
        title="后退"
        className={btn}
        disabled={none || !tab.canGoBack}
        onClick={() => void window.api.browserBack()}
      >
        <ArrowLeft className="h-4 w-4" />
      </button>
      <button
        type="button"
        title="前进"
        className={btn}
        disabled={none || !tab.canGoForward}
        onClick={() => void window.api.browserForward()}
      >
        <ArrowRight className="h-4 w-4" />
      </button>
      {!none && tab.loading ? (
        <button
          type="button"
          title="停止"
          className={btn}
          onClick={() => void window.api.browserStop()}
        >
          <X className="h-4 w-4" />
        </button>
      ) : (
        <button
          type="button"
          title="刷新"
          className={btn}
          disabled={none}
          onClick={() => void window.api.browserReload()}
        >
          <RotateCw className="h-4 w-4" />
        </button>
      )}
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") handleSubmit();
        }}
        placeholder="输入网址或搜索词，回车打开"
        spellCheck={false}
        className="min-w-0 flex-1 rounded-md border border-border bg-muted/50 px-2.5 py-1 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-foreground/30 focus:bg-background"
      />
      <button
        type="button"
        title="在系统浏览器打开"
        className={btn}
        disabled={url.trim().length === 0}
        onClick={handleExternal}
      >
        <ExternalLink className="h-4 w-4" />
      </button>
      <button
        type="button"
        title="关闭浏览器面板"
        className={btn}
        onClick={() => void window.api.browserClose()}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
