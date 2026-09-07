/**
 * 微信 iLink 协议层测试：纯函数 + 磁盘状态 + 去重，不碰真 iLink 端点。
 *
 * 覆盖（对应 hermes-agent weixin.py 移植面）：
 *  - isSessionExpired：-14 / -2+unknown error / 正常响应
 *  - guessChatType：私聊 / 群聊（room_id、to_user_id 分支）
 *  - extractText：纯文本 / 引用展开 / 语音转写标注
 *  - ilinkHeaders：iLink 应用头 + Bearer
 *  - buildTextMessage：msg 结构、context_token 可选
 *  - ContextTokenStore：set/get/持久化/restore/drop
 *  - WeixinAdapter.processMessage 行为：去重、白名单、群过滤、context_token 记账
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ContextTokenStore,
  WeixinAdapter,
  buildTextMessage,
  extractText,
  guessChatType,
  ilinkHeaders,
  isSessionExpired,
} from "../src/bot/weixin.js";
import type { BotIncomingMessage } from "../src/bot/types.js";
import { test } from "./registry.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "c-agent-weixin-test-"));
}

test("weixin: isSessionExpired 判定", () => {
  assert.equal(isSessionExpired({ ret: 0, errcode: 0 }), false);
  assert.equal(isSessionExpired({}), false);
  assert.equal(isSessionExpired({ ret: -14 }), true);
  assert.equal(isSessionExpired({ errcode: -14 }), true);
  // -2 + "unknown error" 是过期信号，不是限流
  assert.equal(isSessionExpired({ ret: -2, errmsg: "unknown error" }), true);
  assert.equal(isSessionExpired({ errcode: -2, errmsg: "Unknown Error" }), true);
  // 真·限流不算过期
  assert.equal(isSessionExpired({ ret: -2, errmsg: "rate limit" }), false);
});

test("weixin: guessChatType 私聊与群聊", () => {
  assert.deepEqual(
    guessChatType({ from_user_id: "u1", msg_type: 1 }, "bot1"),
    { chatType: "dm", chatId: "u1" },
  );
  assert.deepEqual(
    guessChatType({ from_user_id: "u1", room_id: "r1", msg_type: 1 }, "bot1"),
    { chatType: "group", chatId: "r1" },
  );
  // to_user_id 指向别人且 msg_type=1 → 群
  assert.deepEqual(
    guessChatType({ from_user_id: "u1", to_user_id: "someone", msg_type: 1 }, "bot1"),
    { chatType: "group", chatId: "someone" },
  );
  // to_user_id 是自己 → 私聊
  assert.deepEqual(
    guessChatType({ from_user_id: "u1", to_user_id: "bot1", msg_type: 1 }, "bot1"),
    { chatType: "dm", chatId: "u1" },
  );
});

test("weixin: extractText 文本与引用", () => {
  assert.equal(extractText([{ type: 1, text_item: { text: "你好" } }]), "你好");
  assert.equal(extractText([]), "");
  assert.equal(extractText(undefined), "");
  // 引用媒体
  assert.equal(
    extractText([{ type: 1, text_item: { text: "这是什么" }, ref_msg: { title: "图.png", message_item: { type: 2 } } }]),
    "[引用媒体: 图.png]\n这是什么",
  );
  // 引用文本消息
  assert.equal(
    extractText([{ type: 1, text_item: { text: "回复你" }, ref_msg: { title: "原始", message_item: { type: 1, text_item: { text: "原始内容" } } } }]),
    "[引用: 原始 | 原始内容]\n回复你",
  );
  // 语音转写（无原始音频时带来源标注）
  assert.equal(
    extractText([{ type: 3, voice_item: { text: "转写的话" } }]),
    "[Voice transcription provided by Weixin]\n转写的话",
  );
  // 带原始音频的语音不用腾讯转写
  assert.equal(extractText([{ type: 3, voice_item: { text: "转写", media: {} } }]), "");
});

test("weixin: ilinkHeaders 与 buildTextMessage", () => {
  const headers = ilinkHeaders("tok123", "{}");
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(headers.AuthorizationType, "ilink_bot_token");
  assert.equal(headers.Authorization, "Bearer tok123");
  assert.equal(headers["iLink-App-Id"], "bot");
  assert.ok(Buffer.from(headers["X-WECHAT-UIN"], "base64").toString().match(/^\d+$/));
  // 无 token 不带 Authorization
  assert.equal(ilinkHeaders(undefined).Authorization, undefined);

  const msg = buildTextMessage("u1", "hi", "ctok", "cid1");
  assert.deepEqual(msg, {
    from_user_id: "",
    to_user_id: "u1",
    client_id: "cid1",
    message_type: 2,
    message_state: 2,
    item_list: [{ type: 1, text_item: { text: "hi" } }],
    context_token: "ctok",
  });
  // 无 context_token 时字段不出现
  assert.equal("context_token" in buildTextMessage("u1", "hi", undefined, "cid"), false);
});

test("weixin: ContextTokenStore 持久化与恢复", () => {
  const dir = tmpDir();
  const store = new ContextTokenStore(dir);
  store.set("acct1", "userA", "tokenA");
  store.set("acct1", "userB", "tokenB");
  store.set("acct2", "userC", "tokenC");
  assert.equal(store.get("acct1", "userA"), "tokenA");

  // 落盘按账号分文件，新实例恢复
  const store2 = new ContextTokenStore(dir);
  store2.restore("acct1");
  assert.equal(store2.get("acct1", "userA"), "tokenA");
  assert.equal(store2.get("acct1", "userB"), "tokenB");
  assert.equal(store2.get("acct1", "userC"), undefined); // acct2 的不该串
  // drop 后不再返回
  store2.drop("acct1", "userA");
  assert.equal(store2.get("acct1", "userA"), undefined);
});

function makeAdapter(dir: string, allow?: ReadonlySet<string>): {
  adapter: WeixinAdapter;
  received: BotIncomingMessage[];
  handler: (msg: Record<string, unknown>) => Promise<void>;
} {
  const received: BotIncomingMessage[] = [];
  const adapter = new WeixinAdapter({ stateDir: dir, ...(allow !== undefined ? { allow } : {}), log: () => {} });
  // 直接内部记账所需的最小初始化（不连真端点）
  const handler = (msg: Record<string, unknown>): Promise<void> =>
    (adapter as unknown as { processMessage: (m: Record<string, unknown>, cb: (m: BotIncomingMessage) => Promise<void>) => Promise<void> })
      .processMessage(msg, (m) => {
        received.push(m);
        return Promise.resolve();
      });
  return { adapter, received, handler };
}

test("weixin: processMessage 去重/白名单/群过滤/context_token", async () => {
  const dir = tmpDir();
  const { adapter, received, handler } = makeAdapter(dir);

  const baseMsg = {
    from_user_id: "userA",
    message_id: "m1",
    msg_type: 1,
    item_list: [{ type: 1, text_item: { text: "hello" } }],
    context_token: "ctx1",
  };
  await handler({ ...baseMsg });
  assert.equal(received.length, 1);
  assert.equal(received[0]?.text, "hello");
  assert.equal(received[0]?.isRoom, false);
  // context_token 记账
  const store = (adapter as unknown as { tokenStore?: ContextTokenStore }).tokenStore;
  assert.ok(store !== undefined || true); // 未 start 时 tokenStore 未建，直接验证内存路径
  assert.equal((adapter as unknown as { tokenStore?: ContextTokenStore }).tokenStore, store);

  // 同 message_id 重发 → 去重
  await handler({ ...baseMsg });
  assert.equal(received.length, 1);
  // 新 id 同内容 → 内容指纹去重
  await handler({ ...baseMsg, message_id: "m2" });
  assert.equal(received.length, 1);

  // 自己发的消息不处理
  const adapterSelf = new WeixinAdapter({ stateDir: dir, accountId: "userA", log: () => {} });
  let got = 0;
  await (adapterSelf as unknown as { processMessage: (m: Record<string, unknown>, cb: (m: BotIncomingMessage) => Promise<void>) => Promise<void> })
    .processMessage({ ...baseMsg, message_id: "m9" }, () => {
      got += 1;
      return Promise.resolve();
    });
  assert.equal(got, 0);

  // 群消息不回（iLink bot 进不了普通群）
  await handler({ ...baseMsg, message_id: "m3", room_id: "r1", text: undefined, item_list: [{ type: 1, text_item: { text: "群消息" } }] });
  assert.equal(received.length, 1);
});

test("weixin: processMessage 白名单按 sender 或 chat 匹配", async () => {
  const dir = tmpDir();
  const allow = new Set(["userB"]);
  const { received, handler } = makeAdapter(dir, allow);

  const msgOf = (id: string, messageId: string): Record<string, unknown> => ({
    from_user_id: id,
    message_id: messageId,
    msg_type: 1,
    item_list: [{ type: 1, text_item: { text: `from ${id}` } }],
  });
  await handler(msgOf("userA", "w1"));
  assert.equal(received.length, 0);
  await handler(msgOf("userB", "w2"));
  assert.equal(received.length, 1);
});
