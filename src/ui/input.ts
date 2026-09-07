/**
 * 输入控制器。
 * 关键点：代理运行期间敲进去的内容不会被丢弃，而是进入「中途插入指令」缓冲区，
 * 由主循环定时取走注入当前消息——这就是流程图里的 steering 通道。
 *
 * 为了让 REPL 循环（src/ui/repl.ts）能在测试里被 fake 输入驱动，这里把
 * 真实终端的 readline 接口和测试用的 fake 驱动都收敛到一个 `LoopInput` 协议。
 * 真在终端下跑仍然只引 `InputController`；测试用例另外引入 `FakeInput`。
 */

import readline from "node:readline";
import { EventEmitter } from "node:events";

/**
 * REPL 循环在每轮迭代里需要的最小输入接口。
 *
 * - `ask()`：阻塞等一行，EOF 时 resolve null — REPL 据此判断 "Ctrl-D 退出"
 * - `drainSteering()`：模型流期间用户半路插进来的文字，定时泵站会取走
 * - `onSigint()`：注册 Ctrl-C 处理；handler 内部决定 abort 还是 close
 * - `close()`：给信号让 readline 真正回收 tty，第二次调用幂等
 *
 * 设计动机：让 `FakeInput`（测试用）能实现同一套接口，整段 REPL 循环对底层 IO
 * 类型不变，测试就能用一行行手敲数据驱动。
 */
export interface LoopInput {
  /** 等一行；EOF → null。`prompt` 写到输出（如果实现支持） */
  ask(prompt: string): Promise<string | null>;
  /** 取走代理跑期间用户敲进的所有中途指令 */
  drainSteering(): string[];
  /** 注册 Ctrl-C 处理（handler 由 REPL 提供，常见动作：abort agent / close input） */
  onSigint(handler: () => void): void;
  /** 关闭 readline；调用两次幂等 */
  close(): void;
}

// ---------------------------------------------------------------- 真终端

export class InputController implements LoopInput {
  private readonly rl: readline.Interface;
  private waiter: ((line: string | null) => void) | null = null;
  private readonly steering: string[] = [];
  private closed = false;

  constructor() {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
      historySize: 500,
    });

    this.rl.on("line", (line) => {
      const waiter = this.waiter;
      if (waiter !== null) {
        this.waiter = null;
        waiter(line);
        return;
      }
      const trimmed = line.trim();
      if (trimmed.length > 0) this.steering.push(trimmed);
    });

    this.rl.on("close", () => {
      this.closed = true;
      const waiter = this.waiter;
      if (waiter !== null) {
        this.waiter = null;
        waiter(null);
      }
    });
  }

  ask(prompt: string): Promise<string | null> {
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.waiter = resolve;
      this.rl.setPrompt(prompt);
      this.rl.prompt();
    });
  }

  drainSteering(): string[] {
    const out = this.steering;
    this.steering.length = 0;
    return out;
  }

  onSigint(handler: () => void): void {
    this.rl.on("SIGINT", handler);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rl.close();
  }
}

// ---------------------------------------------------------------- Fake 驱动

/**
 * 测试用 fake：可手动 push 一行、push steering、关 readline、触发 SIGINT。
 *
 * 与真 InputController 的差别：
 * - ask()/close 不会写任何输出（readline 真模式会写 prompt）——> 测试要自己 print
 * - 整段没有 tty 概念，所以可用于 in-process REPL 测试
 *
 * 用法（见 tests/repl-loop.ts）：
 *   const input = new FakeInput();
 *   input.pushLine('hello');
 *   const line = await input.ask('› ');  // → 'hello'
 *
 *   input.pushSteering('halfway');
 *   input.drainSteering();  // → ['halfway']
 *
 *   input.pushSigint();
 *   // handler 跑了
 */
export class FakeInput implements LoopInput {
  private readonly queue: string[] = [];
  private readonly steeringBuf: string[] = [];
  private waiter: ((line: string | null) => void) | null = null;
  private readonly sigintEmitter = new EventEmitter();
  private closed = false;

  /**
   * 给 ask() 推一行数据。如果当前没 waiter 就入队，下次 ask 时按 FIFO 出队。
   * 用空串模拟「用户敲了回车但没输入」—— REPL 那边会忽略继续。
   */
  pushLine(line: string): void {
    if (this.waiter !== null) {
      const w = this.waiter;
      this.waiter = null;
      w(line);
      return;
    }
    this.queue.push(line);
  }

  /**
   * 给 ask() 推 EOF —— 等价的 waiter 会被 resolve 为 null，REPL 据此退出。
   * 等价于真模式下的 Ctrl-D。
   */
  pushEof(): void {
    if (this.waiter !== null) {
      const w = this.waiter;
      this.waiter = null;
      w(null);
      return;
    }
    this.queue.push("__FAKE_EOF__");
  }

  /**
   * 推一条 steering 文本（不等 ask）。
   * 这些文字会在 agent.run() 期间被 REPL 定时 pump 取走注入当前消息。
   */
  pushSteering(text: string): void {
    this.steeringBuf.push(text);
  }

  /** 触发 SIGINT；所有 onSigint 注册的 handler 都会被调用 */
  triggerSigint(): void {
    this.sigintEmitter.emit("sigint");
  }

  async ask(prompt: string): Promise<string | null> {
    if (this.closed) return null;
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next === "__FAKE_EOF__") return null;
      return next ?? "";
    }
    // 如果实现支持会把 prompt 写到输出——FakeInput 不写，真正的 InputController 走 readline
    void prompt;
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  drainSteering(): string[] {
    const out = this.steeringBuf.slice();
    this.steeringBuf.length = 0;
    return out;
  }

  onSigint(handler: () => void): void {
    this.sigintEmitter.on("sigint", handler);
  }

  close(): void {
    this.closed = true;
    if (this.waiter !== null) {
      const w = this.waiter;
      this.waiter = null;
      w(null);
    }
  }
}
