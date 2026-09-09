/**
 * Tool 支柱：模型 → 用户的结构化提问通道。
 *
 * 职责边界（消失之问：模型「把问题写在回复里然后结束本轮」是天然兜底，
 * 但那样会切断内层循环、拿不到结构化选项；本工具给模型一个不打断回合的
 * 提问通道——问题作为 toolResult 回灌，模型拿到答案继续干）：
 * - 模型侧：缺关键决策/信息、多个合理方案需要用户拍板时调用
 * - harness 侧：只提供通道，不替模型决定何时该问
 *
 * 通道注入：工具注册表是静态对象，而「谁来回答」是端点能力（REPL 借
 * LoopInput 抓下一行、桌面端弹 dialog、bot 挂起等下一条消息），所以用
 * 模块级 handler，由各端在启动时 setAskUserHandler 注入。
 * 未注入（print 模式 / 无人值守）时优雅 fail，提示语引导模型自行兜底，
 * 绝不静默阻塞。
 *
 * 安全边界：isMutating=false——提问本身就是知情同意机制，不需要再过
 * approvalGate（否则桌面端会双重弹窗）。
 */

import { fail, ok, type Tool, type ToolContext } from "./types.js";

/** 模型发出的一次提问 */
export interface AskUserRequest {
  question: string;
  /** 可选候选答案（建议 2-4 个）；用户仍可自由输入 */
  choices?: string[];
}

/**
 * 端点注入的回答实现。
 * 返回用户答案文本；返回 null 表示用户中断 / EOF / 未得到回答（不算异常）。
 * 实现方应尊重 ctx.signal：agent 被 abort 时尽快返回 null。
 */
export type AskUserFn = (req: AskUserRequest, ctx: ToolContext) => Promise<string | null>;

let askHandler: AskUserFn | undefined;

/** 端点启动时注入提问通道；传 undefined 撤下（REPL 退出时清理） */
export function setAskUserHandler(fn: AskUserFn | undefined): void {
  askHandler = fn;
}

/** 单次提问允许的最大选项数（防模型塞长清单稀释用户注意力） */
const MAX_CHOICES = 6;

export const askUserTool: Tool = {
  name: "ask_user",
  description:
    "向用户提问并等待回答（答案会作为本工具的结果返回，你拿到后继续任务）。" +
    "适用：缺少关键信息无法继续、多个合理方案需要用户拍板、外部动作前需要确认 scope。" +
    "不适用：能靠读文件/搜索自查的问题（先自查）、纯进度播报（直接说即可）。",
  isMutating: false,
  parameters: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "要问用户的问题，一句话说清楚背景与要决策的点",
      },
      choices: {
        type: "array",
        items: { type: "string" },
        description: "可选：候选答案（2-4 个，用户仍可自由输入）。给出选项能显著降低用户的回答成本",
      },
    },
    required: ["question"],
  },

  async execute(args, ctx) {
    if (askHandler === undefined) {
      return fail(
        "当前运行端没有接入提问通道（print / 无人值守场景），无法向用户提问。" +
          "请基于现有信息做合理假设继续，并在最终回答里说明该假设；或列出需要用户补充的事项。",
      );
    }

    const question = String(args["question"] ?? "").trim();
    if (question.length === 0) return fail("ask_user 需要非空的 question 参数");

    const raw = Array.isArray(args["choices"]) ? args["choices"] : [];
    const choices = raw
      .map((c) => String(c).trim())
      .filter((c) => c.length > 0)
      .slice(0, MAX_CHOICES);

    try {
      const answer = await askHandler(
        { question, ...(choices.length > 0 ? { choices } : {}) },
        ctx,
      );
      if (answer === null) return fail("提问被中断（用户中止或退出），没有得到回答");
      const trimmed = answer.trim();
      if (trimmed.length === 0) return fail("用户没有输入有效回答（空输入）");
      return ok(`用户的回答：${trimmed}`);
    } catch (err) {
      return fail(`提问通道出错：${err instanceof Error ? err.message : String(err)}`);
    }
  },
};
