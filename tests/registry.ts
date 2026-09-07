/**
 * 测试用例注册中心。
 *
 * 原本 `cases[]` / `test()` / `main()` 直接写在 `tests/run.ts` 里，但 48 个用例之后
 * 单一文件已经膨胀；现在按用例种类分到 `cli-print.ts` / `repl-loop.ts` 等文件，
 * 它们都通过这个 registry 注册，再由 `run.ts` 统一编排执行。
 *
 * 用法：
 *   tests/run.ts        // 入口：只 import 子用例 + 跑 main()
 *   tests/cli-print.ts  // import { test } from './registry.js'，写用例
 *   tests/repl-loop.ts  // 同上
 *
 * 设计动机来自 AGENTS.md：测试运行器保持零依赖（仅 `node:assert/strict`），用例
 * 数量上去后用文件拆分而不是堆在一个文件里。这样新增测试只需要新写一个文件、
 * 在 `run.ts` 加一行 import，不会污染入口的编排代码。
 */

import assert from "node:assert/strict";

export interface Case {
  name: string;
  fn: () => Promise<void> | void;
}

export const cases: Case[] = [];

/** 注册一条用例，按调用顺序串行执行 */
export function test(name: string, fn: () => Promise<void> | void): void {
  cases.push({ name, fn });
}

/**
 * 跑一遍所有用例，把结果打在 stdout。失败计数器 > 0 时返回 1，否则 0。
 *
 * 调用方通常在 `tests/run.ts` 末尾以 `await main()` 形式收尾。
 * 这里抽出来而不是写在 run.ts 里，是因为子测试文件如果想独立运行也需要它。
 */
export async function main(defaultReporter?: (line: string) => void): Promise<number> {
  const out = defaultReporter ?? ((line: string): void => console.log(line));
  let failed = 0;
  for (const c of cases) {
    const started = Date.now();
    try {
      await c.fn();
      out(`  ✓ ${c.name} (${Date.now() - started}ms)`);
    } catch (err) {
      failed += 1;
      out(`  ✗ ${c.name}`);
      const message = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
      out(`    ${message}`);
    }
  }
  out(`\n${cases.length - failed}/${cases.length} 通过`);
  if (failed > 0) {
    process.exitCode = 1;
    return 1;
  }
  return 0;
}

/**
 * 阻塞到下一次事件循环 tick。
 *
 * 用来在 `spawn()` 之类异步动作后给 `on('data')` 监听器一点时间把数据读出来。
 * 不要用魔法数字 sleep——这就是 `setImmediate` 套个壳，简洁。
 */
export function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** 等多少毫秒；基本只在 `ManualSession` 之类的工具里用 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 把 ANSI 转义序列脱掉，方便 substring 断言 */
export function stripAnsi(s: string): string {
  // CSI 控制序列：ESC [ ... 字母
  // 也覆盖 OSC（ESC ] ... BEL/ST）。这里只覆盖测试用得到的：颜色/光标/链接。
  // 用一个简单的状态机不划算；正则够用。
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

/** re-export 让子用例文件不需要重复 import assert */
export { assert };
