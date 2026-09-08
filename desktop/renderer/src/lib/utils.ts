/** shadcn 风格的 cn()：合并 className，处理 Tailwind 类冲突 */
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * 写剪贴板。
 *
 * 主路径用 async clipboard API；生产构建从 file:// 加载时它可能不可用（Electron
 * 里 isSecureContext / 权限策略随版本与协议变化），失败一律落回隐藏 textarea +
 * execCommand。两条路都不抛错，只回报成功与否——调用方按返回值决定要不要给反馈。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard !== undefined) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 落回 execCommand 兜底
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
