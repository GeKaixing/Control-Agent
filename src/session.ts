/**
 * 装配层：CLI 与桌面端共享的会话启动逻辑。
 *
 * 原本在 src/index.ts 里内联：loadDotEnv、buildSeedMessages、模型解析、createInitialState
 * 那段。抽出来后 index.ts 只管 REPL，桌面端主进程也能复用同一份装配，避免出现
 * 「两份代码，两种默认参数」的偏差。
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { createInitialState, MessageQueue, type AgentState } from "./context/index.js";
import type { ResolvedModel } from "./providers/index.js";
import { defaultModel, parseModelSpec, resolveModel } from "./providers/index.js";
import { allTools } from "./tools/index.js";
import type { ModelRef } from "./types.js";

export interface AssembleOptions {
  cwd: string;
  /** "openai:gpt-4o-mini" 这类写法；省略走环境变量 → 降级 mock */
  modelSpec?: string;
  /** 完全替换默认系统提示词 */
  systemPrompt?: string;
  /** 追加到默认系统提示词末尾 */
  appendSystemPrompt?: string;
  /** CLI 的 --user-prompt / --assistant-prompt / 位置参数 */
  seedMessages?: { role: "user" | "assistant"; content: string }[];
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

/**
 * 把 cwd / 模型 spec / 提示词选项组装成 AgentState + Queue + ResolvedModel。
 * 桌面端与 CLI 都从这里起手。
 */
export async function assembleSession(opts: AssembleOptions): Promise<AssembledSession> {
  await loadDotEnv(opts.cwd);
  const { resolved } = resolveModelSpec(opts.modelSpec);
  const state = createInitialState({
    cwd: opts.cwd,
    model: resolved.model,
    tools: allTools,
    ...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
    ...(opts.appendSystemPrompt !== undefined && opts.appendSystemPrompt.length > 0
      ? { appendSystemPrompt: opts.appendSystemPrompt }
      : {}),
    ...(opts.seedMessages !== undefined && opts.seedMessages.length > 0 ? { seedMessages: opts.seedMessages } : {}),
  });
  const queue = new MessageQueue();
  return { state, queue, resolved };
}