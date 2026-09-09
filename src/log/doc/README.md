# log —— 文件日志

## 职责

把进程内的故障现场（模型流失败、工具异常、顶层崩溃）落盘到
`<cwd>/.c-agent/logs/agent-YYYY-MM-DD.log`，让「终端一闪而过的报错」变成
「可以事后翻的错误记录」。

## 对外接口

| 导出 | 用途 |
| --- | --- |
| `log.debug/info/warn/error(scope, message, err?)` | 记一条日志；`err` 传 Error 对象时自动带 stack |
| `initFileLogging(cwd, { level? })` | 入口调用一次，指定日志目录与级别；未调用前所有写入丢弃 |
| `setLogLevel(level)` | 运行时调整（`off` 关闭） |
| `logFilePath()` | 当前日志文件路径（给排障提示用） |
| `errorText(err)` | 错误对象 → 可读文本（Error 优先 stack），供别处复用 |

## 级别与环境变量

- 默认级别 `info`；环境变量 `C_AGENT_LOG=debug|info|warn|error|off` 覆盖，
  非法值按 `info` 兜底。
- `debug`：循环边界、观察者异常这类只在排查时才看的流水；
- `info`：启动信息、流失败重试等关键路径事件；
- `warn`：工具返回 isError（模型自己能重试的失败）；
- `error`：模型调用失败、工具执行抛异常、顶层崩溃等需要人工介入的事故。

## 铁律

1. **日志绝不抛错**：目录不可写等任何失败 → 静默禁用（`disabled` 标记），
   主流程不感知。日志是诊断设施，不能成为新的故障源。
2. **同步写**（`appendFileSync`）：日志量低（默认 info 起），换「崩溃前最后一行
   一定在盘上」。
3. **保留最近 7 份**：初始化时清理更早的按天文件。
4. **`.c-agent/` 分治**：数据（sessions / config）归 `context/sessions.ts`，
   运行日志归本模块——两条落盘路径，互不掺和。

## 接入点

- CLI 入口（`src/index.ts`）：`initFileLogging(cwd)` + 启动信息 + `main()`
  顶层 catch + `process.on("uncaughtException")` 兜底（先落日志再按原语义崩溃）。
- `src/agent/agent.ts`：`callModel` 失败/重试、工具 `isError` 与执行异常、
  审批门异常、会话持久化失败、`emit` 观察者异常（原先静默吞掉的那类）。
- 桌面端 / 微信 bot：Agent 内部的日志调用天然生效，但需要各自入口调
  `initFileLogging` 才会真正写盘（桌面端 cwd 与 CLI 不同，待接入）。
