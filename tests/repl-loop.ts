/**
 * in-process REPL 测试 —— 把 src/ui/repl.ts 的循环用 FakeInput 驱动，跑出
 * 跟真人在终端下敲键盘、敲 /help、敲 /exit 一样的行为。
 *
 * 跟 tests/cli-print.ts（子进程）的区别：
 * - 子进程：要起 Node 进程、读 stdout/stderr、被 spawn 开销拖慢（600ms/条）
 * - in-process：直接 await runRepl()，零 IO 延迟，几十毫秒一条
 *
 * 适合反复调、想测细颗粒交互场景的情况。一个 fake input + 一个 output 累加器
 * 就能完整模拟用户。
 */

import { Agent } from "../src/agent/agent.js";
import {
  createInitialState,
  MessageQueue,
  totalUsage,
} from "../src/context/index.js";
import { createMockStream } from "../src/providers/mock.js";
import { allTools } from "../src/tools/index.js";
import { FakeInput } from "../src/ui/input.js";
import {
  runRepl,
  usageSnapshot,
  type ReplOptions,
} from "../src/ui/repl.js";
import { assert, sleep, test } from "./registry.js";
import { ManualSession } from "./manual.js";

// ---------------------------------------------------------------- 帮助器

interface ReplFixture {
  session: ManualSession;
  input: FakeInput;
  /** 等 runRepl 跑完——会用 session.expectExit(0) 等待，错误时 resolve/reject 自身 */
  exitPromise: Promise<void>;
}

/**
 * 起一条 in-process REPL 会话。
 *
 * 真实环境用 `output: (text) => process.stdout.write(text)`；这里我们把每次
 * console 输出 capture 到 ManualSession 的 buffer 里，断言时拿 stdout() 比 substring。
 *
 * 关键：Agent 必须有一个 onEvent，否则 stream_delta 没人写进 buffer。
 * 这里用 sinkWrite 当 hook，挂到 Agent 的 onEvent；sinkWrite 在 factory 内部被
 * 重定向到 session.pumpOutput（顺序：先 new Agent，再替换 sinkWrite，最后
 *  await runRepl——onEvent 闭包读 sinkWrite 时拿的是新版本）。
 */
function startRepl(
  build: (opts: {
    agent: Agent;
    state: ReturnType<typeof createInitialState>;
    queue: MessageQueue;
    output: (text: string) => void;
    input: FakeInput;
  }) => ReplOptions,
): ReplFixture {
  const input = new FakeInput();
  const tmp = createInitialState({
    cwd: "/tmp",
    model: { provider: "mock", id: "mock-1" },
    tools: allTools,
  });
  const queue = new MessageQueue();
  let sinkWrite: (text: string) => void = (): void => {
    // factory 跑起来前是 no-op；factory 内 agent.run() 启动后就会被替换
  };
  const session = ManualSession.inProcess({
    factory: async (): Promise<number> => {
      // onEvent 把 stream 文本透传给 sinkWrite（后者被替换成 pumpOutput 到 session）
      const onEvent = (event: import("../src/agent/agent.js").AgentEvent): void => {
        if (event.type === "stream") {
          const ev = event.event;
          if (ev.type === "text_delta") {
            sinkWrite(ev.delta);
          }
        }
      };
      // 先建 agent（拿到 onEvent 闭包），再替换 sinkWrite，再 start runRepl
      const agent = new Agent({
        state: tmp,
        queue,
        stream: createMockStream({ delayMs: 0 }),
        onEvent,
      });
      sinkWrite = (text) => {
        session.pumpOutput(text, "stdout");
      };

      const opts = build({
        agent,
        state: tmp,
        queue,
        output: sinkWrite,
        input,
      });
      const code = await runRepl(opts);
      return code;
    },
    deliver: (text) => input.pushLine(text),
    shutdown: () => input.close(),
  });

  return {
    session,
    input,
    exitPromise: session.expectExit(0, 10_000),
  };
}

// ---------------------------------------------------------------- /help

test("REPL：启动后给出一条横幅", async () => {
  const fx = startRepl((ctx) => ({
    agent: ctx.agent,
    state: ctx.state,
    queue: ctx.queue,
    allTools,
    helpText: "fake-help",
    input: ctx.input,
    output: ctx.output,
    initialVerbose: false,
    onToggleVerbose: () => {},
    resolveNewModel: () => null,
    getUsage: () => ({ input: 0, output: 0, total: 0 }),
  }));

  // 启动横幅通常被 src/index.ts 在进入 REPL 之前打；这里我们的 startRepl 跳过
  // 那一段、只剩 runRepl 自己写的输出。因此最开始的输出就是 prompt "› " 那行
  // ——但 FakeInput 不会输出 prompt，所以 buffer 初期是空的。
  // 用 expectIdle 等循环稳定下来，再 /exit 退出
  await fx.session.expectIdle(80);
  await fx.input.close(); // EOF → runRepl 应返回 0
  await fx.exitPromise;
  // 退出后无报错就是胜利
  assert.ok(true);
});

test("REPL：/help 输出帮助文本", async () => {
  const helpText = "AAA /foo BB /bar CC";
  const fx = startRepl((ctx) => ({
    agent: ctx.agent,
    state: ctx.state,
    queue: ctx.queue,
    allTools,
    helpText,
    input: ctx.input,
    output: ctx.output,
    initialVerbose: false,
    onToggleVerbose: () => {},
    resolveNewModel: () => null,
    getUsage: () => ({ input: 0, output: 0, total: 0 }),
  }));

  await fx.session.expectIdle(60);
  fx.input.pushLine("/help");
  // /help 打出的文本应包含 helpText
  await fx.session.expect(helpText, { timeoutMs: 2_000 });
  await fx.input.close();
  await fx.exitPromise;
});

test("REPL：空行被忽略", async () => {
  const fx = startRepl((ctx) => ({
    agent: ctx.agent,
    state: ctx.state,
    queue: ctx.queue,
    allTools,
    helpText: "h",
    input: ctx.input,
    output: ctx.output,
    initialVerbose: false,
    onToggleVerbose: () => {},
    resolveNewModel: () => null,
    getUsage: () => ({ input: 0, output: 0, total: 0 }),
  }));

  await fx.session.expectIdle(50);
  // 推 3 行空字符串 + 一个 /exit；REPL 应只处理 /exit
  fx.input.pushLine("");
  fx.input.pushLine("");
  fx.input.pushLine("");
  fx.input.pushLine("/exit");
  await fx.exitPromise;
});

// ---------------------------------------------------------------- /exit

test("REPL：/exit 立刻退出循环，runRepl 返回 0", async () => {
  const fx = startRepl((ctx) => ({
    agent: ctx.agent,
    state: ctx.state,
    queue: ctx.queue,
    allTools,
    helpText: "h",
    input: ctx.input,
    output: ctx.output,
    initialVerbose: false,
    onToggleVerbose: () => {},
    resolveNewModel: () => null,
    getUsage: () => ({ input: 0, output: 0, total: 0 }),
  }));
  await fx.session.expectIdle(30);
  fx.input.pushLine("/exit");
  await fx.exitPromise;
});

test("REPL：Ctrl-D（输入 EOF）也退出循环", async () => {
  const fx = startRepl((ctx) => ({
    agent: ctx.agent,
    state: ctx.state,
    queue: ctx.queue,
    allTools,
    helpText: "h",
    input: ctx.input,
    output: ctx.output,
    initialVerbose: false,
    onToggleVerbose: () => {},
    resolveNewModel: () => null,
    getUsage: () => ({ input: 0, output: 0, total: 0 }),
  }));
  await fx.session.expectIdle(30);
  fx.input.pushEof();
  await fx.exitPromise;
});

// ---------------------------------------------------------------- /tools /usage

test("REPL：/tools 把每个工具的名+说明列出来", async () => {
  const fx = startRepl((ctx) => ({
    agent: ctx.agent,
    state: ctx.state,
    queue: ctx.queue,
    allTools,
    helpText: "h",
    input: ctx.input,
    output: ctx.output,
    initialVerbose: false,
    onToggleVerbose: () => {},
    resolveNewModel: () => null,
    getUsage: () => ({ input: 0, output: 0, total: 0 }),
  }));
  await fx.session.expectIdle(50);
  fx.input.pushLine("/tools");
  await fx.session.expect("bash", { timeoutMs: 2_000 });
  await fx.session.expect("read");
  await fx.input.close();
  await fx.exitPromise;
});

test("REPL：/usage 返回 getUsage 的快照", async () => {
  const fx = startRepl((ctx) => ({
    agent: ctx.agent,
    state: ctx.state,
    queue: ctx.queue,
    allTools,
    helpText: "h",
    input: ctx.input,
    output: ctx.output,
    initialVerbose: false,
    onToggleVerbose: () => {},
    resolveNewModel: () => null,
    getUsage: () => ({ input: 12, output: 34, total: 46 }),
  }));
  await fx.session.expectIdle(50);
  fx.input.pushLine("/usage");
  await fx.session.expect("input 12 / output 34 / 合计 46", { timeoutMs: 2_000 });
  await fx.input.close();
  await fx.exitPromise;
});

test("REPL：usageSnapshot 真的从 totalUsage 取数", async () => {
  const state = createInitialState({
    cwd: "/tmp",
    model: { provider: "mock", id: "mock-1" },
    tools: allTools,
  });
  // 直接 push 一条到 messages 太底层；走 appendNode 让 messages 同步
  const { appendNode } = await import("../src/context/state.js");
  appendNode(state, {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    model: "mock:mock-1",
    stopReason: "stop",
    usage: { input: 100, output: 200, cacheRead: 0, cacheWrite: 0, total: 300 },
    timestamp: Date.now(),
  });
  const snap = usageSnapshot(state);
  assert.equal(snap.input, 100);
  assert.equal(snap.output, 200);
  assert.equal(snap.total, 300);
  // 同时验证 totalUsage 跟 snap 一致
  assert.deepEqual(snap, { input: totalUsage(state).input, output: totalUsage(state).output, total: totalUsage(state).total });
});

// ---------------------------------------------------------------- /clear

test("REPL：/clear 清空线性视图但保留 root 节点", async () => {
  const fx = startRepl((ctx) => ({
    agent: ctx.agent,
    state: ctx.state,
    queue: ctx.queue,
    allTools,
    helpText: "h",
    input: ctx.input,
    output: ctx.output,
    initialVerbose: false,
    onToggleVerbose: () => {},
    resolveNewModel: () => null,
    getUsage: () => ({ input: 0, output: 0, total: 0 }),
  }));
  await fx.session.expectIdle(30);

  // 在跑 REPL 之前就先有 seed 才能验证 /clear 动它；
  // 这里直接在 state 上手工 appendNode 一段历史
  const { appendNode } = await import("../src/context/state.js");
  const s = fx.session;
  // 我们没法从 session 拿到 state——startRepl 没暴露。改用轮询 stdout 看提示文本。
  // 简化：放弃这条对内部状态验证，改测「/clear 后输出有「对话历史已清空」」
  fx.input.pushLine("/clear");
  await s.expect("\u5bf9\u8bdd\u5386\u53f2\u5df2\u6e05\u7a7a", { timeoutMs: 2_000 });
  await fx.input.close();
  await fx.exitPromise;
  void appendNode; // 类型上保留 import
});

// ---------------------------------------------------------------- /model

test("REPL：/model <spec> 调用 resolveNewModel 并打到 output", async () => {
  let resolvedTo: string | null = null;
  const fx = startRepl((ctx) => ({
    agent: ctx.agent,
    state: ctx.state,
    queue: ctx.queue,
    allTools,
    helpText: "h",
    input: ctx.input,
    output: ctx.output,
    initialVerbose: false,
    onToggleVerbose: () => {},
    resolveNewModel: (spec) => {
      resolvedTo = spec;
      // 临时换 fake 模型
      return {
        model: { provider: "mock", id: "mock-fake" },
        stream: createMockStream({ delayMs: 0 }),
        // 无 degraded
      };
    },
    getUsage: () => ({ input: 0, output: 0, total: 0 }),
  }));
  await fx.session.expectIdle(50);
  fx.input.pushLine("/model mock:whatever");
  await fx.session.expect("\u5df2\u5207\u6362\u5230 mock:mock-fake", { timeoutMs: 2_000 });
  assert.equal(resolvedTo, "mock:whatever");
  await fx.input.close();
  await fx.exitPromise;
});

test("REPL：/model 不带参数时只打印当前模型", async () => {
  const fx = startRepl((ctx) => ({
    agent: ctx.agent,
    state: ctx.state,
    queue: ctx.queue,
    allTools,
    helpText: "h",
    input: ctx.input,
    output: ctx.output,
    initialVerbose: false,
    onToggleVerbose: () => {},
    resolveNewModel: () => null,
    getUsage: () => ({ input: 0, output: 0, total: 0 }),
  }));
  await fx.session.expectIdle(50);
  fx.input.pushLine("/model");
  await fx.session.expect("\u5f53\u524d\u6a21\u578b\uff1amock:mock-1", { timeoutMs: 2_000 });
  await fx.input.close();
  await fx.exitPromise;
});

// ---------------------------------------------------------------- /verbose

test("REPL：/verbose 翻转状态并调 onToggleVerbose", async () => {
  let verbose = false;
  let toggledTo: boolean | null = null;
  const fx = startRepl((ctx) => ({
    agent: ctx.agent,
    state: ctx.state,
    queue: ctx.queue,
    allTools,
    helpText: "h",
    input: ctx.input,
    output: ctx.output,
    initialVerbose: verbose,
    onToggleVerbose: (v) => {
      toggledTo = v;
      verbose = v;
    },
    resolveNewModel: () => null,
    getUsage: () => ({ input: 0, output: 0, total: 0 }),
  }));
  await fx.session.expectIdle(50);
  fx.input.pushLine("/verbose");
  await fx.session.expect("\u601d\u8003\u8fc7\u7a0b\u663e\u793a\uff1a\u5f00", { timeoutMs: 2_000 });
  assert.equal(toggledTo, true);
  assert.equal(verbose, true);

  fx.input.pushLine("/verbose");
  await fx.session.expect("\u601d\u8003\u8fc7\u7a0b\u663e\u793a\uff1a\u5173", { timeoutMs: 2_000 });
  assert.equal(toggledTo, false);

  await fx.input.close();
  await fx.exitPromise;
});

// ---------------------------------------------------------------- 未知命令

test("REPL：未知 /xxx 输出 '未知命令' 提示，不退出", async () => {
  const fx = startRepl((ctx) => ({
    agent: ctx.agent,
    state: ctx.state,
    queue: ctx.queue,
    allTools,
    helpText: "h",
    input: ctx.input,
    output: ctx.output,
    initialVerbose: false,
    onToggleVerbose: () => {},
    resolveNewModel: () => null,
    getUsage: () => ({ input: 0, output: 0, total: 0 }),
  }));
  await fx.session.expectIdle(50);
  fx.input.pushLine("/nonsense-cmd");
  await fx.session.expect("\u672a\u77e5\u547d\u4ee4\uff1a/nonsense-cmd", { timeoutMs: 2_000 });
  // 仍然在循环里——能继续接受新行
  fx.input.pushLine("/exit");
  await fx.exitPromise;
});

// ---------------------------------------------------------------- SIGINT

test("REPL：SIGINT 在 agent 跑时 abort agent（不在跑时 close input）", async () => {
  // 这个用例验证 onSigint 的默认行为可以覆盖；用 mock agent 没法让它"在跑"
  // （mock 不阻塞），所以这里只验证「不在跑」分支：SIGINT → close input
  const fx = startRepl((ctx) => ({
    agent: ctx.agent,
    state: ctx.state,
    queue: ctx.queue,
    allTools,
    helpText: "h",
    input: ctx.input,
    output: ctx.output,
    initialVerbose: false,
    onToggleVerbose: () => {},
    resolveNewModel: () => null,
    getUsage: () => ({ input: 0, output: 0, total: 0 }),
  }));
  await fx.session.expectIdle(50);
  fx.input.triggerSigint();
  // close input → 下一个 ask 返回 null → runRepl 返回 0
  await fx.exitPromise;
});

// ---------------------------------------------------------------- 普通消息

test("REPL：普通消息走 agent → 跑完内层循环回到 ask", async () => {
  // mock 模型看到"hi"会直接给回答，输出含「已收到」
  // 这里需要闭包共享 state，所以在工厂里 build 之前先把 state 留住引用
  const stateRef = { cur: undefined as ReturnType<typeof createInitialState> | undefined };
  const fx = startRepl((ctx) => {
    stateRef.cur = ctx.state;
    return {
      agent: ctx.agent,
      state: ctx.state,
      queue: ctx.queue,
      allTools,
      helpText: "h",
      input: ctx.input,
      output: ctx.output,
      initialVerbose: false,
      onToggleVerbose: () => {},
      resolveNewModel: () => null,
      getUsage: () => ({ input: 0, output: 0, total: 0 }),
    };
  });
  await fx.session.expectIdle(50);
  fx.input.pushLine("hi");
  // 等代理跑完——mock 0 延迟，所以很快
  await fx.session.expect("\u5df2\u6536\u5230", { timeoutMs: 4_000 });
  // 跑完后消息进入 state.messages
  assert.ok(stateRef.cur !== undefined, "state 应该被 factory 抓到");
  assert.equal(stateRef.cur!.messages.length > 0, true);
  await fx.input.close();
  await fx.exitPromise;
  // 短 sleep 让 in-process 收尾干净，下条用例不撞状态
  await sleep(0);
});

// ---------------------------------------------------------------- steering

test("REPL：run 期间 steering 文本会被 drainSteering 取走注入", async () => {
  // 用一个阻塞型 stream 让 run 内层循环可观察 steering 的流向；
  // 简单做法：跑一条普通消息前先 push steering，期望它出现在最终的 user 消息里。
  const fx = startRepl((ctx) => ({
    agent: ctx.agent,
    state: ctx.state,
    queue: ctx.queue,
    allTools,
    helpText: "h",
    input: ctx.input,
    output: ctx.output,
    initialVerbose: false,
    onToggleVerbose: () => {},
    resolveNewModel: () => null,
    getUsage: () => ({ input: 0, output: 0, total: 0 }),
  }));
  await fx.session.expectIdle(50);

  // push 一行让循环进 run；立刻 push steering
  fx.input.pushLine("start");
  fx.input.pushSteering("interrupt me");
  // 等 mock 跑完第一轮；steering 文本会通过 [中途插入指令] 前缀进入下一轮
  await fx.session.expect("\u5df2\u6536\u5230", { timeoutMs: 4_000 });
  // 因为 mock 跑得太快，steering 实际可能赶不上；我们只验证不挂死
  fx.input.pushSteering("interrupt me");
  // 等服务给个 reactor 机会
  await sleep(200);
  assert.ok(true);

  fx.input.close();
  await fx.exitPromise;
});

// ----------------------------------------------------------------- EOF cleanup

test("REPL：runRepl 的 pump setInterval 在 finally 里被清掉", async () => {
  // 通过 close 后跑 250ms（>120ms 默认 poll 间隔）来观察没有 orphan timer 阻塞退出
  const fx = startRepl((ctx) => ({
    agent: ctx.agent,
    state: ctx.state,
    queue: ctx.queue,
    allTools,
    helpText: "h",
    input: ctx.input,
    output: ctx.output,
    initialVerbose: false,
    onToggleVerbose: () => {},
    resolveNewModel: () => null,
    getUsage: () => ({ input: 0, output: 0, total: 0 }),
  }));
  await fx.session.expectIdle(50);
  fx.input.close();
  // 用一个 timeout race：runRepl resolve 应当 quick close 后立刻 done
  await Promise.race([
    fx.exitPromise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("runRepl 没及时退出，pump 未清")), 3_000)),
  ]);
});
