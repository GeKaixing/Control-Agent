#!/usr/bin/env node
/**
 * 微信 bot 入口：腾讯 iLink Bot API 适配器 + CLI。
 *
 * 协议实现逐条对齐 hermes-agent 的 gateway/platforms/weixin.py（Python 原版）：
 * https://github.com/NousResearch/hermes-agent —— 这是微信官方给个人号 bot 开的
 * iLink 通道（ilinkai.weixin.qq.com），不是 wechaty 那类 Web 协议野路子：
 * 官方接口、扫码登录、长轮询收信、回复必须 echo 对端的 context_token。
 *
 * 已移植的协议行为（与原版一致）：
 *   - qr_login 状态机（wait / scaned / scaned_but_redirect 换 base_url / expired 刷新 3 次 / confirmed）
 *   - getupdates 长轮询：sync_buf 游标落盘、longpolling_timeout_ms 自适应、
 *     errcode -14 会话过期歇 10 分钟、-2 限流退避、连续失败 backoff
 *   - context_token 磁盘缓存（account+peer 粒度，重启可续）
 *   - 双重去重：message_id（TTL 5min，挡游标回退重投递）+ 内容指纹（TTL 15s，
 *     只挡上游秒级重发同文，不吞用户窗口外的重复提问）
 *   - sendmessage：session 过期时去掉 context_token 降级重试一次
 *   - 引用消息展开（ref_msg）进正文
 * v1 未移植：媒体收发（AES-ECB CDN 上传下载）、typing 指示器、文本 batch 合并。
 *
 * 用法：
 *   npm run bot:weixin                       # 首跑出二维码，微信扫码
 *   npm run bot:weixin -- --allow "张三"      # 白名单（可选）
 *   npm run bot:weixin -- --mode full        # 放开工具（默认 answer_only）
 *   npm run bot:weixin -- --login            # 忽略已存凭据，重新扫码
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, migrateDataDir } from "../paths.js";

import qrcodeTerminal from "qrcode-terminal";

import type { BotAdapter, BotIncomingMessage } from "./types.js";

// ============ 协议常量（对齐 weixin.py） ============

const ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";
const ILINK_APP_ID = "bot";
const CHANNEL_VERSION = "2.2.0";
/** (2 << 16) | (2 << 8) | 0 —— Python 侧的 ILINK_APP_CLIENT_VERSION */
const ILINK_APP_CLIENT_VERSION = String((2 << 16) | (2 << 8) | 0);
const EP_GET_UPDATES = "ilink/bot/getupdates";
const EP_SEND_MESSAGE = "ilink/bot/sendmessage";
const EP_GET_BOT_QR = "ilink/bot/get_bot_qrcode";
const EP_GET_QR_STATUS = "ilink/bot/get_qrcode_status";
const LONG_POLL_TIMEOUT_MS = 35_000;
const API_TIMEOUT_MS = 15_000;
const QR_TIMEOUT_MS = 35_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const RETRY_DELAY_SECONDS = 2;
const BACKOFF_DELAY_SECONDS = 30;
/** errcode -14 = 会话过期；-2 = 限流（配合 errmsg "unknown error" 也是过期信号） */
const SESSION_EXPIRED_ERRCODE = -14;
const RATE_LIMIT_ERRCODE = -2;
const MSG_TYPE_BOT = 2;
const MSG_STATE_FINISH = 2;
const ITEM_TEXT = 1;
const ITEM_IMAGE = 2;
const ITEM_VOICE = 3;
const ITEM_FILE = 4;
const ITEM_VIDEO = 5;

/** message_id 去重 TTL：同一 id 的重投递（游标回退）可能隔几分钟才到，保持放宽 */
export const MESSAGE_ID_DEDUP_TTL_MS = 300_000;
/**
 * 内容指纹去重 TTL：只为挡「上游用新 message_id 秒级重发同文」——长轮询批次内
 * 重发是毫秒级、跨批是秒级，15s 足够。**别调大**：调到分钟级会把用户在窗口内
 * 重复发的同文静默吞掉（真实案例：连发两次「模拟模型失败」测错误链路，第二条
 * 石沉大海、无任何回复）。
 */
export const CONTENT_DEDUP_TTL_MS = 15_000;

// ============ 协议层纯函数（测试覆盖这些） ============

export interface ILinkResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  [key: string]: unknown;
}

/** ret/errcode=-2 且 errmsg 是 "unknown error" 是过期信号，不是真限流（对齐 _is_stale_session_ret） */
export function isSessionExpired(resp: ILinkResponse): boolean {
  const ret = resp.ret;
  const errcode = resp.errcode;
  if (SESSION_EXPIRED_ERRCODE === ret || SESSION_EXPIRED_ERRCODE === errcode) return true;
  const staleRateLimit = (ret === RATE_LIMIT_ERRCODE || errcode === RATE_LIMIT_ERRCODE)
    && (resp.errmsg ?? "").toLowerCase() === "unknown error";
  return staleRateLimit;
}

/** 群聊判定（对齐 _guess_chat_type）：有 room_id，或 bot 被单独 @ 到别的会话（msg_type=1） */
export function guessChatType(
  message: Record<string, unknown>,
  accountId: string,
): { chatType: "group" | "dm"; chatId: string } {
  const roomId = String(message.room_id ?? message.chat_room_id ?? "").trim();
  const toUserId = String(message.to_user_id ?? "").trim();
  if (roomId !== "" || (toUserId !== "" && accountId !== "" && toUserId !== accountId && message.msg_type === 1)) {
    return { chatType: "group", chatId: roomId || toUserId || String(message.from_user_id ?? "") };
  }
  return { chatType: "dm", chatId: String(message.from_user_id ?? "") };
}

/** 提取文本正文，引用消息展开为前缀（对齐 _extract_text 的文本/引用分支） */
export function extractText(itemList: Array<Record<string, unknown>> | undefined): string {
  if (!Array.isArray(itemList)) return "";
  for (const item of itemList) {
    if (item.type !== ITEM_TEXT) continue;
    const text = String((item.text_item as Record<string, unknown> | undefined)?.text ?? "");
    const ref = (item.ref_msg as Record<string, unknown> | undefined) ?? {};
    const refItem = (ref.message_item as Record<string, unknown> | undefined) ?? undefined;
    if (refItem !== undefined && [ITEM_IMAGE, ITEM_VIDEO, ITEM_FILE, ITEM_VOICE].includes(Number(refItem.type))) {
      const title = String(ref.title ?? "");
      return title !== "" ? `[引用媒体: ${title}]\n${text}`.trim() : `[引用媒体]\n${text}`.trim();
    }
    if (refItem !== undefined) {
      const parts = [String(ref.title ?? ""), extractText([refItem])].filter((p) => p !== "");
      return parts.length > 0 ? `[引用: ${parts.join(" | ")}]\n${text}`.trim() : text;
    }
    return text;
  }
  // 无文本项但有语音转写（且语音不带原始音频）时用腾讯的转写，标注来源
  for (const item of itemList) {
    if (item.type !== ITEM_VOICE) continue;
    const voiceItem = (item.voice_item as Record<string, unknown> | undefined) ?? {};
    const voiceText = String(voiceItem.text ?? "");
    const hasMedia = voiceItem.media !== undefined && voiceItem.media !== null;
    if (!hasMedia && voiceText !== "") return `[Voice transcription provided by Weixin]\n${voiceText}`;
  }
  return "";
}

/** 请求头（对齐 _headers）：随机 X-WECHAT-UIN + iLink 应用标识 + Bearer token */
export function ilinkHeaders(token: string | undefined, body?: string): Record<string, string> {
  const uin = randomBytes(4).readUInt32BE(0).toString();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": Buffer.from(uin, "utf-8").toString("base64"),
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": ILINK_APP_CLIENT_VERSION,
  };
  if (token !== undefined && token !== "") headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Length"] = String(Buffer.byteLength(body, "utf-8"));
  return headers;
}

/** sendmessage 的 msg 结构（对齐 _send_message / _send_items） */
export function buildTextMessage(
  to: string,
  text: string,
  contextToken: string | undefined,
  clientId: string,
): Record<string, unknown> {
  const message: Record<string, unknown> = {
    from_user_id: "",
    to_user_id: to,
    client_id: clientId,
    message_type: MSG_TYPE_BOT,
    message_state: MSG_STATE_FINISH,
    item_list: [{ type: ITEM_TEXT, text_item: { text } }],
  };
  if (contextToken !== undefined && contextToken !== "") message.context_token = contextToken;
  return message;
}

/**
 * 纯 TTL 去重：key 在 ttl 窗口内出现过 → true（不更新时间戳）；否则记下当前
 * 时间并返回 false。超过 1000 条时顺手清理过期项，防止无限增长。
 */
export function isDuplicateWithin(
  store: Map<string, number>,
  key: string,
  ttlMs: number,
  now: number,
): boolean {
  const seenAt = store.get(key);
  if (seenAt !== undefined && now - seenAt < ttlMs) return true;
  store.set(key, now);
  if (store.size > 1_000) {
    for (const [k, ts] of store) {
      if (now - ts >= ttlMs) store.delete(k);
    }
  }
  return false;
}

// ============ ContextTokenStore（对齐 ContextTokenStore：account+peer 磁盘缓存） ============

export class ContextTokenStore {
  private readonly cache = new Map<string, string>();

  constructor(private readonly rootDir: string) {
    fs.mkdirSync(rootDir, { recursive: true });
  }

  private static key(accountId: string, userId: string): string {
    return `${accountId}:${userId}`;
  }

  restore(accountId: string): void {
    const file = path.join(this.rootDir, `${sanitizeFile(accountId)}.context-tokens.json`);
    if (!fs.existsSync(file)) return;
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, string>;
      for (const [userId, token] of Object.entries(data)) {
        if (typeof token === "string" && token !== "") this.cache.set(ContextTokenStore.key(accountId, userId), token);
      }
    } catch {
      // 损坏就当没有，重新积累
    }
  }

  get(accountId: string, userId: string): string | undefined {
    return this.cache.get(ContextTokenStore.key(accountId, userId));
  }

  set(accountId: string, userId: string, token: string): void {
    this.cache.set(ContextTokenStore.key(accountId, userId), token);
    const prefix = `${accountId}:`;
    const payload: Record<string, string> = {};
    for (const [key, value] of this.cache) {
      if (key.startsWith(prefix)) payload[key.slice(prefix.length)] = value;
    }
    try {
      fs.writeFileSync(path.join(this.rootDir, `${sanitizeFile(accountId)}.context-tokens.json`), JSON.stringify(payload));
    } catch {
      // 持久化失败不致命：缓存仍在内存里
    }
  }

  drop(accountId: string, userId: string): void {
    this.cache.delete(ContextTokenStore.key(accountId, userId));
  }
}

function sanitizeFile(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_") || "default";
}

// ============ 适配器 ============

export interface WeixinAdapterOptions {
  /** iLink bot 的 account_id（扫码后获得，或 env WEIXIN_ACCOUNT_ID） */
  accountId?: string;
  /** bot token（env WEIXIN_TOKEN）；没有就走扫码 */
  token?: string;
  /** 白名单：sender id 或会话 id 精确匹配；省略 = 私聊全回 */
  allow?: ReadonlySet<string>;
  /** 凭据与游标的存储根目录；默认 <cwd>/.control-agent/weixin */
  stateDir?: string;
  /** true = 忽略已存凭据，强制重新扫码 */
  forceLogin?: boolean;
  log?: (line: string) => void;
}

interface ILinkAccount {
  account_id: string;
  token: string;
  base_url: string;
  user_id: string;
  saved_at: string;
}

export class WeixinAdapter implements BotAdapter {
  readonly platform = "weixin";

  private readonly allow: ReadonlySet<string> | undefined;
  private readonly log: (line: string) => void;
  private readonly stateDir: string;
  private readonly forceLogin: boolean;
  private accountId: string | undefined;
  private token: string | undefined;
  private baseUrl = ILINK_BASE_URL;
  private tokenStore: ContextTokenStore | undefined;
  private running = false;
  private readonly seenMessageIds = new Map<string, number>();
  private readonly seenContent = new Map<string, number>();

  constructor(opts: WeixinAdapterOptions = {}) {
    this.allow = opts.allow;
    this.log = opts.log ?? ((line) => console.log(line));
    // 默认 stateDir 挂迁移钩子：旧 .c-agent/weixin 凭据（免扫码登录态）先挪过来
    migrateDataDir(process.cwd());
    this.stateDir = opts.stateDir ?? path.join(process.cwd(), DATA_DIR, "weixin");
    this.forceLogin = opts.forceLogin ?? false;
    this.accountId = opts.accountId ?? process.env.WEIXIN_ACCOUNT_ID;
    this.token = opts.token ?? process.env.WEIXIN_TOKEN;
  }

  // ---- 凭据存取（对齐 save/load_weixin_account） ----

  private accountFile(): string {
    return path.join(this.stateDir, "accounts", `${sanitizeFile(this.accountId ?? "default")}.json`);
  }

  private loadAccount(): ILinkAccount | undefined {
    try {
      const raw = fs.readFileSync(this.accountFile(), "utf-8");
      return JSON.parse(raw) as ILinkAccount;
    } catch {
      return undefined;
    }
  }

  private saveAccount(account: ILinkAccount): void {
    const file = this.accountFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(account, null, 2), { mode: 0o600 });
  }

  // ---- HTTP 底座（对齐 _api_get / _api_post） ----

  private async apiGet(endpoint: string, timeoutMs: number): Promise<ILinkResponse> {
    const response = await fetch(`${this.baseUrl}/${endpoint}`, {
      headers: ilinkHeaders(undefined),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`iLink GET ${endpoint} HTTP ${response.status}: ${raw.slice(0, 200)}`);
    return JSON.parse(raw) as ILinkResponse;
  }

  private async apiPost(endpoint: string, payload: Record<string, unknown>, timeoutMs: number): Promise<ILinkResponse> {
    const body = JSON.stringify({ ...payload, base_info: { channel_version: CHANNEL_VERSION } });
    const response = await fetch(`${this.baseUrl}/${endpoint}`, {
      method: "POST",
      headers: ilinkHeaders(this.token, body),
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`iLink POST ${endpoint} HTTP ${response.status}: ${raw.slice(0, 200)}`);
    return JSON.parse(raw) as ILinkResponse;
  }

  // ---- 扫码登录（对齐 qr_login 状态机） ----

  private async qrLogin(): Promise<ILinkAccount | undefined> {
    let qrcodeValue = "";
    let qrcodeUrl = "";
    const fetchQr = async (): Promise<void> => {
      const resp = await this.apiGet(`${EP_GET_BOT_QR}?bot_type=3`, QR_TIMEOUT_MS);
      qrcodeValue = String(resp.qrcode ?? "");
      qrcodeUrl = String(resp.qrcode_img_content ?? "");
    };

    try {
      await fetchQr();
    } catch (err) {
      this.log(`[weixin] 获取二维码失败：${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
    if (qrcodeValue === "") {
      this.log("[weixin] 二维码响应缺少 qrcode 字段");
      return undefined;
    }
    // 必须扫 qrcode_img_content（liteapp 链接），不是裸 hex token（对齐 _print_qr 注释）
    this.log("\n请使用微信扫描以下二维码：");
    if (qrcodeUrl !== "") console.log(qrcodeUrl);
    qrcodeTerminal.generate(qrcodeUrl !== "" ? qrcodeUrl : qrcodeValue, { small: true });

    const deadline = Date.now() + 480_000;
    let refreshCount = 0;
    while (Date.now() < deadline) {
      let statusResp: ILinkResponse;
      try {
        statusResp = await this.apiGet(`${EP_GET_QR_STATUS}?qrcode=${encodeURIComponent(qrcodeValue)}`, QR_TIMEOUT_MS);
      } catch (err) {
        if (!(err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError"))) {
          this.log(`[weixin] 二维码状态轮询出错：${err instanceof Error ? err.message : String(err)}`);
        }
        await sleep(1_000);
        continue;
      }
      const status = String(statusResp.status ?? "wait");
      if (status === "wait") {
        process.stdout.write(".");
      } else if (status === "scaned") {
        this.log("\n已扫码，请在微信里确认...");
      } else if (status === "scaned_but_redirect" && typeof statusResp.redirect_host === "string" && statusResp.redirect_host !== "") {
        this.baseUrl = `https://${statusResp.redirect_host}`;
      } else if (status === "expired") {
        refreshCount += 1;
        if (refreshCount > 3) {
          this.log("\n二维码多次过期，请重新执行登录。");
          return undefined;
        }
        this.log(`\n二维码已过期，正在刷新... (${refreshCount}/3)`);
        try {
          await fetchQr();
          qrcodeTerminal.generate(qrcodeUrl !== "" ? qrcodeUrl : qrcodeValue, { small: true });
        } catch (err) {
          this.log(`[weixin] 二维码刷新失败：${err instanceof Error ? err.message : String(err)}`);
          return undefined;
        }
      } else if (status === "confirmed") {
        const account: ILinkAccount = {
          account_id: String(statusResp.ilink_bot_id ?? ""),
          token: String(statusResp.bot_token ?? ""),
          base_url: String(statusResp.baseurl ?? ILINK_BASE_URL).replace(/\/$/, ""),
          user_id: String(statusResp.ilink_user_id ?? ""),
          saved_at: new Date().toISOString(),
        };
        if (account.account_id === "" || account.token === "") {
          this.log("[weixin] 扫码确认但凭据不完整");
          return undefined;
        }
        this.accountId = account.account_id;
        this.token = account.token;
        this.baseUrl = account.base_url;
        this.saveAccount(account);
        this.log(`\n微信连接成功，account_id=${account.account_id}`);
        return account;
      }
      await sleep(1_000);
    }
    this.log("\n微信登录超时。");
    return undefined;
  }

  // ---- BotAdapter 接口 ----

  async start(onMessage: (msg: BotIncomingMessage) => void | Promise<void>): Promise<void> {
    let account: ILinkAccount | undefined;
    if (!this.forceLogin && this.token === undefined) account = this.loadAccount();
    if (this.forceLogin || (account === undefined && this.token === undefined)) {
      account = await this.qrLogin();
      if (account === undefined) throw new Error("微信登录失败（扫码未完成）");
    }
    if (account !== undefined && this.token === undefined) {
      this.token = account.token;
      this.baseUrl = account.base_url;
      if (this.accountId === undefined) this.accountId = account.account_id;
    }
    if (this.accountId === undefined) this.accountId = "default";
    if (this.token === undefined || this.token === "") throw new Error("缺少 iLink bot token（扫码登录或设置 WEIXIN_TOKEN）");

    this.tokenStore = new ContextTokenStore(this.stateDir);
    this.tokenStore.restore(this.accountId);
    this.running = true;
    void this.pollLoop(onMessage);
  }

  async sendText(chatId: string, text: string): Promise<void> {
    if (this.token === undefined || this.token === "") {
      this.log("[weixin] 未连接，无法发送");
      return;
    }
    const trimmed = text.trim();
    if (trimmed === "") return;
    const contextToken = this.tokenStore?.get(this.accountId ?? "", chatId);
    let tokenUsed = contextToken;
    let retriedWithoutToken = false;
    for (let attempt = 0; attempt <= 4; attempt++) {
      try {
        const resp = await this.apiPost(
          EP_SEND_MESSAGE,
          { msg: buildTextMessage(chatId, trimmed, tokenUsed, `control-agent-weixin-${randomUUID()}`) },
          API_TIMEOUT_MS,
        );
        const ret = resp.ret;
        const errcode = resp.errcode;
        if ((ret !== undefined && ret !== 0) || (errcode !== undefined && errcode !== 0)) {
          if (isSessionExpired(resp) && !retriedWithoutToken && tokenUsed !== undefined) {
            // 对齐 _send_text_chunk：过期时去掉 context_token 降级重试一次
            retriedWithoutToken = true;
            tokenUsed = undefined;
            this.tokenStore?.drop(this.accountId ?? "", chatId);
            this.log(`[weixin] ${chatId} 会话过期，去掉 context_token 重试`);
            continue;
          }
          if (ret !== RATE_LIMIT_ERRCODE && errcode !== RATE_LIMIT_ERRCODE) {
            throw new Error(`iLink sendmessage 错误：ret=${ret} errcode=${errcode} errmsg=${resp.errmsg ?? resp.msg ?? "unknown"}`);
          }
          // 限流：退避后重试（3 倍间隔，对齐原版）
          const wait = 3_000 * (attempt + 1);
          this.log(`[weixin] 发往 ${chatId} 被限流，${wait / 1000}s 后重试（${attempt + 1}/4）`);
          await sleep(wait);
          continue;
        }
        return;
      } catch (err) {
        if (attempt >= 4) throw err;
        const wait = 1_000 * (attempt + 1);
        this.log(`[weixin] 发送失败（${attempt + 1}/4）：${err instanceof Error ? err.message : String(err)}，${wait / 1000}s 后重试`);
        await sleep(wait);
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  // ---- 长轮询（对齐 _poll_loop） ----

  private async pollLoop(onMessage: (msg: BotIncomingMessage) => void | Promise<void>): Promise<void> {
    const syncFile = path.join(this.stateDir, `${sanitizeFile(this.accountId ?? "default")}.sync.json`);
    let syncBuf = loadSyncBuf(syncFile);
    let timeoutMs = LONG_POLL_TIMEOUT_MS;
    let consecutiveFailures = 0;

    while (this.running) {
      let response: ILinkResponse;
      try {
        try {
          response = await this.apiPost(EP_GET_UPDATES, { get_updates_buf: syncBuf }, timeoutMs);
        } catch (err) {
          if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
            // 长轮询超时 = 没有新消息，对齐 _get_updates 的 TimeoutError 分支
            response = { ret: 0, msgs: [], get_updates_buf: syncBuf };
          } else {
            throw err;
          }
        }
        const ret = response.ret;
        const errcode = response.errcode;
        if ((ret !== undefined && ret !== 0) || (errcode !== undefined && errcode !== 0)) {
          if (isSessionExpired(response)) {
            this.log("[weixin] 会话过期，暂停 10 分钟后重试");
            await sleep(600_000);
            consecutiveFailures = 0;
            continue;
          }
          consecutiveFailures += 1;
          this.log(`[weixin] getUpdates 失败 ret=${ret} errcode=${errcode} errmsg=${response.errmsg ?? ""}（${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}）`);
          const waited = backoffSleep(consecutiveFailures);
          consecutiveFailures = waited === 0 ? 0 : consecutiveFailures;
          await sleep(waited);
          continue;
        }
        consecutiveFailures = 0;
        const suggested = response.longpolling_timeout_ms;
        if (typeof suggested === "number" && suggested > 0) timeoutMs = suggested;
        if (typeof response.get_updates_buf === "string" && response.get_updates_buf !== "") {
          syncBuf = response.get_updates_buf;
          saveSyncBuf(syncFile, syncBuf);
        }
        const msgs = Array.isArray(response.msgs) ? (response.msgs as Array<Record<string, unknown>>) : [];
        for (const message of msgs) {
          try {
            await this.processMessage(message, onMessage);
          } catch (err) {
            this.log(`[weixin] 消息处理失败：${err instanceof Error ? err.message : String(err)}`);
          }
        }
      } catch (err) {
        if (!this.running) break;
        consecutiveFailures += 1;
        this.log(`[weixin] 轮询出错（${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}）：${err instanceof Error ? err.message : String(err)}`);
        const streakDone = consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
        await sleep(streakDone ? BACKOFF_DELAY_SECONDS * 1000 : RETRY_DELAY_SECONDS * 1000);
        if (streakDone) consecutiveFailures = 0;
      }
    }
  }

  // ---- 入站消息（对齐 _process_message） ----

  private async processMessage(
    message: Record<string, unknown>,
    onMessage: (msg: BotIncomingMessage) => void | Promise<void>,
  ): Promise<void> {
    const accountId = this.accountId ?? "";
    const senderId = String(message.from_user_id ?? "").trim();
    const messageId = String(message.message_id ?? "").trim();
    if (senderId === "" || senderId === accountId) return;
    if (messageId !== "" && this.isDuplicate(this.seenMessageIds, messageId, MESSAGE_ID_DEDUP_TTL_MS)) return;

    const itemList = Array.isArray(message.item_list) ? (message.item_list as Array<Record<string, unknown>>) : [];
    const text = extractText(itemList).trim();
    // 内容指纹去重：上游会用新 message_id 重发同文（秒级窗口，见 CONTENT_DEDUP_TTL_MS）
    if (text !== "" && this.isDuplicate(this.seenContent, `content:${senderId}:${createHash("md5").update(text).digest("hex")}`, CONTENT_DEDUP_TTL_MS)) {
      this.log(`[weixin] ${senderId} 与 ${CONTENT_DEDUP_TTL_MS / 1000}s 内的上一条消息同文，按上游重发忽略`);
      return;
    }

    const { chatType, chatId } = guessChatType(message, accountId);
    // iLink bot 身份通常进不了普通群（对齐原版 connect() 里的警告），群消息默认不回
    if (chatType === "group") return;

    // 白名单：sender id 或会话 id 精确匹配
    if (this.allow !== undefined && this.allow.size > 0 && !this.allow.has(senderId) && !this.allow.has(chatId)) return;

    const contextToken = String(message.context_token ?? "").trim();
    if (contextToken !== "") this.tokenStore?.set(accountId, senderId, contextToken);

    if (text === "") return; // v1 不处理媒体
    await onMessage({
      chatId: senderId,
      chatName: senderId,
      senderName: senderId,
      isRoom: false,
      text,
    });
  }

  /** 带 TTL 的去重（对齐 MessageDeduplicator）；TTL 按 store 用途区分（见两个 *_DEDUP_TTL_MS 常量） */
  private isDuplicate(store: Map<string, number>, key: string, ttlMs: number): boolean {
    return isDuplicateWithin(store, key, ttlMs, Date.now());
  }
}

// ============ 小工具 ============

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 失败退避（对齐 _poll_loop 的 backoff）：未满一轮按短间隔，满一轮按长间隔并清零 */
function backoffSleep(consecutiveFailures: number): number {
  const streakDone = consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
  return streakDone ? BACKOFF_DELAY_SECONDS * 1000 : RETRY_DELAY_SECONDS * 1000;
}

function loadSyncBuf(file: string): string {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf-8")) as { get_updates_buf?: string };
    return typeof data.get_updates_buf === "string" ? data.get_updates_buf : "";
  } catch {
    return "";
  }
}

function saveSyncBuf(file: string, syncBuf: string): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ get_updates_buf: syncBuf }));
  } catch {
    // 游标保存失败只影响重启后的少量重复，不致命
  }
}

// ============ CLI ============

interface BotCliArgs {
  model: string | undefined;
  cwd: string | undefined;
  allow: string[];
  mode: "answer_only" | "plan" | "full";
  account: string | undefined;
  login: boolean;
  help: boolean;
}

function parseArgs(argv: readonly string[]): BotCliArgs {
  const args: BotCliArgs = { model: undefined, cwd: undefined, allow: [], mode: "answer_only", account: undefined, login: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    switch (a) {
      case "--model": args.model = argv[++i]; break;
      case "--cwd": args.cwd = argv[++i]; break;
      case "--allow": {
        const v = argv[++i] ?? "";
        args.allow.push(...v.split(",").map((s) => s.trim()).filter((s) => s.length > 0));
        break;
      }
      case "--mode": {
        const v = argv[++i];
        if (v === "plan" || v === "full" || v === "answer_only") args.mode = v;
        break;
      }
      case "--account": args.account = argv[++i]; break;
      case "--login": args.login = true; break;
      case "--help": case "-h": args.help = true; break;
      default: break;
    }
  }
  return args;
}

const HELP = [
  "用法：npm run bot:weixin -- [选项]",
  "",
  "微信 iLink Bot 通道（官方接口，协议对齐 hermes-agent 的 weixin 平台）。",
  "",
  "  --model <provider:id>  模型，如 openai:gpt-4o-mini（缺省走环境变量 → mock）",
  "  --cwd <dir>            agent 工作目录（默认当前目录）",
  "  --allow <id>[,id…]     白名单：sender/会话 id；缺省不限制",
  "  --mode <mode>          answer_only（默认，无工具）/ plan / full（放开本机工具，慎用）",
  "  --account <id>         iLink bot account_id（多账号时指定；缺省用已存凭据或扫码结果）",
  "  --login                忽略已存凭据，强制重新扫码",
  "  --help                 本帮助",
  "",
  "首跑会显示二维码，用微信扫码并在微信里确认即可；凭据存 .control-agent/weixin/，重启免扫码。",
].join("\n");

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }

  const adapter = new WeixinAdapter({
    ...(args.account !== undefined ? { accountId: args.account } : {}),
    ...(args.allow.length > 0 ? { allow: new Set(args.allow) } : {}),
    forceLogin: args.login,
  });
  const { BotRunner } = await import("./runner.js");
  const runner = new BotRunner(adapter, {
    cwd: path.resolve(args.cwd ?? process.cwd()),
    ...(args.model !== undefined ? { modelSpec: args.model } : {}),
    mode: args.mode,
  });

  const shutdown = (): void => {
    void runner.stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await runner.start();
}

/**
 * 只在「被直接执行」时起 bot（`tsx src/bot/weixin.ts` / `npm run bot:weixin`）。
 *
 * 不能像 src/index.ts 那样在模块作用域裸调 main()：本文件导出 WeixinAdapter
 * 供测试与复用，import 即执行会真的去扫码登录（打二维码 + 长轮询等确认），
 * 把 `npm test` 卡成等待人工扫码，最后以登录超时失败收场。
 *
 * 判定用 process.argv[1] 而不是 `import.meta.url === ...`：本文件同时被
 * 根 tsconfig（NodeNext，ESM）和 desktop/tsconfig.main.json（CommonJS）编译，
 * 后者的 include 覆盖到 ../src，写 import.meta 会直接编译失败。
 */
const isDirectRun = /[\\/]weixin\.(ts|js|mjs|cjs)$/.test(process.argv[1] ?? "");

if (isDirectRun) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack : err);
    process.exit(1);
  });
}
