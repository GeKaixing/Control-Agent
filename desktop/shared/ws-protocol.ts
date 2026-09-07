/**
 * 独立 UI（remote-ui）与 agent host 之间的 WebSocket 协议。
 *
 * 帧格式：换行分隔 JSON（与 MCP / LSP 同风格）。
 *
 * 两个方向：
 *  - 下行（host → UI）：WireEvent 事件流 + RPC 响应 + hello 握手
 *  - 上行（UI → host）：RPC 请求，方法名与 `DesktopApi` 的方法一一对应，
 *    args 按位置排列（与 preload 的 ipcRenderer.invoke 传参一致）。
 *
 * 设计原则：渲染层代码（含 Composer）零改动——`WsApiClient` 实现 `DesktopApi`，
 * 赋给 `window.api`，其余组件感知不到自己跑在浏览器而不是 Electron 里。
 */

import type { InfoPayload, WireEvent } from "./api.js";

/** 上行 RPC 请求。method 取值见 `RpcMethod`。 */
export interface WsRpcRequest {
  kind: "rpc";
  /** 客户端自增 id，host 原样带回 */
  id: number;
  method: string;
  /** 位置参数，与 preload 里 invoke 的第二组参数一致 */
  args: unknown[];
}

export type WsClientMessage = WsRpcRequest;

/** RPC 成功响应。result 形状由 method 决定（与 IPC handler 返回值一致）。 */
export interface WsRpcResultOk {
  kind: "rpc_result";
  id: number;
  ok: true;
  result: unknown;
}

/** RPC 失败响应（handler 抛错 / 会话不存在 / 参数不合法）。 */
export interface WsRpcResultErr {
  kind: "rpc_result";
  id: number;
  ok: false;
  error: string;
}

/** 连接建立后 host 先推一条 hello，携带当前会话快照。 */
export interface WsHello {
  kind: "hello";
  info: InfoPayload;
}

/** host → UI 的事件广播（与 desktop-display connector 推给本地窗口的 WireEvent 相同）。 */
export interface WsEventBroadcast {
  kind: "event";
  event: WireEvent;
}

export type WsServerMessage = WsHello | WsEventBroadcast | WsRpcResultOk | WsRpcResultErr;

/** 序列化一帧（不含换行）。 */
export function encodeWsFrame(msg: WsClientMessage | WsServerMessage): string {
  return JSON.stringify(msg);
}

/**
 * 解析一行 JSON 为客户端消息。
 * 非法 JSON / 不是 rpc 请求时返回 error 字符串；合法返回消息对象。
 */
export function decodeWsClientFrame(line: string): { msg: WsRpcRequest } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { error: "invalid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null) return { error: "not an object" };
  const obj = parsed as Record<string, unknown>;
  if (obj.kind !== "rpc") return { error: `unknown kind: ${String(obj.kind)}` };
  if (typeof obj.id !== "number") return { error: "rpc.id must be number" };
  if (typeof obj.method !== "string") return { error: "rpc.method must be string" };
  if (!Array.isArray(obj.args)) return { error: "rpc.args must be array" };
  return {
    msg: { kind: "rpc", id: obj.id, method: obj.method, args: obj.args as unknown[] },
  };
}
