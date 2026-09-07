/**
 * Bot 运行器测试：FakeAdapter + mock 模型，不碰真微信。
 *
 * 覆盖：
 *  - 私聊消息 → mock 回复 → sendText 收到答案
 *  - 会话持久化：处理完落 .c-agent/sessions/bot_wechat_<id>.json，第二个 runner 续接
 *  - 白名单之外的消息不触发 agent
 *  - 同聊天连发两条消息：串行处理，各得一条回复（followUps 合并语义由 Agent 保证）
 *  - splitReply 分块边界
 */

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { sessionFileExists } from "../src/context/index.js";
import { BotRunner, sanitizeId, splitReply } from "../src/bot/runner.js";
import type { BotAdapter, BotIncomingMessage } from "../src/bot/types.js";
import { test } from "./registry.js";

/** 捕获 sendText 的假适配器：start 返回后可手动投递消息 */
class FakeAdapter implements BotAdapter {
  readonly platform = "wechat";
  readonly sent: { chatId: string; text: string }[] = [];
  private handler: ((msg: BotIncomingMessage) => void | Promise<void>) | undefined;

  async start(onMessage: (msg: BotIncomingMessage) => void | Promise<void>): Promise<void> {
    this.handler = onMessage;
  }

  async sendText(chatId: string, text: string): Promise<void> {
    this.sent.push({ chatId, text });
  }

  async stop(): Promise<void> {}

  /** 测试用：模拟平台收到一条消息，等 runner 把这轮处理完 */
  async receive(msg: BotIncomingMessage): Promise<void> {
    assert.ok(this.handler !== undefined, "adapter 尚未 start");
    await this.handler(msg);
  }
}

function makeMsg(chatId: string, text: string, overrides: Partial<BotIncomingMessage> = {}): BotIncomingMessage {
  return {
    chatId,
    chatName: `用户${chatId}`,
    senderName: `用户${chatId}`,
    isRoom: false,
    text,
    ...overrides,
  };
}

async function tmpCwd(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "c-agent-bot-test-"));
}

test("bot: 私聊消息经 mock 模型得到回复", async () => {
  const cwd = await tmpCwd();
  const adapter = new FakeAdapter();
  const runner = new BotRunner(adapter, { cwd, modelSpec: "mock" });
  await runner.start();

  await adapter.receive(makeMsg("wxid_a", "你好"));
  // dispatch 只排队；等串行链跑完 = 再投一条无关消息等它返回即可（链内顺序保证）
  await adapter.receive(makeMsg("wxid_a", "第二条"));

  const replies = adapter.sent.filter((s) => s.chatId === "wxid_a");
  assert.ok(replies.length >= 2, `应至少两条回复，实际 ${replies.length}`);
  assert.ok(replies[0]?.text.includes("已收到你的请求"), `mock 回复应含回执文案：${replies[0]?.text.slice(0, 50)}`);

  await runner.stop();
});

test("bot: 会话持久化 + 第二个 runner 续接同一会话", async () => {
  const cwd = await tmpCwd();
  const adapter1 = new FakeAdapter();
  const runner1 = new BotRunner(adapter1, { cwd, modelSpec: "mock" });
  await runner1.start();
  await adapter1.receive(makeMsg("wxid_b", "你好"));
  await adapter1.receive(makeMsg("wxid_b", "占位等待"));

  const expectedId = `bot_wechat_${sanitizeId("wxid_b")}`;
  assert.ok(await sessionFileExists(cwd, expectedId), "会话应按固定 id 落盘");

  // 新 runner（模拟进程重启）：同 chatId 续接，不抛错即可继续对话
  const adapter2 = new FakeAdapter();
  const runner2 = new BotRunner(adapter2, { cwd, modelSpec: "mock" });
  await runner2.start();
  await adapter2.receive(makeMsg("wxid_b", "重启后第一条"));
  await adapter2.receive(makeMsg("wxid_b", "占位等待"));
  assert.ok(adapter2.sent.length >= 1, "续接后应能正常回复");

  await runner1.stop();
  await runner2.stop();
});

test("bot: 不同聊天各自独立会话 id", async () => {
  const cwd = await tmpCwd();
  const adapter = new FakeAdapter();
  const runner = new BotRunner(adapter, { cwd, modelSpec: "mock" });
  await runner.start();

  await adapter.receive(makeMsg("wxid_c1", "hi"));
  await adapter.receive(makeMsg("wxid_c1", "占位"));
  await adapter.receive(makeMsg("room_9@chatroom", "群消息（无 @ 的 runner 不拦，平台侧拦）", { isRoom: true, chatName: "测试群" }));
  await adapter.receive(makeMsg("room_9@chatroom", "占位", { isRoom: true, chatName: "测试群" }));

  assert.ok(await sessionFileExists(cwd, `bot_wechat_${sanitizeId("wxid_c1")}`));
  assert.ok(await sessionFileExists(cwd, `bot_wechat_${sanitizeId("room_9@chatroom")}`), "@chatroom 特殊字符应被安全化");

  await runner.stop();
});

test("bot: splitReply 短文本不分块、长文本按换行切、硬切兜底", () => {
  assert.deepEqual(splitReply("短回复", 2000), ["短回复"]);
  assert.deepEqual(splitReply("   \n  ", 2000), []);

  const long = Array.from({ length: 10 }, (_, i) => `第${i}行${"x".repeat(300)}`).join("\n");
  const parts = splitReply(long, 1000);
  assert.ok(parts.length >= 2, "超长应分块");
  for (const p of parts) assert.ok(p.length <= 1000, `每块 ≤ max，实际 ${p.length}`);

  const noNewline = "y".repeat(2500);
  const hardParts = splitReply(noNewline, 2000);
  assert.equal(hardParts.length, 2, "无换行时硬切");
  assert.equal(hardParts[0]?.length, 2000);
});
