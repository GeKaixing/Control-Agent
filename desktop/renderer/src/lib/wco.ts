/**
 * Windows WCO（Window Controls Overlay）适配。
 *
 * WCO 启用后（main 里 titleBarStyle:"hidden" + titleBarOverlay），窗口右上角的
 * 原生 最小化/最大化/关闭 按钮悬浮在渲染层内容之上（约 138px 宽）——任何顶到
 * 窗口右上角的横条（StatusBar、Composer 模式的顶部拖动条）右侧都必须留出这块，
 * 不然按钮会被原生按钮盖住。左侧则无占位，从窗口左缘开始即可。
 */

import React from "react";

// WCO API 尚未进当前 TS 的 lib.dom，补最小声明（运行时 Chromium 早已支持）
declare global {
  interface Navigator {
    readonly windowControlsOverlay?: {
      getTitlebarAreaRect(): DOMRect | undefined;
      addEventListener(type: "geometrychange", listener: () => void): void;
      removeEventListener(type: "geometrychange", listener: () => void): void;
    };
  }
}

/** preload 暴露的平台（darwin 才有红绿灯，标题栏左侧要留 80px）。 */
export function isMacPlatform(): boolean {
  return window.api?.platform === "darwin";
}

/**
 * WCO 右侧按钮区宽度。
 * `getTitlebarAreaRect()` 返回可用标题栏区域，按钮宽 = 窗口宽 − 区域宽 − 区域 x 偏移；
 * 监听 geometrychange（窗口缩放 / 跨屏 / DPI 变化都会触发）实时更新。
 * API 不存在（未启用 WCO 的平台）时保持 0，右侧只留常规 padding。
 */
export function useWcoButtonWidth(): number {
  const [width, setWidth] = React.useState(0);
  React.useEffect(() => {
    const wco = navigator.windowControlsOverlay;
    if (wco === undefined) return;
    const update = (): void => {
      const rect = wco.getTitlebarAreaRect();
      // rect 不可用（visibleState false 等）时兜底 Windows 三按钮标准宽 138px
      setWidth(rect === undefined || rect.width <= 0 ? 138 : Math.max(0, window.innerWidth - rect.x - rect.width));
    };
    update();
    wco.addEventListener("geometrychange", update);
    return () => wco.removeEventListener("geometrychange", update);
  }, []);
  return width;
}
