import React, { useEffect, useRef, useState } from "react";
import { Server, ExternalLink, Eye, EyeOff } from "lucide-react";
import { cn } from "../lib/utils";
import { openPopoverAt } from "./ToolsPanel";
import type { InfoPayload, LocalServerInfo } from "../../../shared/api";

/**
 * 「agent 开启的本地服务预览」：
 *  - LocalServicesButton：状态栏入口（设置开关开启且检测到服务时显示角标），
 *    点击打开弹层子窗口；
 *  - LocalServicesContent：弹层内容——服务列表（探活状态 + 打开/内嵌预览）。
 *
 * 数据来源是 info.localServers：主进程 SessionManager 在 bash 工具结束时从
 * 输出里检测 localhost 地址（见 desktop/main/local-services.ts），随 info()
 * 下发。这里在 bash 的 tool_end / end 事件到达时重拉 info 保持实时。
 */

/** 单个服务的探活结果：probing 检测中 / ok 可访问 / down 未响应。 */
type ProbeState = "probing" | "ok" | "down";

/** 对服务发一个 no-cors 请求探活：连得上（TCP 层活）就算 ok，3s 超时。 */
async function probe(url: string): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    await fetch(url, { mode: "no-cors", signal: ctrl.signal, cache: "no-store" });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * 状态栏入口按钮（渲染在 Composer 底部状态栏，SettingsButton 左侧）。
 * 开关关闭时整颗按钮不渲染（feature 默认关闭 = 状态栏干净）。
 */
export function LocalServicesButton({
  enabled,
  count,
}: {
  enabled: boolean;
  count: number;
}): React.ReactElement | null {
  const ref = useRef<HTMLButtonElement | null>(null);
  if (!enabled) return null;
  return (
    <button
      type="button"
      ref={ref}
      data-popover-trigger="local-services"
      onClick={() => openPopoverAt("local-services", ref.current, 440)}
      title="agent 开启的本地服务"
      className="relative flex h-7 items-center gap-1 rounded-md px-1.5 text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
    >
      <Server className="h-4 w-4" />
      {count > 0 && (
        <span className="min-w-4 rounded-full bg-emerald-600 px-1 text-center text-[10px] font-medium leading-4 text-white">
          {count}
        </span>
      )}
    </button>
  );
}

/** 单个服务行的共用视觉。 */
function ServerRow({
  server,
  state,
  selected,
  onSelect,
}: {
  server: LocalServerInfo;
  state: ProbeState;
  selected: boolean;
  onSelect: () => void;
}): React.ReactElement {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-[12px] hover:bg-accent/30">
      {/* 探活状态点 */}
      <span
        className={cn(
          "h-2 w-2 shrink-0 rounded-full",
          state === "ok" && "bg-emerald-500",
          state === "down" && "bg-red-400",
          state === "probing" && "animate-pulse bg-muted-foreground/40",
        )}
        title={state === "ok" ? "可访问" : state === "down" ? "未响应（进程可能已退出）" : "检测中…"}
      />
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={() => window.open(server.url)}
          className="block max-w-full truncate font-medium text-left hover:underline"
          title={`${server.url}（点击在系统浏览器打开）`}
        >
          {server.url}
        </button>
        <div className="text-[10px] text-muted-foreground">
          端口 {server.port} · 最近出现 {formatTime(server.lastSeenAt)}
          {server.hits > 1 ? ` · ${server.hits} 次` : ""}
        </div>
      </div>
      <button
        type="button"
        onClick={onSelect}
        title={selected ? "收起内嵌预览" : "在弹窗内预览页面"}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent/60 hover:text-foreground"
      >
        {selected ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
      </button>
      <button
        type="button"
        onClick={() => window.open(server.url)}
        title="在系统浏览器打开"
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent/60 hover:text-foreground"
      >
        <ExternalLink className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/**
 * 「本地服务」弹层内容（弹层子窗口渲染，PopoverHost case "local-services"）。
 * 数据独立拉取（子窗口有自己的事件流订阅）；探活在拉到列表后逐个进行。
 */
export function LocalServicesContent(): React.ReactElement {
  const [info, setInfo] = useState<InfoPayload | null>(null);
  const [probes, setProbes] = useState<Record<string, ProbeState>>({});
  const [selected, setSelected] = useState<string | null>(null);

  const servers = info?.localServers ?? [];

  // 数据：拉一次 + 事件流增量更新。bash 的 tool_end / 会话 end / refresh-info
  // 到达时重拉 info——主进程在这些时点前后可能刚记录了新服务。
  useEffect(() => {
    void window.api.info().then(setInfo);
    return window.api.onEvent((e) => {
      if (
        (e.t === "tool_end" && e.name === "bash") ||
        e.t === "end" ||
        (e.t === "ui_action" && e.action === "refresh-info")
      ) {
        void window.api.info().then(setInfo);
      }
    });
  }, []);

  // 探活：info 每次更新都重新检测一轮（列表没变时也只是刷新存活状态，值得）。
  useEffect(() => {
    let cancelled = false;
    for (const s of servers) {
      setProbes((p) => (p[s.url] !== undefined ? p : { ...p, [s.url]: "probing" }));
      void probe(s.url).then((ok) => {
        if (!cancelled) setProbes((p) => ({ ...p, [s.url]: ok ? "ok" : "down" }));
      });
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info]);

  return (
    <div className="w-full overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md">
      <div className="border-b border-border bg-muted/40 px-3 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        agent 开启的本地服务
      </div>

      {/* 功能开关提示：入口按钮在关闭时不可见，这里兜底「先开后关」的时序 */}
      {info !== null && !info.localPreview && (
        <div className="border-b border-border bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
          该功能默认关闭。请到「设置」里开启「agent开启的本地服务预览」后使用。
        </div>
      )}

      {servers.length === 0 ? (
        <div className="px-3 py-3 text-[11px] leading-relaxed text-muted-foreground">
          还没有检测到本地服务。agent 在 bash 里启动服务后（输出中出现 localhost /
          127.0.0.1 地址），会自动出现在这里。
        </div>
      ) : (
        <div className="py-1">
          {servers.map((s) => (
            <ServerRow
              key={s.url}
              server={s}
              state={probes[s.url] ?? "probing"}
              selected={selected === s.url}
              onSelect={() => setSelected((cur) => (cur === s.url ? null : s.url))}
            />
          ))}
        </div>
      )}

      {/* 内嵌预览：iframe 直连服务页面；有些页面会拒绝被内嵌，留了浏览器打开的退路 */}
      {selected !== null && (
        <div className="border-t border-border">
          <iframe
            src={selected}
            title={`预览 ${selected}`}
            sandbox="allow-scripts allow-same-origin allow-forms"
            className="block h-72 w-full bg-white"
          />
          <div className="px-3 py-1.5 text-[10px] text-muted-foreground">
            内嵌预览空白？该页面可能禁止被内嵌，点链接在系统浏览器打开查看。
          </div>
        </div>
      )}

      <div className="border-t border-border px-3 py-1.5 text-[10px] leading-relaxed text-muted-foreground">
        服务地址检测自 bash 输出；bash 命令超时（120s）后会终止长驻进程，「未响应」的服务可能已被回收。
      </div>
    </div>
  );
}
