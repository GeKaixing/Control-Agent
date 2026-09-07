import React, { useEffect, useRef, useState } from "react";
import { ChevronDown, Cpu, Pencil, Globe, RefreshCw } from "lucide-react";
import { cn } from "../lib/utils";
import { openPopoverAt } from "./ToolsPanel";
import type {
  EndpointId,
  InfoPayload,
  ListModelsResult,
  PopoverId,
} from "../../../shared/api";

interface MenuEntry {
  spec: string;
  label: string;
  hint?: string;
}

/** 把 ListModelsResult 的条目转成菜单行；spec 拼 "provider:id" */
function toEntries(result: ListModelsResult): MenuEntry[] {
  return result.models.map((m) => ({
    spec: `${result.endpoint}:${m.id}`,
    label: m.id,
    hint: m.ownedBy !== undefined ? `owned_by: ${m.ownedBy}` : undefined,
  }));
}

/** 「模型」触发按钮：OpenCode 风格 `⑂ 模型名 ▾`，点击打开弹层子窗口。 */
export function EndpointModelMenu({ info }: { info: InfoPayload }): React.ReactElement {
  const ref = useRef<HTMLButtonElement | null>(null);
  return (
    <button
      type="button"
      ref={ref}
      data-popover-trigger="model"
      onClick={() => openPopoverAt("model" satisfies PopoverId, ref.current, 288)}
      title={`当前端点 base URL：${info.baseURL}\n来源：env（如 OPENAI_BASE_URL / ANTHROPIC_BASE_URL）\n点击切换模型 / 端点`}
      className="flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-[12px] text-foreground transition-colors hover:bg-accent/40"
    >
      <Cpu className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="max-w-[240px] truncate whitespace-nowrap font-medium" title={info.model}>
        {info.model}
      </span>
      <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
    </button>
  );
}

/**
 * 「模型」弹层内容，渲染在弹层子窗口里（PopoverHost）。
 *
 * 模型列表来自当前端点的动态 /models（5 分钟缓存，刷新按钮绕过）。
 * 拉取失败不回退静态列表——任意端点走「自定义模型」弹窗手动填接口地址 + key + 模型名。
 * 切换模型本轮会重建 `resolved`，但已开始的 turn 不打断——下一轮新建 Agent 时生效。
 */
export function EndpointModelMenuContent({
  info,
  onClose,
  onOpenCustomModel,
}: {
  info: InfoPayload;
  onClose: () => void;
  onOpenCustomModel: () => void;
}): React.ReactElement {
  /** 动态列表状态：null = 还没拉 / 不适用；loading 中 models 为空且 error 为 undefined */
  const [dynamic, setDynamic] = useState<ListModelsResult | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  /** 切换失败提示（setModel 的 IPC 异常必须可见，不能静默吞掉） */
  const [switchError, setSwitchError] = useState<string | null>(null);
  /** 防竞态：快速刷新时只采纳最后一次请求的结果 */
  const seqRef = useRef(0);

  const loadModels = (endpoint: EndpointId, refresh: boolean): void => {
    const seq = ++seqRef.current;
    setLoadingModels(true);
    window.api
      .listModels(endpoint, refresh)
      .then((result) => {
        if (seqRef.current !== seq) return; // 已过期，丢弃
        setDynamic(result);
      })
      .catch(() => {
        if (seqRef.current !== seq) return;
        setDynamic({ endpoint, url: "(unknown)", models: [], error: "拉取模型列表失败" });
      })
      .finally(() => {
        if (seqRef.current === seq) setLoadingModels(false);
      });
  };

  // 挂载 / 端点变化时拉当前端点的动态列表
  useEffect(() => {
    loadModels(info.endpoint, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info.endpoint]);

  const select = (spec: string): void => {
    // refresh-info 由主进程在 setModel 成功后广播
    window.api
      .setModel(spec)
      .then(() => onClose())
      .catch((err) => setSwitchError(`切换模型失败：${err instanceof Error ? err.message : String(err)}`));
  };

  // 模型列表：只用动态 /models；拉取失败提示走「自定义模型」
  const dynamicOk = dynamic !== null && dynamic.error === undefined && dynamic.models.length > 0;
  const modelEntries: MenuEntry[] = dynamicOk ? toEntries(dynamic) : [];
  const sectionTitle = dynamicOk
    ? `可用模型（${dynamic.models.length}）`
    : loadingModels
      ? "模型列表（加载中…）"
      : "可用模型";

  return (
    <div className="w-full overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md">
      <div className="flex items-center gap-1.5 border-b border-border bg-muted/40 px-3 py-1.5 text-[10px] text-muted-foreground">
        <Globe className="h-3 w-3" />
        <span className="truncate font-mono" title={info.baseURL}>
          {info.baseURL}
        </span>
      </div>

      {switchError !== null && (
        <div className="border-b border-border bg-red-500/10 px-3 py-1.5 text-[11px] text-red-600">
          {switchError}
        </div>
      )}

      {/* 模型列表：动态 /models */}
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        <span className="truncate" title={dynamicOk ? dynamic.url : undefined}>
          {sectionTitle}
        </span>
        <button
          type="button"
          title="重新拉取模型列表（绕过 5 分钟缓存）"
          onClick={(e) => {
            e.stopPropagation();
            loadModels(info.endpoint, true);
          }}
          className="shrink-0 rounded p-0.5 hover:bg-accent/40"
        >
          <RefreshCw className={cn("h-3 w-3", loadingModels && "animate-spin")} />
        </button>
      </div>
      {dynamicOk
        ? null
        : dynamic !== null && dynamic.error !== undefined
          ? (
            <div className="border-b border-border px-3 py-1.5 text-[10px] text-amber-600" title={dynamic.error}>
              模型列表拉取失败（{dynamic.error}），可用「自定义模型」手动输入
            </div>
          )
          : null}
      <ul className="max-h-56 overflow-auto py-1">
        {modelEntries.map((m) => {
          const active = m.spec === (info.modelSpec ?? info.model);
          return (
            <li key={m.spec}>
              <button
                type="button"
                onClick={() => select(m.spec)}
                className={cn(
                  "flex w-full items-start gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-accent/40",
                  active && "bg-primary/10",
                )}
              >
                <span className="mt-0.5 w-3 shrink-0 text-primary">{active ? "✓" : ""}</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono">{m.label}</div>
                  {m.hint !== undefined && (
                    <div className="truncate text-[10px] text-muted-foreground">{m.hint}</div>
                  )}
                </div>
              </button>
            </li>
          );
        })}
        {dynamic !== null && !dynamicOk && !loadingModels && dynamic.error === undefined && (
          <li className="px-3 py-1.5 text-[10px] text-muted-foreground">该端点暂无可用模型</li>
        )}
        <li className="border-t border-border">
          <button
            type="button"
            onClick={onOpenCustomModel}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-accent/40"
          >
            <Pencil className="h-3 w-3" />
            <span>自定义模型…</span>
          </button>
        </li>
      </ul>
    </div>
  );
}
