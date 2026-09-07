# ui/ —— 终端交互层

**关注点**：把代理事件流式地画到终端上，并把用户在交互模式下的键入收回来。本目录是项目里**唯一知道 ANSI 转义序列的地方**，`enabled: false` 时全部纯透传。

## 文件清单

| 文件 | 行数级 | 职责 |
| --- | --- | --- |
| `input.ts` | ~120 | `LoopInput` 接口 + `InputController`（readline）+ `FakeInput`（测试） |
| `repl.ts` | ~190 | `runRepl()`：把 `src/index.ts` 的 REPL 主循环抽出来，可被 `FakeInput` 注入 |
| `renderer.ts` | ~185 | `TerminalRenderer`：把 `AgentEvent` 转成带 ANSI 颜色的终端输出；按 `verbose` 决定是否显示 thinking；token 用量汇总 |
| `markdown.ts` | ~155 | `createMarkdownStream()` / `renderMarkdown()`：精简 Markdown → ANSI（标题、列表、引用、分隔线、围栏代码块 + 行内粗体/斜体/行内码/链接） |
| `print.ts` | ~90 | `createPrintOutput()`：`npm start -- -p` / 管道场景下，把同一批事件收敛成「最终答案」+ 警告 + 错误 + exitCode |

## 与 agent/ 的边界

`ui/` **只读** `AgentEvent`（`agent/agent.ts:24-39`），不知道「模型」是谁、不知道「工具」是谁。
事件按 `type` 分发，新增事件时这里也得加一份处理。详见 `agent/doc/README.md`「事件清单」一节。

## `TerminalRenderer.handle()` —— 事件到终端的映射

```ts
case "agent_start":    // （无输出，仅记录起始时间）
case "turn_start":     // 打个空行
case "steering":       // 灰字「↳ 收到中途指令：xxx」
case "stream":         // 转发给 handleStream
case "tool_end":       // ✓ bash 36ms + 前 12 行输出；失败时换成红色 ✗
case "turn_end":       // 错误信息（红色）；最终回答时给 token 行
case "context_pruned": // 黄字「上下文已裁剪：丢弃 N 条消息，压缩 M 处工具结果」
case "notice":         // 黄字
case "agent_end":      // 闭合上一段
case "tool_start":     // （无输出）
```

`stream` 子事件由 `handleStream()` 进一步分发：

| `StreamEvent.type` | 处理 |
| --- | --- |
| `text_delta` | 进 `MarkdownStream.push(delta)`，返回完整行才写 |
| `thinking_delta` | 仅 `verbose` 时写灰字 |
| `toolcall_end` | `→ toolName(args…)`，工具名青色 |
| `error` | 红字「流错误：…」 |

## `MarkdownStream` —— 为什么按行攒

模型流式输出时 `text_delta` 可能切成任意长度；`**bo|ld**` 这种跨 delta 的标记如果直接
渲染就会被切坏。`createMarkdownStream` 维护一个 `buffer`：

1. 收到 `delta` ⇒ 追加进 `buffer`
2. 找到 `\n` ⇒ 把 `\n` 前那段当整行 `renderLine(...)` 渲染出去，slice 到 `\n` 后继续
3. `end()` ⇒ 把最后一段（没换行的尾巴）也渲染出去

`renderLine` 持有跨行的唯一状态 `BlockState { fence }`——代码块开关必须在同一行写完才知道
有没有开/关。

## `createPrintOutput()` —— print 模式的相反一面

交互模式下 `TerminalRenderer` 把事件**画到终端**；print 模式下 `createPrintOutput`
把同一批事件**收敛成三段**：

| 字段 | 来源 |
| --- | --- |
| `answer: string` | 所有 `text_delta` 拼起来 |
| `warnings: string[]` | `notice` + `context_pruned` |
| `errors: string[]` | `stream.error` + `turn_end.message.errorMessage` |
| `exitCode: 0 \| 1` | `errors.length > 0 ? 1 : 0` |

`index.ts` 在 print 模式下把 `answer` 写 stdout、`warnings` / `errors` 写 stderr，并按
`exitCode` 设置退出码。

## `InputController` —— REPL 与中途指令

```ts
interface LoopInput {
  ask(prompt): Promise<string>;       // 外层等一行
  drainSteering(): string[];          // 模型跑着期间积攒的输入一次性取走
  onSigint(handler): void;            // Ctrl-C 转发给 agent.abort()
  close(): void;
}

class InputController implements LoopInput { /* 真终端 readline */ }
class FakeInput implements LoopInput { /* tests/repl-loop.ts 驱动 */ }
```

`readline.on("line", ...)` 里：如果有等待中的 `ask()` waiter（外层正在等），就交给
waiter；否则进 `steering` 队列。`on("close")` 会把最后没读完的 `/exit` 喂给 waiter，
处理 stdin 关闭的场景。

抽出 `LoopInput` 接口是因为子进程 stdio 永远不是 TTY——`process.stdin.isTTY === false`
会让 `index.ts` 走 print 模式，测不了 REPL。`runRepl()` 吃 `LoopInput`，测试灌 `FakeInput`，
真实启动还是 `InputController`。

## `runRepl()` —— REPL 主循环

`src/index.ts` 原本 inline 了 REPL 主循环，抽到 `repl.ts` 是为了在测试里 in-process 跑。
函数签名：

```ts
runRepl(opts: {
  agent, state, queue, allTools, helpText,
  input: LoopInput,
  output: (text: string) => void,      // 测试可替换，真实启动 = process.stdout.write
  initialVerbose: boolean,
  onToggleVerbose: (next: boolean) => void,   // 闭包对象把可变状态传出
  resolveNewModel: (spec: string) => Promise<{…}>,
  getUsage: () => UsageSnapshot,
  steeringPollMs?: number,
}): Promise<number>   // 退出码，0 / 130 (Ctrl-C)
```

斜杠命令：`/exit` / `/help` / `/tools` / `/usage` / `/clear` / `/verbose` / `/model <spec>`。
主要两件事：把内层循环处理 steering 合并进 user 输入；按 model 重置 agent。

## Markdown 渲染的「终端够用」子集

`markdown.ts` 自己写、不引第三方依赖，覆盖：

- **块级**：标题 `#` ~ `######`、无序列表 `-` / `*` / `+`、有序列表 `1.` / `1)`、引用 `>`、
  分隔线 `---` / `***` / `___`、围栏代码块 ` ``` ` / `~~~`
- **行内**：粗体 `**x**`、斜体 `*x*`（**不**识别 `_x_`，避免误伤 `snake_case`）、删除线 `~~x~~`、
  行内码 `` `x` ``、链接 `[text](url)`

`enabled: false` 时**两个入口都是纯透传**（`push` 原样返回、`end` 返回空串），
调用方可以无脑用，不用关心「现在是不是管道」。

## 已知坑

- **`text_delta` 必须在 `stream` 之前的 `flushText()` 才安全**：任何非 `stream` 事件进入
  时都会先把 Markdown 缓冲里没吐完的半行冲出去，避免工具调用行 / 用量行插在一行
  文字中间。
- **token 行只在「最终回答」显示**：中间轮次（还会继续调工具）不打印用量，等真正停
  下来时再统一给（`renderer.ts:104-110` 的 `hasToolCalls` 检查）。
- **管道 / 输出不是 TTY 务必关 markdown**：转义序列会污染下游；`index.ts` 在 `-p`
  或 `process.stdout.isTTY === false` 时把 `TerminalRenderer({ markdown: false })`。
