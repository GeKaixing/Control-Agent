import React, { useEffect, useRef } from "react";
import { ChevronDown, Zap, Activity, Sparkles, Gauge, FileText, Wrench, MessagesSquare, Plug, BookOpen } from "lucide-react";
import { cn } from "../lib/utils";
import { openPopoverAt } from "./ToolsPanel";
import { useSessionStore } from "../store";
import type { ContextBreakdown, ReasoningLevel, UsagePayload } from "../../../shared/api";

/** 推理强度四档配置（auto 在最前，标推荐）。 */
const REASONING_OPTIONS: {
  value: ReasoningLevel;
  label: string;
  tip: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  {
    value: "auto",
    label: "自动",
    tip: "推荐：按任务难度动态升降推理强度，简单问题不浪费",
    icon: Gauge,
  },
  {
    value: "fast",
    label: "快速",
    tip: "固定 low，缩短输出 token 上限，秒回",
    icon: Zap,
  },
  {
    value: "balanced",
    label: "均衡",
    tip: "固定 medium，平衡速度与质量",
    icon: Activity,
  },
  {
    value: "ultra",
    label: "极致",
    tip: "固定 high，放开 token 让模型尽量多思考",
    icon: Sparkles,
  },
];

/** 「推理强度」触发按钮：OpenCode 风格「均衡 ▾」，点击打开弹层子窗口。 */
export function ContextBar(): React.ReactElement {
  const ref = useRef<HTMLButtonElement | null>(null);
  const current = useSessionStore((s) => s.info?.reasoning ?? "balanced");
  const activeMeta =
    REASONING_OPTIONS.find((r) => r.value === current) ??
    REASONING_OPTIONS.find((r) => r.value === "balanced")!;
  const TriggerIcon = activeMeta.icon;

  return (
    <button
      type="button"
      ref={ref}
      data-popover-trigger="reasoning"
      onClick={() => openPopoverAt("reasoning", ref.current, 288)}
      title="推理强度（点击调整）"
      className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
    >
      <TriggerIcon className="h-3.5 w-3.5" />
      <span className="font-medium text-foreground">{activeMeta.label}</span>
      <ChevronDown className="h-3 w-3 opacity-60" />
    </button>
  );
}

/**
 * 「上下文使用量」独立触发按钮：紧挨「均衡」旁，迷你进度条 + 百分比，
 * 阈值着色（<60% 绿 / 60-80% 琥珀 / ≥80% 红），点击打开用量 + 构成弹层。
 */
export function ContextUsageBar({
  usage,
  contextWindow,
}: {
  usage: UsagePayload;
  contextWindow: number;
}): React.ReactElement {
  const ref = useRef<HTMLButtonElement | null>(null);
  const safe = contextWindow > 0 ? contextWindow : 1;
  const ratio = Math.min(1, usage.input / safe);
  const pct = Math.round(ratio * 100);
  const barClass = pct >= 80 ? "bg-destructive" : pct >= 60 ? "bg-amber-500" : "bg-emerald-500";
  const textClass = pct >= 80 ? "text-destructive" : pct >= 60 ? "text-amber-500" : "text-emerald-500";

  return (
    <button
      type="button"
      ref={ref}
      data-popover-trigger="usage"
      onClick={() => openPopoverAt("usage", ref.current, 288)}
      title="上下文使用量（点击查看构成）"
      className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-1.5 py-1 transition-colors hover:bg-accent/40"
    >
      <div className="h-1.5 w-10 overflow-hidden rounded-full bg-border">
        <div className={cn("h-full rounded-full transition-all", barClass)} style={{ width: `${pct}%` }} />
      </div>
      <span className={cn("font-mono text-[11px]", textClass)}>{pct}%</span>
    </button>
  );
}

/** 推理强度弹层内容，渲染在弹层子窗口里（PopoverHost）。 */
export function ReasoningContent({ onClose }: { onClose: () => void }): React.ReactElement {
  const [current, setCurrent] = React.useState<ReasoningLevel>("balanced");

  useEffect(() => {
    void window.api.info().then((i) => setCurrent(i.reasoning));
  }, []);

  return (
    <div className="w-full overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md">
      <div className="border-b border-border bg-muted/40 px-3 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        推理强度
      </div>
      <ul className="py-1">
        {REASONING_OPTIONS.map((o) => {
          const active = o.value === current;
          const Icon = o.icon;
          return (
            <li key={o.value}>
              <button
                type="button"
                onClick={() => {
                  // 主进程在 setReasoning 成功后主动广播 refresh-info（弹层随时会被
                  // onClose 销毁，这里发事后通知有竞态丢失）
                  void window.api.setReasoning(o.value);
                  onClose();
                }}
                className={cn(
                  "flex w-full items-start gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-accent/40",
                  active && "bg-primary/10",
                )}
              >
                <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-1.5">
                    <span className="font-medium text-foreground">{o.label}</span>
                    {active && <span className="text-[10px] text-primary">✓ 当前</span>}
                  </div>
                  <div className="text-[10px] text-muted-foreground">{o.tip}</div>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** 上下文构成五段（顺序 = 弹层展示顺序）。 */
const BREAKDOWN_SEGMENTS: {
  key: keyof ContextBreakdown;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { key: "systemPrompt", label: "系统提示词", icon: FileText },
  { key: "tools", label: "工具", icon: Wrench },
  { key: "messages", label: "对话消息", icon: MessagesSquare },
  { key: "connectors", label: "连接器", icon: Plug },
  { key: "skills", label: "技能", icon: BookOpen },
];

/** 上下文使用量 + 构成弹层内容，渲染在弹层子窗口里（PopoverHost）。 */
export function UsageContent({
  usage,
  contextWindow,
  breakdown,
}: {
  usage: UsagePayload;
  contextWindow: number;
  breakdown: ContextBreakdown;
}): React.ReactElement {
  const safe = contextWindow > 0 ? contextWindow : 1;
  const ratio = Math.min(1, usage.input / safe);
  const pct = Math.round(ratio * 100);
  const barClass = pct >= 80 ? "bg-destructive" : pct >= 60 ? "bg-amber-500" : "bg-emerald-500";

  return (
    <div className="w-full overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md">
      {/* ─── 上下文使用量 ─── */}
      <div className="border-b border-border bg-muted/40 px-3 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        上下文使用量
      </div>
      <div className="space-y-2 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-border">
            <div className={cn("h-full rounded-full transition-all", barClass)} style={{ width: `${pct}%` }} />
          </div>
          <span className="font-mono text-[11px] text-muted-foreground">{pct}%</span>
        </div>
        <div className="flex items-baseline justify-between text-[11px]">
          <span className="text-muted-foreground">已用</span>
          <span className="font-mono text-foreground">{fmt(usage.input)}</span>
        </div>
        <div className="flex items-baseline justify-between text-[11px]">
          <span className="text-muted-foreground">窗口上限</span>
          <span className="font-mono text-foreground">{fmt(contextWindow)}</span>
        </div>
        <p className="pt-1 text-[10px] leading-relaxed text-muted-foreground">
          基于当前模型（按 model id 粗查）的上下文窗口估算。超过 80% 会变红提示溢出风险。
        </p>
      </div>

      {/* ─── 上下文构成（分项粗估） ─── */}
      <div className="border-t border-border bg-muted/40 px-3 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        上下文构成
      </div>
      <div className="space-y-1.5 px-3 py-2.5">
        {BREAKDOWN_SEGMENTS.map((seg) => {
          const tokens = breakdown[seg.key];
          const total = BREAKDOWN_SEGMENTS.reduce((acc, s) => acc + breakdown[s.key], 0);
          const share = total > 0 ? Math.round((tokens / total) * 100) : 0;
          const Icon = seg.icon;
          return (
            <div key={seg.key} className="flex items-center gap-2">
              <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="w-16 shrink-0 text-[11px] text-foreground">{seg.label}</span>
              <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-border">
                <div
                  className="h-full rounded-full bg-primary/70 transition-all"
                  style={{ width: `${share}%` }}
                />
              </div>
              <span
                className={cn(
                  "w-14 shrink-0 text-right font-mono text-[11px]",
                  tokens === 0 ? "text-muted-foreground/60" : "text-foreground",
                )}
              >
                {fmt(tokens)}
              </span>
            </div>
          );
        })}
        <p className="pt-1 text-[10px] leading-relaxed text-muted-foreground">
          按字符数粗估（与真实计费口径有偏差）：工具 / 连接器按 schema + 描述序列化估算，
          技能注入暂未接入。
        </p>
      </div>
    </div>
  );
}

/** k / M 简化。 */
function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
