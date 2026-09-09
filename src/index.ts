#!/usr/bin/env node
/**
 * CLI 入口：组装代理状态、工具、队列与终端 UI，然后进入 REPL。
 */

import path from "node:path";
import { Agent, type AgentEvent } from "./agent/agent.js";
import {
  latestSessionId,
  loadSessionInto,
  modelSpecString,
  readSavedCustomModel,
  readSavedModelSpec,
  saveModelSpec,
} from "./context/index.js";
import { ConnectorLoader } from "./connector/loader/connector-loader.js";
import { ConnectorRuntime } from "./connector/runtime/connector-runtime.js";
import type { StreamFn } from "./providers/types.js";
import { initFileLogging, log } from "./log/index.js";
import { assembleSession, buildSeedMessages, resolveModelSpec } from "./session.js";
import type { ModelRef } from "./types.js";
import { InputController } from "./ui/input.js";
import { createPrintOutput, readStdin } from "./ui/print.js";
import { renderMarkdown } from "./ui/markdown.js";
import { TerminalRenderer } from "./ui/renderer.js";
import { runRepl, usageSnapshot } from "./ui/repl.js";

const HELP = [
  "命令：",
  "  /help              显示本帮助",
  "  /model <provider:id>   切换模型，如 /model openai:gpt-4o-mini、/model anthropic:claude-3-7-sonnet-latest",
  "                      切换会持久保存到 .c-agent/config.json，下次启动默认沿用",
  "  /tools             列出可用工具",
  "  /usage             显示本次会话的 token 用量",
  "  /clear             清空对话历史",
  "  /compact           把对话历史压缩成模型摘要（旧分支保留，可回溯）",
  "  /sessions          列出已持久化的会话（.c-agent/sessions/）",
  "  /sessions rm <id>  删除指定会话（id 可只写前缀，当前会话不可删）",
  "  /verbose           切换是否显示思考过程",
  "  /exit              退出（也可用 Ctrl-D）",
  "",
  "非交互用法（print 模式，只输出答案，进度信息走 stderr）：",
  "  npm start -- --model openai:gpt-4o-mini --cwd ./my-project",
  "  echo \"列出 src 下的 ts 文件\" | npm start -- --model mock",
  "  npm start -- -p \"src 下有哪些 ts 文件\" --model mock",
  "  npm start -- --print --model mock < question.txt",
  "",
  "提示词来自位置参数，或（无位置参数时）来自 stdin。",
  "退出码：0 成功，1 代理出错或无输出，2 缺少提示词。",
  "",
  "代理运行期间直接输入的文字会作为「中途插入指令」，在下一轮工具往返时生效。",
  "",
  "提示词覆盖（print 模式用一次；交互模式会在进 REPL 前先跑一轮）：",
  "  --system-prompt,        -sp   完全替换默认系统提示词",
  "  --append-system-prompt, -asp  在默认系统提示词末尾追加一段指令",
  "  --user-prompt,          -up   显式传入用户提示词（与位置参数互斥，二选一）",
  "  --assistant-prompt,     -ap   注入一段助手 prefill，必须与 --user-prompt 同用",
  "                            注入后会追加一条用户消息触发「接续」轮次。",
  "  --prefill-commit,       -pc   自定义上面那条「接续」消息的内容；",
  "                            传空串 \"\" 则完全跳过，不追加任何默认消息。",
  "",
  "会话持久化：",
  "  --resume [id]                恢复已持久化的会话（含 compact 旧分支）；",
  "                            省略 id 时恢复最近一次。交互模式每轮结束自动保存。",
  "",
  "模型持久化：",
  "  启动时模型来源优先级：--model 参数 > MODEL 环境变量 > .c-agent/config.json",
  "  保存值 > 内置默认。--model 是一次性覆盖，不写入配置；想改默认用 /model 切换，",
  "  想清掉持久值就删 .c-agent/config.json。",
  "",
  "输出渲染：",
  "  --no-markdown                原样输出 Markdown 源码，不做终端渲染",
  "                            （管道/重定向时自动关闭，避免转义序列污染下游）",
  "",
  "Connector：",
  "  --connectors <dir>           扫描目录，加载 connector 暴露的工具",
  "                            （可多次，目录里需有 connector.json + 默认导出 class）",
  "",
  "日志：",
  "  运行日志写入 <cwd>/.c-agent/logs/（按天一份，保留最近 7 份）。",
  "  环境变量 C_AGENT_LOG=debug|info|warn|error|off 调整详细度（默认 info）。",
].join("\n");

interface CliArgs {
  model: string | undefined;
  cwd: string | undefined;
  verbose: boolean;
  help: boolean;
  print: boolean;
  /** 位置参数拼起来的提示词，print 模式用它作为一次性输入 */
  prompt: string;
  /** 完全替换默认系统提示词 */
  systemPrompt: string | null;
  /** 在默认系统提示词末尾追加指令 */
  appendSystemPrompt: string | null;
  /** 显式用户提示词（与位置参数互斥） */
  userPrompt: string | null;
  /** 助手 prefill（必须与 userPrompt 同用） */
  assistantPrompt: string | null;
  /**
   * 助手 prefill 后追加的「接续」消息内容。
   * - `null`：未传入；调用 buildSeedMessages 时回退到 `DEFAULT_PREFILL_COMMIT`
   * - `""`：显式空串；跳过追加，模型会直接从 prefill 接续而不被「触发」
   * - 其他：完整替换默认消息
   */
  prefillCommit: string | null;
  /** 是否把模型输出的 Markdown 渲染成终端样式；`--no-markdown` 关掉 */
  markdown: boolean;
  /** 要扫描的 connector 目录，可多次指定 */
  connectorsPaths: string[];
  /**
   * 恢复已持久化的会话。undefined = 未传；true = --resume 不带 id（取最近一次）；
   * 字符串 = 指定会话 id。
   */
  resume: string | boolean | undefined;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    model: undefined,
    cwd: undefined,
    verbose: false,
    help: false,
    print: false,
    prompt: "",
    systemPrompt: null,
    appendSystemPrompt: null,
    userPrompt: null,
    assistantPrompt: null,
    prefillCommit: null,
    markdown: true,
    connectorsPaths: [],
    resume: undefined,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--model" || a === "-m") args.model = argv[++i];
    else if (a === "--cwd" || a === "-c") args.cwd = argv[++i];
    else if (a === "--verbose" || a === "-v") args.verbose = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--print" || a === "-p") args.print = true;
    else if (a === "--resume") {
      // id 可省略：下一个参数是另一个 flag 或不存在时，恢复最近一次
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        args.resume = next;
        i += 1;
      } else {
        args.resume = true;
      }
    } else if (a === "--system-prompt" || a === "-sp") args.systemPrompt = argv[++i] ?? "";
    else if (a === "--append-system-prompt" || a === "-asp") args.appendSystemPrompt = argv[++i] ?? "";
    else if (a === "--user-prompt" || a === "-up") args.userPrompt = argv[++i] ?? "";
    else if (a === "--assistant-prompt" || a === "-ap") args.assistantPrompt = argv[++i] ?? "";
    else if (a === "--prefill-commit" || a === "-pc") args.prefillCommit = argv[++i] ?? "";
    else if (a === "--no-markdown") args.markdown = false;
    else if (a === "--connectors") {
      const dir = argv[++i];
      if (dir === undefined) {
        console.error("错误：--connectors 后面需要跟一个目录路径");
        process.exit(2);
      }
      args.connectorsPaths.push(dir);
    } else if (a !== undefined) positional.push(a);
  }
  args.prompt = positional.join(" ").trim();
  return args;
}

export { buildSeedMessages, DEFAULT_PREFILL_COMMIT, assembleSession } from "./session.js";

/**
 * print 模式的提示词来源：位置参数优先，其次 stdin。
 * stdin 是 TTY 时不去读——那会一直卡住等用户输入。
 */
async function resolvePrompt(fromArgs: string, stdinIsTty: boolean): Promise<string | null> {
  if (fromArgs.length > 0) return fromArgs;
  if (stdinIsTty) return null;
  const piped = (await readStdin()).trim();
  return piped.length > 0 ? piped : null;
}

/** Connector 启动结果摘要，给启动横幅展示用 */
interface ConnectorSummary {
  loadedCount: number;
  toolCount: number;
}

/**
 * 跑一遍 Loader → adopt → start，失败信息走 console.error，但不阻塞 agent 启动。
 *
 * 返回的 summary 仅用于横幅展示——agent 实际用的是 runtime 里的 tool 集合。
 */
async function bootstrapConnectors(
  runtime: ConnectorRuntime,
  paths: readonly string[],
): Promise<ConnectorSummary> {
  if (paths.length === 0) return { loadedCount: 0, toolCount: 0 };

  const loader = new ConnectorLoader({ paths: [...paths] });
  const { loaded, failed } = await loader.scan();
  for (const f of failed) {
    console.error(`[connector] load failed: ${f.rootDir} -> ${f.error}`);
  }
  for (const c of loaded) runtime.adopt(c);
  if (loaded.length === 0) return { loadedCount: 0, toolCount: 0 };

  const startFailed = await runtime.start();
  for (const id of startFailed) {
    const c = runtime.registry.get(id);
    console.error(
      `[connector] start failed: ${id}${c?.errorMessage !== undefined ? ` -> ${c.errorMessage}` : ""}`,
    );
  }
  const started = loaded.length - startFailed.length;
  return {
    loadedCount: started,
    toolCount: started > 0 ? runtime.extraTools().length : 0,
  };
}

/** 极简 .env 加载：不覆盖已存在的环境变量 */
async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(HELP);
    return 0;
  }

  const cwd = path.resolve(args.cwd ?? process.cwd());

  // 文件日志先开：后面的模型解析、会话恢复出错才有地方查
  initFileLogging(cwd);

  // 没有终端就没有交互可言：提示词读不进来、进度也画不出来，直接走 print 模式
  const stdinIsTty = process.stdin.isTTY === true;
  const printMode = args.print || !stdinIsTty || process.stdout.isTTY !== true;

  // 管道 / 重定向时不能打转义序列，否则下游拿到的是一串 \x1b[1m 之类的噪声
  const markdown = args.markdown && process.stdout.isTTY === true;

  const seedResult = buildSeedMessages({
    userPrompt: args.userPrompt,
    assistantPrompt: args.assistantPrompt,
    positional: args.prompt,
    prefillCommit: args.prefillCommit,
  });
  if (seedResult.error !== undefined) {
    console.error(`错误：${seedResult.error}`);
    return 2;
  }

  // Connector bootstrap：扫描目录 → adopt → start，失败不阻塞（只 warn）
  const connectorRuntime = new ConnectorRuntime({ cwd });
  const connectorSummary = await bootstrapConnectors(connectorRuntime, args.connectorsPaths);

  // 模型来源优先级：--model 参数 > MODEL env（defaultModel 内处理）> .c-agent/config.json
  // 持久值 > 内置默认。持久值由 REPL /model 切换或桌面端选模型时写入（spec 与
  // 自定义模型完整参数互斥，最后一次的选择是唯一真相），让选择跨进程生效；
  // --model 是一次性覆盖，不落盘（脚本里 --model mock 不该污染用户配置）。
  let modelSpec: string | undefined = args.model;
  let customRef: ModelRef | undefined;
  if (modelSpec === undefined && process.env.MODEL === undefined) {
    const saved = await readSavedModelSpec(cwd);
    if (saved !== null) {
      modelSpec = saved;
      console.error(`提示：模型沿用持久配置 ${saved}（.c-agent/config.json，--model / MODEL env 可覆盖）`);
    } else {
      // 最后一次选的是自定义模型（完整参数自描述，CLI 同样恢复）
      const custom = await readSavedCustomModel(cwd);
      if (custom !== null) {
        customRef = {
          provider: custom.provider as ModelRef["provider"],
          id: custom.id,
          baseUrl: custom.baseUrl,
          apiKey: custom.apiKey,
          ...(custom.contextWindow !== undefined ? { contextWindow: custom.contextWindow } : {}),
        };
        console.error(`提示：模型沿用持久配置（自定义模型 ${custom.id}，.c-agent/config.json）`);
      }
    }
  }

  const assembled = await assembleSession({
    cwd,
    ...(modelSpec !== undefined ? { modelSpec } : customRef !== undefined ? { modelRef: customRef } : {}),
    ...(args.systemPrompt !== null ? { systemPrompt: args.systemPrompt } : {}),
    ...(args.appendSystemPrompt !== null ? { appendSystemPrompt: args.appendSystemPrompt } : {}),
    ...(seedResult.seeds.length > 0 ? { seedMessages: seedResult.seeds } : {}),
    ...(connectorRuntime.size() > 0 ? { extraTools: connectorRuntime.extraTools() } : {}),
  });
  const { state, queue } = assembled;
  // resolved 后续 /model 命令会改，所以单独拎出来
  let resolved = assembled.resolved;
  let verbose = args.verbose;
  log.info(
    "cli",
    `启动 mode=${printMode ? "print" : "repl"} model=${resolved.model.provider}:${resolved.model.id} cwd=${cwd}`,
  );

  // 会话持久化：--resume 整体还原会话树（含 compact 旧分支）；失败降级为全新会话。
  // 信息走 stderr——print 模式的 stdout 是答案本身，不能混入进度文本。
  if (args.resume !== undefined) {
    const id = typeof args.resume === "string" ? args.resume : await latestSessionId(cwd);
    if (id === null) {
      console.error("提示：没有可恢复的会话（.c-agent/sessions/ 为空），按全新会话启动");
    } else if (await loadSessionInto(state, cwd, id)) {
      console.error(`已恢复会话 ${id}（${state.messages.length} 条消息）`);
    } else {
      console.error(`提示：会话 ${id} 不存在或已损坏，按全新会话启动`);
    }
  }

  let onEvent: (event: AgentEvent) => void;
  let exitCode: number;
  try {
  if (printMode) {
    const sink = createPrintOutput();
    onEvent = (event: AgentEvent): void => sink.onEvent(event);

    // seed 已有 user 提示词时不再额外 enqueue
    const hasSeedUser = seedResult.seeds.some((s) => s.role === "user");
    const prompt = hasSeedUser ? "" : await resolvePrompt(args.prompt, stdinIsTty);
    if (prompt === null) {
      console.error(
        "print 模式需要一个提示词：用位置参数传入（npm start -- -p \"你的问题\"），或通过管道/重定向喂给 stdin。",
      );
      exitCode = 2;
    } else {
      if (resolved.degraded !== undefined) console.error(`提示：${resolved.degraded}`);

      const agent = new Agent({ state, queue, stream: resolved.stream, onEvent });
      if (prompt.length > 0) agent.enqueueUser(prompt);
      await agent.run();

      const answer = sink.answer.trim();
      if (answer.length > 0) {
        process.stdout.write(`${renderMarkdown(answer, { enabled: markdown })}\n`);
      }
      for (const warning of sink.warnings) process.stderr.write(`${warning}\n`);
      for (const error of sink.errors) process.stderr.write(`错误：${error}\n`);

      if (sink.errors.length > 0) exitCode = 1;
      else if (answer.length === 0) {
        process.stderr.write("代理没有产生任何输出\n");
        exitCode = 1;
      } else {
        exitCode = 0;
      }
    }
  } else {
    const sink = new TerminalRenderer({ verbose, markdown });
    onEvent = (event: AgentEvent): void => sink.handle(event);

    let stream: StreamFn = resolved.stream;

    const agent = new Agent({ state, queue, stream, onEvent, persistSessions: true });

    const input = new InputController();

    console.log(`编码代理已启动`);
    console.log(`  工作目录：${cwd}`);
    console.log(`  模型：${resolved.model.provider}:${resolved.model.id}`);
    console.log(`  工具：${state.tools.map((t) => t.name).join(", ")}`);
    if (connectorSummary.loadedCount > 0) {
      console.log(`  Connector：${connectorSummary.loadedCount} 个 / ${connectorSummary.toolCount} 个工具`);
    }
    if (resolved.degraded !== undefined) console.log(`  提示：${resolved.degraded}`);
    console.log(`  输入 /help 查看命令，Ctrl-C 中断当前任务，Ctrl-D 退出。\n`);

    // 启动时若提供了 user-prompt / assistant-prompt，先跑一轮（prefill 同理）
    if (seedResult.seeds.length > 0) {
      await agent.run();
    }

    exitCode = await runRepl({
      agent,
      state,
      queue,
      allTools: state.tools,
      helpText: HELP,
      input,
      output: (text) => process.stdout.write(text),
      initialVerbose: verbose,
      onToggleVerbose: (next) => {
        verbose = next;
        sink.setVerbose(next);
      },
      resolveNewModel: (spec) => {
        const { resolved: newResolved } = resolveModelSpec(spec);
        // /model 切换即持久化：下次启动默认沿用（--model / MODEL env 仍可临时覆盖）。
        // 写失败不阻断切换，stderr 提示即可。
        const specToSave = modelSpecString(newResolved.model);
        void saveModelSpec(cwd, specToSave).catch((err: unknown) => {
          console.error(
            `提示：模型配置保存失败（${specToSave}）：${err instanceof Error ? err.message : String(err)}`,
          );
        });
        // 复用同一个变量存回去；调用方拿到的是新 model + stream
        resolved = newResolved;
        stream = newResolved.stream;
        const out: { model: typeof newResolved.model; stream: StreamFn; degraded?: string } = {
          model: newResolved.model,
          stream: newResolved.stream,
        };
        if (newResolved.degraded !== undefined) out.degraded = newResolved.degraded;
        return out;
      },
      getUsage: () => usageSnapshot(state),
    });
  }
  } finally {
    await connectorRuntime.dispose();
  }
  return exitCode!;
}

// 未捕获异常兜底：先落日志再复刻默认崩溃语义（stderr 打印 + 非零退出码）。
// 未处理的 Promise rejection（Node 15+ 默认按崩溃处理）同样走这里——
// 这是「开发人员不知道错在哪里」的最大黑洞，必须在进程死掉前留一份现场。
process.on("uncaughtException", (err) => {
  log.error("cli", "未捕获异常", err);
  console.error(err);
  process.exit(1);
});

main().then(
  (code: number) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    log.error("cli", "main() 顶层异常", err);
    console.error(err);
    process.exitCode = 1;
  },
);
