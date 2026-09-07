/**
 * 厂商预设：OpenAI 兼容的知名模型厂商一键接入。
 *
 * spec 前缀（如 "deepseek:deepseek-chat"）命中本表 → parseModelSpec 产出带
 * baseUrl / apiKey 的 ModelRef，流式请求复用 openaiStream（都是 Chat Completions
 * 协议，只是 base URL 和 key env 不同）——不为每家厂商写一个适配器。
 *
 * 下方的 BASE_URL_PRESETS 是「自定义模型」弹层的接口地址预设（经
 * InfoPayload.baseUrlPresets 下发），不要在渲染层再抄一份。
 */

import type { ProviderId } from "../types.js";

export interface VendorPreset {
  /** spec 前缀，同时是 ModelRef.provider（如 "deepseek"） */
  id: Exclude<ProviderId, "openai" | "anthropic" | "mock">;
  /** 展示名（UI chips 用） */
  label: string;
  /** 默认 baseUrl：必须含版本段（openai.ts 拼 `${baseUrl}/chat/completions`） */
  baseUrl: string;
  /** 可用 env 覆盖 baseUrl（自建代理 / 中转场景） */
  baseUrlEnv: string;
  /** API key 的 env 名；缺 key 由 resolveModel 降级 mock 并按此名提示 */
  apiKeyEnv: string;
  /** 本地端点无需 key：parseModelSpec 填占位 key，避免被降级逻辑误伤 */
  noKey?: boolean;
  /** spec 只写前缀不写模型 id 时的默认模型（占位，用户可覆盖） */
  defaultModel: string;
  /** 别名前缀（"kimi:..." 等价 "moonshot:..."） */
  aliases?: string[];
}

export const VENDOR_PRESETS: VendorPreset[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    baseUrlEnv: "DEEPSEEK_BASE_URL",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    defaultModel: "deepseek-chat",
  },
  {
    id: "moonshot",
    label: "Moonshot Kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    baseUrlEnv: "MOONSHOT_BASE_URL",
    apiKeyEnv: "MOONSHOT_API_KEY",
    defaultModel: "kimi-k2-0905-preview",
    aliases: ["kimi"],
  },
  {
    id: "zhipu",
    label: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    baseUrlEnv: "ZHIPU_BASE_URL",
    apiKeyEnv: "ZHIPU_API_KEY",
    defaultModel: "glm-4.6",
    aliases: ["glm"],
  },
  {
    id: "dashscope",
    label: "阿里 Qwen",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    baseUrlEnv: "DASHSCOPE_BASE_URL",
    apiKeyEnv: "DASHSCOPE_API_KEY",
    defaultModel: "qwen-plus",
    aliases: ["qwen"],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    baseUrlEnv: "OPENROUTER_BASE_URL",
    apiKeyEnv: "OPENROUTER_API_KEY",
    defaultModel: "openai/gpt-4o-mini",
  },
  {
    id: "ollama",
    label: "Ollama（本地）",
    baseUrl: "http://localhost:11434/v1",
    baseUrlEnv: "OLLAMA_BASE_URL",
    apiKeyEnv: "OLLAMA_API_KEY",
    noKey: true,
    defaultModel: "qwen3",
  },
];

/** 按前缀查厂商（含别名）；不命中返回 undefined（走 openai/anthropic/mock 原有分支） */
export function lookupVendor(prefix: string): VendorPreset | undefined {
  const p = prefix.trim().toLowerCase();
  for (const v of VENDOR_PRESETS) {
    if (v.id === p || (v.aliases ?? []).includes(p)) return v;
  }
  return undefined;
}

// ────────────── 上下文窗口粗表（ModelRef.contextWindow 的缺省来源） ──────────────

/**
 * v1 上下文窗口粗表：按 model id 正则查。正路是提供商 /models 元数据
 * （桌面端已接）——粗表只为「CLI 无元数据来源时分母/预算永远有值」。
 * 用户定调：命中不上时回退 1M——大窗口时代宁可低估使用也不提前压缩：
 * 误判大只浪费安全余量（模型真超限会报错走 ×0.6 降档），误判小会白白
 * 丢历史、浪费真实窗口。已知的小窗口模型靠下面的条目精确覆盖。
 */
const CONTEXT_WINDOW_HINTS: Array<[RegExp, number]> = [
  [/gpt-4o-mini/i, 128000],
  [/gpt-4o/i, 128000],
  [/gpt-4-turbo/i, 128000],
  [/gpt-4/i, 8192],
  [/gpt-3\.5-turbo|o1-mini|o1-preview|o1/i, 128000],
  [/claude-3-5-sonnet|claude-3-7-sonnet|claude-3-opus|claude-3-sonnet/i, 200000],
  [/claude-3-haiku/i, 200000],
  [/claude-2/i, 100000],
  [/gemini-1\.5-pro/i, 1000000],
  [/gemini-1\.5-flash/i, 1000000],
  [/mimo/i, 1000000],
  [/mistral-large|mistral-medium/i, 128000],
  [/deepseek/i, 128000],
  [/kimi/i, 256000],
  [/mock/i, 32000],
];

export function lookupContextWindow(modelId: string): number {
  for (const [re, n] of CONTEXT_WINDOW_HINTS) if (re.test(modelId)) return n;
  return 1_000_000;
}

// ────────────── 「自定义模型」弹层的接口地址预设（纯 UI 数据） ──────────────

/**
 * 接口地址预设：只喂桌面端「自定义模型」弹层（经 InfoPayload.baseUrlPresets 下发），
 * 不参与 spec 解析——所以不扩 ProviderId，也不带 env 约定。
 *
 * 覆盖面参考 cc-switch 接入的厂商面，收敛到各家**官方 OpenAI 兼容端点**；
 * cc-switch 里的中继/赞助商服务不适合做内置预设（地址多变、需注册），不收。
 * baseURL 约定同 VendorPreset：必须含版本段（openai.ts 拼 `${baseURL}/chat/completions`）。
 */
export interface BaseUrlPreset {
  /** 展示名 */
  label: string;
  /** base URL（协议见 protocol） */
  baseURL: string;
  /** 请求协议；缺省 "openai"（OpenAI 兼容） */
  protocol?: "openai" | "anthropic" | "gemini";
  /** 选中后预填的默认模型名（仅当模型名输入框为空时填入） */
  defaultModel?: string;
  /** 模型名输入框的 placeholder 提示（无合适默认模型时给填写指引） */
  modelHint?: string;
}

const fromVendor = (id: VendorPreset["id"]): BaseUrlPreset => {
  const v = VENDOR_PRESETS.find((p) => p.id === id);
  if (v === undefined) throw new Error(`BASE_URL_PRESETS 引用了不存在的厂商预设: ${id}`);
  return { label: v.label, baseURL: v.baseUrl, defaultModel: v.defaultModel };
};

export const BASE_URL_PRESETS: BaseUrlPreset[] = [
  // ── OpenAI 兼容 ──
  fromVendor("deepseek"),
  fromVendor("zhipu"),
  fromVendor("dashscope"),
  fromVendor("moonshot"),
  { label: "SiliconFlow 硅基流动", baseURL: "https://api.siliconflow.cn/v1", defaultModel: "deepseek-ai/DeepSeek-V3" },
  {
    label: "火山方舟（豆包）",
    baseURL: "https://ark.cn-beijing.volces.com/api/v3",
    defaultModel: "doubao-1.5-pro-32k-250115",
    modelHint: "填接入点 ID（ep-…）或模型 ID",
  },
  { label: "腾讯混元", baseURL: "https://api.hunyuan.cloud.tencent.com/v1", defaultModel: "hunyuan-turbos-latest" },
  { label: "MiniMax", baseURL: "https://api.minimaxi.com/v1", defaultModel: "MiniMax-M2" },
  { label: "OpenAI", baseURL: "https://api.openai.com/v1", defaultModel: "gpt-4o-mini" },
  fromVendor("openrouter"),
  { label: "Groq", baseURL: "https://api.groq.com/openai/v1", defaultModel: "llama-3.3-70b-versatile" },
  { label: "xAI Grok", baseURL: "https://api.x.ai/v1", defaultModel: "grok-4" },
  fromVendor("ollama"),
  { label: "LM Studio（本地）", baseURL: "http://localhost:1234/v1", modelHint: "本地已加载的模型名" },
  // ── Anthropic Messages 协议（base 是根路径，anthropic.ts 自动拼 /v1/messages）──
  {
    label: "Anthropic",
    baseURL: "https://api.anthropic.com",
    protocol: "anthropic",
    defaultModel: "claude-sonnet-4-5",
  },
  // ── Gemini 原生协议（generateContent）──
  {
    label: "Gemini",
    baseURL: "https://generativelanguage.googleapis.com/v1beta",
    protocol: "gemini",
    defaultModel: "gemini-2.5-flash",
  },
];
