import React, { useRef } from "react";
import { ChevronDown, Info } from "lucide-react";
import { cn } from "../lib/utils";
import { openPopoverAt } from "./ToolsPanel";
import type { RunMode } from "../../../shared/api";

const MODES: { value: RunMode; label: string; tip: string }[] = [
  { value: "answer_only", label: "仅回答", tip: "agent 不调任何工具，仅基于上下文回答" },
  { value: "plan", label: "计划", tip: "agent 先输出计划，等用户确认后再执行" },
  { value: "full", label: "允许完全访问", tip: "agent 可调用所有工具自由执行" },
  {
    value: "autopilot",
    label: "朝着目标",
    tip: "自动驾驶：自动朝着目标连续推进，模型输出 [目标完成] 收工；连续 20 轮自动熔断",
  },
];

/** 远行模式触发按钮的强调色（violet 与「完全访问」的 red 区分）。 */
const AUTOPILOT_CLASS = "text-violet-600";

/** 「运行模式」触发按钮：`① [label] ▾`，点击打开弹层子窗口。 */
export function ModeToggle({ value }: { value: RunMode }): React.ReactElement {
  const ref = useRef<HTMLButtonElement | null>(null);
  const active = MODES.find((m) => m.value === value) ?? MODES[2];
  const isFull = value === "full";
  const isAutopilot = value === "autopilot";
  const accent = isFull ? "text-red-600" : isAutopilot ? AUTOPILOT_CLASS : "";

  return (
    <button
      type="button"
      ref={ref}
      data-popover-trigger="mode"
      onClick={() => openPopoverAt("mode", ref.current, 176)}
      title={active.tip}
      className={cn(
        "flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-1 text-[12px] transition-colors hover:bg-accent/40",
        accent !== "" ? accent : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Info className={cn("h-3.5 w-3.5", accent !== "" ? accent : "text-muted-foreground")} />
      <span className="font-medium">{active.label}</span>
      <ChevronDown className="h-3 w-3 opacity-60" />
    </button>
  );
}

/**
 * 「运行模式」弹层内容，渲染在弹层子窗口里（PopoverHost）。
 * 审批模式开关已迁到「设置」弹层（SettingsPopover）——权限是设置项不是模式。
 */
export function ModeToggleContent({ mode, onChange }: { mode: RunMode; onChange: (mode: RunMode) => void }): React.ReactElement {
  return (
    <div className="w-full overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md">
      <div className="border-b border-border bg-muted/40 px-3 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        运行模式
      </div>
      <ul className="py-1">
        {MODES.map((m) => {
          const activeItem = m.value === mode;
          const fullItem = m.value === "full";
          const autopilotItem = m.value === "autopilot";
          return (
            <li key={m.value}>
              <button
                type="button"
                onClick={() => onChange(m.value)}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-accent/40",
                  fullItem && "text-red-600",
                  autopilotItem && "text-violet-600",
                )}
              >
                <span className="w-3 text-center">{activeItem ? (fullItem ? "●" : "✓") : ""}</span>
                <span className="flex-1">
                  <div className="font-medium">{m.label}</div>
                  <div className="text-[10px] text-muted-foreground">{m.tip}</div>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
