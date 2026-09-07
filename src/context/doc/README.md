# context/ —— 模型真正看到的那份上下文

**关注点**：所有关于「模型看到什么」的代码都在本目录。包括会话状态（系统提示词、模型、工具、cwd）、会话树（节点 / ★ / 分支）、token 估算、消息入队的两条通道、`transformContext` 三步后处理。

## 为什么独立成目录（2026-09-05 用户约定）

之前「上下文相关代码」散落在 `agent/state.ts`、`agent/context.ts`、`agent/queue.ts` 三处，
新加上下文功能时容易放错位置。现在统一收口到 `context/`，**引用方只能从 `context/index.ts`**
导入，新加文件也得在这里补一份导出。

**判定标准**：**模型真正看到的那份上下文**（存什么、怎么裁剪、消息怎么进来）归 `context/`。
调度与厂商协议（`agent.ts`、`providers/`）不算上下文。

## 文件清单

| 文件 | 行数级 | 职责 |
| --- | --- | --- |
| `state.ts` | ~290 | `AgentState`（系统提示词 + 模型 + 工具 + cwd + **会话树**）；`MessageNode`（每条消息带 parent / children）；`appendNode` / `addNodeAt` / `switchTo` / `currentNode` / `pathToRoot` / `activeBranch`；`estimateTokens` 粗估 |
| `transform.ts` | ~165 | `transformContext(state, overrides?)`：三步后处理（清理孤儿 → 压缩旧轮 → 按预算裁剪整轮） |
| `queue.ts` | ~50 | `MessageQueue`：两条独立通道——`steering`（中途插入指令）与 `followUp`（后续指令） |
| `index.ts` | ~30 | **统一出口**，外部一律从这里 import，所有新增 export 都要在此补一份 |

## 概念视图：会话是一棵树

参考 `AGENTS.md` 的「概念视图」一节。简版：

```
Root
 │ parent
 ▼
User #1 → Assistant #1 → User #3 → Assistant #3
                                     ┌──────┴──────┐
                                     ▼              ▼
                                 Branch A       Branch B
                                     │              │
                                     ▼              ▼
                              Assistant #4-A  Assistant #4-B
                                     │
                                     ▼
                              ★ Current Node       ← LLM 下次接手写的位置
```

- 每个节点 = 一条 `Message`，携带 `parent` 指针
- `★ Current Node` = LLM 下次接手写的位置
- `★` 推进规则（在 `state.ts:appendNode` 里实现）：用户消息 / 模型输出 / 工具结果回填都推进到新节点
- 「模型真正看到的上下文」 = 从 `★` 沿 `parent` 反向走到 `Root` 的线性序列（`activeBranch(state)`）

## state.ts 关键 API

```ts
// 类型与构造
function createInitialState(opts: {
  cwd: string;
  model: ModelRef;
  tools: Tool[];
  thinkingLevel?: ThinkingLevel;
  systemPrompt?: string;          // 完整替换默认系统提示词
  appendSystemPrompt?: string;    // 追加到默认末尾
  seedMessages?: SeedMessage[];   // 种子消息（CLI 的 --user-prompt / --assistant-prompt）
}): AgentState;

// 树操作
function appendNode(state, message): MessageNode;     // 在 ★ 下追加
function addNodeAt(state, parentId, message): MessageNode;  // 在指定 parent 下追加
function switchTo(state, nodeId): MessageNode | undefined;  // 切换 ★（分支切换 / 回放）
function currentNode(state): MessageNode | undefined; // 取 ★
function pathToRoot(state, nodeId): MessageNode[];    // ★ → Root
function activeBranch(state): AgentMessage[];         // ★ → Root 反转后的线性消息

// 实用
function buildSystemPrompt(cwd, toolNames): string;   // 默认系统提示词
function estimateTokens(messages, systemPrompt): number;  // 粗估：中文 1.5 字/token，其余 4 字/token
function calibrateCharsPerToken(state, charsSent, inputTokens): void;  // usage 反馈 EMA 校准
function totalUsage(state): { input; output; total };
```

## transformContext —— 三步后处理

每轮 `turn_end` 之后、内层循环继续前调用一次（`agent.ts:172`）。三步**顺序敏感**：

```
linear := activeBranch(state)      // ★ → Root 反转
       │
       ▼
[1] dropOrphanToolResults()        // 删掉没有对应 toolCall.id 的 toolResult（异常流中断会留下）
       │
       ▼
[2] pruneOldTurns()                // 早期轮次的 assistant 抹掉 thinking；
                                   //   超长 toolResult：成功 → 整条替换成占位指针，
                                   //   error → 保留内容只做头尾截断
       │
       ▼
[3] trimToBudget()                 // 迟滞裁剪：超 触发线（预算×0.85）才进入，
                                   //   一次丢整轮到 目标线（预算×0.7）以下为止
                                   //   （两次裁剪之间前缀字节级稳定，保 provider 前缀缓存）
       │
       ▼
TransformedContext { messages, systemPrompt, tools, droppedMessages, prunedToolResults }
```

每一步都会更新 `TransformedContext.droppedMessages` / `prunedToolResults`，由 `agent.ts` 透出
`context_pruned` 事件，让 UI 实时显示「已清理 N 条 / 压缩 M 条」。

默认参数（`defaultTransformOptions`）：

| 字段 | 值 | 含义 |
| --- | --- | --- |
| `maxContextTokens` | 120 000 | 模型上下文上限（默认值）。桌面端经 `maxContextTokensFor(模型真实窗口)` 覆写——`/models` 元数据优先、粗表兜底 |
| `reservedTokens`   | 8 000 | 为回复预留 |
| `keepRecentTurns`  | 2 | 无论如何都要保住的最近轮数 |
| `maxToolResultChars` | 4 000 | 旧工具结果的省略阈值（成功结果换指针，error 截断） |
| `trimTriggerRatio` | 0.85 | 迟滞裁剪触发线（预算 × ratio） |
| `trimTargetRatio`  | 0.7 | 迟滞裁剪目标线（预算 × ratio） |

自动 compact（`shouldAutoCompact`）：agent 内层循环每轮开跑前，用与 `trimToBudget`
同一套预算 / 口径 / 触发线判定上下文是否越线；越线则先让模型把历史摘要成新 Root
（`Agent.compact()` 的内部路径），抢在 [1]–[3] 的机械处理之前——摘要保得住要点，
丢轮次 / 换指针做不到。压缩失败自动落回本管线兜底，本次 run 内不再重试
（`AgentOptions.autoCompact: false` 可整体关闭）。

**token 口径自校准**（state.ts）：固定 chars/token（3.5）在中文 + 代码混合场景偏差可达 ±30%。
`agent.ts` 每次真实调用后把「发出去的字符量 ÷ `usage.input`（prompt_tokens）」喂给
`calibrateCharsPerToken(state, chars, tokens)` 做 EMA（α=0.3，观测值限幅 1.5~8 防异常
provider 污染），结果存 `state.observedCharsPerToken`；`trimToBudget` 优先用它，
无观测时回落 3.5。

## queue.ts —— 两条独立通道

```ts
class MessageQueue {
  enqueueSteering(text)   // 中途插入：模型跑着的时候键入的回车
  enqueueFollowUp(text)   // 后续指令：模型停下来的间隙里键入的回车
  drainSteering(): string[]          // 由内层 runInnerLoop 在每轮头部取走
  drainFollowUps():  string[]        // 由外层 run 在每轮 agent_start 后取走
  hasSteering() / hasFollowUps()
  get pendingSteering / pendingFollowUps
}
```

两条通道**不能混用**：错通道消费会让消息进错地方，回放就乱了。

## 与 agent/ 的协作边界

`agent.ts` 只读写 `context/` 暴露的 API：
- `appendNode` / `addNodeAt` / `currentNode`（写会话树）
- `activeBranch`（读上下文）
- `transformContext`（读并裁剪）
- `MessageQueue`（两条通道）
- `createInitialState`（构造初始状态）

**不直接操作** `state.nodes` / `state.currentNodeId` / `state.rootId` 这些内部字段；
那些字段的语义变化只属于 `state.ts`。

## 扩展指引

- **新增一种压策略**：在 `transform.ts` 里加一步（或一个独立函数），并在 `transformContext()`
  里按顺序串起来；返回值里加新字段 + 在 `agent.ts` 的事件里加新字段。
- **新增一种消息入队通道**：在 `queue.ts` 里加成员方法，并补一对 `enqueueXxx` / `drainXxx`；
  在 `MessageQueue` 上同步加 getter，让 `agent.ts` 在合适时机 `drain`。
- **修改节点存储**：集中在 `state.ts`，不要在 `agent.ts` 里偷偷改 map。

## 已知坑

- **状态写消息树 ≠ 直接给模型**：`appendNode` 把消息写进 `state.nodes`（树）+ 同步维护一份
  `state.messages`（线性兼容数组）。`★ 缺失` 时 `activeBranch` 回退到 `state.messages`，
  这是老测试（直接 `state.messages = ...`）的兼容路径，生产代码里不会出现。
- **`state.messages` 不要从外部直接赋值**：会绕过树的维护。除非你确认自己就是「老 fallback
  模式」（几乎不会）。
- **`currentNodeId === null` ≠ 空会话**：建 state 时一定是 `null`；只要 `appendNode` 一次就
  就被推进了。判断「有没有活干」应该读 ★ 节点（或 messages 末位）消息的 `role`
  （`agent.ts:hasPendingWork`）。

## 会话持久化（sessions.ts）

会话树（`AgentState.nodes`）可整体 JSON 序列化——每条消息是带 parent/children
指针的节点，`saveSession` 原子写（tmp + rename）到 `.c-agent/sessions/<id>.json`，
`loadSessionInto` 整树还原后从 ★ 重算线性视图；compact 留下的旧分支一并回来，
`switchTo` 仍可回溯。接入点：

- **自动保存**：`AgentOptions.persistSessions`（默认 false）→ 每次 `agent_end`
  后落盘，同一 state 复用同一个会话 id；CLI 交互模式已开启。
- **恢复**：CLI `--resume [id]`（省略 id 取最近一次）；REPL `/sessions` 列清单。
- 与 memory 工具的分工：项目根 `MEMORY.md` 是模型自己记的「跨会话有效事实」，
  注入系统提示词；sessions 是完整对话历史，只在恢复时整体读回，不注入。
- 不做的事：不摘要、不清洗、不做保留期——哪些内容值得留是 transformContext
  管线的事，这里只管字节。
