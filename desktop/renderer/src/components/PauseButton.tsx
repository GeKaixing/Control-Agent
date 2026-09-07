import React from "react";
import { Play, Loader2 } from "lucide-react";
import { cn } from "../lib/utils";

interface Props {
  paused: boolean;
  /** 仅在 agent 跑着时显示，否则不显示 */
  visible: boolean;
  onToggle: () => void;
}

/**
 * 暂停/继续 —— OpenCode 风格圆形图标钮（运行态才出现）。
 * - 运行且未暂停：显示一个脉冲 icon，点击暂停。
 * - 已暂停：显示 ▶，点击继续。
 * v1：只切 UI 态；agent 调度层尚未消费这个信号（下一轮接 text_delta 处的 await resumeEvent）。
 */
export function PauseButton({ paused, visible, onToggle }: Props): React.ReactElement | null {
  if (!visible) return null;
  return (
    <button
      type="button"
      onClick={onToggle}
      title={paused ? "继续输出" : "暂停输出"}
      className={cn(
        "flex h-7 w-7 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground",
        paused && "border-primary/50 text-primary",
      )}
    >
      {paused ? (
        <Play className="h-3.5 w-3.5" />
      ) : (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      )}
    </button>
  );
}
