# AGENTS.md

给编码代理看的仓库约定。动手改代码前先读完，能省掉大部分返工。

## 这是什么

一个用 TypeScript 写的终端编码代理：外层循环处理一轮轮用户请求，内层循环处理当前请求里
「模型 ↔ 工具」的多轮往返。模型接口与厂商无关（OpenAI / Anthropic / mock 三个适配器收敛成
同一个 `StreamFn`），工具可插拔。

架构细节、工具清单、上下文管理策略见 [README.md](README.md)。

## 项目结构

### 数据流（外层 ↔ 内层）

```mermaid
graph TD
  User([用户]) --> Index[index.ts<br/>parseArgs + main]
  Index -->|有 TTY| Input[ui/input.ts<br/>readline REPL]
  Index -->|管道或 -p| Print[ui/print.ts<br/>单轮 + 收敛成答案]
  Input --> Agent
  Print --> Agent
  Index --> Agent[agent/agent.ts<br/>外层 user · 内层 model↔tool]
  Agent -->|stream 调用| Providers[providers/*<br/>openai / anthropic / mock]
  Agent -->|tool 调用| Tools[tools/_registry<br/>read·write·edit·bash·glob·grep]
  Agent -->|AgentEvent| Renderer[ui/renderer.ts<br/>终端着色输出]
  Agent -->|notice/done/error| Index
```

### 文件树（已排除 node_modules / dist / .workbuddy / *.log / .DS_Store）

```
g/
├── AGENTS.md           本文件：仓库约定、扩展流程、已知坑
├── README.md           架构图、工具表、print 用法、扩展指引
├── package.json
├── tsconfig.json       strict + NodeNext + verbatimModuleSyntax
├── src/
│   ├── index.ts                CLI 入口，TTY / 管道 / -p 三路分发
│   ├── types.ts                全局共享类型（ModelRef / Message / TextContent）
│   ├── agent/                  唯一的调度状态机
│   │   ├── agent.ts              外层 enqueue + 内层 model↔tool 循环
│   │   ├── state.ts              messages / tools / usage 累计
│   │   ├── queue.ts              MessageQueue（中途指令合并）
│   │   ├── context.ts            transformContext：清理→压缩→裁剪
│   │   └── convert.ts            Anthropic ⇄ 内部消息互转
│   ├── providers/              模型适配器（缺 key 自动降级 mock）
│   │   ├── stream.ts             StreamAccumulator（流式 → 完整消息）
│   │   ├── types.ts              StreamEvent / StreamFn / JsonSchema
│   │   ├── openai.ts             OpenAI 兼容，BASE_URL 可覆写
│   │   ├── anthropic.ts          Anthropic API
│   │   ├── mock.ts               离线测试与 print 模式
│   │   └── index.ts              resolveModel + providers 表
│   ├── tools/                  6 个内置工具
│   │   ├── types.ts              Tool 接口 + ok() / fail()
│   │   ├── validate.ts           JSON Schema 参数校验
│   │   ├── fs-utils.ts           resolvePath / truncateText / 跳过隐藏目录
│   │   ├── glob-matcher.ts       glob 模式 → 正则
│   │   ├── read.ts
│   │   ├── write.ts
│   │   ├── edit.ts
│   │   ├── bash.ts               超时 + 输出截断（默认 120s/100K 字符）
│   │   ├── glob.ts               走 fs-utils 的 walk
│   │   ├── grep.ts               ripgrep 后端
│   │   └── index.ts              TOOL_REGISTRY + ToolName 派生源
│   └── ui/                     终端交互
│       ├── input.ts              InputController（readline + ctrl-c）
│       ├── renderer.ts           AgentEvent → 终端着色
│       └── print.ts              -p / 管道 / 缺 TTY 走这条
└── tests/
    └── run.ts                零依赖运行器，当前 20 个用例
```

### 各目录一行职责

- **index.ts** — 解析 CLI 参数，决定走交互 REPL、print 单轮还是 help
- **agent/** — 项目的核心；外层等用户输入，内层跑模型 ↔ 工具直到模型给出终态
- **providers/** — 把各家厂商的流式协议收敛成同一个 `StreamFn`，加供应商只需在这里挂一份
- **tools/** — 6 个内置工具的注册与共享辅助
- **ui/** — 渲染器只读 `AgentEvent`，不知道「模型」或「工具」是谁
- **tests/run.ts** — 端到端 + 单元 + 边界，靠 `node:assert/strict`，无第三方依赖

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm install` | 装依赖 |
| `npm start` | 交互模式（无 API key 时自动降级到 mock） |
| `npm run typecheck` | `tsc --noEmit`，不产出文件 |
| `npm test` | 跑 `tests/run.ts`，零依赖测试运行器 |
| `npm run build` | 编译到 `dist/` |

**提交前必跑：`npm run typecheck && npm test`。** 两个都干净才算改完。

## 代码约定

- **TypeScript strict 全开**，含 `noUnusedLocals`、`noUnusedParameters`、`noFallthroughCasesInSwitch`、
  `noImplicitOverride`。声明了不用的变量/参数会直接编译失败 —— 不要留占位变量。
- **ESM + NodeNext**：相对导入必须写 `.js` 后缀，哪怕源文件是 `.ts`。
  `import { Agent } from "../agent/agent.js";` 才对，写 `../agent/agent` 会报错。
- **`verbatimModuleSyntax: true`**：类型导入必须显式 `import type { ... }`，
  类型再导出用 `export type { ... }`。不能拿普通 `import` 混着导入类型。
- **`switch` 每个 case 都要 `break` / `return`**，不允许贯穿（除非有意且写注释的空 case）。
- **工具不要 `throw`**，用 `src/tools/types.ts` 里的 `ok(text)` / `fail(text)` 返回 `ToolResult`。
  抛异常由 `agent.ts` 统一兜底转成 `fail`。
- **用命名导出**，不用 default。需要 barrel 的目录（`tools/`、`providers/`）放 `index.ts`。
- **文件头写一段中文 JSDoc**，说明这个文件在流程图里负责哪一块。
- **面向用户的文案用简体中文**（UI 输出、错误提示、README、本文件）。

## 加一个工具

1. 在 `src/tools/` 下新建文件，实现 `Tool` 接口：

   ```ts
   import { ok, type Tool } from "./types.js";

   export const fooTool: Tool = {
     name: "foo",
     description: "一句话说清干什么，会作为提示词发给模型。",
     parameters: { type: "object", properties: { /* JsonSchema */ }, required: [] },
     isMutating: false,          // 会改文件/外部状态就写 true
     async execute(args, ctx) {  // ctx: { cwd, signal }
       return ok("结果文本");
     },
   };
   ```

2. 注册进 `src/tools/index.ts` 的 `_registry` 对象（**不是数组**，单源真相是 `_registry`）。

   ```ts
   const _registry = {
     read: readTool,
     write: writeTool,
     edit: editTool,
     bash: bashTool,
     glob: globTool,
     grep: grepTool,
     foo: fooTool,   // ← 这里加一行
   } as const;
   ```

   `ToolName` 联合从 `_registry` 自动派生（`keyof typeof _registry`）。
   `findTool(name: ToolName)` 的参数因此编译期收紧——拼错立刻报错。
   `_registry` 顶部还有 `_AllAreTools` 类型断言，确保每个值 implements `Tool`。

`isMutating` 很关键：一批调用里只要有一个是 `true`，整批就退回串行执行。
只读工具标成 `true` 会白白牺牲并行，会改文件的标成 `false` 则可能并发写坏东西。

## 临时禁用某些工具

`AgentOptions.disabledTools?: ToolName[]` 接受一个名字数组，模型调用这些工具时会收到「已被禁用」错误（不会真的执行），可用工具列表里也会被剔除。常用于：让代理只读（`["write", "edit", "bash"]`）、强制只走 shell（`["write", "edit"]`）。

## 单次工具结果截断

`AgentOptions.maxToolResultChars?: number`（默认 50 000）：单条工具返回文本超过这个上限会被按头/尾截断，写入消息前完成。这与 `transformContext` 里的 `maxToolResultChars` 是不同机制——前者管「新写入」，后者管「旧轮次裁剪」。

## 加一个模型供应商

1. 在 `src/providers/` 下实现 `StreamFn`：一个产出 `StreamEvent`
   （`start` / `text_delta` / `thinking_delta` / `toolcall_delta` / `toolcall_end` / `done` / `error`）
   的异步生成器，用 `providers/stream.ts` 的 `StreamAccumulator` 累积出完整消息。
2. 在 `providers/index.ts` 的 `providers` 表里登记。
3. 把新的 id 加进 `src/types.ts` 的 `ProviderId` 联合类型。

缺 API key 时不要抛错 —— 现有的约定是降级到 mock 并在 `resolved.degraded` 里写明原因，
保证任何环境都能启动。

## 测试

`tests/run.ts` 是自带的零依赖运行器，用 `tsx` 跑，没有 jest/vitest。

```ts
test("用一句话说明验证什么", async () => {
  assert.equal(actual, expected);   // node:assert/strict
});
```

已有辅助：`runAgent({ cwd, prompt, stream?, tools?, allowParallelTools? })` 跑一遍完整代理，
返回 `{ events, messages, durationMs }`；`textOnly(text)` 造纯文本助手消息；
`tempDir()` 开临时目录。

端到端测试用 `createMockStream({ delayMs: 0 })`，不依赖网络也不需要 API key。

## 注意事项 / 已知的坑

- **`src/index.ts` 在模块作用域直接调用 `main()`**，从测试里 import 它会把 CLI 跑起来。
  想测 CLI 相关的逻辑，抽到独立模块（参考 `src/ui/print.ts` 就是这么拆出来的）。
- **交互模式没法用管道测。** stdin 不是终端时会自动走 print 模式，管道进去的内容
  变成一次性提示词而不是 REPL 输入。要验证 REPL 得造伪终端：

  ```bash
  { sleep 1; printf '/verbose\n'; sleep 3; printf '运行 echo hi\n'; sleep 7; printf '/exit\n'; sleep 2; } \
    | script -q /tmp/tty.log npm start --silent -- --model mock
  ```

  输入必须逐行加 3 秒以上间隔。`script` 一次灌进多行会撞上 `InputController` 的竞态 ——
  waiter 为 null 时到达的行会掉进 steering 缓冲区，被当成「中途插入指令」而不是新请求，最终丢失。
  这是既有行为，真人打字速度碰不到，暂未处理。
- **别破坏 `assistant` 与 `toolResult` 的配对。** `transformContext()` 按 `toolCall.id`
  清理孤儿工具结果、按整轮丢弃上下文，都依赖这个结构。改 `agent.ts` 写回消息的部分要特别小心。
- **不要提交** `.env`、`node_modules/`、`dist/`、`*.log`、`.DS_Store`（已在 `.gitignore`）。
  配置样例放 `.env.example`。
