# Control-Agent

<p align="center">
  <img src="docs/logo.png" alt="Control-Agent logo" width="280">
</p>

<p align="center">
  <strong>一个模型控制一切：纯视觉操作电脑、结构化控制浏览器、adb 控制手机</strong>
</p>

用 TypeScript 从零实现的终端编码代理，零框架依赖（运行时仅 tsx + Node 内置模块）。核心是
**外层循环 + 内层循环**的双层调度结构，配一套与厂商无关的统一大模型接口、可插拔工具与
Connector 插件运行时。

不配任何 API key 也能直接跑起来——缺 key 时自动降级到内置 mock 模型，整条链路走通。

## 特性

- **双循环调度**：外层循环处理一轮轮用户请求，内层循环处理「模型 ↔ 工具」多轮往返。
- **会话树**：会话是树不是列表——任意节点可开分支、可回退重放，模型只看到当前分支的线性序列。
- **上下文自动管理**：`transformContext` 三步走（清孤儿 → 压旧轮 → 迟滞裁剪），对 prompt cache 亲和。
- **模型无关**：OpenAI / Anthropic / Gemini / mock 四个协议适配器收敛成同一个 `StreamFn`，外加 8 个厂商预设。
- **内置 19 个工具**：文件读写编辑、bash、搜索、跨会话记忆、纯视觉 Computer Use、9 个浏览器控制工具、`ask_user` 提问通道。
- **Connector 插件运行时**：自研 Loader → Registry → Runtime，把外部软件/MCP server 暴露成原生工具，支持 `manifest.enabledBy` 门控。
- **一个内核、三个入口**：CLI、Electron 桌面端、微信 Bot 共用同一个 Agent 类；另有 Cron 定时任务无头执行。
- **审批门**：mutating 工具执行前过人工审批（桌面端），带 write/edit 的 diff 预览。

## 快速开始

```bash
npm install
npm start          # 没有 API key 时自动用 mock 模型
```

接真实模型，复制 `.env.example` 为 `.env` 填入 key：

```bash
cp .env.example .env
# OPENAI_API_KEY=sk-...
# ANTHROPIC_API_KEY=sk-ant-...
# MODEL=gpt-4o-mini            # 可选：覆盖默认模型
# OPENAI_BASE_URL=https://...  # 可选：只填到 /v1 目录
```

也可以启动时显式指定模型：

```bash
npm start -- --model openai:gpt-4o-mini
npm start -- --model anthropic:claude-3-7-sonnet-latest
npm start -- --model mock                # 离线
```

## 三种入口

| 入口 | 启动方式 | 说明 |
| --- | --- | --- |
| **CLI** | `npm start` | 交互 REPL；管道或 `-p` 进 print 模式（答案走 stdout、进度走 stderr） |
| **桌面端** | `npm run desktop:build && npm run desktop:dev` | Electron：审批弹窗（带 diff 预览）、浏览器面板、手机投屏面板、独立消息窗 |
| **微信 Bot** | `npm run bot:weixin` | 每个聊天一个会话，落盘续聊 |
| **Cron** | `src/cron/cli.ts` | 5 字段 cron 解析 / `jobs.json` 持久化 / 无头临时会话执行 |

Windows 桌面端需 `--disable-gpu --no-sandbox` 启动，否则 GPU 进程崩溃退出。

## 命令行参考

| 参数 | 说明 |
| --- | --- |
| `-m, --model <provider:id>` | 指定模型，如 `openai:gpt-4o-mini`、`mock` |
| `-c, --cwd <dir>` | 工作目录，默认当前目录 |
| `-p, --print` | 非交互模式，只输出最终答案 |
| `-v, --verbose` | 显示模型的思考过程 |
| `--resume [id]` | 恢复已持久化的会话；不带 id 取最近一次 |
| `--connectors <dir>` | 扫描目录，加载 connector 暴露的工具 |
| `--system-prompt <text>` | 完全替换默认系统提示词 |
| `--append-system-prompt <text>` | 在默认系统提示词末尾追加指令 |
| `--user-prompt <text>` | 显式传入用户提示词（与位置参数互斥） |
| `--assistant-prompt <text>` | 注入助手 prefill；必须与 `--user-prompt` 同用 |
| `--prefill-commit <text>` | 自定义 prefill 后的接续消息；传 `""` 跳过追加 |
| `--no-markdown` | 原样输出 Markdown 源码；管道/重定向时自动关闭渲染 |

交互模式斜杠命令：`/help` `/model` `/tools` `/usage` `/clear` `/compact` `/sessions` `/cron` `/verbose` `/exit`。
运行中 Ctrl-C 中断当前任务，Ctrl-D 退出。

### print 模式

```bash
npm start -- -p "src 下有哪些 ts 文件" --model mock
echo "找出所有包含 TODO 的文件" | npm start -- --model mock   # stdin 非终端自动进 print
npm start -- -p "这个项目是干什么的" --model mock | pbcopy    # 管道输出自动关闭 ANSI 渲染
```

退出码：`0` 成功；`1` 代理出错或无输出；`2` 缺少提示词。

## 模型接入

协议适配器：`openai`（chat-completions 兼容，BASE_URL 可覆写）、`openai-responses`、
`anthropic`、`gemini`、`mock`（离线测试）。全部收敛为同一个 `StreamFn`，上层只认 `StreamEvent`。

厂商预设（`src/providers/vendors.ts`），填对应 env 即用：DeepSeek、Moonshot Kimi、智谱 GLM、
阿里 Qwen、OpenRouter、OpenCode Zen、OpenCode Go（订阅）、Ollama（本地）。缺 key 一律降级
mock 不抛错，提示语会给出真实的 env 变量名。

## 工具（19 个）

**文件与执行**

| 工具 | 说明 | 会改文件 |
| --- | --- | --- |
| `read` | 读取文件并附带行号，未读完给续读 offset 提示 | 否 |
| `glob` | 按模式匹配文件，结果按修改时间排序 | 否 |
| `grep` | 按正则搜索内容（ripgrep 后端），输出 `路径:行号:内容` | 否 |
| `bash` | 在工作目录下执行命令，超时 + 输出截断 | 是 |
| `write` | 整文件写入，必要时自动创建目录 | 是 |
| `edit` | 精确字符串替换，`oldString` 必须唯一 | 是 |
| `memory` | 跨会话记忆（追加式存储，写入项目根 MEMORY.md） | 是 |

**Computer Use（纯视觉）**

| 工具 | 说明 |
| --- | --- |
| `screenshot` | 截屏返回 JPEG + 尺寸；图片左上角即 `(0,0)`，harness 不做坐标换算 |
| `computer` | click / doubleClick / rightClick / type / hotkey / scroll / drag / focus 八个动作，坐标必须来自最近一次截图 |

Windows 后端：PowerShell + System.Drawing / user32 P/Invoke，多显示器并集 + 高 DPI 处理；
macOS 后端：`screencapture` + JXA ObjC bridge 发 CGEvent。两端均零 npm 依赖。
历史截图会被上下文压缩替换成占位文本（需要时重新截屏），这是有意行为。

**浏览器（内部面板，结构化通道）**

`browser_navigate` `browser_read` `browser_screenshot` `browser_evaluate` `browser_input`
`browser_network` `browser_tabs` `browser_wait` `browser_intercept` —— DOM 级读写、CDP 受信输入、
多标签、抓包/拦截、登录态持久，不弹外部窗口。

**其他**：`ask_user`（模型 → 用户提问通道）。

只读工具自动并行执行；这批调用里只要有一个会改文件，就退回串行。

## 上下文管理

会话是一棵树（节点 + ★ 当前指针），模型只看到 ★ 到根的线性序列。每次调模型前
`transformContext` 三步走：

1. **清理**：丢掉没有对应 `toolCall` 的孤儿工具结果。
2. **压缩**：抹掉较早轮次的思考过程；历史截图替换成占位文本；超长工具结果截断。
3. **裁剪**：按 token 预算迟滞式整轮丢弃最老对话（触发线 0.85、目标 0.70，对 prompt cache 亲和），保证不拆散 `assistant + toolResult` 结构。

会话持久化在 `.control-agent/sessions/`，`--resume` 还原。运行中的插话不会丢——合并进下一轮
工具往返；串行工具间隙发现插话会立即停手，剩余调用标 skipped 回给模型。

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

同一个内核，多个壳：CLI（`src/index.ts`）、Electron 桌面端（`desktop/main/session.ts`）、
微信 Bot（`src/bot/runner.ts`）、Cron（`src/cron/runner.ts`）都 `new Agent(...)` 调
`src/agent/agent.ts` 这一个类。

内层循环保护：同一工具调用连续失败 3 次判定无解停机；工具往返累计 50 轮触发上限。

### 目录结构

```
src/
  index.ts           CLI 入口：TTY / 管道 / -p 三路分发
  session.ts         装配层：三端共用的 assembleSession
  agent/             唯一调度状态机（agent.ts + convert.ts）
  context/           会话树、transformContext、指令队列、会话持久化
  providers/         模型适配器 + 厂商预设（缺 key 降级 mock）
  tools/             19 个内置工具（含 Computer Use 与浏览器工具族）
  connector/         Connector 插件运行时（Loader → Registry → Runtime）
  cron/              定时任务：解析 / 调度 / 持久化 / 无头执行
  bot/               微信 Bot：per-chat 会话落盘续聊
  log/               分级文件日志 → .control-agent/logs/（按天、绝不抛错）
  ui/                renderer · print · input · repl · markdown
desktop/
  main/              Electron 主进程（审批门、浏览器面板、手机投屏、tray）
  renderer/          React 渲染层（Vite 构建）
tests/               零依赖测试运行器 + 三类用例
connectors-mcp/      MCP 桥接插件（browser-use 等，manifest 门控）
```

## Connector 插件

`src/connector/` 是自研插件运行时：扫描插件目录 → 校验 manifest → 注册工具 → 运行时暴露
给 Agent。插件可以把外部软件（浏览器、记忆库、MCP server……）封装成原生工具，也可以反把
Control-Agent 的能力通过 `protocol/mcp-server.ts` 对外暴露成 MCP server。

默认关闭的插件走 `manifest.enabledBy` 环境变量门控（如 `C_AGENT_BROWSER_USE=1` 启用外部
browser-use 兜底通道），不显式点名就不加载。

## 设计哲学

如果模型越来越强大，哪些 agent 能力是可以消失的？harness 里的每段逻辑都拿这个问题过一遍：
模型对齐变好后会自然做对的事，优先让给模型，而不是在代码里替它兜底。消失掉的代码就是最好的代码。

评估改动沿「五支柱」过一遍：**Model / Context / Tool / Permission / Environment**——
每根支柱都问「这件事是 harness 的职责，还是模型变强后自己能做对？」
详见 [AGENTS.md](AGENTS.md)。

## 测试

```bash
npm test             # 272 个用例
npm run typecheck    # tsc --noEmit
npm run typecheck:desktop
```

测试运行器是项目自带的零依赖版本（只 `node:assert/strict` + `tsx`），分三类：
直接 import 内部模块的单元/集成测试、spawn 真子进程的 CLI 端到端（`tests/cli-print.ts`）、
`FakeInput` 驱动 REPL 循环的 in-process 用例（`tests/repl-loop.ts`）。
新用例写到 `tests/foo.ts` 并在 `run.ts` 加一行 import 即接入。

## 扩展

- **加工具**：在 `src/tools/` 实现 `Tool` 接口，注册进 `src/tools/index.ts` 的 `_registry`——`ToolName` 联合自动派生，单处定义。
- **加模型供应商**：实现 `StreamFn`（产出 `StreamEvent` 的异步生成器），登记进 `providers/index.ts`，`ProviderId` 补进 `src/types.ts`。
- **加 Connector**：按 manifest 规范写插件目录，`--connectors <dir>` 或入口装配时扫描加载。

代码风格、目录约定和已知坑都在 [AGENTS.md](AGENTS.md)，动手改代码前建议先读完。
