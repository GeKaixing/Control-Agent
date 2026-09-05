#!/usr/bin/env node
/**
 * CLI 入口：组装代理状态、工具、队列与终端 UI，然后进入 REPL。
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { Agent, type AgentEvent } from "./agent/agent.js";
import { MessageQueue } from "./agent/queue.js";
import { createInitialState, totalUsage } from "./agent/state.js";
import {
  defaultModel,
  parseModelSpec,
  resolveModel,
} from "./providers/index.js";
import type { StreamFn } from "./providers/types.js";
import { allTools } from "./tools/index.js";
import { InputController } from "./ui/input.js";
import { createPrintOutput, readStdin } from "./ui/print.js";
import { TerminalRenderer } from "./ui/renderer.js";
import type { ModelRef } from "./types.js";

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
].join("\n");

interface CliArgs {
  model: string | undefined;
  cwd: string | undefined;
  verbose: boolean;
  help: boolean;
  print: boolean;
  /** 位置参数拼起来的提示词，print 模式用它作为一次性输入 */
  prompt: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    model: undefined,
    cwd: undefined,
    verbose: false,
    help: false,
    print: false,
    prompt: "",
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--model" || a === "-m") args.model = argv[++i];
    else if (a === "--cwd" || a === "-c") args.cwd = argv[++i];
    else if (a === "--verbose" || a === "-v") args.verbose = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--print" || a === "-p") args.print = true;
    else if (a !== undefined) positional.push(a);
  }
  args.prompt = positional.join(" ").trim();
  return args;
}

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
async function loadDotEnv(cwd: string): Promise<void> {
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

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(HELP);
    return 0;
  }

  const cwd = path.resolve(args.cwd ?? process.cwd());
  await loadDotEnv(cwd);

  // 没有终端就没有交互可言：提示词读不进来、进度也画不出来，直接走 print 模式
  const stdinIsTty = process.stdin.isTTY === true;
  const printMode = args.print || !stdinIsTty || process.stdout.isTTY !== true;

  const model: ModelRef = args.model !== undefined ? parseModelSpec(args.model) : defaultModel();
  let resolved = resolveModel(model);

  const state = createInitialState({ cwd, model: resolved.model, tools: allTools });
  const queue = new MessageQueue();
  let verbose = args.verbose;

  let renderer: TerminalRenderer | undefined;
  let onEvent: (event: AgentEvent) => void;
  if (printMode) {
    const sink = createPrintOutput();
    onEvent = (event: AgentEvent): void => sink.onEvent(event);

    const prompt = await resolvePrompt(args.prompt, stdinIsTty);
    if (prompt === null) {
      console.error(
        "print 模式需要一个提示词：用位置参数传入（npm start -- -p \"你的问题\"），或通过管道/重定向喂给 stdin。",
      );
      return 2;
    }
    if (resolved.degraded !== undefined) console.error(`提示：${resolved.degraded}`);

    const agent = new Agent({ state, queue, stream: resolved.stream, onEvent });
    agent.enqueueUser(prompt);
    await agent.run();

    const answer = sink.answer.trim();
    if (answer.length > 0) process.stdout.write(`${answer}\n`);
    for (const warning of sink.warnings) process.stderr.write(`${warning}\n`);
    for (const error of sink.errors) process.stderr.write(`错误：${error}\n`);

    if (sink.errors.length > 0) return 1;
    if (answer.length === 0) {
      process.stderr.write("代理没有产生任何输出\n");
      return 1;
    }
    return 0;
  }

  const sink = new TerminalRenderer({ verbose });
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
            resolved = resolveModel(parseModelSpec(argument));
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
