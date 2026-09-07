import React, { useRef } from "react";
import { Plus, Wrench, BookOpen, Plug, Puzzle, Layers } from "lucide-react";
import { cn } from "../lib/utils";
import type { InfoPayload, PopoverId, ToolCategory, ToolEntry } from "../../../shared/api";

const CATEGORY_META: Array<{
  key: ToolCategory;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  desc: string;
}> = [
  { key: "tool", label: "Tool", icon: Wrench, desc: "agent 内核直接调用的工具" },
  { key: "skill", label: "Skill", icon: BookOpen, desc: "注入提示词的 expert skill" },
  { key: "mcp", label: "MCP", icon: Plug, desc: "Model Context Protocol server 注册的工具" },
  { key: "plugin", label: "Plugin", icon: Puzzle, desc: "通过 connector runtime 加载的插件" },
  { key: "extension", label: "Extension", icon: Layers, desc: "桌面端 / IDE 提供的扩展" },
];

/**
 * 从触发元素算出屏幕坐标，请求主进程打开弹层子窗口（浮在按钮下方，主窗口不动）。
 * 坐标：窗口原点（screenX/Y，hiddenInset 下即内容原点）+ 元素在视口内的位置。
 */
export function openPopoverAt(id: PopoverId, el: HTMLElement | null, width: number): void {
  if (el === null) return;
  const r = el.getBoundingClientRect();
  void window.api.openPopover({
    id,
    x: Math.round(window.screenX + r.left),
    y: Math.round(window.screenY + r.bottom + 6),
    width,
    // 按钮顶边：主进程在屏幕底部空间不足时据此把弹层翻到按钮上方
    triggerTop: Math.round(window.screenY + r.top),
  });
}

/**
 * 弹层子窗口内换弹层（如「模型」弹层 → 「自定义模型」弹层）：
 * 没有触发元素，直接以当前弹层窗口自己的屏幕位置为锚点——主进程收到请求后
 * 关掉旧弹层、在原位开新弹层，观感是弹层内容原地切换。
 */
export function openPopoverSelf(id: PopoverId, width: number): void {
  void window.api.openPopover({
    id,
    x: Math.round(window.screenX),
    y: Math.round(window.screenY),
    width,
    triggerTop: Math.round(window.screenY),
  });
}

/** 「工具」触发按钮：点击打开弹层子窗口。 */
export function ToolsPanel(): React.ReactElement {
  const ref = useRef<HTMLButtonElement | null>(null);
  return (
    <button
      type="button"
      ref={ref}
      data-popover-trigger="tools"
      onClick={() => openPopoverAt("tools", ref.current, 320)}
      title="agent 可用工具 · 按来源分组"
      className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
    >
      <Plus className="h-4 w-4" />
    </button>
  );
}

/**
 * 「工具」弹层内容：按来源分组展示 agent 当前可用 tool / skill / mcp / plugin / extension。
 * v1：只有 tool 是实数据，其他分组保留骨架（空数组时显示「（暂未注册）」）。
 * 渲染在弹层子窗口里（PopoverHost），宽度由窗口宽度决定。
 */
export function ToolsPanelContent({ info }: { info: InfoPayload }): React.ReactElement {
  const total = CATEGORY_META.reduce((acc, c) => acc + info.toolsByCategory[c.key].length, 0);

  return (
    <div className="flex max-h-[420px] w-full flex-col overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md">
      <div className="border-b border-border bg-muted/40 px-3 py-2 text-[10px] uppercase tracking-wide text-muted-foreground">
        agent 可用工具（{total} · 按来源分组）
      </div>
      <div className="overflow-auto">
        {CATEGORY_META.map((c) => {
          const items = info.toolsByCategory[c.key];
          const Icon = c.icon;
          return (
            <section key={c.key} className="border-b border-border last:border-b-0">
              <header className="flex items-center gap-2 px-3 pt-2 pb-1">
                <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                <div className="text-[11px] font-semibold">{c.label}</div>
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {items.length}
                </span>
              </header>
              <div className="px-3 pb-2 text-[10px] text-muted-foreground">{c.desc}</div>
              {items.length === 0 ? (
                <div className="px-3 pb-2 text-[10px] italic text-muted-foreground">（暂未注册）</div>
              ) : (
                <ul className="px-2 pb-2">
                  {items.map((t) => (
                    <ToolRow key={t.name} entry={t} />
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function ToolRow({ entry }: { entry: ToolEntry }): React.ReactElement {
  return (
    <li className="rounded-md px-2 py-1 hover:bg-accent/40">
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[12px] font-medium">{entry.name}</span>
        {entry.source !== undefined && (
          <span className={cn("truncate text-[10px] text-muted-foreground")}>{entry.source}</span>
        )}
      </div>
      <div className="line-clamp-2 text-[11px] text-muted-foreground">{entry.description}</div>
    </li>
  );
}
