# bot/ — 聊天平台机器人

把 Control-Agent 接进聊天软件：用户在微信里发消息，agent 在后台跑，回复原样发回聊天窗口。

## 分层

```
weixin.ts（平台壳：iLink 协议 / 扫码登录 / 长轮询 / 白名单）
    │  BotAdapter 接口（types.ts）
    ▼
runner.ts（平台无关：per-chat 会话 + Agent 驱动 + 回复分块）
    │  复用 assembleSession / Agent / createPrintOutput / sessions 持久化
    ▼
agent/ + context/ + providers/（核心，原样复用）
```

换平台（飞书 / Telegram / Slack）= 新写一个 `BotAdapter` 实现 + 一个入口文件，
runner 与会话管理不动。参考 `weixin.ts` 的形状即可。

## 微信通道：腾讯 iLink Bot API

`weixin.ts` 的协议实现逐条对齐 hermes-agent 的 `gateway/platforms/weixin.py`
（https://github.com/NousResearch/hermes-agent）。这是微信官方给个人号 bot 开的
iLink 通道（`ilinkai.weixin.qq.com`），**不是** Web 微信协议的自动化野路子：
官方接口、扫码登录、长轮询收信，没有 wechaty 路线的封号与老账号限制。

已移植的协议行为：

- **扫码登录**（`qr_login` 状态机）：`get_bot_qrcode` 出码（必须扫
  `qrcode_img_content` 的 liteapp 链接）→ 轮询 `get_qrcode_status`
  （wait / scaned / `scaned_but_redirect` 换 base_url / expired 刷新 3 次 / confirmed），
  凭据（bot_token + base_url + account_id）存 `.c-agent/weixin/accounts/`（0600）。
- **长轮询 getupdates**：`sync_buf` 游标落盘断点续收；`longpolling_timeout_ms`
  自适应；errcode -14 会话过期歇 10 分钟；-2 限流退避；连续失败 backoff。
- **context_token 磁盘缓存**：iLink 要求回复 echo 对端最新 context_token，
  按 account+peer 存 `<account>.context-tokens.json`，重启可续；发送时若报会话过期，
  去掉 context_token 降级重试一次。
- **双重去重**：message_id（TTL 5min，挡游标回退重投递）+ 内容 md5 指纹（TTL 15s，
  只挡上游秒级重发同文——窗口故意短，避免吞掉用户在窗口内连发的同文提问）。
- **引用展开**：ref_msg 的引用文本/媒体标题并入正文前缀。

v1 未移植（需要时从 hermes weixin.py 继续）：媒体收发（AES-128-ECB CDN）、
typing 指示器、入站文本 batch 合并、群聊投递（iLink bot 身份通常进不了普通群，
hermes 原版同样注明此为平台限制）。

## 会话模型

- 每个聊天（私聊联系人 / 群）一套独立上下文：`state + queue + stream`。
- 会话 id 固定为 `bot_<platform>_<sanitized chatId>`（字符做文件名安全化，
  有极小碰撞可能，v1 接受），落 `.c-agent/sessions/`，进程重启自动续聊。
- 同聊天消息串行（per-chat promise 链）；运行中的新消息走 followUps 队列，
  由 Agent 外层循环在同一个 run 内合并（与 CLI 中途插话同语义）。
- 跨聊天并发：不同 chatId 的 run 互不阻塞。

## 安全默认值（为什么默认 answer_only）

聊天窗口是远程输入面：任何能给你发消息的人都能往模型里塞指令。
默认 `answer_only`（模型看不到任何工具）；`--mode full` 显式放开后，
聊天消息可以直接驱动 read/write/bash——**不要在白名单全开的模式下用 full**。

## 已知边界（v1）

- 只处理文本消息（图片 / 文件 / 语音不回）。
- 只支持私聊；群聊投递受 iLink 平台限制（bot 身份进不了普通群）。
- 测试覆盖协议纯函数与磁盘状态（`tests/bot-weixin.ts`）；真实收发需扫码联调。
