/**
 * 内部浏览器面板的标签条（渲染层 HTML）：全部标签页 + 新建按钮。
 * 点击切换（主进程换挂载视图，后台标签保活），× 真正关闭该标签。
 * 活动标签高亮、加载中带脉冲点；标题缺省用 URL / 占位文案。
 */

import React from "react";
import { Plus, X } from "lucide-react";
import type { BrowserPanelState } from "../store";

interface Props {
  browser: BrowserPanelState;
}

function tabLabel(t: { title: string; url: string }): string {
  if (t.title.trim().length > 0) return t.title;
  if (t.url.length > 0) return t.url;
  return "新标签页";
}

export function BrowserTabs({ browser }: Props): React.ReactElement | null {
  if (browser.tabs.length === 0) return null;
  return (
    <div className="flex shrink-0 items-end gap-1 border-b border-border bg-muted/40 px-1.5 pt-1">
      {browser.tabs.map((t) => {
        const active = t.id === browser.activeId;
        const label = tabLabel(t);
        return (
          <div
            key={t.id}
            onClick={() => void window.api.browserSwitchTab(t.id)}
            title={label}
            className={`group flex min-w-0 max-w-[11rem] shrink cursor-pointer items-center gap-1 rounded-t-md border border-b-0 px-2 py-1 text-xs transition-colors ${
              active
                ? "border-border bg-background text-foreground"
                : "border-transparent text-muted-foreground hover:bg-background/60"
            }`}
          >
            {t.loading && (
              <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-muted-foreground/60" />
            )}
            <span className="min-w-0 flex-1 truncate select-none">{label}</span>
            <button
              type="button"
              title="关闭标签页"
              onClick={(e) => {
                e.stopPropagation();
                void window.api.browserCloseTab(t.id);
              }}
              className={`shrink-0 rounded p-0.5 text-muted-foreground transition-opacity hover:bg-muted hover:text-foreground ${
                active ? "opacity-60 hover:opacity-100" : "opacity-0 group-hover:opacity-100"
              }`}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        title="新建标签页"
        onClick={() => void window.api.browserNewTab()}
        className="mb-0.5 shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
