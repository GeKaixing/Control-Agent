# Control-Agent

<p align="center">
  <img src="docs/logo.png" alt="Control-Agent logo" width="280">
</p>

用 TypeScript 从零实现的终端编码代理。核心是一个**外层循环 + 内层循环**的双层结构，配一套与厂商无关的统一大模型接口和可插拔工具。

不配任何 API key 也能直接跑起来——缺 key 时会自动降级到内置的 mock 模型，把整条链路走通。

## 特性

- **双循环调度**：外层循环处理一轮轮用户请求，内层循环处理当前请求里「模型 ↔ 工具」的多轮往返。
- **统一的流式接口**：OpenAI / Anthropic / mock 三个适配器都收敛成同一个 `StreamFn`，上层只认 `StreamEvent`。
- **六个内置工具**：`read` `write` `edit` `bash` `glob` `grep`，只读工具默认并行执行。
- **上下文自动管理**：清理孤儿工具结果 → 压缩旧轮次 → 按 token 预算整轮丢弃，保证不拆散 `assistant + toolResult` 结构。
- **中途插入指令**：代理运行期间敲进去的话不会丢，会注入下一轮工具往返；串行工具的
  间隙发现插话会立即停手，剩余调用标 skipped 回给模型（借鉴 pi agent 的打断语义）。
- **可脚本化**：print 模式只输出最终答案，进度信息走 stderr，方便管道与重定向。

## 快速开始

```bash
npm install
npm start          # 没有 API key 时自动用 mock 模型
```

想接真实模型，复制 `.env.example` 为 `.env` 并填入 key：

```bash
cp .env.example .env
# OPENAI_API_KEY=sk-...
# ANTHROPIC_API_KEY=sk-ant-...
```

启动时按 `OPENAI_API_KEY` → `ANTHROPIC_API_KEY` → mock 的顺序挑默认模型。也可以显式指定：

```bash
npm start -- --model openai:gpt-4o-mini
npm start -- --model anthropic:claude-3-7-sonnet-latest
```

## 命令行

| 参数                                  | 说明 |
| ----------------------------------- | ---- |
| `-m, --model <provider:id>`           | 指定模型，如 `openai:gpt-4o-mini`、`mock` |
| `-c, --cwd <dir>`                     | 工作目录，默认当前目录 |
| `-p, --print`                         | 非交互模式，只输出最终答案 |
| `-v, --verbose`                       | 显示模型的思考过程 |
| `-h, --help`                          | 显示帮助 |
| `--system-prompt, -sp <text>`         | 完全替换默认系统提示词 |
| `--append-system-prompt, -asp <text>` | 在默认系统提示词末尾追加一段指令 |
| `--user-prompt, -up <text>`           | 显式传入用户提示词（与位置参数互斥） |
| `--assistant-prompt, -ap <text>`      | 注入一段助手 prefill；必须与 `--user-prompt` 同用 |
| `--prefill-commit, -pc <text>`        | 自定义 prefill 后追加的那条接续消息；传 `""` 表示跳过 |
| `--no-markdown`                       | 原样输出 Markdown 源码；管道 / 重定向时自动关闭渲染 |

交互模式下的斜杠命令：`/help` `/model <spec>` `/tools` `/usage` `/clear` `/verbose` `/exit`。  
运行中按 Ctrl-C 中断当前任务，Ctrl-D 退出。

### print 模式

把代理当命令行工具用：答案写 stdout，进度与诊断写 stderr，两者互不污染。

```bash
# 提示词作为位置参数
npm start -- -p "src 下有哪些 ts 文件" --model mock

# 或者走管道 / 重定向（stdin 不是终端时自动进入 print 模式）
echo "找出所有包含 TODO 的文件" | npm start -- --model mock
npm start -- --model mock < question.txt

# 只把答案捞出来接着处理
npm start -- -p "这个项目是干什么的" --model mock | pbcopy
```

退出码：

| 码   | 含义           |
| --- | ------------ |
| `0` | 成功           |
| `1` | 代理出错，或没有任何输出 |
| `2` | 缺少提示词        |

## 提示词覆盖

```bash
# 完全替换默认系统提示词
npm start -- --model mock --system-prompt "你是复读机，只回显用户输入。" -p "hello"

# 在默认段后追加指令
npm start -- --model mock --append-system-prompt "回答保持一行以内。" -p "讲个笑话"

# 显式传入用户提示词（与位置参数互斥）
npm start -- --model mock --user-prompt "用一句话回答"

# 注入助手 prefill：模型会从「好的，」接续
npm start -- --model mock --user-prompt "用一句话回答" --assistant-prompt "好的，"

# 自定义 prefill 后的接续消息
npm start -- --model mock --user-prompt "u" --assistant-prompt "好的，" --prefill-commit ">>> CONTINUE <<<"

# 传空串：跳过接续消息，模型从 prefill 静默接续
npm start -- --model mock --user-prompt "u" --assistant-prompt "好的，" --prefill-commit ""
```

`-ap` 注入 prefill 后会自动追加一条用户消息触发接续轮次。文本默认是 `[control-agent prefill] 请基于上一条助手消息继续。`，可用 `--prefill-commit` 自定义；传空串 `""` 表示**完全跳过追加**，模型会从 prefill 静默接续。prefill 必须跟在 user 之后，所以 `--assistant-prompt` 不允许单独使用。

## 输出渲染

模型吐出来的是 Markdown 源码，终端里会把它渲染成带样式的文本：`# 标题` 去掉井号并加粗、
`**粗体**` / `*斜体*` / `` `行内码` `` 转成对应样式、列表与引用换上暗色标记、围栏代码块整块暗色并
原样保留内容（里面的 `**` 不会被当成强调）。

```bash
# 默认就开着，交互模式和 print 模式（stdout 是终端时）都生效
npm start -- -p "用 Markdown 表格对比一下" --model mock

# 想要原始 Markdown（比如要粘到别处）
npm start -- --no-markdown -p "…" --model mock
```

管道 / 重定向时**自动关闭**渲染，不写任何 ANSI 转义序列——`| pbcopy`、`> out.md` 拿到的仍是干净
的 Markdown 源码。渲染器自己实现（`src/ui/markdown.ts`），不引第三方依赖；流式输出按行攒齐再吐，
所以跨 chunk 断开的 `**bo|ld**` 也不会渲染错。

## 架构

```
用户请求 ──► 后续指令队列 ──┐
                            ▼
                    ┌───────────────┐
                    │   外层循环     │  取后续指令 → 跑内层循环 → 还有就再来一轮
                    └───────┬───────┘
                            ▼
        ┌───────────────────────────────────────┐
        │              内层循环                  │
        │  中途指令 → transformContext →         │
        │  convertToLlm → StreamFn → 执行工具 ──┐│
        │       ▲                               ││
        │       └─────── 有工具调用就继续 ───────┘│
        └───────────────────────────────────────┘
```

内层循环的保护机制：同一个工具调用连续失败 3 次判定无解并停机；工具往返累计 50 轮触发上限。

### 目录结构

```
src/
  index.ts           CLI 入口：组装状态、工具、队列、UI
  types.ts           与厂商无关的内部消息格式
  agent/
    agent.ts         双层循环 + 事件发射
    convert.ts       内部消息 → 模型消息
  context/           模型真正看到的那份上下文（统一出口 index.ts）
    state.ts         会话状态 + 会话树（节点 / ★ / 分支）与 token 估算
    transform.ts     transformContext：清理 / 压缩 / 按预算裁剪
    queue.ts         后续指令队列 + 中途插入队列
  providers/
    types.ts         StreamFn、StreamEvent、LlmTool
    stream.ts        流式事件累积成完整消息
    openai.ts  anthropic.ts  mock.ts
  tools/             read / write / edit / bash / glob / grep / memory（跨会话记忆）
  cron/              定时任务：5 字段 cron 解析 / jobs.json 持久化 / 轮询调度 / 无头执行（详见 src/cron/doc/README.md）
  ui/                renderer（交互）· print（非交互）· input（readline）· repl（REPL 主循环，可被测试注入 FakeInput）
tests/
  run.ts              零依赖运行器入口；编排 + 直接 import 内部模块的单元/集成测试
  registry.ts         用例注册中心，子用例文件自注册
  manual.ts           ManualSession：spawn 真子进程 / in-process FakeInput
  cli-print.ts        spawn Control-Agent 跑 print 模式的端到端用例（21）
  repl-loop.ts        FakeInput 驱动 src/ui/repl.ts 的循环用例（17）
```

## 工具

| 工具      | 说明                       | 会改文件 |
| ------- | ------------------------ | ---- |
| `read`  | 读取文件并附带行号                | 否    |
| `glob`  | 按模式匹配文件，结果按修改时间排序        | 否    |
| `grep`  | 按正则搜索内容，输出 `路径:行号:内容`    | 否    |
| `bash`  | 在工作目录下执行命令，输出过长会截断       | 是    |
| `write` | 整文件写入，必要时自动创建目录          | 是    |
| `edit`  | 精确字符串替换，`oldString` 必须唯一 | 是    |

多个只读工具会自动并行；只要这批调用里有一个会改文件，就退回串行。

## 上下文管理

*`transformContext()`* 在每次调用模型前运行，三步走：

1. **清理**：丢掉没有对应 `toolCall` 的孤儿工具结果。
2. **压缩**：较早轮次里的思考过程抹掉，超长工具结果截断到 4000 字符。
3. **裁剪**：按 token 预算整轮丢弃最老的对话（默认上限 120k、预留 8k、保底最近 2 轮）。

裁剪时会发 `context_pruned` 事件，交互模式打印提示，print 模式写 stderr，不影响退出码。

## 测试

```bash
npm test           # 86 个用例：48 单元/集成 + 21 CLI 子进程 + 17 in-process REPL
npm run typecheck  # tsc --noEmit
```

测试运行器是项目自带的零依赖版本（只 `node:assert/strict` + `tsx`），用例分三类：

| 文件 | 关注 | 用例数 |
| --- | --- | --- |
| `tests/run.ts` | 直接 import 内部模块测单元 / 集成 / 边界，最快 | 48 |
| `tests/cli-print.ts` | spawn 真 Control-Agent 跑 print 模式，端到端测 CLI 参数、退出码、stdout/stderr 分离 | 21 |
| `tests/repl-loop.ts` | 把 `src/ui/repl.ts` 的循环用 `FakeInput` 驱动，in-process 模拟用户在终端里敲键盘 | 17 |

CLI/REPL 两类用例都跑在 `tests/manual.ts` 提供的 `ManualSession` 上：

- `ManualSession.spawn({...})` 起真子进程：`expect()` / `send()` / `expectIdle()` 模拟按键 + 等待输出。
- `ManualSession.inProcess({...})` 不起子进程：`FakeInput.pushLine()` 模拟 readline，agent 的 text_delta 通过 `pumpOutput()` 灌进 session 里 await。

`tests/registry.ts` 是用例注册中心——子文件 `import { test } from "./registry.js"` 自注册，`run.ts` 加一行 import 就接进。零依赖是硬约束，所以这两层抽象都用 `node:assert/strict` + `tsx`，不上 jest/vitest。

### 加测试分类

新写一份 `tests/foo.ts`：

```ts
import { test, assert } from "./registry.js";

test("foo: …", async () => {
  // …
});
```

再到 `tests/run.ts` 顶部加 `import "./foo.js";` 就接进总编排，npm test 就会跑。

## 扩展

**加工具**：在 `src/tools/` 下实现 `Tool` 接口（`name` / `description` / `parameters` / `execute`，会改文件的加 `isMutating: true`），然后注册进 `src/tools/index.ts` 的 `_registry` 对象。`ToolName` 联合会自动跟着更新。

**禁用某些工具**：`AgentOptions.disabledTools` 接受 `ToolName[]`，模型调用列表里的工具会收到「已被禁用」错误，不会真的执行。

**加模型供应商**：在 `src/providers/` 下实现 `StreamFn`（产出 `StreamEvent` 的异步生成器），在 `providers/index.ts` 的 `providers` 表里登记，并把 `ProviderId` 补进 `src/types.ts`。

代码风格、目录约定和已知坑都写在 [AGENTS.md](AGENTS.md) 里，改动前建议先扫一遍。
