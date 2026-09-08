/**
 * 装配层：CLI 与桌面端共享的会话启动逻辑。
 *
 * 原本在 src/index.ts 里内联：loadDotEnv、buildSeedMessages、模型解析、createInitialState
 * 那段。抽出来后 index.ts 只管 REPL，桌面端主进程也能复用同一份装配，避免出现
 * 「两份代码，两种默认参数」的偏差。
 */

import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";

import { createInitialState, MessageQueue, type AgentState } from "./context/index.js";
import type { ResolvedModel } from "./providers/index.js";
import { defaultModel, parseModelSpec, resolveModel } from "./providers/index.js";
import { allTools, type Tool } from "./tools/index.js";
import { truncateText } from "./tools/fs-utils.js";
import type { ModelRef } from "./types.js";

/**
 * v1 简单的"运行模式"枚举：决定传给模型的工具列表与系统提示词。
 *  - answer_only：去掉所有 tool，告诉模型"只用现有上下文回答"
 *  - plan：保留 tool，但 system 加"先输出一段计划，由用户确认后才会真正调用工具"
 *  - full：原样（保留所有 tool，无额外 system 提示）
 *
 * v2 想做更细粒度的权限（比如"只允许只读工具"），再加 `disabledTools` 这层。
 */
export type SessionMode = "answer_only" | "plan" | "full" | "autopilot";

/**
 * plan mode 注入到 system 末尾的提示词，提示模型先输出计划再执行。
 * 用 `\n\n` 分隔以保证与默认 system 之间有空行。
 */
export const PLAN_MODE_SYSTEM_SUFFIX = `

[模式: plan] 当前处于"计划模式"：你**先给出一段执行计划**（列出你打算做什么 / 调用哪些工具），等用户确认后才会真正调用工具。请把回答分成两段：
1. 📋 计划：bullet 形式列出步骤
2. ⏸ 等确认：声明等待用户指令，不要在这一轮主动调用工具。`;

/**
 * answer_only mode 注入到 system 末尾的提示词。
 */
export const ANSWER_ONLY_MODE_SYSTEM_SUFFIX = `

[模式: answer_only] 当前处于"仅回答模式"：**不要调用任何工具**，只用上下文里已有的信息回答。如果信息不足，请直接告诉用户缺什么。`;

/** 朝着目标（autopilot）模式收工哨兵：模型在最终回答里单独输出这行 → 自动续跑停止。 */
export const AUTOPILOT_DONE_SENTINEL_TEXT = "[目标完成]";

/**
 * autopilot（朝着目标）模式注入到 system 末尾的提示词：
 * 模型连续自主执行，每轮结束系统自动发「继续」，模型用哨兵主动收工。
 */
export const AUTOPILOT_MODE_SYSTEM_SUFFIX = `

[模式: autopilot] 当前处于"朝着目标"模式（自动驾驶）：
- 每轮结束后系统会自动让你继续，**不需要等待用户确认**，也不要输出"等待用户指示"之类的话。
- 主动连续调用工具把任务推进到底，不要每一步都请示；过程结论用简短文字带过。
- 目标全部完成（或你判断继续推进没有意义 / 遇到必须用户决策的阻塞点）时，在最后一条回答的**单独一行**输出：${AUTOPILOT_DONE_SENTINEL_TEXT}
- 输出哨兵后本轮回答即结束，系统不会再自动续跑。`;

export interface AssembleOptions {
  cwd: string;
  /** "openai:gpt-4o-mini" 这类写法；省略走环境变量 → 降级 mock */
  modelSpec?: string;
  /**
   * 完整 ModelRef 直接注入（优先于 modelSpec）——自定义模型恢复用：
   * baseUrl/apiKey 无法编码进 spec 字符串，持久化层存的是完整参数对象。
   */
  modelRef?: ModelRef;
  /** 完全替换默认系统提示词 */
  systemPrompt?: string;
  /** 追加到默认系统提示词末尾 */
  appendSystemPrompt?: string;
  /** CLI 的 --user-prompt / --assistant-prompt / 位置参数 */
  seedMessages?: { role: "user" | "assistant"; content: string }[];
  /**
   * 附加工具：通常是 Connector Runtime 暴露的 tool。
   * 合并到默认 allTools 之后传给 Agent；同名工具 warn 后跳过（保留内置 tool）。
   */
  extraTools?: readonly Tool[];
  /**
   * 会话模式：影响 agent 能调用的工具集与系统提示词。
   *  - answer_only → tools 传空，system 加 answer-only 提示
   *  - plan → tools 全部保留，system 加 plan 提示
   *  - full → tools 全部保留，不追加 system 提示（默认）
   *
   * 切换 mode 会在下一次新建的 Agent 上生效（当前 turn 不打断）。
   */
  mode?: SessionMode;
  /**
   * 覆盖 maxTokens（OpenAI / Anthropic 等按 token 截断）。undefined 表示用 provider 默认。
   * 桌面端通常用 reasoning level 推出一个值再传进来。
   */
  maxTokens?: number;
  /**
   * 是否把 cwd 下的跨会话记忆（.c-agent/memory.md，此前会话由模型通过 memory
   * 工具记下）注入系统提示词。默认 true。显式传 systemPrompt 时不注入（完全替换语义优先）。
   */
  includeProjectMemory?: boolean;
}

export interface AssembledSession {
  state: AgentState;
  queue: MessageQueue;
  resolved: ResolvedModel;
}

/**
 * 极简 .env 加载：不覆盖已存在的环境变量
 */
export async function loadDotEnv(cwd: string): Promise<void> {
  try {
    const raw = await fs.readFile(path.join(cwd, ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      if (process.env[key] !== undefined) continue;
      process.env[key] = trimmed.slice(eq + 1).trim();
    }
  } catch {
    // .env 不存在是正常情况
  }
}

/**
 * `--assistant-prompt` 注入 prefill 后默认追加的那条「接续触发」用户消息。
 * prefill 模型只看到一段没有「上一轮对话」的助手输出，对话框其实还停在
 * prefill 自身——为了让 LLM 真正开始接续，我们需要一条用户消息把它推下去。
 * 这个文本对用户可见，可通过 `--prefill-commit` 自定义或传 `""` 跳过。
 */
export const DEFAULT_PREFILL_COMMIT = "[c-agent prefill] 请基于上一条助手消息继续。";

/**
 * 把 CLI 参数翻译成 `createInitialState` 的 `seedMessages`。
 * 拆成纯函数以便单测；不再直接拿整个 `CliArgs`，只关心这四个字段。
 *
 * 规则：
 * - `userPrompt` 与 `positional` 互斥，二选一；同时给出返回 `error`
 * - `assistantPrompt` 必须与 `userPrompt` 同用；后面会追加一条
 *   「请基于上一条助手消息继续」类的用户消息触发接续轮次
 *
 * `prefillCommit` 决定那条接续消息怎么写：
 * - `null`：用 `DEFAULT_PREFILL_COMMIT`
 * - `""`  显式空串：跳过，模型从 prefill 静默接续
 * - 其他：完整替换默认文本
 */
export function buildSeedMessages(args: {
  userPrompt: string | null;
  assistantPrompt: string | null;
  positional: string;
  prefillCommit: string | null;
}): { seeds: { role: "user" | "assistant"; content: string }[]; error?: string } {
  const seeds: { role: "user" | "assistant"; content: string }[] = [];
  const hasUserPrompt = args.userPrompt !== null && args.userPrompt.length > 0;
  const hasPositional = args.positional.length > 0;
  const hasAssistantPrompt = args.assistantPrompt !== null && args.assistantPrompt.length > 0;

  if (hasUserPrompt && hasPositional) {
    return {
      seeds: [],
      error: "--user-prompt 与位置参数互斥，请二选一。",
    };
  }
  if (hasAssistantPrompt && !hasUserPrompt) {
    return {
      seeds: [],
      error: "--assistant-prompt 必须与 --user-prompt 同用：prefill 需要跟在 user 消息之后。",
    };
  }

  if (hasUserPrompt) {
    seeds.push({ role: "user", content: args.userPrompt ?? "" });
  }
  if (hasAssistantPrompt) {
    seeds.push({ role: "assistant", content: args.assistantPrompt ?? "" });
    // prefillCommit：null → 默认；"" → 跳过；其他 → 完整替换
    if (args.prefillCommit !== null && args.prefillCommit.length === 0) {
      // 跳过：模型会直接从 prefill 接续而不被「触发」
    } else {
      const commitText = args.prefillCommit ?? DEFAULT_PREFILL_COMMIT;
      seeds.push({ role: "user", content: commitText });
    }
  }

  return { seeds };
}

/**
 * 解析模型 spec（"openai:gpt-4o-mini" / "mock"）→ ModelRef。无 key 时静默降级。
 */
export function resolveModelSpec(spec: string | undefined): { model: ModelRef; resolved: ResolvedModel } {
  const model = spec !== undefined ? parseModelSpec(spec) : defaultModel();
  const resolved = resolveModel(model);
  return { model: resolved.model, resolved };
}

/** 每个记忆文件注入系统提示词的最大字符数 */
const PROJECT_MEMORY_MAX_CHARS = 4_000;

/**
 * Context 支柱：收集 cwd 下的跨会话记忆。
 * 只注入项目根的 MEMORY.md（此前会话由模型通过 memory 工具自己记下的内容）。
 * 不注入 AGENTS.md 等人类/开发侧文档——那些按需用 read 工具读。
 * 不存在 / 读失败 → 空串（调用方跳过注入）。
 */
export async function collectProjectMemory(cwd: string): Promise<string> {
  const file = path.join(cwd, "MEMORY.md");
  const label = "跨会话记忆（此前会话你通过 memory 工具记下的；memory 工具可继续追加）";
  try {
    const raw = await fs.readFile(file, "utf8");
    const trimmed = raw.trim();
    if (trimmed.length === 0) return "";
    return `## ${label}\n\n${truncateText(trimmed, PROJECT_MEMORY_MAX_CHARS)}`;
  } catch {
    // 不存在是正常情况
    return "";
  }
}

export interface GitSnapshot {
  branch: string;
  dirty: boolean;
  /** dirty 为 true 时带：porcelain 行数 ≈ 未提交文件数（多字头条目按 1 计，够用） */
  dirtyFiles?: number;
}

/**
 * Environment 支柱：读取 git 环境快照（当前分支 + 工作区脏净与未提交数），
 * 让模型在动手前知道自己站在哪。非 git 仓库 / git 不可用 / 超时 → null。
 */
export async function readGitSnapshot(
  cwd: string,
  timeoutMs = 1_500,
): Promise<GitSnapshot | null> {
  const run = (args: string[]): Promise<string> =>
    new Promise((resolve, reject) => {
      execFile("git", args, { cwd, timeout: timeoutMs }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout.trim());
      });
    });

  try {
    const inside = await run(["rev-parse", "--is-inside-work-tree"]);
    if (inside !== "true") return null;
    const [branch, status] = await Promise.all([
      run(["rev-parse", "--abbrev-ref", "HEAD"]),
      run(["status", "--porcelain"]),
    ]);
    const dirtyFiles = status.length > 0 ? status.split("\n").filter((l) => l.length > 0).length : 0;
    return { branch: branch.length > 0 ? branch : "HEAD", dirty: dirtyFiles > 0, dirtyFiles };
  } catch {
    return null;
  }
}

/**
 * 把 cwd / 模型 spec / 提示词选项组装成 AgentState + Queue + ResolvedModel。
 * 桌面端与 CLI 都从这里起手。
 *
 * `mode` 影响：
 *  - answer_only：`tools` 字段传给 createInitialState 时为空数组（模型看不到任何 tool 描述）
 *  - plan / full：保留全部 tool；plan 会追加一段「先计划后执行」系统提示词
 */
export async function assembleSession(opts: AssembleOptions): Promise<AssembledSession> {
  await loadDotEnv(opts.cwd);
  // modelRef（自定义模型恢复）优先于 modelSpec——spec 编码不了 baseUrl/apiKey
  const { resolved } =
    opts.modelRef !== undefined
      ? { resolved: resolveModel(opts.modelRef) }
      : resolveModelSpec(opts.modelSpec);

  // mode 决定 tool 列表：answer_only 强制空，其它保留全部
  const baseTools: Tool[] = opts.mode === "answer_only" ? [] : mergeTools(opts.extraTools);

  // mode 决定 system 提示词追加内容
  let appendSystemPrompt = opts.appendSystemPrompt ?? "";
  if (opts.mode === "plan" && !appendSystemPrompt.includes("[模式: plan]")) {
    appendSystemPrompt = appendSystemPrompt.length > 0
      ? appendSystemPrompt + PLAN_MODE_SYSTEM_SUFFIX
      : PLAN_MODE_SYSTEM_SUFFIX;
  } else if (opts.mode === "answer_only" && !appendSystemPrompt.includes("[模式: answer_only]")) {
    appendSystemPrompt = appendSystemPrompt.length > 0
      ? appendSystemPrompt + ANSWER_ONLY_MODE_SYSTEM_SUFFIX
      : ANSWER_ONLY_MODE_SYSTEM_SUFFIX;
  } else if (opts.mode === "autopilot" && !appendSystemPrompt.includes("[模式: autopilot]")) {
    appendSystemPrompt = appendSystemPrompt.length > 0
      ? appendSystemPrompt + AUTOPILOT_MODE_SYSTEM_SUFFIX
      : AUTOPILOT_MODE_SYSTEM_SUFFIX;
  }

  // Context 支柱：跨会话记忆注入（显式 systemPrompt 时不注入——完全替换语义优先）
  if (opts.systemPrompt === undefined && opts.includeProjectMemory !== false) {
    const memory = await collectProjectMemory(opts.cwd);
    if (memory.length > 0) {
      appendSystemPrompt = appendSystemPrompt.length > 0
        ? `${appendSystemPrompt}\n\n${memory}`
        : memory;
    }
    // Environment 支柱：git 环境快照（非 git 仓库静默跳过）。
    // 只给事实不给规则——模型看到分支与未提交数，自然知道动手前要谨慎
    const snap = await readGitSnapshot(opts.cwd);
    if (snap !== null) {
      const envLine =
        `[环境快照] git 分支 ${snap.branch}，` +
        (snap.dirty
          ? `工作区有 ${snap.dirtyFiles} 个文件未提交改动（git 可回滚）`
          : "工作区干净");
      appendSystemPrompt = appendSystemPrompt.length > 0
        ? `${appendSystemPrompt}\n\n${envLine}`
        : envLine;
    }
  }

  // maxTokens：若 opts 给了，写到 model 上让 provider 自然透传
  if (opts.maxTokens !== undefined) {
    resolved.model = { ...resolved.model, maxTokens: opts.maxTokens };
  }

  const state = createInitialState({
    cwd: opts.cwd,
    model: resolved.model,
    tools: baseTools,
    ...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
    ...(appendSystemPrompt.length > 0 ? { appendSystemPrompt } : {}),
    ...(opts.seedMessages !== undefined && opts.seedMessages.length > 0 ? { seedMessages: opts.seedMessages } : {}),
  });
  const queue = new MessageQueue();
  return { state, queue, resolved };
}

/**
 * 把 extraTools 合并到默认工具表。
 *
 * 同名冲突策略：保留内置 tool，extraTools 同名项被忽略并 warn。
 * 这是保守策略——内置 read/write/edit/bash 等是项目硬约定，
 * 不该被 connector 静默覆盖。Phase 2 想做替换语义时再放开。
 */
function mergeTools(extraTools: readonly Tool[] | undefined): Tool[] {
  if (extraTools === undefined || extraTools.length === 0) return [...allTools];
  const builtin = [...allTools];
  const builtinNames = new Set(builtin.map((t) => t.name));
  for (const t of extraTools) {
    if (builtinNames.has(t.name)) {
      console.warn(`[session] extraTool "${t.name}" 名字与内置工具冲突，跳过（保留内置实现）`);
      continue;
    }
    builtin.push(t);
  }
  return builtin;
}