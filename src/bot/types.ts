/**
 * Bot 模块共享类型：平台适配器与运行器之间的契约。
 *
 * 分层（与 hermes-agent 的 gateway 思路一致）：
 *   adapter（wechat.ts 等平台壳）只做协议翻译：登录、收消息、发消息；
 *   runner（runner.ts）只做 agent 驱动：per-chat 会话、上下文隔离、回复收集。
 * 换平台 = 换一个 BotAdapter 实现，runner 不动。
 */

/** 平台投递给 runner 的入站消息（已做平台侧清洗：@ 前缀去除、非文本过滤） */
export interface BotIncomingMessage {
  /** 平台内稳定且唯一的会话标识：私聊 = 联系人 id，群聊 = 群 id */
  chatId: string;
  /** 展示名：私聊 = 昵称/备注，群聊 = 群名（仅用于日志与白名单匹配） */
  chatName: string;
  /** 实际发言者显示名（群聊里区分谁在说话；私聊与 chatName 基本相同） */
  senderName: string;
  /** true = 群聊消息 */
  isRoom: boolean;
  /** 清洗后的消息正文 */
  text: string;
}

/** 平台适配器：一个聊天平台一个实现 */
export interface BotAdapter {
  /** 平台标识，同时用于会话 id 前缀（bot_<platform>_<chatId>），用 [a-z0-9-] */
  readonly platform: string;
  /**
   * 启动平台连接（登录 / 长轮询 / 事件订阅），就绪后 resolve。
   * 之后所有入站消息经 onMessage 投递给 runner；adapter 不等待其返回。
   */
  start(onMessage: (msg: BotIncomingMessage) => void | Promise<void>): Promise<void>;
  /** 向指定会话发送一条文本 */
  sendText(chatId: string, text: string): Promise<void>;
  /** 优雅下线（登出 / 断开长连接） */
  stop(): Promise<void>;
}
