/**
 * 模型解析与分发：把 ModelRef 映射到具体的 StreamFn。
 * 缺少 API key 时降级为 mock，而不是直接抛错——保证任何环境都能启动。
 */

import type { ModelRef, ProviderId } from "../types.js";
import { anthropicDefaultModel, anthropicStream } from "./anthropic.js";
import { createMockStream, mockDefaultModel } from "./mock.js";
import { openaiDefaultModel, openaiStream } from "./openai.js";
import type { Provider, StreamFn } from "./types.js";

const providers: Record<ProviderId, () => Provider> = {
  openai: () => ({ id: "openai", stream: openaiStream }),
  anthropic: () => ({ id: "anthropic", stream: anthropicStream }),
  mock: () => ({ id: "mock", stream: createMockStream() }),
};

export interface ResolvedModel {
  model: ModelRef;
  stream: StreamFn;
  /** 降级原因；正常为 undefined */
  degraded?: string;
}

export function resolveModel(model: ModelRef): ResolvedModel {
  const hasKey = (model.apiKey ?? "").length > 0;
  if (model.provider !== "mock" && !hasKey) {
    return {
      model,
      stream: providers["mock"]().stream,
      degraded: `未配置 ${model.provider.toUpperCase()}_API_KEY，已降级为 mock 模型`,
    };
  }
  return { model, stream: providers[model.provider]().stream };
}

/** 解析 "openai:gpt-4o-mini" 这类写法 */
export function parseModelSpec(spec: string): ModelRef {
  const [rawProvider, ...rest] = spec.split(":");
  const id = rest.join(":").trim();
  const provider = (rawProvider ?? "").trim().toLowerCase();

  if (provider === "openai") {
    return { ...openaiDefaultModel(), id: id.length > 0 ? id : openaiDefaultModel().id };
  }
  if (provider === "anthropic") {
    return {
      ...anthropicDefaultModel(),
      id: id.length > 0 ? id : anthropicDefaultModel().id,
    };
  }
  if (provider === "mock") {
    return { ...mockDefaultModel(), id: id.length > 0 ? id : "mock-1" };
  }
  return { provider: "mock", id: spec.length > 0 ? spec : "mock-1" };
}

/** 按环境变量挑选默认模型：有 key 用真模型，否则 mock */
export function defaultModel(): ModelRef {
  const explicit = process.env["MODEL"];
  if ((process.env["OPENAI_API_KEY"] ?? "").length > 0) {
    return { ...openaiDefaultModel(), id: explicit ?? openaiDefaultModel().id };
  }
  if ((process.env["ANTHROPIC_API_KEY"] ?? "").length > 0) {
    return {
      ...anthropicDefaultModel(),
      id: explicit ?? anthropicDefaultModel().id,
    };
  }
  return mockDefaultModel();
}

export { openaiStream, anthropicStream, createMockStream };
export type { Provider, StreamFn };
