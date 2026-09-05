# agent/ —— 调度状态机

**关注点**：跑轮子的代码都在这里。外层循环负责一轮又一轮的用户任务，内层循环负责当前任务里「大模型 ↔ 工具」的多轮往返。所有「什么时候让谁干活、干完之后算什么」的决定都在这里发出去。

## 文件清单

| 文件 | 行数级 | 职责 |
| --- | --- | --- |
| `agent.ts` | ~400 | `Agent` 类：外层 enqueue + 内层 model↔tool 循环、11 种 `AgentEvent` 事件、并发与失败止损、流式累积、AbortController |
| `convert.ts` | ~65 | `convertToLlm()`：把内部 `AgentMessage` 翻译成模型能理解的 `LlmMessage`；多条 `toolResult` 会被合并、Anthropic 场景下强制首条消息是 user |

## 它在流程图里的位置

```mermaid
graph TD
  Index[index.ts] --> Agent
  User([用户]) -->|enqueueUser| Agent
  Agent -->|drainFollowUps<br/>drainSteering| Queue[context/queue.ts]
  Agent -->|transformContext| Transform[context/transform.ts]
  Agent -->|activeBranch / appendNode| State[context/state.ts]
  Transform --> State
  Agent -->|convertToLlm| Convert[agent/convert.ts]
  Convert -->|LlmMessage[]| Providers[providers/*]
  Agent -->|Tool.execute| Tools[tools/_registry]
  Agent -->|AgentEvent| Renderer[ui/renderer.ts]
```

## 关键类型与概念

### `AgentEvent` —— 11 种事件

见 `src/agent/agent.ts:29-44`。订阅者按 `type` 分发。完整清单与每种事件何时发出、关键字段、UI 渲染动作参考仓库根 `AGENTS.md` 的「事件清单」一节。

### 外层 vs 内层

- **外层 `run()`**（`agent.ts:132`）：取后续指令 → 跑内层循环 → 还有后续指令就再来一轮。
  唯一产生 `agent_start` / `agent_end` 事件的地方。
- **内层 `runInnerLoop()`**（`agent.ts:163`）：中途指令 → `transformContext` → `convertToLlm` → 调用模型 → 有 `toolCall` 就执行 → 把结果写回消息记录 → 再进入下一轮，直到模型给出「无 toolCall」的终态（或触发止损）。

### `AgentOptions` —— 配置面

```ts
interface AgentOptions {
  state: AgentState;             // 必填：会话状态与会话树
  queue?: MessageQueue;          // 可选：中途指令 / 后续指令两条通道
  stream: StreamFn;              // 必填：统一大模型调用入口
  onEvent?: (e: AgentEvent) => void;
  transform?: Partial<TransformOptions>;
  maxToolRounds?: number;        // 默认 50
  allowParallelTools?: boolean;  // 默认 true
  disabledTools?: ToolName[];    // 黑名单
  maxToolResultChars?: number;   // 默认 50_000
}
```

### 并发与止损

- **并发规则**：只看 `isMutating`（`read / glob / grep` 为 `false`），
  `allowParallelTools && 全部只读` ⇒ `Promise.all`；任一 mutating ⇒ 串行 await。
- **失败止损**：
  - 工具 `execute()` 不 `throw`，统一用 `ok()` / `fail()` 返回
  - 同一调用（`name + arguments` 哈希）连续 `MAX_REPEATED_FAILURES = 3` 次失败 ⇒ 发 `notice` + 退出内层
  - 外层 `maxToolRounds`（默认 50）：超出 ⇒ 发 `notice` + 退出
  - `abort()` / `AbortController`：取消会把流式适配器里未完成的 `fetch` 整体中止

## convert.ts 的关键差异抹平

`LlmMessage` 与 `AgentMessage` 有几个关键差异在 `convertToLlm()` 里被抹平（`agent.ts:227-238` 也读它的产物）：

1. **空 user 跳过**：trim 后为空的 user message 不送给模型（部分 API 拒收）。
2. **空 thinking 跳过**：模型偶发返回 `" "` 的 thinking，会被过滤掉。
3. **toolResult 合并**：连续多条 `toolResult` 会被合并进同一条 `LlmMessage.content`，
   具体「一条一调」还是「打包进一条」由各厂商适配器自行展开（OpenAI 选前者，Anthropic 选后者）。
4. **首条 user 强约束**：循环 `while (out[0].role !== "user") out.shift()`，
   满足 Anthropic 的「第一条消息必须是 user」要求。

## 与 context/ 的协作

`agent.ts` 严格只读写 `context/` 暴露的 API（`appendNode` / `currentNode` / `activeBranch` /
`transformContext`），不直接操作 `state.nodes` / `state.currentNodeId` 这种内部字段。

> 不参与上下文判断：所有「会话树长什么样、★ 在哪、要不要走分支」的决定都不在 `agent/`
> 里，而是在 `context/state.ts` 里。需要新增上下文功能时，改在 `context/` 加文件再从
> `context/index.ts` 导出。

## 已知坑

- `enqueueUser` 与 `steer` 都会把消息写进会话树，区别在**消费时机**：
  - `enqueueUser`（后续指令）：被外层 `run()` 在下一轮 `agent_start` 之后消费
  - `steer`（中途插入）：被内层 `runInnerLoop()` 在下一轮 `turn_start` 头部消费，并被
    注入 `[中途插入指令]` 前缀
- `toolcall_end` 事件里**只有最终解析出的 `ToolCallSummary`**，原 JSON 字符串在适配器里已经被
  `StreamAccumulator` 消化掉了——`renderer.ts` 也只看到 `name` 与 `arguments` 这两份数据。

## 如何扩展

- **新增一种事件**：往 `AgentEvent` 联合里添一个分支 + 在 `run()` / `runInnerLoop()` 的合适时机
  `emit`；订阅者按 `type` 分发，不用改 `agent.ts` 的形状。
- **新增一种止损条件**：在 `hasRepeatedFailure` 之类的地方加判断，`emit({ type: "notice", ... })` 后
  `return` 即可，渲染器会自动收到。
- **替换流模型**：保留 `StreamFn` 接口（`providers/types.ts`），换实现比换 `agent.ts` 简单得多。
