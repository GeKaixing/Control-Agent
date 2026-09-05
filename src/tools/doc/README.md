# tools/ —— 6 个内置工具

**关注点**：把模型能调用的「动作」都收口在这里。模型看到的是 `LlmTool[]`（带 JSON Schema
签名），执行时拿到的是 `Tool.execute(args, ctx)` 的统一签名。每个工具都标 `isMutating`
以决定能不能并行。

## 文件清单

| 文件 | 行数级 | 职责 |
| --- | --- | --- |
| `index.ts` | ~60 | `TOOL_REGISTRY`（单一真相源）；`ToolName` 联合派生；`findTool()` / `toolNames()` / `allTools` / `describeToolsForModel()` |
| `types.ts` | ~30 | `Tool` 接口、`ToolContext { cwd, signal }`、`ToolResult { content, isError }`、`ok()` / `fail()` 辅助 |
| `validate.ts` | ~? | `validateParams(schema, args)`：用本目录精简版 `JsonSchema` 校验参数 |
| `fs-utils.ts` | ~? | `resolvePath()`、`truncateText()`、walk 时跳过隐藏目录与 `IGNORED_DIRS` |
| `glob-matcher.ts` | ~? | glob 模式 → 正则 |
| `read.ts` | ~? | 读文件 + 自动截断（默认 `maxBytes` 2MB，行数 + 行宽双重截断） |
| `write.ts` | ~? | 写文件；需要时自动 `mkdir -p` |
| `edit.ts` | ~? | 精确替换（oldString / newString，含全局替换选项） |
| `bash.ts` | ~? | 执行 shell；超时默认 120s、上限 600s；输出按 `MAX_OUTPUT_CHARS` 截断；`isMutating: true` |
| `glob.ts` | ~? | 走 `fs-utils.walk` 的 glob 匹配 |
| `grep.ts` | ~? | 走 `parseSse` 类似的字节流解析，最终落到 ripgrep 后端 |

## `Tool` 接口

```ts
interface Tool {
  name: string;
  description: string;           // 会被拼到模型看到的描述里
  parameters: JsonSchema;        // 精简版 JSON Schema
  isMutating: boolean;           // true ⇒ 不能并行
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

interface ToolContext { cwd: string; signal: AbortSignal; }
interface ToolResult   { content: TextContent[]; isError: boolean; }

function ok(text:  string): ToolResult;
function fail(text: string): ToolResult;
```

**约定**：

- `execute()` 不抛异常——失败用 `fail(...)` 返回；异常由 `agent.ts:executeToolCalls` 兜底转 `fail`
- `isMutating: true` ⇒ `agent.ts` 会串行 await；`false` ⇒ 只读，可并行
- 返回 `content` 用 `TextContent[]`（统一多模态预留位），目前每个工具都只用 `[{ type: "text", text: "..." }]`

## 工具表与并行性

| 名称 | 用途 | isMutating | 关键参数 |
| --- | --- | --- | --- |
| `read` | 读文件 | false | `path`, `limit?`, `fromLine?`（2MB / 行数 / 行宽三重截断） |
| `write` | 写文件 | true | `path`, `content`（需要时自动 `mkdir -p`） |
| `edit` | 精确替换 | true | `path`, `oldString`, `newString`, `replaceAll?` |
| `bash` | 跑 shell | true | `command`, `timeLimitMs?`（默认 120s，上限 600s，输出按 `MAX_OUTPUT_CHARS` 截断） |
| `glob` | 路径匹配 | false | `pattern`（glob 模式） |
| `grep` | 内容搜索 | false | `pattern`, `path?`, `include?`（ripgrep 后端） |

## `describeToolsForModel()` —— 给模型的工具清单

```ts
// tools/index.ts
function describeToolsForModel(tools: Tool[] = allTools): LlmTool[]
```

把工具签名转成模型能理解的 `LlmTool`，**并把参数的 JSON Schema 文字化后拼到 description
末尾**，因为模型看到 Markdown 渲染的可读签名比纯 JSON 更容易一次调用成功。
（参见 `tools/validate.ts:describeSchema`。）

## 注册表与编译期校验

```ts
// tools/index.ts
const _registry = {
  read:  readTool,
  write: writeTool,
  edit:  editTool,
  bash:  bashTool,
  glob:  globTool,
  grep:  grepTool,
} as const;

export const TOOL_REGISTRY = _registry;
export type ToolName = keyof typeof TOOL_REGISTRY;

type _AllAreTools = (typeof _registry)[ToolName] extends Tool ? true : "某个工具不 implements Tool";
const _checkAll: _AllAreTools = true;
void _checkAll;   // 编译期失败时会把诊断推到这一行
```

`as const` + `_checkAll` 让所有「工具必须 `implements Tool`」的破坏在编译期出现。

## 共享辅助（fs-utils.ts）

| 函数 / 常量 | 用途 |
| --- | --- |
| `resolvePath(input, cwd)` | 解析相对路径、处理 `~` 展开 |
| `truncateText(text, maxChars)` | 按头/尾等量截断（中间插 `…`），常用于压缩旧轮工具结果 |
| `walk(cwd, opts)` | 遍历文件树，跳过 `.git` 等 `IGNORED_DIRS` 与隐藏目录 |
| `IGNORED_DIRS` | `["node_modules", ".git", "dist", "build", "coverage", ".next", ".cache", ".workbuddy", "vendor"]` |
| `MAX_OUTPUT_CHARS` | bash 输出截断阈值 |

## 路径围栏 —— 已移除

> **2026-09-05 用户选择「完全放开」**：原 `assertInsideCwd()` 函数本体及 write/edit 调用
> 已删除。`bash` 工具从来没有任何路径限制，代理随时能 `echo x > /任意路径`，围栏
> 本来就是漏的，保留意义不大。

仍然存在的**非路径**限制（保留是为了安全 / 体验）：

| 工具 | 限制 |
| --- | --- |
| `bash` | 超时默认 120s / 上限 600s；输出按 `MAX_OUTPUT_CHARS` 截断 |
| `read` | `maxBytes` 2MB；行数 + 行宽双重截断 |
| `glob` / `grep` | `maxFiles` 5000；跳过隐藏文件 / 隐藏目录与 `IGNORED_DIRS` |

`~` 在 `write` / `edit` 里**自 2026-09-05 起真实生效**（此前 `resolvePath` 展开成 `$HOME/x`
后立刻被围栏拒绝，等于死代码）。

## 如何新增工具

最小动作清单：

1. 新建 `tools/<name>.ts`，实现 `Tool` 接口（注意 `isMutating` 标对）
2. 在 `tools/index.ts` 的 `_registry` 里加一项；类型不匹配会在 `_checkAll` 行报错
3. 测试覆盖：参数校验、失败返回 `fail(...)` 而不是抛、并发时不与其他 mutating 工具并行

## 已知坑

- **`bash` 里的 `grep` 在本环境不可靠**：实测 `grep -n "..." tests/run.ts` 假阴性。
  排查时改用本仓库自带的 `Grep` 工具（ripgrep 后端）。
- **`edit` 不知道跨文件边界**：精确替换是基于文件内容的字符串匹配，不会自动选
  「同名的多个文件」。多文件编辑要 `read` 看清楚后再 `edit` 各一份。
- **`write` 写盘是覆盖式**：传 `content` 就是整文件覆盖；做局部修改应该用 `edit`。
- **`read` 大文件截断是单向的**：从顶部 `limit` 行 / `fromLine` 起的内容，不保留两侧。
  超大文件先 `grep` 精准定位行号，再 `read` 拿对应区间。
