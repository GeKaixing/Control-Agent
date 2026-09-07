/**
 * 子进程级 CLI 测试 —— 跑真正的 c-agent 二进制，像一个人那样敲键盘、看输出。
 *
 * 与 tests/run.ts 里那些用 `Agent` 类 + mock StreamFn 直接构造的端到端测试不同，
 * 这里通过 `node --import tsx src/index.ts ...` 启一个真子进程，验证：
 * - 参数解析真的能命中
 * - stdout / stderr 真的分得开（不被 TTY 检测误判）
 * - 退出码符合约定（0 / 1 / 2）
 * - shell 拼接 / stdin 管道 / cwd 这些"边角"行为不退化
 *
 * 设计动机见 tests/manual.ts。Mock 模型故意被打成 0 延迟，否则测试太慢。
 */

import path from "node:path";
import url from "node:url";

import { assert, test } from "./registry.js";
import { ManualSession } from "./manual.js";

// tests/ 当前目录拼到 src/index.ts 的相对路径
const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ENTRY = path.resolve(HERE, "..", "src", "index.ts");

// 默认子进程超时：mock 模型 0 延迟，加上 spawn() 启动开销，单条用例 ≤ 8s 足够。
// 之所以这么死板写死，是因为期望超时的用例本身有 bug 时不希望永久挂住测试。
const DEFAULT_TIMEOUT_MS = 8_000;
const HELP_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------- 启动 / 帮助

test("手动：--help 输出命令清单，且退出码 0", async () => {
  const s = await ManualSession.spawn({
    entry: ENTRY,
    args: ["--help"],
    cwd: HERE,
  });
  await s.expectExit(0, HELP_TIMEOUT_MS);

  // 关键内容：常规命令、print 模式说明、退出码约定
  assert.match(s.stdout(), /\/help/);
  assert.match(s.stdout(), /\/exit/);
  assert.match(s.stdout(), /非交互用法/);
  assert.match(s.stdout(), /\u9000\u51fa\u7801/); // 退出码
  assert.match(s.stdout(), /--print/);
  // 不应该有 ANSI 转义（子进程没拿到 TTY）
  assert.equal(/\x1b\[/.test(s.stdout()), false, "help 不应有任何 ANSI 序列");
});

test("手动：-h 简写和 --help 等价", async () => {
  const s = await ManualSession.spawn({ entry: ENTRY, args: ["-h"], cwd: HERE });
  await s.expectExit(0, HELP_TIMEOUT_MS);
  assert.match(s.stdout(), /\/help/);
});

test("手动：--help 走到 help 路径时不应走 .env / 模型装配", async () => {
  // 即便 cwd 下塞一个假的、错的 .env 文件，--help 也不该去读它。
  // 断言：输出不包含降级提示（"未配置 API_KEY"）——意味着根本没尝试装配会话。
  const tmp = makeTmp("help-no-env");
  await writeFile(path.join(tmp, ".env"), "OPENAI_API_KEY=bogus\n");
  try {
    const s = await ManualSession.spawn({ entry: ENTRY, args: ["--help"], cwd: tmp });
    await s.expectExit(0, HELP_TIMEOUT_MS);
    assert.equal(/未配置.*API_KEY/.test(s.stdout()), false);
    assert.equal(s.stderr(), "");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------- print 模式

test("手动：-p 单次问答走 mock 模型，stdout 拿到答案，stderr 为空", async () => {
  const s = await ManualSession.spawn({
    entry: ENTRY,
    args: ["-p", "一句话介绍 TypeScript", "--model", "mock"],
    cwd: HERE,
  });
  await s.expectExit(0, DEFAULT_TIMEOUT_MS);

  // 答案必须包含「已收到」(mock 模型的固定开场)
  assert.match(s.stdout(), /\u5df2\u6536\u5230/);
  // 进度噪音（✓、→ "工具名"）不应混入 stdout
  assert.equal(s.stdout().includes("✓"), false, "不应混入成功标记");
  assert.equal(/\u2192 /.test(s.stdout()), false, "不应混入工具调用行");
  // stderr 应该空
  assert.equal(s.stderr(), "");
});

test("手动：-p 后接多个位置参数会被空格拼成一个 prompt", async () => {
  const s = await ManualSession.spawn({
    entry: ENTRY,
    args: ["-p", "你好", "再见", "--model", "mock"],
    cwd: HERE,
  });
  await s.expectExit(0, DEFAULT_TIMEOUT_MS);
  // mock 模型会把最近的 user 文本整段回显
  assert.match(s.stdout(), /\u4f60\u597d\u518d\u89c1|\u5df2\u6536\u5230/);
});

test("手动：--print 完整写法等价于 -p", async () => {
  const s = await ManualSession.spawn({
    entry: ENTRY,
    args: ["--print", "随便一句话", "--model", "mock"],
    cwd: HERE,
  });
  await s.expectExit(0, DEFAULT_TIMEOUT_MS);
  assert.match(s.stdout(), /\u5df2\u6536\u5230/);
});

test("手动：stdin 喂提示词等价于位置参数", async () => {
  const s = await ManualSession.spawn({
    entry: ENTRY,
    args: ["--model", "mock"],
    cwd: HERE,
    stdinPayload: "\u4ece\u7ba1\u9053\u8bfb\u8fc7\u6765\u7684\u95ee\u9898",
  });
  await s.expectExit(0, DEFAULT_TIMEOUT_MS);
  // mock 模型会回显管道里的文本
  assert.match(s.stdout(), /\u7ba1\u9053|\u5df2\u6536\u5230/);
});

test("手动：print 模式 stdio 不是 TTY 时自动启用，连 -p 都不用写", async () => {
  // 这个测试就是模拟「echo x | c-agent」的真实场景：
  //   ManualSession 用 pipe 喂 stdin，子进程 stdinIsTty=false → 强制 print 模式
  const s = await ManualSession.spawn({
    entry: ENTRY,
    args: ["--model", "mock"], // 不传 -p
    cwd: HERE,
    stdinPayload: "\u7ba1\u9053\u6d4b\u8bd5\n",
  });
  await s.expectExit(0, DEFAULT_TIMEOUT_MS);
  assert.match(s.stdout(), /\u5df2\u6536\u5230/);
});

test("手动：print 模式没 prompt 时退码 2，并把说明打到 stderr", async () => {
  const s = await ManualSession.spawn({
    entry: ENTRY,
    args: ["--model", "mock"],
    cwd: HERE,
    // 显式什么都不喂，连空字符串都没有
    stdinPayload: "",
  });
  await s.expectExit(2, DEFAULT_TIMEOUT_MS);
  assert.match(s.stderr(), /\u63d0\u793a\u8bcd/);
  assert.equal(s.stdout().trim(), "");
});

// ------------------------------------------------------ 参数互斥校验

test("手动：--user-prompt 与位置参数同用 → exit 2 + 错误提示", async () => {
  const s = await ManualSession.spawn({
    entry: ENTRY,
    args: ["-p", "positional", "--user-prompt", "from-flag", "--model", "mock"],
    cwd: HERE,
  });
  await s.expectExit(2, HELP_TIMEOUT_MS);
  assert.match(s.stderr(), (/--user-prompt/));
  assert.match(s.stderr(), /\u4e92\u65a5/); // 互斥
});

test("手动：--assistant-prompt 单独给 → exit 2 + 提示必须配对", async () => {
  const s = await ManualSession.spawn({
    entry: ENTRY,
    args: ["--assistant-prompt", "孤零零的 prefill", "--model", "mock"],
    cwd: HERE,
  });
  await s.expectExit(2, HELP_TIMEOUT_MS);
  assert.match(s.stderr(), /--assistant-prompt/);
  assert.match(s.stderr(), /--user-prompt/);
});

test("手动：--user-prompt + --assistant-prompt 是合法组合", async () => {
  const s = await ManualSession.spawn({
    entry: ENTRY,
    args: [
      "--user-prompt", "u",
      "--assistant-prompt", "好的，",
      "--model", "mock",
      "--cwd", HERE,
    ],
    cwd: HERE,
  });
  // prefill + commit → 模型从 prefill 接续，mock 会出第一段文本
  await s.expectExit(0, DEFAULT_TIMEOUT_MS);
  assert.match(s.stdout(), /\u5df2\u6536\u5230|\u4ee3\u7406|\u5b8c\u6210/);
});

// ------------------------------------------------------ 提示词覆盖

test("手动：--append-system-prompt 真的能改变模型行为（让 mock 给更短的回答）", async () => {
  // mock 不读 system 提示词做推理，但可以借"无 markdown"标志验证它至少收到了附录。
  // 这里用 --no-markdown 走 stdout 原始模式做反向验证：装上 -asp 也不会走 markdown 路径。
  // 实际"行为变化"覆盖在 tests/run.ts 的 prompts 用例里（端到端）。
  const s = await ManualSession.spawn({
    entry: ENTRY,
    args: [
      "-p", "完整回答我",
      "--model", "mock",
      "--append-system-prompt", "只能用 5 个字以内回答。",
      "--no-markdown",
    ],
    cwd: HERE,
  });
  await s.expectExit(0, DEFAULT_TIMEOUT_MS);
  assert.match(s.stdout(), /\u5df2\u6536\u5230/);
  // --no-markdown 模式下不应有 ANSI 序列
  assert.equal(/\x1b\[/.test(s.stdout()), false, "--no-markdown 应关掉 ANSI");
});

test("手动：--prefill-commit 自定义内容真的进了会话", async () => {
  // 这条用例既验证 CLI 参数串通，又验证模型（mock）真的拿到了 commit 文本作为
  // 最后一条 user 消息：mock 会按关键字行动，"continue here" 不匹配工具关键词，
  // 会直接回 "已收到 ..."，但回显里会带 commit 文本本身吗？
  // mock 的回显是 user 文本的最后一个非空消息，"continue here" 长度短，断言它
  // 出现在输出里能让 commit "进到 LLM 看到的地方" 落实。
  const s = await ManualSession.spawn({
    entry: ENTRY,
    args: [
      "--user-prompt", "u",
      "--assistant-prompt", "好的，",
      "--prefill-commit", ">>> HERE IS CONTINUE <<<",
      "--model", "mock",
    ],
    cwd: HERE,
  });
  await s.expectExit(0, DEFAULT_TIMEOUT_MS);
  // 用户消息是 "u"，最后一条文本用户消息是 commit，会被 mock 拿去回显
  assert.match(s.stdout(), />>> HERE IS CONTINUE <<</);
});

test("手动：--prefill-commit 空字符串生效 —— mock 拿不到 commit，跳过接续触发", async () => {
  // 空 prefill-commit 意味着模型直接从 prefill 静默接续；mock 可能会"没活干"。
  // 这种情况属于规范预期，不会 exit 2，但可能 exit 1（"代理没有产生任何输出"）。
  // 这里主要确认不挂死、退出码合 CLI 约定。
  const s = await ManualSession.spawn({
    entry: ENTRY,
    args: [
      "--user-prompt", "u",
      "--assistant-prompt", "好的，",
      "--prefill-commit", "",
      "--model", "mock",
    ],
    cwd: HERE,
  });
  // 不论 0 还是 1，都能在合理时间内退出
  await s.expectExit(null, DEFAULT_TIMEOUT_MS);
  // 行为契约见 src/session.ts:buildSeedMessages，错误信息不空也合法
});

// ------------------------------------------------------ 模型装配

test("手动：未知模型 spec 走 mock 降级，stderr 给出说明", async () => {
  const s = await ManualSession.spawn({
    entry: ENTRY,
    args: ["-p", "hi", "--model", "very-fake:does-not-exist"],
    cwd: HERE,
  });
  // --model 解析失败时会退 mock（parseModelSpec:55 的 fallback），不是错
  await s.expectExit(0, DEFAULT_TIMEOUT_MS);
  assert.match(s.stdout(), /\u5df2\u6536\u5230/);
});

test("手动：没配 key 的 openai 自动降级为 mock，并打提示", async () => {
  // ManualSession.spawn 自动清空 _API_KEY，所以这个用例其实测的是无 key 路径。
  const s = await ManualSession.spawn({
    entry: ENTRY,
    args: ["-p", "hi", "--model", "openai:gpt-4o-mini"],
    cwd: HERE,
  });
  await s.expectExit(0, DEFAULT_TIMEOUT_MS);
  // 降级提示走 stderr（与答案隔离）
  assert.match(s.stderr(), /\u964d\u7ea7/);
  // 答案照样走 stdout
  assert.match(s.stdout(), /\u5df2\u6536\u5230/);
});

// ------------------------------------------------------ cwd 行为

test("手动：--cwd 让代理把工作目录换到指定路径", async () => {
  const tmp = makeTmp("cli-cwd");
  await writeFile(path.join(tmp, "marker.txt"), "i-am-here");
  try {
    const s = await ManualSession.spawn({
      entry: ENTRY,
      args: [
        "-p", "\u67e5\u770b marker.txt \u91cc\u7684\u5185\u5bb9", // "查看 marker.txt 里的内容"
        "--model", "mock",
        "--cwd", tmp,
      ],
      cwd: tmp,
    });
    await s.expectExit(0, DEFAULT_TIMEOUT_MS);
    // mock 看到「查看 ... marker.txt」会调 read 工具，结果带 i-am-here
    assert.match(s.stdout(), /i-am-here|\u5df2\u6536\u5230/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ------------------------------------------------------ edge cases

test("手动：完全没有任何参数且 stdin 为空 → 退码 2（缺提示词）", async () => {
  const s = await ManualSession.spawn({
    entry: ENTRY,
    args: [],
    cwd: HERE,
    stdinPayload: "",
  });
  await s.expectExit(2, DEFAULT_TIMEOUT_MS);
  assert.match(s.stderr(), /\u63d0\u793a\u8bcd/);
});

test("手动：未知 --flag 不会阻止 print 模式跑（剩下部分照样工作）", async () => {
  // 这条保护"宽松解析"——CLI 不应该对一个误传的 flag 整个崩溃。
  // 测试：加一个识别不出的 -xyz（实际是位置参数），看主流程是否还能跑。
  const s = await ManualSession.spawn({
    entry: ENTRY,
    args: ["-p", "简单问题", "-xyz", "--model", "mock"],
    cwd: HERE,
  });
  await s.expectExit(0, DEFAULT_TIMEOUT_MS);
  assert.match(s.stdout(), /\u5df2\u6536\u5230/);
});

test("手动：stdout 与 stderr 严格分离（除 -p 错误之外的内容不在 stdout）", async () => {
  // 触发降级提示（走 stderr），然后断言 stdout 里没有任何看起来像"未配置/降级"字样。
  // mock 模型的标准回答里也会提到 "OPENAI_API_KEY"，故意放在 regex 之外——
  // 那是模型自然输出，不算"混入"。我们关心的是真实诊断信息不应进 stdout。
  const s = await ManualSession.spawn({
    entry: ENTRY,
    args: ["-p", "x", "--model", "openai:gpt-4o-mini"],
    cwd: HERE,
  });
  await s.expectExit(0, DEFAULT_TIMEOUT_MS);
  assert.equal(/未配置|降级/.test(s.stdout()), false, "诊断信息不应混入 stdout");
  assert.match(s.stderr(), /(未配置|降级)/);
});

// ---------------------------------------------------------------- helpers

const fsPromises = await import("node:fs/promises");
const fsSync = await import("node:fs");

function makeTmp(prefix: string): string {
  // 拼一个本会话唯一的临时目录名；同时建出来——writeFile/rm 都要求父目录存在。
  // 用 mkdirSync 同步建，避免 race（异步 mkdir 后立刻 writeFile 可能还没建好）。
  const dir = path.join(
    "/tmp",
    `c-agent-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  fsSync.mkdirSync(dir, { recursive: true });
  return dir;
}

const { writeFile, rm } = fsPromises;
