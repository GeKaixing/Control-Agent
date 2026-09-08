# providers/ —— 模型适配器

**关注点**：屏蔽 OpenAI（chat/responses）/ Anthropic / Gemini / mock 的协议差异，把它们都收敛成同一个
`StreamFn`，让 `agent.ts` 完全不关心「我现在连的是哪家模型」。

## 文件清单

| 文件 | 行数级 | 职责 |
| --- | --- | --- |
| `types.ts` | ~120 | `StreamEvent` 联合、`StreamFn` 类型、`LlmMessage` / `LlmContent` / `LlmTool` 数据形态，精简 `JsonSchema`（用于工具参数声明与校验） |
| `stream.ts` | ~190 | `StreamAccumulator`：把各家增量事件统一累积成 `AssistantMessage`；`parseSse` 把 `ReadableStream` 切成完整 `data:` 行；`StreamError` 抛带 status 的错误 |
| `openai.ts` | ~230 | OpenAI Chat Completions 适配器：`/v1/chat/completions`、流式 SSE、tool_call 增量累积；`openaiDefaultModel()` 默认从环境变量读 |
| `responses.ts` | ~280 | OpenAI Responses API 适配器（新一代 `/v1/responses`）：instructions+input 消息形状、扁平 tools、function_call(_output) item 回放、reasoning 增量（历史 thinking 不回放）、`response.completed` usage；`responsesDefaultModel()` 与 openai 同 key/baseUrl 源 |
| `anthropic.ts` | ~? | Anthropic API 适配器（同形态） |
| `gemini.ts` | ~? | Gemini 原生 REST 适配器（`streamGenerateContent?alt=sse`） |
| `mock.ts` | ~? | `createMockStream()`：离线测试 / 缺 key 时降级使用；脚本式应答；「模拟模型失败」关键字触发流错误事件（错误输出链路的测试钩子） |
| `index.ts` | ~75 | `resolveModel()` / `parseModelSpec()` / `defaultModel()`；按 `ModelRef.provider` 把请求分给具体适配器；`mock` 在缺 key 时自动降级 |

## 收敛后的统一接口

```ts
// providers/types.ts
type StreamFn = (
  options: StreamOptions,
) => AsyncGenerator<StreamEvent, void, void>;

type StreamEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_delta"; delta: string; partial: AssistantMessage }
  | { type: "thinking_delta"; delta: string; partial: AssistantMessage }
  | { type: "toolcall_delta"; delta: string; partial: AssistantMessage }
  | { type: "toolcall_end"; toolCall: ToolCallSummary; partial: AssistantMessage }
  | { type: "done"; reason: StopReason; message: AssistantMessage }
  | { type: "error"; reason: StopReason; error: AssistantMessage };
```

`partial` 字段**恒为「截止当前事件的完整快照」**，UI 直接拿来渲染而不必自己累积。
这是统一接口的最关键设计决定：让 `renderer.ts` 只读 `event.partial.content`，不维护任何
流式状态。

## 各适配器的职责

| 适配器 | 请求形态 | 关键差异抹平 |
| --- | --- | --- |
| OpenAI | `POST {baseUrl}/chat/completions`，SSE 流式 | tool 调用按 `tool_calls` 数组增量累积；`role=tool` 一调一条消息；o 系列用 `reasoning_content` 字段返回 thinking |
| Anthropic | `POST {baseUrl}/v1/messages`，SSE 流式 | 多 tool_result 合并进同一条消息；强约束「首条消息必须是 user」（由 `agent/convert.ts` 抹平） |
| Mock | 不发请求，返回脚本式事件流 | 用作离线测试、缺 key 时的降级目标 |

## `StreamAccumulator` —— 跨厂商共享

每家适配器都构造一个 `StreamAccumulator(modelId)`，通过这几个 API 喂增量：

| 适配器调用 | 含义 |
| --- | --- |
| `acc.pushText(delta)` | 普通文本增量 |
| `acc.pushThinking(delta)` | 推理 / thinking 增量 |
| `acc.openToolCall(id, name)` | 开一条新工具调用 |
| `acc.pushToolCallDelta(delta)` | 工具调用参数 JSON 的增量字符 |
| `acc.closeToolCall()` | 关闭并解析参数（JSON 非法时降级为空对象 `{}`） |
| `acc.addUsage({...})` | 把上游 usage 合并进来 |
| `acc.partial` | 当前快照（每次 `push` 后更新） |
| `acc.finish(reason, errMsg?)` | 终态消息，附带 stopReason |

适配器**只负责翻译事件**，**不负责维护消息状态**——所有共享的累积逻辑都在
`StreamAccumulator` 里。

## `resolveModel()` 与降级（providers/index.ts）

```ts
function resolveModel(model: ModelRef): ResolvedModel {
  const hasKey = (model.apiKey ?? "").length > 0;
  if (model.provider !== "mock" && !hasKey) {
    return {
      model,
      stream: providers.mock().stream,                  // 降级到 mock
      degraded: `未配置 ${model.provider.toUpperCase()}_API_KEY，已降级为 mock 模型`,
    };
  }
  return { model, stream: providers[model.provider]().stream };
}
```

**降级而非抛错**是核心约定——任何环境都能启动，调 `Agent.start` 时拿到的 `degraded`
原因可以显示给用户，但不阻断。

`defaultModel()` 按环境变量挑选：有 `OPENAI_API_KEY` 用 OpenAI；其次 `ANTHROPIC_API_KEY`；
否则 mock。

## `parseModelSpec()` —— CLI 字符串解析

把 `"openai:gpt-4o-mini"` 之类解析成 `ModelRef`，拼错 / 未知 provider 一律回落 `mock`。

## 如何新增厂商

最小动作清单（建议先草拟 `types.ts` 不动、`StreamFn` 接口已稳定）：

1. 新建 `providers/<your>.ts`，按上面 OpenAI 的形态实现 `StreamFn`。
2. 在 `providers/index.ts` 的 `providers` 表里加一条：
   ```ts
   const providers = { openai, anthropic, mock, <your>: () => ({ id: "<your>", stream: <yourStream> }) };
   ```
3. 在 `types.ts` 加 `ProviderId` 联合的一个分支，并实现 `defaultModel()`。
4. 把新环境变量名（如 `<YOUR>_API_KEY`）加进 `resolveModel()` 的「缺 key 降级 mock」判断。

### OpenAI 兼容厂商的捷径

多数厂商只是「OpenAI 协议 + 不同 baseUrl / key」，不必新建适配器：在 `vendors.ts`
的 `VENDOR_PRESETS` 加一条预设，即可自动获得 spec 前缀（含别名）、`<VENDOR>_BASE_URL`
覆盖、缺 key 降级提示。桌面端「自定义模型」弹层的接口地址预设来自同文件的
`BASE_URL_PRESETS`（经 InfoPayload 下发，渲染层不抄一份）。

## 已知坑

- **`OPENAI_BASE_URL` 只填到版本目录**（如 `https://host/v1`），
  `openai.ts:109` 会自己拼 `${baseUrl}/chat/completions`；填完整端点会变成
  `.../chat/completions/chat/completions` 而 404。
- **OpenAI 兼容端点会返回 `reasoning_content`**：o 系列与部分兼容实现都用此字段返回
  thinking；其他兼容实现可能没有这一字段，要看具体供应商。
- **`SSE` 里 `[DONE]` 哨兵**：OpenAI 在最后一条后发 `data: [DONE]`，`parseSse` 会把它
  转成 `return`——上游适配器看到「流自然结束」就调 `acc.finish(...)` 即可。
- **`AbortSignal` 必须传到 `fetch`**：否则用户 Ctrl-C 取消时流式请求会挂着不释放。
