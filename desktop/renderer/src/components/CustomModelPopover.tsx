import React, { useState } from "react";
import type { CustomModelParams, InfoPayload } from "../../../shared/api";

type Protocol = NonNullable<CustomModelParams["protocol"]>;

const PROTOCOLS: Array<{ id: Protocol; label: string }> = [
  { id: "openai", label: "OpenAI 兼容" },
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

/**
 * 「自定义模型」弹层内容（PopoverHost 子窗口渲染）：
 * 协议（OpenAI 兼容 / Anthropic / Gemini 原生）+ 接口地址 + API KEY + 模型名称。
 *
 * 与其他菜单弹层同款技术：无边框子窗口浮在触发按钮下方，主窗口高度不变。
 * 确认走 setCustomModel（后端校验失败会把 Error 弹在这里），成功后主进程广播
 * refresh-info 让主窗口头部立即刷新。
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
              setProtocol(p.id);
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
      <label className="mb-1 block text-[10px] text-muted-foreground" htmlFor="custom-model-preset">
        预设提供商
      </label>
      <select
        id="custom-model-preset"
        value={matchedPreset?.baseURL ?? ""}
        onChange={(e) => {
          const p = presets.find((x) => x.baseURL === e.target.value);
          if (p === undefined) return;
          setBaseURL(p.baseURL);
          // 默认模型只在模型名为空时预填，不覆盖用户已输入的内容
          setModelId((cur2) => (cur2.trim().length === 0 ? (p.defaultModel ?? cur2) : cur2));
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
        onKeyDown={onKey}
        className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-[12px] outline-none focus:border-ring/50"
      />
      <label className="mb-1 mt-2.5 block text-[10px] text-muted-foreground" htmlFor="custom-model-id">
        模型名称
      </label>
      <input
        id="custom-model-id"
        value={modelId}
        placeholder={matchedPreset?.modelHint ?? matchedPreset?.defaultModel ?? "例：deepseek-chat、glm-4.6"}
        onChange={(e) => setModelId(e.target.value)}
        onKeyDown={onKey}
        className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-[12px] outline-none focus:border-ring/50"
      />
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
