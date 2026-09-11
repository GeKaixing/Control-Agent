目标：

> 构建一个基于 TypeScript 的 Connector Runtime，让 AI Agent 可以统一连接各种开源软件、API、桌面应用。

类似：

* MCP Server 管理器
* VS Code Extension Host
* Docker Plugin Runtime
* Browser Extension Runtime

的结合体。

---

# Connector Runtime 开发文档

版本：v0.1
语言：TypeScript
运行环境：Node.js / Electron

---

# 1. 项目定位

## 1.1 什么是 Connector Runtime

Connector Runtime 是 Agent 与外部软件之间的中间层。

职责：

1. 加载 Connector 插件
2. 管理 Connector 生命周期
3. 注册 Tool 能力
4. 转换不同软件 API
5. 提供统一 MCP 接口
6. 管理权限、安全、日志

整体架构：

```text
                 User

                  |
                  v

             AI Agent Core

                  |
                  v

          Connector Runtime

                  |
        +---------+---------+
        |         |         |
        v         v         v

    Office     Video      Design
 Connector  Connector  Connector


        |         |         |

        v         v         v

   ONLYOFFICE  FFmpeg    Blender

```

---

# 2. 核心设计原则

## 2.1 Agent 不感知软件

错误：

```typescript
agent.call(
 "blender.create_model"
)
```

Agent绑定 Blender。

正确：

```typescript
agent.call(
 "model.create"
)
```

Runtime决定：

```
model.create

↓

Blender Connector
```

---

## 2.2 Connector 是插件

类似 VS Code：

```
connector-runtime

    |
    |
 connectors

    |
    |
 blender
 office
 video

```

---

# 3. 技术架构

```text
connector-runtime

src/

├── core
│
├── registry
│
├── loader
│
├── runtime
│
├── security
│
├── protocol
│
└── connectors


```

---

# 4. 核心模块设计

## 4.1 Connector Loader

负责发现插件。

目录：

```
connectors/

├── blender
│
├── onlyoffice
│
└── ffmpeg

```

加载：

```typescript
class ConnectorLoader {


 load(path:string){

 }


}
```

---

# 4.2 Connector Manifest

每个 Connector 必须提供：

```
connector.json
```

示例：

```json
{
"name":"blender",
"version":"1.0.0",

"type":"desktop",

"capabilities":[

 {
  "name":"model.create",
  "description":"Create 3D model"
 },


 {
  "name":"model.render",
  "description":"Render scene"
 }

]

}
```

## 4.2.1 默认关闭的 connector：`enabledBy`

manifest 里写 `enabledBy`（值为环境变量名）表示**默认不加载**，只有该变量取真值时才加载：

```json
{
  "id": "browser-use",
  "enabledBy": "C_AGENT_BROWSER_USE"
}
```

判定在 `ConnectorLoader.scan()` 一处收口（读 process.env，真值口径：非空且不是 `0/false/no/off`），
命中的 connector 进 `LoaderResult.skipped`（不是 `failed`，也不是错误），各入口照实播报。

为什么放 manifest 而不是各入口维护黑名单：开关是插件自己的属性。
典型用例 `browser-use` —— 它起独立 Chromium 进程，与桌面端内置浏览器面板
（`desktop/main/browser-view.ts`）职责重叠，两套同时在场会让模型选错工具、并多弹一个外部窗口；
写进 manifest 后 CLI / 桌面端 / bot 都不需要知道这件事。

---

# 4.3 Connector Interface

所有 Connector 必须实现：

```typescript
interface Connector {


 id:string;


 start():Promise<void>


 stop():Promise<void>


 getTools():Tool[]


 execute(
   tool:string,
   params:any
 ):Promise<any>


}
```

---

# 5. Tool 系统

Agent 最终看到的是 Tool。

例如：

```typescript
{
name:"document.create",

description:
"Create office document",

inputSchema:{
 type:"object",

 properties:{
   title:{
    type:"string"
   }
 }

}

}
```

---

# 6. MCP Adapter

Runtime 对外暴露 MCP。

结构：

```
Agent

 |

MCP Client

 |

Connector Runtime

 |

Connector

```

实现：

```typescript
class MCPServer {


listTools(){

 return registry.tools

}



callTool(
name,
args
){

 return runtime.execute(
   name,
   args
 )

}

}
```

---

# 7. Connector 生命周期

状态：

```
INSTALL

 |

LOAD

 |

READY

 |

RUNNING

 |

STOPPED

```

例如 Blender：

```
用户请求:

model.render


Runtime:

启动 Blender

连接 Python API

执行任务

返回结果

关闭

```

---

# 8. Connector 示例

## Blender Connector

目录：

```
blender/

├── connector.json

├── index.ts

└── blender-api.ts

```

代码：

```typescript
export default class BlenderConnector
implements Connector{


id="blender"



async start(){

 await startBlender()

}



getTools(){

return [

{
name:"model.render"
}

]

}



async execute(
tool,
params
){

return blenderApi.call(
tool,
params
)

}


}
```

---

# 9. Adapter 层

因为软件接口不同：

需要 Adapter。

例如：

## Blender

```
Python API
```

## LibreOffice

```
UNO API
```

## FFmpeg

```
CLI
```

统一：

```
Connector

 |

Adapter

 |

Software

```

---

# 10. 支持类型

Runtime 支持：

## API Connector

例如：

GitHub

```
REST API

↓

Connector

```

---

## CLI Connector

例如：

FFmpeg

```
Connector

↓

child_process

↓

ffmpeg

```

---

## Python Connector

例如：

Blender

```
Node

↓

Python Bridge

↓

Blender

```

---

## GUI Connector

最后方案：

```
Connector

↓

Playwright
PyAutoGUI

↓

Desktop App

```

---

# 11. 权限系统

Connector 声明：

```json
{
"permissions":[

"filesystem.read",

"filesystem.write",

"process.start"

]
}
```

Runtime审批：

```
Blender wants:

start_process

Allow?

[Yes]
[No]

```

---

# 12. 配置系统

目录：

```
~/.connector-runtime/


config.json


connectors/

```

配置：

```json
{

"enabled":[

"blender",

"office"

]

}
```

---

# 13. 日志系统

统一：

```
logs/


runtime.log

connector.log

security.log

```

---

# 14. Package 结构

npm monorepo：

```
connector-runtime


packages/


core

@mcp

@registry

@loader


connectors/


blender

office

ffmpeg


```

---

# 15. 开发一个 Connector 流程

例如开发 Office Connector：

步骤：

## Step 1

创建：

```
connectors/office
```

## Step 2

定义能力：

```json
{
"tools":[

"document.create",

"spreadsheet.read"

]

}
```

## Step 3

实现 Adapter：

```
office-api.ts
```

## Step 4

注册：

```bash
connector install office
```

## Step 5

Agent 自动发现：

```
document.create

available
```

---

# 16. 第一阶段 MVP

不要一开始做全部。

建议：

## Phase 1

完成：

✅ Connector Loader
✅ Tool Registry
✅ MCP Server
✅ 一个 Connector

选择：

FFmpeg Connector

因为简单：

```
Agent

↓

video.cut

↓

ffmpeg

```

---

## Phase 2

加入：

* Blender
* LibreOffice
* GitHub

---

## Phase 3

加入：

* 权限
* 商店
* 自动安装

---

# 最终目标

形成：

```
                 AI Desktop OS


                 Agent Core

                      |

             Connector Runtime

                      |

 -------------------------------------------------

 Office       Video       Design       Dev

 ONLYOFFICE   FFmpeg      Blender      GitHub


 -------------------------------------------------


```

