/**
 * PhonePanel：手机镜像面板（Mobile 控制通道的渲染层）。
 *
 * 与 BrowserBar/浏览器面板的分工：浏览器是原生 WebContentsView（渲染层只报
 * 占位区矩形）；手机镜像反过来——**面板本体就是渲染层 DOM**，帧由主进程经
 * PUSH 通道 phone_frame 推下来（本组件自行订阅，不进全局 store，避免 600ms
 * 一帧的 base64 拖累全局订阅者重渲染）。
 *
 * 手势换算：指针事件按**本帧实测尺寸**归一化成设备物理像素（模拟器横竖屏
 * 翻转分辨率会变，永远以帧为准）：
 * - 按下抬起位移 < 6px → tap；
 * - 否则 → swipe（时长 = 按住时长，夹在 80-800ms）。
 * 导航键：BACK(4) / HOME(3) / 最近任务(187)，keycode 由主进程注入。
 */

import React, { useEffect, useRef, useState } from "react";
import { useSessionStore } from "../store";

interface Frame {
  dataUrl: string;
  width: number;
  height: number;
}

/** 按下到抬起位移小于该值（CSS px）视为点击，否则视为滑动。 */
const TAP_SLOP_PX = 6;

export function PhonePanel(): React.ReactElement {
  const [frame, setFrame] = useState<Frame | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const downRef = useRef<{ x: number; y: number; t: number } | null>(null);
  const connected = useSessionStore((s) => s.phone?.connected === true);

  useEffect(() => {
    const off = window.api.onEvent((e) => {
      if (e.t === "phone_frame") {
        setFrame({ dataUrl: e.dataUrl, width: e.width, height: e.height });
      }
    });
    // 挂载即补一帧：不等下一个轮询周期（600ms），打开面板立刻有画面
    void window.api.phoneRefresh();
    return off;
  }, []);

  /** CSS 坐标 → 设备物理像素（按帧实测尺寸归一化）。 */
  function devicePoint(clientX: number, clientY: number): { x: number; y: number } | null {
    const img = imgRef.current;
    if (img === null || frame === null) return null;
    const rect = img.getBoundingClientRect();
    const nx = (clientX - rect.left) / rect.width;
    const ny = (clientY - rect.top) / rect.height;
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return null;
    return { x: nx * frame.width, y: ny * frame.height };
  }

  function onPointerDown(e: React.PointerEvent): void {
    downRef.current = { x: e.clientX, y: e.clientY, t: Date.now() };
  }

  function onPointerUp(e: React.PointerEvent): void {
    const down = downRef.current;
    downRef.current = null;
    if (down === null) return;
    const start = devicePoint(down.x, down.y);
    const end = devicePoint(e.clientX, e.clientY);
    if (start === null || end === null) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    if (moved < TAP_SLOP_PX) {
      void window.api.phoneTap(start.x, start.y);
      return;
    }
    const duration = Math.min(Math.max(Date.now() - down.t, 80), 800);
    void window.api.phoneSwipe(start.x, start.y, end.x, end.y, duration);
  }

  return (
    <div className="flex min-h-[480px] flex-1 flex-col bg-muted">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="text-xs font-medium text-foreground">手机镜像</span>
        <span className={`text-xs ${connected ? "text-muted-foreground" : "text-destructive"}`}>
          {connected ? "已连接" : "未检测到设备（启动安卓模拟器或接入 USB 真机）"}
        </span>
        <div className="flex-1" />
        <PhoneButton label="刷新" onClick={() => void window.api.phoneRefresh()} />
        <PhoneButton label="返回" onClick={() => void window.api.phoneKey(4)} />
        <PhoneButton label="HOME" onClick={() => void window.api.phoneKey(3)} />
        <PhoneButton label="最近任务" onClick={() => void window.api.phoneKey(187)} />
      </div>
      <div className="flex flex-1 items-center justify-center overflow-hidden p-2">
        {frame !== null ? (
          <img
            ref={imgRef}
            src={frame.dataUrl}
            alt="手机画面"
            draggable={false}
            onPointerDown={onPointerDown}
            onPointerUp={onPointerUp}
            className="max-h-full max-w-full select-none [-webkit-app-region:no-drag] [touch-action:none]"
          />
        ) : (
          <div className="flex flex-col items-center gap-2 text-muted-foreground">
            <span className="text-sm">等待手机画面…</span>
            <span className="text-xs">启动安卓模拟器（MuMu / 雷电 / 夜神 / 蓝叠）或接入真机后，画面会自动出现，无需重启面板</span>
          </div>
        )}
      </div>
    </div>
  );
}

/** 面板工具条按钮。 */
function PhoneButton({ label, onClick }: { label: string; onClick: () => void }): React.ReactElement {
  return (
    <button
      type="button"
      className="shrink-0 rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
      onClick={onClick}
    >
      {label}
    </button>
  );
}
