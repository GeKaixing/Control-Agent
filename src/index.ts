#!/usr/bin/env node
/**
 * CLI 入口：组装代理状态、工具、队列与终端 UI，然后进入 REPL。
 */

import path from "node:path";
import { Agent, type AgentEvent } from "./agent/agent.js";
import { totalUsage } from "./context/index.js";
import type { StreamFn } from "./providers/types.js";
import { assembleSession, buildSeedMessages, resolveModelSpec } from "./session.js";
import { allTools } from "./tools/index.js";
import { InputController } from "./ui/input.js";
import { createPrintOutput, readStdin } from "./ui/print.js";
import { renderMarkdown } from "./ui/markdown.js";
import { TerminalRenderer } from "./ui/renderer.js";

const HELP = [
  "命令：",
  "  /help              显示本帮助",
  "  /model <provider:id>   切换模型，如 /model openai:gpt-4o-mini、/model anthropic:claude-3-7-sonnet-latest",
  "  /tools             列出可用工具",
  "  /usage             显示本次会话的 token 用量",
  "  /clear             清空对话历史",
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
  "输出渲染：",
  "  --no-markdown                原样输出 Markdown 源码，不做终端渲染",
  "                            （管道/重定向时自动关闭，避免转义序列污染下游）",
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
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--model" || a === "-m") args.model = argv[++i];
    else if (a === "--cwd" || a === "-c") args.cwd = argv[++i];
    else if (a === "--verbose" || a === "-v") args.verbose = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--print" || a === "-p") args.print = true;
    else if (a === "--system-prompt" || a === "-sp") args.systemPrompt = argv[++i] ?? "";
    else if (a === "--append-system-prompt" || a === "-asp") args.appendSystemPrompt = argv[++i] ?? "";
    else if (a === "--user-prompt" || a === "-up") args.userPrompt = argv[++i] ?? "";
    else if (a === "--assistant-prompt" || a === "-ap") args.assistantPrompt = argv[++i] ?? "";
    else if (a === "--prefill-commit" || a === "-pc") args.prefillCommit = argv[++i] ?? "";
    else if (a === "--no-markdown") args.markdown = false;
    else if (a !== undefined) positional.push(a);
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

/** 极简 .env 加载：不覆盖已存在的环境变量 */
async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(HELP);
    return 0;
  }

  const cwd = path.resolve(args.cwd ?? process.cwd());

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

  const assembled = await assembleSession({
    cwd,
    modelSpec: args.model,
    ...(args.systemPrompt !== null ? { systemPrompt: args.systemPrompt } : {}),
    ...(args.appendSystemPrompt !== null ? { appendSystemPrompt: args.appendSystemPrompt } : {}),
    ...(seedResult.seeds.length > 0 ? { seedMessages: seedResult.seeds } : {}),
  });
  const { state, queue } = assembled;
  // resolved 后续 /model 命令会改，所以单独拎出来
  let resolved = assembled.resolved;
  let verbose = args.verbose;

  let renderer: TerminalRenderer | undefined;
  let onEvent: (event: AgentEvent) => void;
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
      return 2;
    }
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

    if (sink.errors.length > 0) return 1;
    if (answer.length === 0) {
      process.stderr.write("代理没有产生任何输出\n");
      return 1;
    }
    return 0;
  }

  const sink = new TerminalRenderer({ verbose, markdown });
  renderer = sink;
  onEvent = (event: AgentEvent): void => sink.handle(event);

  let stream: StreamFn = resolved.stream;

  const agent = new Agent({ state, queue, stream, onEvent });

  const input = new InputController();
  input.onSigint(() => {
    if (agent.isRunning) {
      agent.abort();
      console.log("\n(已请求中断，正在收尾)");
    } else {
      input.close();
      process.exit(0);
    }
  });

  console.log(`编码代理已启动`);
  console.log(`  工作目录：${cwd}`);
  console.log(`  模型：${resolved.model.provider}:${resolved.model.id}`);
  console.log(`  工具：${allTools.map((t) => t.name).join(", ")}`);
  if (resolved.degraded !== undefined) console.log(`  提示：${resolved.degraded}`);
  console.log(`  输入 /help 查看命令，Ctrl-C 中断当前任务，Ctrl-D 退出。\n`);

  // 运行期间把终端输入搬运到中途插入队列
  const pump = setInterval(() => {
    if (!agent.isRunning) return;
    for (const text of input.drainSteering()) agent.steer(text);
  }, 120);
  pump.unref();

  try {
    // 启动时若提供了 user-prompt / assistant-prompt，先跑一轮（prefill 同理）
    if (seedResult.seeds.length > 0) {
      await agent.run();
    }

    while (true) {
      const line = await input.ask("› ");
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;

      if (trimmed.startsWith("/")) {
        const [command, ...rest] = trimmed.slice(1).split(/\s+/);
        const argument = rest.join(" ").trim();

        switch (command) {
          case "exit":
          case "quit":
            return 0;

          case "help":
            console.log(HELP);
            break;

          case "tools":
            for (const t of allTools) console.log(`  ${t.name} — ${t.description}`);
            break;

          case "usage": {
            const u = totalUsage(state);
            console.log(`  input ${u.input} / output ${u.output} / 合计 ${u.total}`);
            break;
          }

          case "clear":
            state.messages.length = 0;
            console.log("  对话历史已清空");
            break;

          case "verbose":
            verbose = !verbose;
            renderer?.setVerbose(verbose);
            console.log(`  思考过程显示：${verbose ? "开" : "关"}`);
            break;

          case "model": {
            if (argument.length === 0) {
              console.log(`  当前模型：${state.model.provider}:${state.model.id}`);
              break;
            }
            resolved = resolveModelSpec(argument).resolved;
            stream = resolved.stream;
            agent.setModel(resolved.model, stream);
            console.log(`  已切换到 ${resolved.model.provider}:${resolved.model.id}`);
            if (resolved.degraded !== undefined) console.log(`  提示：${resolved.degraded}`);
            break;
          }

          default:
            console.log(`  未知命令：/${command}，输入 /help 查看可用命令`);
        }
        continue;
      }

      agent.enqueueUser(trimmed);
      await agent.run();
    }
  } finally {
    clearInterval(pump);
    input.close();
  }
}

main().then(
  (code: number) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  },
);
