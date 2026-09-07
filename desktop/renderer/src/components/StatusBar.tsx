import React from "react";
import { Separator } from "./ui/separator";
import type { InfoPayload, UsagePayload } from "../../../shared/api";
import { Cpu, FolderTree, AlertTriangle } from "lucide-react";

interface Props {
  info: InfoPayload | null;
  usage: UsagePayload;
  notice: string | null;
  /** 当前会话标题（session_title 事件）：红绿灯右侧第一个位置。缺省不渲染 */
  title?: string | null;
}

/**
 * 顶部状态条：会话标题 / cwd / 模型 / token 用量 / 通知。
 *
 * 兼任窗口标题栏（main 里 titleBarStyle: "hiddenInset"）：
 * - `pl-20` 给 macOS 红绿灯留位；
 * - `[-webkit-app-region:drag]` 让整条可拖动窗口；本条内没有可点元素，
 *   无须给子元素标 no-drag（切模型/新会话按钮都在 Composer，不在这条上）。
 * 想换标题栏颜色：改这里的 bg-* 即可，原生标题栏已经不存在了。
 *
 * 「切模型」已迁到 Composer 的 EndpointModelMenu + 自定义 modal；
 * 「新会话」已迁到 Composer 的 FilePlus 按钮（发送键左边）。本条只负责状态回显。
 */
export function StatusBar({ info, usage, notice, title }: Props): React.ReactElement {
  return (
    <header className="flex flex-nowrap items-center gap-3 overflow-hidden border-b border-border bg-card/50 pr-4 pl-20 py-2 text-xs text-muted-foreground select-none [-webkit-app-region:drag]">
      {info !== null && info.sessionTitle.length > 0 && (
        <span className="max-w-[16rem] shrink-0 truncate font-medium text-foreground" title={info.sessionTitle}>
          {info.sessionTitle}
        </span>
      )}
      {title !== undefined && title !== null && title.length > 0 && (
        <>
          <div
            className="min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            title={title}
          >
            <span className="whitespace-nowrap">
              {info !== null && info.sessionTitle.length > 0 ? "· " : ""}
              {title}
            </span>
          </div>
          <Separator orientation="vertical" className="h-3 shrink-0" />
        </>
      )}
      {info !== null ? (
        <>
          <span className="inline-flex min-w-0 shrink items-center gap-1" title={info.cwd}>
            <FolderTree className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate font-mono">{shorten(info.cwd, 32)}</span>
          </span>
          <Separator orientation="vertical" className="h-3 shrink-0" />
          <span className="inline-flex min-w-0 shrink items-center gap-1" title={info.tools.join(", ")}>
            <Cpu className="h-3.5 w-3.5 shrink-0" />
            <span className="max-w-[16rem] truncate font-semibold text-foreground">{info.model}</span>
            {info.degraded !== undefined && (
              <span className="inline-flex items-center gap-1 whitespace-nowrap text-amber-400">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                {info.degraded}
              </span>
            )}
          </span>
        </>
      ) : (
        <span className="shrink-0 whitespace-nowrap">连接中…</span>
      )}
      {notice !== null && notice.length > 0 && (
        <span className="max-w-[24rem] truncate rounded-md bg-amber-900/40 px-2 py-0.5 text-amber-300">{notice}</span>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-3">
        <span className="font-mono">
          in <span className="text-foreground">{usage.input}</span> ·
          out <span className="text-foreground">{usage.output}</span> ·
          total <span className="text-foreground">{usage.total}</span>
        </span>
      </div>
    </header>
  );
}

function shorten(s: string, n: number): string {
  if (s.length <= n) return s;
  return `…${s.slice(s.length - n + 1)}`;
}
