/**
 * phone_panel 工具：agent 打开/关闭内部手机镜像面板（桌面端渲染层 DOM 面板）。
 *
 * 与 mobile_* 工具族的分工（两条通道互补，不重叠）：
 * - phone_panel 打开的是**给人看的面板**：600ms 帧率的镜像画面 + 用户手动
 *   点按/滑动——适合「让用户看我在操作什么」「用户自己上手试」的场景；
 * - mobile_screen / mobile_ui / mobile_act 是**模型自己的操作通道**：控件树
 *   文本层 + 截图 + 动作注入，适合批量、精确、无人值守的自动化。
 * 模型想「边操作边给用户看」时：phone_panel 开面板 → mobile_act 做动作，
 * 面板画面会实时反映操作结果。
 *
 * 通道注入（与 browser.ts / ask-user.ts 同一模式）：只有 Electron 桌面端有
 * 面板，main 进程启动时 setPhonePanelBackend 注入控制器；CLI / print 端
 * 不注入，优雅 fail。面板与浏览器面板互斥（原生 WebContentsView 会盖住
 * DOM 面板），互斥逻辑在桌面端注入的 open() 里，工具层不感知。
 *
 * 权限：开/关面板只改桌面端 UI 状态（随时可再开/关，无外部副作用），
 * isMutating=false——与 browser_navigate 打开浏览器面板同一待遇。
 */

import type { Tool } from "./types.js";
import { fail, ok } from "./types.js";

/** 桌面端注入的面板控制器。open() 内含与浏览器面板的互斥处理。 */
export interface PhonePanelBackend {
  open(): Promise<void>;
  close(): Promise<void>;
  status(): Promise<{ open: boolean; connected: boolean; device: string | null }>;
}

let backend: PhonePanelBackend | null = null;

/** 桌面端启动时注入；传 null 撤下 */
export function setPhonePanelBackend(b: PhonePanelBackend | null): void {
  backend = b;
}

function noBackend(): string {
  return "手机镜像面板仅在桌面端可用（当前是 CLI / print / 无人值守环境）。" +
    "模型侧操作手机请直接用 mobile_screen / mobile_ui / mobile_act 工具。";
}

export const phonePanelTool: Tool = {
  name: "phone_panel",
  description:
    "打开/关闭/查询内部手机镜像面板（桌面端内嵌的实时手机画面，约 1.7fps，" +
    "支持用户在画面上直接点按/滑动/导航键）。与 mobile_* 工具互补：本工具" +
    "把画面**展示给用户**（或让用户手动操作），mobile_* 是模型自己的操作" +
    "通道——两者可同时用（开面板后跑 mobile_act，用户能实时看到效果）。" +
    "open 会自动关闭浏览器面板（两者互斥），设备发现支持真机与模拟器多 adb 入口。",
  isMutating: false,
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["open", "close", "status"],
        description: "open 打开面板（幂等）/ close 关闭（幂等）/ status 查询开合与设备连接状态",
      },
    },
    required: ["action"],
  },
  async execute(args) {
    const action = String(args["action"] ?? "");
    if (backend === null) {
      // status 在未注入端也按 fail 走：模型需要知道这条通道根本不在
      return fail(noBackend());
    }
    try {
      if (action === "open") {
        await backend.open();
        const s = await backend.status();
        return ok(
          s.connected
            ? `手机镜像面板已打开，已连接设备 ${s.device ?? ""}。画面每 600ms 刷新，用户可在画面上直接点按/滑动。`
            : "手机镜像面板已打开，但还没检测到设备——启动安卓模拟器或接入 USB 真机后画面会自动出现。模型侧操作可配合 mobile_* 工具。",
        );
      }
      if (action === "close") {
        await backend.close();
        return ok("手机镜像面板已关闭。");
      }
      if (action === "status") {
        const s = await backend.status();
        if (!s.open) return ok("手机镜像面板未打开（用 action=open 打开）。");
        return ok(
          s.connected
            ? `面板打开中，已连接设备 ${s.device ?? ""}。`
            : "面板打开中，暂未检测到设备。",
        );
      }
      return fail(`phone_panel 不认识 action=${action}（支持 open / close / status）`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return fail(`phone_panel 执行失败：${msg.slice(0, 300)}`);
    }
  },
};
