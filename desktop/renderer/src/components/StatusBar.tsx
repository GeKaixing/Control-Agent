import React from "react";
import { Separator } from "./ui/separator";
import type { InfoPayload, UsagePayload } from "../../../shared/api";
import { isMacPlatform, useWcoButtonWidth } from "../lib/wco";
import { fmtTokens } from "../lib/format";
import { Cpu, FolderTree, AlertTriangle } from "lucide-react";

interface Props {
  info: InfoPayload | null;
  usage: UsagePayload;
  notice: string | null;
  /** 当前会话标题（session_title 事件）：红绿灯右侧第一个位置。缺省不渲染 */
  title?: string | null;
}

/**
 * 顶部状态条：应用标识 / 会话标题 / cwd / 模型 / token 用量 / 通知。
 *
 * 兼任窗口标题栏（main 里按平台配的 titleBarStyle）：
 * - macOS（hiddenInset）：`pl-20` 给红绿灯留位；
 * - Windows（hidden + titleBarOverlay / WCO）：左侧整块由本组件自定义，
 *   右侧原生 最小化/最大化/关闭按钮区 用 `windowControlsOverlay` 动态量宽避让；
 * - Linux（hidden，无 overlay）：无原生控件，两侧只留常规 padding。
 * 整条 `[-webkit-app-region:drag]` 可拖动窗口；本条内没有可点元素。
 * 想换标题栏颜色：改这里的 bg-* 即可，原生标题栏已经不存在了。
 *
 * **左侧自定义入口**：见下方 <Brand /> —— logo / 名字 / 徽标想怎么换都行。
 *
 * 「切模型」已迁到 Composer 的 EndpointModelMenu + 自定义 modal；
 * 「新会话」已迁到 Composer 的 FilePlus 按钮（发送键左边）。本条只负责状态回显。
 */

/**
 * Windows WCO 右侧按钮区宽度与平台判断的实现已抽到 lib/wco.ts
 * （Composer 模式的顶部拖动条同样要避让），这里只消费。
 */

/** 左侧品牌位：标题栏自定义的最左元素。换 logo / 改名字只动这里。 */
function Brand(): React.ReactElement {
  return (
    <span className="flex shrink-0 select-none items-center gap-1.5">
      {/* 想换成图片 logo：把下面这个圆点换成 <img src=... className="h-4 w-4" /> */}
      <span className="h-3.5 w-3.5 rounded-full bg-foreground" />
      <span className="font-semibold tracking-wide text-foreground">Control-Agent</span>
    </span>
  );
}

export function StatusBar({ info, usage, notice, title }: Props): React.ReactElement {
  // pl：darwin 红绿灯占位 80px；win32/linux 从左边缘开始，常规 padding 即可
  const isMac = isMacPlatform();
  const wcoWidth = useWcoButtonWidth();
  return (
    <header
      className="flex flex-nowrap items-center gap-3 overflow-hidden border-b border-border bg-card/50 py-2 text-xs text-muted-foreground select-none [-webkit-app-region:drag]"
      style={{
        paddingLeft: isMac ? "5rem" : "0.75rem",
        // 右侧给 WCO 原生按钮区让位（无 WCO 时 0 → 常规留白）
        paddingRight: `calc(${wcoWidth}px + 1rem)`,
      }}
    >
      <Brand />
      <Separator orientation="vertical" className="h-3 shrink-0" />
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
        {/* ctx = 当前上下文占用（窗口占比的分子）；in/out/total = 会话累计计费量。
            两者口径不同，刻意分开标注，避免被当成同一个数。 */}
        <span className="font-mono" title="ctx：当前上下文占用（最近一次请求的 prompt_tokens）">
          ctx <span className="text-foreground">{fmtTokens(usage.contextTokens)}</span>
        </span>
        <span className="font-mono" title="in/out/total：本会话累计用量（每轮重发上下文，累计远大于 ctx）">
          in <span className="text-foreground">{fmtTokens(usage.input)}</span> ·
          out <span className="text-foreground">{fmtTokens(usage.output)}</span> ·
          total <span className="text-foreground">{fmtTokens(usage.total)}</span>
        </span>
      </div>
    </header>
  );
}

function shorten(s: string, n: number): string {
  if (s.length <= n) return s;
  return `…${s.slice(s.length - n + 1)}`;
}
