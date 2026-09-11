# tools/ —— 25 个内置工具

**关注点**：把模型能调用的「动作」都收口在这里。模型看到的是 `LlmTool[]`（带 JSON Schema
签名），执行时拿到的是 `Tool.execute(args, ctx)` 的统一签名。每个工具都标 `isMutating`
以决定能不能并行。

## 文件清单

| 文件 | 行数级 | 职责 |
| --- | --- | --- |
| `index.ts` | ~65 | `TOOL_REGISTRY`（单一真相源）；`ToolName` 联合派生；`allTools` / `describeToolsForModel()` |
| `types.ts` | ~40 | `Tool` 接口、`ToolContext { cwd, signal }`、`ToolResult { content, isError }`、`ok()` / `fail()` / `okImage()` 辅助 |
| `validate.ts` | ~? | `validateParams(schema, args)`：用本目录精简版 `JsonSchema` 校验参数 |
| `fs-utils.ts` | ~? | `resolvePath()`、`truncateText()`、walk 时跳过隐藏目录与 `IGNORED_DIRS` |
| `glob-matcher.ts` | ~? | glob 模式 → 正则 |
| `read.ts` | ~? | 读文件 + 自动截断（默认 `maxBytes` 2MB，行数 + 行宽双重截断） |
| `write.ts` | ~? | 写文件；需要时自动 `mkdir -p` |
| `edit.ts` | ~? | 精确替换（oldString / newString，含全局替换选项） |
| `bash.ts` | ~? | 执行 shell；超时默认 120s、上限 600s；输出按 `MAX_OUTPUT_CHARS` 截断；灾难命令护栏（POSIX + Windows 双套模式，`CAGENT_ALLOW_DANGEROUS=1` 整体关闭）；`isMutating: true` |
| `glob.ts` | ~? | 走 `fs-utils.walk` 的 glob 匹配 |
| `grep.ts` | ~? | 走 `parseSse` 类似的字节流解析，最终落到 ripgrep 后端 |
| `memory.ts` | ~? | 跨会话记忆：append（带时间戳追加到项目根 `MEMORY.md`）/ read（读回，保留尾部 8K）；注入端在 `session.ts` 的 `collectProjectMemory` |
| `screenshot.ts` | ~110 | Computer Use 感知端：PowerShell + System.Drawing 截全虚拟屏 → JPEG dataUrl（Windows only，零 npm 依赖）；`isMutating: false` |
| `computer.ts` | ~300 | Computer Use 执行端：鼠标点击/双击/右键、type（剪贴板粘贴）、hotkey（SendKeys 映射）、scroll、drag（插值拖拽）、focus（激活窗口）；坐标取自 screenshot 图片，内部加虚拟屏偏移换算；Windows（PowerShell + user32）与 macOS（darwin-cu.ts）双后端；`isMutating: true` |
| `ask-user.ts` | ~110 | 模型 → 用户的结构化提问通道：问题 + 可选选项，答案作为 toolResult 回灌。端点经 `setAskUserHandler()` 注入实现（REPL 借 `LoopInput.ask()` 抓下一行）；未注入时优雅 fail 并引导模型自行兜底；`isMutating: false` |
| `browser.ts` | ~430 | browser_* 工具族（9 个）：agent 操控桌面端内部浏览器面板（导航/读取/截图/evaluate/受信输入/网络抓包）。端点经 `setBrowserBackend()` 注入控制器（实现体在 `desktop/main/browser-view.ts`）；CLI 端不注入优雅 fail |

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
interface ToolResult   { content: (TextContent | ImageContent)[]; isError: boolean; }

function ok(text:  string): ToolResult;
function okImage(dataUrl: string, text: string): ToolResult;   // screenshot 用
function fail(text: string): ToolResult;
```

**约定**：

- `execute()` 不抛异常——失败用 `fail(...)` 返回；异常由 `agent.ts:executeToolCalls` 兜底转 `fail`
- `isMutating: true` ⇒ `agent.ts` 会串行 await；`false` ⇒ 只读，可并行
- `content` 支持 `TextContent` 与 `ImageContent`（dataUrl）混排：screenshot 返回
  `okImage(dataUrl, 说明文本)`，图片随 toolResult 一起进模型上下文（OpenAI 端转
  `image_url` part，Anthropic 端转 base64 source）；transformContext 在压缩旧轮次时
  把图片块替换成占位文本（省 token，需要时重新截图）

## 工具表与并行性

| 名称 | 用途 | isMutating | 关键参数 |
| --- | --- | --- | --- |
| `read` | 读文件 | false | `path`, `limit?`, `fromLine?`（2MB / 行数 / 行宽三重截断） |
| `write` | 写文件 | true | `path`, `content`（需要时自动 `mkdir -p`） |
| `edit` | 精确替换 | true | `path`, `oldString`, `newString`, `replaceAll?` |
| `bash` | 跑 shell | true | `command`, `timeLimitMs?`（默认 120s，上限 600s，输出按 `MAX_OUTPUT_CHARS` 截断） |
| `glob` | 路径匹配 | false | `pattern`（glob 模式） |
| `grep` | 内容搜索 | false | `pattern`, `path?`, `include?`（ripgrep 后端） |
| `memory` | 跨会话记忆 | true | `action`(append/read), `content?` |
| `screenshot` | 截屏（Computer Use 感知） | false | 无参数；返回 JPEG + 尺寸 + 虚拟屏原点 |
| `computer` | 鼠标键盘（Computer Use 执行） | true | `action`(click/doubleClick/rightClick/type/hotkey/scroll), `x?`, `y?`, `content?`, `keys?`, `direction?`, `amount?` |
| `ask_user` | 向用户提问并等答案 | false | `question`, `choices?`（2-4 个候选，用户仍可自由输入） |
| `browser_navigate` | 打开/导航内部浏览器面板 | false | `url?`（像 URL 直开、像搜索词走 Bing；缺省只开面板） |
| `browser_read` | 读面板当前页面文本 | false | 无参数；URL + 标题 + body.innerText（2 万字符截断） |
| `browser_screenshot` | 截面板画面 | false | `fullPage?`（true 走 CDP captureBeyondViewport 截整页）；JPEG + 尺寸，坐标语义同 screenshot |
| `browser_evaluate` | 页面主 frame 执行任意 JS | true | `expression`（可 await；对象结果 JSON 序列化） |
| `browser_input` | 派发受信输入事件（isTrusted=true） | true | `action`（click/dblclick/rightclick/move/drag/type/key/scroll）+ `x/y`、`x2/y2?`（drag）、`text/key`、`dx/dy`、`delayMs?`、`modifiers?`；坐标与截图同坐标系 |
| `browser_network` | 观察页面网络流量（CDP Network 域） | false | `mode`（start/stop/list/body）+ `requestId?`、`urlFilter?`、`limit?`；list 出 URL/方法/状态/大小，body 读响应体 |
| `browser_tabs` | 多标签管理（list/new/switch/close） | true | `action`（list 缺省）+ `id?`（switch/close 必填）、`url?`（new）；browser_* 其余工具作用于活动标签 |
| `browser_wait` | 等待条件满足（替代盲轮询） | false | `load?`、`selector?`、`networkIdleMs?`、`timeoutMs?`（可组合，缺省等加载完成） |
| `browser_intercept` | 拦截/改写页面网络请求（CDP Fetch 域） | true | `urlPattern`（* 通配）+ `action`（block/fulfill）+ `status?/body?/contentType?`、`mode?`（set 缺省/clear）；规则累积生效 |
| `browser_cookie` | Cookie 管理（CDP Network 域） | true | `mode`（list 缺省/set/delete）+ `name?/value?/url?/domain?/path?/secure?/httpOnly?`；set 需要 url 或 domain 至少一个；httpOnly cookie 只有这条通道能读写 |
| `browser_file` | 文件通道（上传/下载记录） | true | `action`（upload/downloads）+ `selector?`（file input 的 CSS 选择器）+ `paths?`（本地绝对路径）；下载静默落盘到系统下载目录（重名自动加序号），不弹保存对话框 |
| `mobile_screen` | 手机截屏（adb screencap） | false | `serial?`（多设备必填）；PNG dataUrl + `wm size`，坐标语义同 screenshot |
| `mobile_ui` | 手机控件树（uiautomator dump） | false | `serial?`；输出 text/desc/id/bounds 中心坐标的控件清单——手机 GUI 的文本层主力 |
| `mobile_act` | 手机操作（input/am start） | true | `action`（tap/swipe/text/key/start）+ `x/y`、`x2/y2?`、`durationMs?`、`content?`、`key?`、`target?`、`serial?`；坐标用 mobile_ui 的 bounds 中心最稳 |
| `uia_tree` | 桌面控件树（UIA 文本层） | false | `title?`（窗口/应用名子串；不给 = 只列顶层窗口索引）、`maxNodes?`；输出中心坐标可直接给 computer |

### ask_user 通道注入约定

- **通道是端点能力**：工具本体只管请求/回灌形状；谁来回答由运行端在启动时
  `setAskUserHandler(fn)` 注入，退出/销毁时传 `undefined` 撤下。
  - REPL：`src/ui/repl.ts` 的 `createReplAskUser`——问题渲染到 output，借
    `LoopInput.ask()` 等下一行（agent 运行期间主循环不占 ask() 的 waiter，
    不会打架）；纯数字输入落在选项序号范围内会映射成选项原文。
  - print / 无人值守：不注入 → 工具 fail，提示语引导模型「做合理假设并在
    最终回答里说明」。
  - 桌面端（2026-09-09 已接）：SessionManager 构造时注入实现——广播
    `ask_user` 事件，渲染层在 Composer 上方弹问答卡（选项按钮 + 自由输入），
    答案经 `answerAsk` RPC 回主进程唤醒挂起的 Promise，`ask_user_done`
    广播收尾。空答案 = 跳过（视为中断）。WS 独立 UI 走同一条
    dispatchApi 通道，天然可用。
  - bot：尚未接（挂起等下一条异步消息即可，接法同上）。
- **中断语义**：实现方应尊重 `ctx.signal`，agent 被 abort 时返回 `null`；
  工具侧把 `null` 转成 `fail("提问被中断…")`，不抛异常。
- **不走 approvalGate**：提问本身就是知情同意机制，`isMutating: false`，
  桌面端不要再给它套审批弹窗（会双重弹窗）。

### browser_* 通道注入约定（2026-09-10）

- **面板是端点能力**：只有 Electron 桌面端有内部浏览器面板（`desktop/main/browser-view.ts`
  的 WebContentsView），main 进程与 Agent 同进程，启动时 `setBrowserBackend()` 注入；
  CLI / print / bot 不注入 → 优雅 fail，提示改用 read/curl。后端闭包实时读当前面板，
  面板开关多次无需重注。
- **与 Computer Use 的分工**：面板内优先结构化操作（browser_evaluate 精确选元素、
  token 便宜）；只有视觉渲染效果（canvas/样式）用 browser_screenshot 看，真实鼠标
  轨迹（hover 悬浮菜单）才用 computer 对屏幕坐标操作。
- **CDP 能力（2026-09-10 续）**：受信输入（Input 域）、网络抓包（Network 域）、请求拦截/伪造（Fetch 域，
  `Fetch.requestPaused` → continueRequest / failRequest / fulfillRequest，规则按标签页隔离）、全页截图
  （Page.captureScreenshot captureBeyondViewport）经 Electron 内置 `webContents.debugger`
  实现——进程内 attach，**绝不开 `--remote-debugging-port`**（本机任意进程都能连，
  等于把登录态 cookie 和浏览器控制权暴露给所有本地进程，安全红线）。attach 一次常驻，
  detach 事件里收尾（netEnabled=false），view 重建时清记录。
- **权限边界**：navigate / read / screenshot / network 只读（`isMutating: false`）；
  browser_evaluate `isMutating: true`——等价于以页面身份做事（可点击/提交表单），
  桌面端过 approvalGate。用户定调 agent 拥有面板的完整操控权限，CLI 端无审批门。
- **边界**：evaluate 只作用于页面主 frame，跨域 iframe 内部访问不到（CDP 网络抓包同样
  抓不到跨进程 iframe 的流量）；browser_input 的 type 逐字符 keyDown/keyUp（触发页面
  keydown 监听），key 支持具名键 + 单字符；响应体依赖浏览器缓存，导航离开后可能取不到；
  后端抛
  「面板未打开」时工具层转成「先调 browser_navigate」的可执行提示。

### Mobile Use 与 uia_tree —— 三通道分层（2026-09-11）

- **分层原则的落地形态**：每条通道都有「文本层 + 视觉层」，文本层优先——
  - 浏览器：browser_read/evaluate（文本）+ browser_screenshot（视觉兜底）；
  - 电脑：`uia_tree`（UIA 控件树，文本）+ screenshot/computer（视觉兜底）；
  - 手机：`mobile_ui`（uiautomator 控件树，文本）+ `mobile_screen`（视觉兜底）。
- **坐标口径**：mobile_ui/mobile_screen 的坐标都是手机屏幕像素（同一坐标系），
  bounds 中心点最稳；uia_tree 输出的是桌面屏幕物理像素（Windows）/ 逻辑点
  （macOS），可直接给 computer。各通道坐标不通用，别跨通道喂。
- **多设备**：mobile_* 的 `serial` 参数缺省时用唯一设备；adb 报
  "more than one device" 时 fail 信息里带 `adb devices` 的设备列表。
- **转义**：`mobile_act` 的 text 走设备端单引号包裹（`'` → `'\''`），空格转
  `%s`（input text 的官方约定）；任意 adb 命令仍可直接走 bash。
- **下载**：browser-view.ts 的 will-download 静默落盘到系统下载目录（重名加
  序号），不弹保存对话框；记录上限 50 条，browser_file action=downloads 查询。
- **screencap 必须走 buffer**：`execFile` 缺省 utf8 解码会毁 PNG——mobile.ts
  专门有 `runAdbBuffer`（`encoding: "buffer"`），别合并回文本路径。

### Computer Use 坐标与安全约定

- **坐标语义**：模型看到的截图左上角是 `(0,0)`；`computer` 执行时把该坐标加上
  虚拟屏原点（`VirtualScreen.X/Y`）换成物理像素。两端都用 `SetProcessDPIAware`
  保证 DPI 缩放下物理像素一致。
- **安全边界**：`computer` 影响真实桌面且无 git 回滚——桌面端必须过 `approvalGate`；
  CLI 无审批门，靠动作留痕（返回值记录每次操作）+ 屏幕变化可见兜底。
  这是 Permission 支柱「不可逆操作过人」的直接案例。
- **已知副作用**：`type` 走剪贴板粘贴（与 UI-TARS pyautogui `input_swap` 同策略），
  会覆盖用户当前剪贴板；工具描述里已向模型明示。
- **`type` 里的中文**：走 Unicode 剪贴板粘贴，比 SendKeys 逐字符可靠。
- **`drag`**：按下后 14 步插值移动再松开——拖拽类操作对瞬时大位移不友好。
  Windows 与 macOS 分别用 mouse_event / kCGEventLeftMouseDragged。
- **`focus`**：Windows 按**窗口标题**子串（不区分大小写）EnumWindows 匹配第一个
  可见窗口，最小化先 SW_RESTORE 再 SetForegroundWindow；macOS 按**应用/进程名**
  子串走 System Events 置 frontmost。应用启动/进程管理刻意不加——bash 已覆盖
  （消失之问）。

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

- **`screenshot` / `computer` 尚未在真实桌面端到端验证**（2026-09-08）：脚本依赖
  `Add-Type` 做 P/Invoke（SetProcessDPIAware / mouse_event），在受安全策略限制的
  运行环境（如本仓库开发会话的钩子）里会被拒绝执行，`execute` 返回 `fail`。
  首次真实使用前先手动验证：`screenshot` → 模型能否拿到图；`computer` click →
  鼠标是否移动。类型链路（toolResult 图片 → openai/anthropic → 模型）已有单测覆盖。
- **`bash` 里的 `grep` 在本环境不可靠**：实测 `grep -n "..." tests/run.ts` 假阴性。
  排查时改用本仓库自带的 `Grep` 工具（ripgrep 后端）。
- **`edit` 不知道跨文件边界**：精确替换是基于文件内容的字符串匹配，不会自动选
  「同名的多个文件」。多文件编辑要 `read` 看清楚后再 `edit` 各一份。
- **`write` 写盘是覆盖式**：传 `content` 就是整文件覆盖；做局部修改应该用 `edit`。
- **`read` 大文件截断是单向的**：从顶部 `limit` 行 / `fromLine` 起的内容，不保留两侧。
  超大文件先 `grep` 精准定位行号，再 `read` 拿对应区间。
- **同一文件多次编辑必须串行**：并行 Edit 同一文件会互相覆盖（各自基于旧快照写盘），
  报成功但改动丢失。2026-09-08 在 toolResult 图片通道改造中踩过。
