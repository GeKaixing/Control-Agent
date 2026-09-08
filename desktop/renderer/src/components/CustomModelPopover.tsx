import React, { useRef, useState } from "react";
import type { CustomModelParams, InfoPayload, ModelInfo } from "../../../shared/api";

type Protocol = NonNullable<CustomModelParams["protocol"]>;

const PROTOCOLS: Array<{ id: Protocol; label: string }> = [
  { id: "openai", label: "OpenAI 兼容" },
  { id: "responses", label: "OpenAI Responses" },
  { id: "anthropic", label: "Anthropic" },
  { id: "gemini", label: "Gemini 原生" },
];

/** 协议对应的接口地址填写提示与请求拼接说明（后端各适配器只自动拼最后一段） */
const PROTOCOL_META: Record<Protocol, { baseLabel: string; basePlaceholder: string; footer: string }> = {
  openai: {
    baseLabel: "接口地址（填到版本目录，如 https://api.deepseek.com/v1）",
    basePlaceholder: "https://api.example.com/v1",
    footer: "下次对话生效；请求发到 接口地址 + /chat/completions",
  },
  responses: {
    baseLabel: "接口地址（填到版本目录，如 https://api.openai.com/v1）",
    basePlaceholder: "https://api.openai.com/v1",
    footer: "下次对话生效；请求发到 接口地址 + /responses（OpenAI 新一代 Responses API）",
  },
  anthropic: {
    baseLabel: "接口地址（填根路径，不带 /v1；自动拼 /v1/messages）",
    basePlaceholder: "https://api.anthropic.com",
    footer: "下次对话生效；请求发到 接口地址 + /v1/messages（Anthropic Messages 协议）",
  },
  gemini: {
    baseLabel: "接口地址（填到 /v1beta）",
    basePlaceholder: "https://generativelanguage.googleapis.com/v1beta",
    footer: "下次对话生效；请求发到 接口地址 + /models/{模型}:streamGenerateContent（Gemini 原生协议）",
  },
};

/** 上下文窗口粗显：131072 → 131k、1000000 → 1m（模型列表条目右侧的参考值） */
function fmtCtxWindow(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}m`;
  }
  return `${Math.round(n / 1000)}k`;
}

/**
 * baseURL 域名 → 协议族的启发式识别（弹层 UI 层的自动猜测）。
 *  - anthropic / gemini：官方域名强信号；
 *  - openai：OpenAI 官方 + 全部 OpenAI 兼容厂商域名 + 本地端点——注意这只表示
 *    「openai 家族」，openai.com 同时跑 chat 与 responses 两种协议，具体归
 *    openai 还是 responses 由用户定（识别逻辑不把 responses 拉回 chat）；
 *  - 未知域名返回 null：保持用户当前选择，不强猜。
 */
function protocolFamilyOf(url: string): "anthropic" | "gemini" | "openai" | null {
  const m = /^https?:\/\/([^/:?#]+)/i.exec(url.trim());
  if (m === null) return null;
  const host = m[1]!.toLowerCase();
  if (host === "api.anthropic.com") return "anthropic";
  if (host === "generativelanguage.googleapis.com") return "gemini";
  const openaiCompatible = new Set([
    "api.openai.com",
    "api.deepseek.com",
    "api.moonshot.cn",
    "api.moonshot.ai",
    "open.bigmodel.cn",
    "dashscope.aliyuncs.com",
    "openrouter.ai",
    "opencode.ai",
    "api.mistral.ai",
    "api.x.ai",
    "api.groq.com",
    "localhost",
    "127.0.0.1",
  ]);
  return openaiCompatible.has(host) ? "openai" : null;
}

/**
 * 「自定义模型」弹层内容（PopoverHost 子窗口渲染）：
 * 协议（OpenAI 兼容 / Anthropic / Gemini 原生）+ 接口地址 + API KEY + 模型名称。
 *
 * 与其他菜单弹层同款技术：无边框子窗口浮在触发按钮下方，主窗口高度不变。
 * 确认走 setCustomModel（后端校验失败会把 Error 弹在这里），成功后主进程广播
 * refresh-info 让主窗口头部立即刷新。
 *
 * 模型列表：选中预设 / key·地址失焦时直连端点 /models 拉可用模型，点选替代
 * 手动填写；拉取条件是已填 key 或本地端点（手动按钮则无条件尝试）。
 */
export function CustomModelContent({
  info,
  onClose,
}: {
  info: InfoPayload;
  onClose: () => void;
}): React.ReactElement {
  // 协议 / 接口地址按当前端点猜测预填；key 与模型名不回填（key 不落地展示，模型名是用户要新填的）
  const cur = info.baseURL;
  const [protocol, setProtocol] = useState<Protocol>(
    info.endpoint === "anthropic" ? "anthropic" : info.endpoint === "gemini" ? "gemini" : "openai",
  );
  const [baseURL, setBaseURL] = useState(cur.startsWith("http") ? cur : "");
  const [apiKey, setApiKey] = useState("");
  const [modelId, setModelId] = useState("");
  const [ctxWindow, setCtxWindow] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 模型列表自动拉取：结果点选填入模型名，失败提示可手动填写
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  // 参数指纹去重：同 protocol+baseURL+key 只拉一次；手动按钮可 force 绕过
  const fetchedKeyRef = useRef<string | null>(null);

  const fetchModels = async (
    p: { baseURL: string; apiKey: string; protocol: Protocol },
    force = false,
  ): Promise<void> => {
    const base = p.baseURL.trim();
    const key = p.apiKey.trim();
    if (!/^https?:\/\//i.test(base)) return;
    // 自动拉取条件：填了 key，或目标是本地端点（localhost 服务常无鉴权，留空 key 也能拉）。
    // 手动点击「拉取模型列表」按钮（force）时无条件尝试——失败就显示错误，让用户自己判断。
    const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(base);
    if (!force && key.length === 0 && !isLocal) return;
    const fingerprint = `${p.protocol}|${base}|${key}`;
    if (!force && fetchedKeyRef.current === fingerprint) return;
    fetchedKeyRef.current = fingerprint;
    setLoadingModels(true);
    setModelsError(null);
    try {
      const result = await window.api.listCustomModels({ baseURL: base, apiKey: key, protocol: p.protocol });
      if (result.error !== undefined) {
        setModels([]);
        setModelsError(result.error);
      } else if (result.models.length === 0) {
        setModels([]);
        setModelsError("端点没有返回任何模型");
      } else {
        setModels(result.models);
      }
    } catch (err) {
      setModels([]);
      setModelsError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingModels(false);
    }
  };

  /** 协议切换统一入口：旧模型列表与去重指纹作废（同 baseURL 不同协议，/models 格式与鉴权都不同） */
  const applyProtocol = (next: Protocol): void => {
    setProtocol(next);
    setModels([]);
    setModelsError(null);
    fetchedKeyRef.current = null;
  };

  /** 接口地址预设（内核 BASE_URL_PRESETS 随 info 下发），按协议过滤 */
  const presets = (info.baseUrlPresets ?? []).filter((p) => (p.protocol ?? "openai") === protocol);
  const matchedPreset = presets.find((p) => p.baseURL === baseURL);
  const meta = PROTOCOL_META[protocol];

  const confirm = async (): Promise<void> => {
    // 三项全空 = 误触，按取消处理；有内容但校验不过由后端报错显示
    if (baseURL.trim().length === 0 && apiKey.trim().length === 0 && modelId.trim().length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    try {
      // refresh-info 由主进程在 setCustomModel 成功后广播
      await window.api.setCustomModel({
        baseURL,
        apiKey,
        model: modelId,
        protocol,
        contextWindow: ctxWindow.trim().length > 0 ? ctxWindow : undefined,
      });
      onClose();
    } catch (err) {
      setError(`切换失败：${err instanceof Error ? err.message : String(err)}`);
      setBusy(false);
    }
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") void confirm();
    if (e.key === "Escape") onClose();
  };

  return (
    <div className="w-full overflow-hidden rounded-md border border-border bg-popover p-3 text-popover-foreground shadow-md">
      <div className="mb-2 text-[12px] font-medium">自定义模型</div>
      {error !== null && (
        <div className="mb-2 rounded-md bg-red-500/10 px-2.5 py-1.5 text-[11px] text-red-600">{error}</div>
      )}
      <div className="mb-1.5 flex gap-1">
        {PROTOCOLS.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => {
              applyProtocol(p.id);
              setError(null);
            }}
            className={
              protocol === p.id
                ? "flex-1 rounded-md border border-primary/50 bg-primary/10 px-2 py-1 text-[11px] text-primary"
                : "flex-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent/40"
            }
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="mb-2 text-[10px] text-muted-foreground">
        协议随预设 / 接口地址自动识别（可手动更改）
      </div>
      <label className="mb-1 block text-[10px] text-muted-foreground" htmlFor="custom-model-preset">
        预设提供商
      </label>
      <select
        id="custom-model-preset"
        value={matchedPreset?.baseURL ?? ""}
        onChange={(e) => {
          const p = presets.find((x) => x.baseURL === e.target.value);
          if (p === undefined) return;
          const proto = p.protocol ?? "openai";
          setBaseURL(p.baseURL);
          // 预设自带协议：切换提供商时协议跟着走（不同协议的预设列表是过滤后各自显示的）
          if (proto !== protocol) applyProtocol(proto);
          // 默认模型只在模型名为空时预填，不覆盖用户已输入的内容
          setModelId((cur2) => (cur2.trim().length === 0 ? (p.defaultModel ?? cur2) : cur2));
          // 选中预设即尝试拉取该提供商的模型列表（已填 key 或本地端点才真正发请求）
          void fetchModels({ baseURL: p.baseURL, apiKey, protocol: proto });
        }}
        className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-[12px] outline-none focus:border-ring/50"
      >
        <option value="">直接输入，或选择提供商…</option>
        {presets.map((p) => (
          <option key={p.baseURL} value={p.baseURL}>
            {p.label}
          </option>
        ))}
      </select>
      <label className="mb-1 mt-2.5 block text-[10px] text-muted-foreground" htmlFor="custom-model-base">
        {meta.baseLabel}
      </label>
      <input
        id="custom-model-base"
        value={baseURL}
        placeholder={meta.basePlaceholder}
        onChange={(e) => setBaseURL(e.target.value)}
        onBlur={() => {
          // 域名族自动识别：anthropic/gemini 官方域名是强信号，直接纠正；
          // openai 家族域名只在明显矛盾时纠回 openai——已是 openai 或 responses
          // 则尊重用户选择（openai.com 同时跑 chat 与 responses，不能替用户拉回 chat）
          const family = protocolFamilyOf(baseURL);
          let effective = protocol;
          if (family === "anthropic" && protocol !== "anthropic") {
            effective = "anthropic";
            applyProtocol("anthropic");
          } else if (family === "gemini" && protocol !== "gemini") {
            effective = "gemini";
            applyProtocol("gemini");
          } else if (
            family === "openai" &&
            (protocol === "anthropic" || protocol === "gemini")
          ) {
            effective = "openai";
            applyProtocol("openai");
          }
          void fetchModels({ baseURL, apiKey, protocol: effective });
        }}
        onKeyDown={onKey}
        autoFocus
        className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-[12px] outline-none focus:border-ring/50"
      />
      <label className="mb-1 mt-2.5 block text-[10px] text-muted-foreground" htmlFor="custom-model-key">
        API KEY（本地无 key 的端点可留空）
      </label>
      <input
        id="custom-model-key"
        type="password"
        value={apiKey}
        placeholder="sk-…"
        onChange={(e) => setApiKey(e.target.value)}
        onBlur={() => void fetchModels({ baseURL, apiKey, protocol })}
        onKeyDown={onKey}
        className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-[12px] outline-none focus:border-ring/50"
      />
      <div className="mb-1 mt-2.5 flex items-center justify-between">
        <label className="text-[10px] text-muted-foreground" htmlFor="custom-model-id">
          模型名称
        </label>
        <button
          type="button"
          disabled={loadingModels}
          onClick={() => void fetchModels({ baseURL, apiKey, protocol }, true)}
          className="text-[10px] text-primary hover:underline disabled:opacity-50"
        >
          {loadingModels ? "拉取中…" : "拉取模型列表"}
        </button>
      </div>
      <input
        id="custom-model-id"
        value={modelId}
        placeholder={matchedPreset?.modelHint ?? matchedPreset?.defaultModel ?? "例：deepseek-chat、glm-4.6"}
        onChange={(e) => setModelId(e.target.value)}
        onKeyDown={onKey}
        className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-[12px] outline-none focus:border-ring/50"
      />
      {!loadingModels && modelsError !== null && (
        <div className="mt-1.5 text-[10px] text-red-600">拉取失败（{modelsError}），可手动填写</div>
      )}
      {models.length > 0 && (
        <div className="mt-1.5 max-h-36 overflow-y-auto rounded-md border border-border">
          {models.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setModelId(m.id)}
              className={
                modelId === m.id
                  ? "flex w-full items-center justify-between px-2.5 py-1 text-left text-[11px] text-primary"
                  : "flex w-full items-center justify-between px-2.5 py-1 text-left text-[11px] hover:bg-accent/40"
              }
            >
              <span className="truncate font-mono">{m.id}</span>
              {m.contextWindow !== undefined && (
                <span className="ml-2 shrink-0 text-[10px] text-muted-foreground">{fmtCtxWindow(m.contextWindow)}</span>
              )}
            </button>
          ))}
        </div>
      )}
      <label className="mb-1 mt-2.5 block text-[10px] text-muted-foreground" htmlFor="custom-model-ctx">
        上下文窗口（可选，留空自动识别）
      </label>
      <input
        id="custom-model-ctx"
        value={ctxWindow}
        placeholder="如 1m、256k、1000000"
        onChange={(e) => setCtxWindow(e.target.value)}
        onKeyDown={onKey}
        className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-[12px] outline-none focus:border-ring/50"
      />
      <div className="mt-2.5 text-[10px] text-muted-foreground">{meta.footer}</div>
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-border px-2.5 py-1 text-[11px] hover:bg-accent/40"
        >
          取消
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void confirm()}
          className="rounded-md bg-foreground px-2.5 py-1 text-[11px] text-background hover:opacity-90 disabled:opacity-50"
        >
          确定
        </button>
      </div>
    </div>
  );
}
