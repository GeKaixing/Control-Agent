/**
 * 会话 API 派发器：`DesktopApi` 方法名 → SessionManager 调用。
 *
 * 这是 IPC（本地窗口）与 WebSocket（独立 UI）共用的唯一实现——
 * 两条传输通道的 handler 都只是薄封装，业务逻辑（参数校验、错误包装）
 * 全部在这里，保证两个入口行为完全一致。
 *
 * method 命名与 `DesktopApi` 接口方法一一对应（见 shared/api.ts）。
 */

import type { Attachment, CustomModelParams, EndpointId, ReasoningLevel, RunMode } from "../shared/api.js";
import type { SessionManager } from "./session.js";

/** 派发器认识的全部方法名。 */
export type ApiMethodName =
  | "info"
  | "submit"
  | "steer"
  | "abort"
  | "answerAsk"
  | "setModel"
  | "setCustomModel"
  | "setMode"
  | "setReasoning"
  | "setEndpoint"
  | "planContinue"
  | "setApprovalMode"
  | "setAutoCompact"
  | "setMsgWindow"
  | "setLocalPreview"
  | "setAlwaysOnTop"
  | "pause"
  | "resume"
  | "getUsage"
  | "newSession"
  | "switchSession"
  | "switchTo"
  | "listSessions"
  | "listPersistedSessions"
  | "deleteSession"
  | "listFiles"
  | "listModels"
  | "listCustomModels";

/**
 * 调用一个会话 API。
 *
 * 返回值形状与原 ipcMain.handle 的各 handler 返回值一致（submit 返回
 * `{ok, error?}` 等）。派发器内部不抛错——所有异常都转成 rejected promise
 * 由传输层决定怎么呈现（IPC → invoke reject；WS → rpc_result ok:false）。
 */
export async function dispatchApi(
  session: SessionManager,
  method: string,
  args: readonly unknown[],
): Promise<unknown> {
  switch (method) {
    case "info":
      return session.info();
    case "submit": {
      const text = args[0];
      if (typeof text !== "string") return { ok: false, error: "非字符串输入" };
      const attachments = args[1];
      const safeAttachments: Attachment[] = Array.isArray(attachments)
        ? (attachments as Attachment[])
        : [];
      try {
        await session.submit(text, safeAttachments);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    case "steer": {
      const text = args[0];
      session.steer(typeof text === "string" ? text : "");
      return undefined;
    }
    case "abort":
      session.abort();
      return undefined;
    case "answerAsk": {
      const id = args[0];
      const answer = args[1];
      // 参数不合规静默丢弃（问答卡是临时 UI，迟到/坏帧不值得报错打扰用户）
      if (typeof id !== "string" || id.length === 0) return undefined;
      session.answerAsk(id, typeof answer === "string" ? answer : "");
      return undefined;
    }
    case "setModel": {
      const spec = args[0];
      if (typeof spec !== "string" || spec.length === 0) return { model: "" };
      return session.setModel(spec);
    }
    case "setCustomModel": {
      const raw = args[0] as Partial<CustomModelParams> | undefined;
      if (raw === null || typeof raw !== "object") return { model: "" };
      return session.setCustomModel({
        baseURL: typeof raw.baseURL === "string" ? raw.baseURL : "",
        apiKey: typeof raw.apiKey === "string" ? raw.apiKey : "",
        model: typeof raw.model === "string" ? raw.model : "",
        // 协议与上下文窗口覆写可选透传（弹窗里可能不填）；写死只会丢字段
        ...(typeof raw.protocol === "string" ? { protocol: raw.protocol as CustomModelParams["protocol"] } : {}),
        ...(typeof raw.contextWindow === "string" ? { contextWindow: raw.contextWindow } : {}),
      });
    }
    case "setMode": {
      session.setMode(args[0] as RunMode);
      return undefined;
    }
    case "setReasoning": {
      session.setReasoning(args[0] as ReasoningLevel);
      return undefined;
    }
    case "setEndpoint":
      return session.setEndpoint(args[0] as EndpointId);
    case "planContinue":
      await session.planContinue();
      return undefined;
    case "setApprovalMode": {
      session.setApprovalMode(args[0] === true);
      return undefined;
    }
    case "setAutoCompact": {
      session.setAutoCompact(args[0] === true);
      return undefined;
    }
    case "setMsgWindow": {
      // 只更新偏好；窗口的实际创建/销毁在 index.ts 的 IPC handler 里做
      // （dispatcher 是纯逻辑层，不能碰 BrowserWindow）
      session.setMsgWindow(args[0] === true);
      return undefined;
    }
    case "setLocalPreview": {
      session.setLocalPreview(args[0] === true);
      return undefined;
    }
    case "setAlwaysOnTop": {
      // 只更新偏好；窗口的实际置顶/取消在 index.ts 的 IPC handler 里做
      // （dispatcher 是纯逻辑层，不能碰 BrowserWindow）
      session.setAlwaysOnTop(args[0] === true);
      return undefined;
    }
    case "pause":
      session.pause();
      return undefined;
    case "resume":
      session.resume();
      return undefined;
    case "getUsage":
      return session.usage();
    case "newSession":
      session.newSession();
      return undefined;
    case "switchSession": {
      const delta = args[0];
      return session.switchSession(typeof delta === "number" ? delta : 0);
    }
    case "switchTo": {
      const index = args[0];
      return session.switchTo(typeof index === "number" ? index : Number.NaN);
    }
    case "listSessions":
      return session.listSessions();
    case "listPersistedSessions":
      return session.listPersistedSessions();
    case "deleteSession": {
      const id = args[0];
      if (typeof id !== "string" || id.length === 0) {
        return { ok: false, error: "缺少会话 id" };
      }
      return session.deletePersistedSession(id);
    }
    case "listFiles": {
      const query = args[0];
      return session.listFiles(typeof query === "string" ? query : "");
    }
    case "listModels": {
      const endpoint = args[0] as EndpointId | undefined;
      const refresh = args[1];
      return session.listModels(endpoint ?? "mock", refresh === true);
    }
    case "listCustomModels": {
      const raw = args[0] as Partial<CustomModelParams> | undefined;
      if (raw === null || typeof raw !== "object") {
        return { endpoint: "openai", url: "", models: [], error: "参数缺失" };
      }
      return session.listCustomModels({
        baseURL: typeof raw.baseURL === "string" ? raw.baseURL : "",
        apiKey: typeof raw.apiKey === "string" ? raw.apiKey : undefined,
        ...(typeof raw.protocol === "string"
          ? { protocol: raw.protocol as CustomModelParams["protocol"] }
          : {}),
      });
    }
    default:
      throw new Error(`未知方法: ${method}`);
  }
}
