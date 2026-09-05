/**
 * 输入控制器。
 * 关键点：代理运行期间敲进去的内容不会被丢弃，而是进入「中途插入指令」缓冲区，
 * 由主循环定时取走注入当前消息——这就是流程图里的 steering 通道。
 */

import readline from "node:readline";

export class InputController {
  private readonly rl: readline.Interface;
  private waiter: ((line: string) => void) | null = null;
  private steering: string[] = [];

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
      const waiter = this.waiter;
      if (waiter !== null) {
        this.waiter = null;
        waiter("/exit");
      }
    });
  }

  /** 等待用户在提示符后输入一行 */
  ask(prompt: string): Promise<string> {
    return new Promise((resolve) => {
      this.waiter = resolve;
      this.rl.setPrompt(prompt);
      this.rl.prompt();
    });
  }

  /** 取走代理运行期间积累的中途插入指令 */
  drainSteering(): string[] {
    const out = this.steering;
    this.steering = [];
    return out;
  }

  onSigint(handler: () => void): void {
    this.rl.on("SIGINT", handler);
  }

  close(): void {
    this.rl.close();
  }
}
