/**
 * watch 工具：会话内持续监控（真·持续聊天基座）。
 *
 * 定位：让 agent 在**当前长寿会话**里进入「定时巡检」状态——每个周期由宿主
 * （CLI REPL / 桌面端）注入一条巡检消息，agent 在同一段对话里循环
 * 「读窗口 → 处理 → 等下个周期」。与 cron 定时任务的分工：
 * - cron：跨会话的日程调度（到点起轮，可无头）；
 * - watch：当前会话内的高频巡检（复用会话全部上下文，如刚聊到哪了）。
 *
 * 注入模式与 browser / phone_panel 同款：宿主经 setWatchController() 注入
 * 控制器，CLI print / 无人值守环境不注入 → 工具优雅 fail。
 *
 * 安全默认：周期下限 10s（防失控循环）；停止只靠 stop 动作或会话结束，
 * 不设自动衰减——监控语义就是要一直盯，误用靠审批描述兜底。
 */

import { fail, ok, type Tool, type ToolResult } from "./types.js";

/** 一次 watch 的配置（tool start 动作解析产物） */
export interface WatchConfig {
  /** 巡检周期（秒），[10, 3600] */
  intervalSec: number;
  /** 监控目标（人 / 会话 / 窗口名），写进巡检消息供 agent 定位 */
  target?: string;
  /** 每个周期要做什么；缺省 = 通用检查表述 */
  instruction?: string;
}

/** 宿主注入的巡检控制器。tick 到点时由宿主负责把 tickText 喂给当前会话 */
export interface WatchController {
  /** 启动定时巡检。已在跑 → false（不重复启动，先 stop 再 start 换配置） */
  start(config: WatchConfig, tickText: string): boolean;
  stop(): void;
  isRunning(): boolean;
}

let controller: WatchController | null = null;

/** 宿主（CLI REPL / 桌面端）启动时注入；传 null 撤销 */
export function setWatchController(c: WatchController | null): void {
  controller = c;
}

const MIN_INTERVAL_SEC = 10;
const MAX_INTERVAL_SEC = 3600;

/** 巡检消息模板：让 agent 知道这是自动触发，别反问用户 */
function buildTickText(config: WatchConfig): string {
  const target = config.target?.trim();
  const custom = config.instruction?.trim() ?? "";
  const instruction =
    custom.length > 0
      ? custom
      : "检查监控目标是否有新消息或新变化，有则按对话语境直接处理，无则只回一句状态";
  return (
    `[watch 巡检 · 每 ${config.intervalSec}s]` +
    (target !== undefined && target.length > 0 ? ` 目标：${target}。` : "") +
    `${instruction}（本条为自动巡检触发，不需要向用户确认再动手）`
  );
}

export const watchTool: Tool = {
  name: "watch",
  description:
    "持续监控（真·持续模式）：在当前会话里启动定时巡检，每个周期自动触发一轮 agent 行动——" +
    "适合「盯着微信/QQ 聊天窗口，有新消息就自动回复」这类持续值守任务。" +
    "start=启动（intervalSec 周期秒数，target 监控对象，instruction 每轮做什么）；" +
    "stop=停止；status=查看状态。与 cron 的分工：cron 管跨会话日程，watch 管当前会话内的高频巡检" +
    "（共享会话上下文，知道刚聊到哪）。启动前确认用户确实要持续自动处理，别自作主张开启。",
  isMutating: false,
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["start", "stop", "status"],
        description: "start 启动巡检；stop 停止；status 查看当前状态",
      },
      intervalSec: {
        type: "number",
        description: "action=start 时必填：巡检周期（秒），10～3600。聊天监控建议 30～120",
      },
      target: { type: "string", description: "action=start 时可选：监控对象（如联系人名「张三」、窗口名）" },
      instruction: {
        type: "string",
        description: "action=start 时可选：每个周期做什么（缺省=检查新消息并处理）。要写到可照做的程度",
      },
    },
    required: ["action"],
  },

  async execute(args): Promise<ToolResult> {
    const action = String(args["action"] ?? "status");

    if (action === "status") {
      if (controller === null || !controller.isRunning()) {
        return ok("watch 未在运行。start 可启动定时巡检。");
      }
      return ok("watch 巡检运行中（stop 停止）。");
    }

    if (action === "stop") {
      if (controller === null || !controller.isRunning()) {
        return ok("watch 本来就没在运行。");
      }
      controller.stop();
      return ok("watch 巡检已停止。");
    }

    // start
    if (controller === null) {
      return fail(
        "当前环境不支持 watch（仅交互式 CLI REPL / 桌面端可用）。" +
          "跨会话的定时需求改用 cron（REPL /cron add）。",
      );
    }
    const intervalSec = Number(args["intervalSec"]);
    if (!Number.isFinite(intervalSec) || intervalSec < MIN_INTERVAL_SEC || intervalSec > MAX_INTERVAL_SEC) {
      return fail(`intervalSec 必须在 ${MIN_INTERVAL_SEC}～${MAX_INTERVAL_SEC} 秒之间（防失控循环）`);
    }
    const config: WatchConfig = {
      intervalSec,
      ...(typeof args["target"] === "string" && args["target"].trim().length > 0 ? { target: args["target"] } : {}),
      ...(typeof args["instruction"] === "string" && args["instruction"].trim().length > 0
        ? { instruction: args["instruction"] }
        : {}),
    };
    if (!controller.start(config, buildTickText(config))) {
      return fail("watch 已在运行中；换配置请先 stop 再 start。");
    }
    return ok(
      `watch 巡检已启动：每 ${intervalSec}s 一轮` +
        (config.target !== undefined ? `，目标：${config.target}` : "") +
        `。停止用 watch action=stop。`,
    );
  },
};
