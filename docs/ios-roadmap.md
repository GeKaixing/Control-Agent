# iOS 控制通道设计路线（WDA 非越狱方案）

> 状态：**设计文档，未实现**（2026-09-11）。本文回答「mobile_* 能不能像 Android 一样控制 iOS」、
> 用什么路线、分几步落地。动手实现前先读完第 3、4、6 节。

## 1. 结论与定位

**可行**。用 Apple 官方 XCUITest 基础设施 **WebDriverAgent（WDA）**，非越狱、非私有 API。
目标形态与现有 Android 通道完全对称：

- 同一套 `mobile_screen` / `mobile_ui` / `mobile_act` 工具名，后端按设备类型路由（adb / WDA）；
- 同一套分层原则（AGENTS.md）：**mobile_ui 控件树文本通道优先，mobile_screen 截图兜底**；
- 同一套 Environment 感知：`readIosSnapshot()` 对标 `readAdbSnapshot()`，探测结果注入系统提示词。

| Android（已实现） | iOS（本文规划） | 说明 |
| --- | --- | --- |
| `adb devices` | `xcrun devicectl list devices` | 装配时探测一次，注入环境快照 |
| `adb screencap` → PNG | `GET /session/:id/screenshot` | WDA 返回 base64 PNG |
| `uiautomator dump` 控件树 | `GET /session/:id/source` | accessibility 树（XML/JSON），带坐标与类型 |
| `input tap/swipe/text/keyevent` | `/wda/tap` `/wda/dragfromtoforduration` `/wda/keys` `/wda/pressButton` | XCUITest 系统级注入，SpringBoard 也能操作 |
| `am start` | `/wda/app/launch` + bundleId | 启动应用 |
| adb 端口直连 | USB 需 iproxy 转发；模拟器直连 localhost | 见 §5 |
| phone_panel 低帧率镜像 | WDA MJPEG 服务（默认 9100 端口） | 桌面端手机投屏面板的 iOS 版数据源 |

**不选的路线**：libimobiledevice 单独用（`idevicescreenshot` 只读、iOS 17 后部分 lockdown
服务被收紧，无法注入输入）；idb（Meta）是 WDA + 私有组件的封装，引入 Python 依赖，
违反零依赖约定；越狱（越狱后 SSH + 时髦框架）不考虑——破坏设备安全模型，且与
Permission 支柱「不可逆操作过人」的前提冲突。

## 2. 前置条件（绕不开的三道门）

1. **完整版 Xcode**（App Store，~10GB）。当前本机只有 Command Line Tools
   （`xcode-select -p` → `/Library/Developer/CommandLineTools`），`xcodebuild` 报错。
   装好后 `sudo xcode-select -s /Applications/Xcode.app`。
2. **WDA 构建签名**：
   - 模拟器：无需签名，`xcodebuild build-for-testing` 直接产出；
   - 真机：需要 Apple ID 签名。**免费账号的描述文件 7 天过期**，过期后 WDA 无法启动，
     要用 Xcode 重签；付费开发者账号（$99/年）一次签一年。
3. **真机开发者模式**：iOS 16+ 需在「设置 → 隐私与安全性 → 开发者模式」手动开启并重启。

桌面端限制：iOS 通道只有 macOS 主机可用（Xcode/WDA 构建链是 Apple 独占）；
Windows 桌面端的 mobile_* 路由必须保留 adb 分支，iOS 分支按平台能力降级 fail。

## 3. WDA 关键 API 速查（实现时的对照基准）

WDA 在设备上跑 HTTP server（真机经 iproxy 映射到本机 8100，模拟器直接 localhost:8100）。
请求体均为 JSON；创建会话后所有接口挂在 `/session/:sessionId` 下：

```
GET  /status                                # 就绪探测：iOS 版本、build
POST /session                               # 创建会话 {"capabilities": {}}
GET  /session/:id/window/size               # 屏幕逻辑尺寸（points）
GET  /session/:id/screenshot                # {"value": "<base64 PNG>"}
GET  /session/:id/source?format=json        # accessibility 树（json 优先，xml 兜底）
POST /session/:id/wda/tap/0                 # {"x":100,"y":200} 单点轻触
POST /session/:id/wda/dragfromtoforduration # {"fromX":..,"fromY":..,"toX":..,"toY":..,"duration":0.3}
POST /session/:id/wda/keys                  # {"value":["文本"]} HID 键盘输入
POST /session/:id/wda/pressButton           # {"name":"home"}（home/volumeup/volumedown/...）
POST /session/:id/wda/app/launch            # {"bundleId":"com.apple.Preferences"}
POST /session/:id/actions                   # 复合手势链（多点/长按/多指）
POST /session/:id/elements                  # {"using":"accessibility id","value":"按钮名"} 定位控件
POST /session/:id/element/:uuid/click       # 按控件点击（等价 mobile_ui 找锚点 → 点击）
```

控件树（`/source`）节点含 `type`（XCUIElementType 按钮/文本框…）、`name`/`label`、
`frame`（x/y/width/height，**points 坐标系**）——与 `uia_tree` 的输出形状对齐后喂模型。

**坐标系注意**：WDA 一律用逻辑点（points），不是像素。这和 `darwin-cu.ts` 的 CGEvent
坐标系同语义，但和 Windows mobile_screen 的物理像素不同——iOS 后端给 mobile_act 的
坐标说明里必须写清「points」，且 screenshot 返回的尺寸要除以 scale 才与 /source 对齐
（Retina 设备 scale=2/3）。这是移植时最容易踩的坑，实现时先写一条对拍单测。

## 4. harness 侧设计（零 npm 依赖）

```
src/tools/
  ios.ts            # WDA HTTP 客户端：Node 内置 fetch + spawn（xcrun/iproxy），零依赖
  mobile.ts         # 路由层改造：工具按设备类型分发 adb / wda 后端（现有 adb 分支不动）
src/session.ts      # readIosSnapshot()：xcrun devicectl list devices / simctl list，
                    # 与 readAdbSnapshot 同款降级约定（无 Xcode → null 静默跳过）
desktop/main/       # phone-panel 后端可选接 MJPEG 流（9100 端口）做 iOS 投屏
```

原则（与 Android 通道同款）：

- **文本通道优先**：mobile_ui（/source 树）是主通道，mobile_screen（截图）兜底，
  和 uia_tree 对 uia 的定位一致——省 token、按控件点更准。
- **环境快照只给事实**：注入「检测到 N 台 iOS 设备（版本/模拟器）」+「WDA 未就绪时
  给出启动指引」，不写操作规则。
- **isMutating 语义不变**：mobile_act 过 approvalGate（真实设备真实操作）。
- **失败不留暗道**：WDA 未启动 / 会话过期 → fail 并给重启指引，绝不静默重试降级。

## 5. 分阶段实施

**Phase A —— 模拟器打通（无签名门槛，本机装完 Xcode 即可做）**

1. `xcodebuild build-for-testing -scheme WebDriverAgentRunner -destination
   'platform=iOS Simulator,name=iPhone 15'` 构建 WDA 到模拟器并启动；
2. 实现 `ios.ts` 最小客户端：status → session → screenshot / source / tap；
3. `mobile_*` 三工具接 iOS 分支，跑通「探测 → 截图 → 控件树 → 点击设置 App」最小链路；
4. 单测：坐标 points 换算、/source 树形状归一（纯函数，不需要真模拟器也能测大半）。

**Phase B —— 真机**

1. Xcode 里把 WDA Runner 签到真机（免费号可跑通，记住 7 天有效期）；
2. USB 转发：`brew install libimobiledevice` → `iproxy 8100 8100`（harness spawn 托管，
   断线重连）；iOS 17+ 也可试 `xcrun devicectl` 系命令减少 brew 依赖；
3. 设备上手动启动一次 WDA 图标（或 `devicectl device process launch`）；
4. 跑通与模拟器相同的四步链路，验证 SpringBoard 级操作（回主屏、开控制中心）。

**Phase C —— 并入主架**

1. `session.ts` 装配层注入 iOS 环境快照；系统提示词补「iOS 设备操作指引」一段
   （对齐 formatAdbSnapshotLine 的写法）；
2. desktop 手机投屏面板接 MJPEG；`watch` 巡检、`procedure` 程序性记忆天然复用——
   「在设置 App 里怎么开某开关」这类流程记忆对 iOS 同样成立；
3. README / AGENTS.md 工具表更新（mobile_* 标注双平台）。

## 6. 已知限制（实现前说清楚）

- **免费签名 7 天过期**：过期后所有 mobile_* 调用 fail。桌面端应在快照里报告签名剩余
  有效期（lockdown 可查 profile 到期），提前提醒重签；
- **WDA 前台存活**：WDA 是 XCUITest runner，被用户手动杀掉或系统回收后需要重新拉起；
  harness 检测 `/status` 404/超时时给「重新启动 WDA」指引；
- **多设备**：WDA 一台设备一个实例；多真机时按 serial 路由多个 iproxy 端口
  （8100/8200/…），与 mobile.ts 现有「serial 选设备」参数对齐；
- **Windows 桌面端无 iOS 通道**：路由层按平台 fail 并说明原因，不是静默隐藏工具；
- **受监管/企业设备**、MDM 限制的设备可能禁用开发者模式——文档写明此类设备不支持。

## 7. 工作量预估

| 部分 | 量级 |
| --- | --- |
| `ios.ts` WDA 客户端（status/session/截图/树/五动作/转发托管） | ~400 行 + 150 行单测 |
| `mobile.ts` 路由改造（设备类型判定 + iOS 分支） | ~100 行 |
| `session.ts` iOS 环境快照 | ~60 行（大半复用 adb 的模式） |
| Phase A 验证调试 | 装好 Xcode 后半天内可通 |
| Phase B 真机 | 主要是签名与转发调试，代码增量很小 |
