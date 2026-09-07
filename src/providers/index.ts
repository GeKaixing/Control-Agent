/**
 * 模型解析与分发：把 ModelRef 映射到具体的 StreamFn。
 * 缺少 API key 时降级为 mock，而不是直接抛错——保证任何环境都能启动。
 */

import type { ModelMaturity, ModelRef, ProviderId } from "../types.js";
import { anthropicDefaultModel, anthropicStream } from "./anthropic.js";
import { geminiDefaultModel, geminiStream } from "./gemini.js";
import { createMockStream, mockDefaultModel } from "./mock.js";
import { openaiDefaultModel, openaiStream } from "./openai.js";
import { lookupContextWindow, lookupVendor, VENDOR_PRESETS } from "./vendors.js";
import type { Provider, StreamFn } from "./types.js";

const providers: Record<ProviderId, () => Provider> = {
  openai: () => ({ id: "openai", stream: openaiStream }),
  anthropic: () => ({ id: "anthropic", stream: anthropicStream }),
  gemini: () => ({ id: "gemini", stream: geminiStream }),
  mock: () => ({ id: "mock", stream: createMockStream() }),
  // 厂商预设全是 OpenAI 兼容协议：同一个 openaiStream，差异只在 ModelRef 的 baseUrl / apiKey
  deepseek: () => ({ id: "deepseek", stream: openaiStream }),
  moonshot: () => ({ id: "moonshot", stream: openaiStream }),
  zhipu: () => ({ id: "zhipu", stream: openaiStream }),
  dashscope: () => ({ id: "dashscope", stream: openaiStream }),
  openrouter: () => ({ id: "openrouter", stream: openaiStream }),
  ollama: () => ({ id: "ollama", stream: openaiStream }),
};

export interface ResolvedModel {
  model: ModelRef;
  stream: StreamFn;
  /** 降级原因；正常为 undefined */
  degraded?: string;
}

export function resolveModel(model: ModelRef): ResolvedModel {
  const hasKey = (model.apiKey ?? "").length > 0;
  // Context 支柱：窗口粗表在这里统一填充（所有解析路径的咽喉）——
  // CLI 没有元数据来源，靠它拿到合理预算；调用方有更准的值可预先填在
  // ModelRef 上（?? 短路），或像桌面端一样用显式 transform 覆写。
  const withWindow: ModelRef =
    model.contextWindow !== undefined ? model : { ...model, contextWindow: lookupContextWindow(model.id) };
  if (model.provider !== "mock" && !hasKey) {
    return {
      model: withWindow,
      stream: providers["mock"]().stream,
      degraded: `未配置 ${model.provider.toUpperCase()}_API_KEY，已降级为 mock 模型`,
    };
  }
  return { model: withWindow, stream: providers[model.provider]().stream };
}

/** 解析 "openai:gpt-4o-mini" / "deepseek:deepseek-chat" 或末段 ":strong"/":budget" 档位写法 */
export function parseModelSpec(spec: string): ModelRef {
  const [rawProvider, ...rest] = spec.split(":");
  const id = rest.join(":").trim();
  const provider = (rawProvider ?? "").trim().toLowerCase();

  // 末段 :strong / :budget 是档位标记，不是模型 id 的一部分
  let maturity: ModelMaturity | undefined;
  const segments = id.split(":");
  const last = segments[segments.length - 1]?.trim().toLowerCase();
  if (segments.length > 1 && (last === "strong" || last === "budget")) {
    maturity = last;
    segments.pop();
  }
  const modelId = segments.join(":").trim();

  // 厂商预设（vendors.ts）：OpenAI 兼容协议，差异只在 baseUrl / key env
  const vendor = lookupVendor(provider);
  if (vendor !== undefined) {
    return {
      provider: vendor.id,
      id: modelId.length > 0 ? modelId : vendor.defaultModel,
      baseUrl: process.env[vendor.baseUrlEnv] ?? vendor.baseUrl,
      apiKey: vendor.noKey === true ? "ollama-local" : process.env[vendor.apiKeyEnv],
      maturity,
    };
  }
  if (provider === "openai") {
    return {
      ...openaiDefaultModel(),
      id: modelId.length > 0 ? modelId : openaiDefaultModel().id,
      maturity,
    };
  }
  if (provider === "anthropic") {
    return {
      ...anthropicDefaultModel(),
      id: modelId.length > 0 ? modelId : anthropicDefaultModel().id,
      maturity,
    };
  }
  if (provider === "gemini") {
    return {
      provider: "gemini",
      id: modelId.length > 0 ? modelId : geminiDefaultModel().id,
      baseUrl: process.env["GEMINI_BASE_URL"] ?? geminiDefaultModel().baseUrl,
      apiKey: process.env["GEMINI_API_KEY"] ?? process.env["GOOGLE_API_KEY"],
      maturity,
    };
  }
  if (provider === "mock") {
    return { ...mockDefaultModel(), id: modelId.length > 0 ? modelId : "mock-1", maturity };
  }
  return {
    provider: "mock",
    id: spec.length > 0 ? modelId : "mock-1",
    maturity,
  };
}

/** 按环境变量挑选默认模型：有 key 用真模型，否则 mock。MODEL 支持 "id:strong" 档位后缀 */
export function defaultModel(): ModelRef {
  const explicit = process.env["MODEL"];
  const envMaturity = parseMaturitySuffix(explicit);
  const envId = envMaturity ? stripMaturitySuffix(explicit) : explicit;
  if ((process.env["OPENAI_API_KEY"] ?? "").length > 0) {
    return { ...openaiDefaultModel(), id: envId ?? openaiDefaultModel().id, maturity: envMaturity };
  }
  if ((process.env["ANTHROPIC_API_KEY"] ?? "").length > 0) {
    return {
      ...anthropicDefaultModel(),
      id: envId ?? anthropicDefaultModel().id,
      maturity: envMaturity,
    };
  }
  return { ...mockDefaultModel(), maturity: envMaturity };
}

const MATURITY_RE = /:(strong|budget)$/;

function parseMaturitySuffix(spec: string | undefined): ModelMaturity | undefined {
  if (spec === undefined) return undefined;
  return (spec.match(MATURITY_RE)?.[1] as ModelMaturity | undefined) ?? undefined;
}

function stripMaturitySuffix(spec: string | undefined): string | undefined {
  return spec?.replace(MATURITY_RE, "");
}

export {
  openaiStream,
  anthropicStream,
  geminiStream,
  createMockStream,
  openaiDefaultModel,
  anthropicDefaultModel,
  geminiDefaultModel,
  mockDefaultModel,
  lookupContextWindow,
  VENDOR_PRESETS,
  lookupVendor,
};
export type { VendorPreset } from "./vendors.js";
export type { Provider, StreamFn };
