// dictate.swift — macOS 听写 helper（SFSpeechRecognizer）
//
// 由 Electron 主进程 spawn 的独立命令行进程，职责单一：
//   打开麦克风 → 流式语音识别 → 把识别文本以 JSON 行写到 stdout。
//
// 协议（stdout，每行一个 JSON 对象）：
//   {"kind":"ready"}                     麦克风+识别器就绪，可以开始说话
//   {"kind":"partial","text":"..."}      中间结果（节流 ~150ms 一次）
//   {"kind":"final","text":"..."}        停止时的最终结果（收到后进程自行退出）
//   {"kind":"error","message":"..."}     任何失败（权限被拒 / 引擎错误 / 无可用识别器）
//
// 生命周期：
//   启动 → 请求麦克风与语音识别授权 → ready → 持续识别 partial
//   stdin 关闭 / SIGTERM / SIGINT → 优雅结束：endAudio → 等 final → 输出 → exit 0
//
// 环境变量：
//   DICTATE_LOCALE  BCP-47 语言，默认 "zh-CN"
//   DICTATE_ON_DEVICE  "1" 强制离线识别（需要系统已下载对应语言模型）；默认自动
//
// 命令行参数（优先于环境变量；`open --args` 启动时用）：
//   --locale <bcp47>     覆盖 DICTATE_LOCALE
//   --pidfile <path>     启动后把自身 pid 写进该文件（父进程 `open` 启动拿不到
//                        子进程句柄，靠 pidfile 定位进程做 SIGTERM 优雅停止）
//   --no-stdin-watch     不把 stdin EOF 当停止信号（open 启动时 stdin=/dev/null，
//                        EOF 立即到达会瞬间自我停止；直接 spawn 管道模式才需要监听）
//
// 权限：TCC 责任人是宿主 App。注意：由 Electron 直接 spawn 裸二进制时，
//   TCC 责任进程沿进程树归属，缺 usage 声明会立刻 SIGABRT
//   （__TCC_CRASHING_DUE_TO_PRIVACY_VIOLATION__）——所以桌面端必须经
//   LaunchServices（`open -n dictate.app`）启动本 helper，让 TCC 归属到
//   dictate.app 自己的 Info.plist（含 mic + speech 两个 usage key）。

import AVFoundation
import Foundation
import Speech

// ───────────────────────── stdout 输出 ─────────────────────────

let stdoutLock = NSLock()

func emit(_ dict: [String: String]) {
    let data: Data
    do {
        var d = try JSONSerialization.data(withJSONObject: dict)
        d.append(0x0A) // \n
        data = d
    } catch {
        return // 序列化失败静默丢弃，不打断识别
    }
    stdoutLock.lock()
    FileHandle.standardOutput.write(data)
    stdoutLock.unlock()
}

func emitError(_ message: String) {
    emitConfigured(["kind": "error", "message": message])
}

// ───────────────────────── 授权 ─────────────────────────

enum AuthResult {
    case granted
    case denied(String)
}

/// 麦克风 + 语音识别两项授权都拿到才继续；任何一项被拒 → error 退出。
func requestAuthorization() async -> AuthResult {
    let micGranted = await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
        AVCaptureDevice.requestAccess(for: .audio) { granted in
            cont.resume(returning: granted)
        }
    }
    if !micGranted {
        return .denied("麦克风权限被拒绝（或 Info.plist 缺 NSMicrophoneUsageDescription）")
    }

    let speechStatus = await withCheckedContinuation { (cont: CheckedContinuation<SFSpeechRecognizerAuthorizationStatus, Never>) in
        SFSpeechRecognizer.requestAuthorization { status in
            cont.resume(returning: status)
        }
    }
    if speechStatus != .authorized {
        let reason: String
        switch speechStatus {
        case .denied: reason = "语音识别权限被用户拒绝"
        case .restricted: reason = "语音识别权限受设备限制"
        case .notDetermined: reason = "语音识别权限未决定（Info.plist 缺 NSSpeechRecognitionUsageDescription？）"
        default: reason = "语音识别权限不可用"
        }
        return .denied(reason)
    }
    return .granted
}

// ───────────────────────── 识别器 ─────────────────────────

final class DictationEngine {
    let localeIdentifier: String
    let forceOnDevice: Bool

    private var recognizer: SFSpeechRecognizer?
    private var audioEngine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    /// 最近一次 partial 的文本；停止时作为 final 兜底（有些引擎不给显式 final 回调）
    private var lastTranscript = ""
    private var lastPartialEmit = Date.distantPast
    /// 优雅停机时置 true：final 已输出后直接 exit(0)
    private var stopping = false
    /// 音频引擎是否成功启动过；未启动时 stop() 走快速收尾（removeTap 未装的 tap 会抛异常）
    private var started = false

    init(localeIdentifier: String, forceOnDevice: Bool) {
        self.localeIdentifier = localeIdentifier
        self.forceOnDevice = forceOnDevice
    }

    func start() async -> Bool {
        switch await requestAuthorization() {
        case .granted: break
        case .denied(let reason):
            emitError(reason)
            return false
        }

        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeIdentifier)) else {
            emitError("无法创建识别器（locale: \(localeIdentifier)）")
            return false
        }
        if !recognizer.isAvailable {
            emitError("识别器当前不可用（网络或服务不可达）")
            return false
        }
        self.recognizer = recognizer

        // 输入格式：引擎硬件采样率转成 request 需要的格式
        let inputNode = audioEngine.inputNode
        let hwFormat = inputNode.outputFormat(forBus: 0)
        if hwFormat.sampleRate == 0 {
            emitError("无法获取麦克风输入格式（是否有其他 App 独占麦克风？）")
            return false
        }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        if forceOnDevice {
            request.requiresOnDeviceRecognition = true
        } else if recognizer.supportsOnDeviceRecognition {
            request.requiresOnDeviceRecognition = true
        }
        self.request = request

        inputNode.installTap(onBus: 0, bufferSize: 2048, format: hwFormat) { [weak self] buffer, _ in
            self?.request?.append(buffer)
        }

        audioEngine.prepare()
        do {
            try audioEngine.start()
        } catch {
            emitError("无法启动音频引擎：\(error.localizedDescription)")
            return false
        }
        started = true

        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }
            if let result {
                let text = result.bestTranscription.formattedString
                self.lastTranscript = text
                if result.isFinal {
                    self.finishWithTranscript(text)
                } else if !text.isEmpty {
                    // partial 节流：150ms 一次，避免 IPC 洪水
                    let now = Date()
                    if now.timeIntervalSince(self.lastPartialEmit) >= 0.15 {
                        self.lastPartialEmit = now
                        emitConfigured(["kind": "partial", "text": text])
                    }
                }
            }
            if let error {
                if self.stopping { return } // 停机过程中的 cancel 错误忽略
                emitError("识别失败：\(error.localizedDescription)")
                self.cleanup()
                exit(1)
            }
        }

        emitConfigured(["kind": "ready"])
        return true
    }

    /// 优雅停止：endAudio → 短暂等 final → 没有就用手上的 lastTranscript 兜底
    func stop() {
        guard !stopping else { return }
        stopping = true
        guard started else {
            // 引擎没起来（LS 启动 stdin 即 EOF / 启动早期收到停止信号）：
            // 直接收尾退出，不能走 removeTap（未装的 tap 会抛 ObjC 异常）
            finishWithTranscript(lastTranscript)
            return
        }
        audioEngine.inputNode.removeTap(onBus: 0)
        audioEngine.stop()
        request?.endAudio()
        // 引擎通常会很快回一个 isFinal result；给 800ms，超时用 lastTranscript 兜底
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.8) { [weak self] in
            guard let self else { return }
            self.finishWithTranscript(self.lastTranscript)
        }
    }

    private func finishWithTranscript(_ text: String) {
        emitConfigured(["kind": "final", "text": text])
        cleanup()
        exit(0)
    }

    private func cleanup() {
        task?.cancel()
        task = nil
        request = nil
    }
}

// ───────────────────────── 信号 ─────────────────────────

/// 持有 DispatchSource，防止 handler 被释放；进程生命周期内有效
var signalSources: [DispatchSourceSignal] = []

func installSignalHandlers(_ engine: DictationEngine) {
    for sig in [SIGTERM, SIGINT] {
        signal(sig, SIG_IGN) // 用 DispatchSource 接管，避免 default handler 直接杀进程（拿不到 final）
        let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
        source.setEventHandler {
            engine.stop()
        }
        source.resume()
        signalSources.append(source)
    }
}

// ───────────────────────── 配置文件（open 模式） ─────────────────────────

/// open 模式配置：这台 macOS 26 上 `open --args/--env/--stdout` 实测均不生效，
/// 所以 controller 把配置写到固定路径，helper 启动时读它。
/// 文件存在 = open 模式（不监听 stdin）；不存在 = 传统直接 spawn 模式（stdin EOF 停止）。
/// 格式：{"pidfile":"…","out":"…","locale":"zh-CN"}
func readConfig() -> [String: String]? {
    let url = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/c-agent-dictate.json")
    guard let raw = try? String(contentsOf: url, encoding: .utf8),
          let data = raw.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data),
          let dict = obj as? [String: String] else { return nil }
    return dict
}

// ───────────────────────── 入口（顶层代码） ─────────────────────────

let env = ProcessInfo.processInfo.environment
let config = readConfig()

// 配置优先（open 模式），其次 argv（直接 spawn 调试用），最后 env 默认
var locale = config?["locale"] ?? env["DICTATE_LOCALE"] ?? "zh-CN"
var pidfilePath: String? = config?["pidfile"]
var watchStdin = config == nil
var argsIterator = CommandLine.arguments.makeIterator()
while let arg = argsIterator.next() {
    if arg == "--locale", let value = argsIterator.next() {
        locale = value
    } else if arg == "--pidfile", let value = argsIterator.next() {
        pidfilePath = value
    } else if arg == "--no-stdin-watch" {
        watchStdin = false
    }
}
let forceOnDevice = env["DICTATE_ON_DEVICE"] == "1"

// open 模式下事件写进 out 文件（open 的 stdout 重定向不可靠）；直接 spawn 模式写 stdout
let outFileHandle: FileHandle? = config?["out"].flatMap { path in
    if !FileManager.default.fileExists(atPath: path) {
        FileManager.default.createFile(atPath: path, contents: nil)
    }
    return FileHandle(forWritingAtPath: path)
}

func emitConfigured(_ dict: [String: String]) {
    emit(dict)
    if let handle = outFileHandle {
        if let data = try? JSONSerialization.data(withJSONObject: dict) {
            var line = data
            line.append(0x0A)
            handle.seekToEndOfFile()
            handle.write(line)
            handle.synchronizeFile()
        }
    }
}

// pidfile：open 启动模式下父进程没有子进程句柄，靠它做 SIGTERM 优雅停止
if let path = pidfilePath {
    try? String(ProcessInfo.processInfo.processIdentifier).write(toFile: path, atomically: true, encoding: .utf8)
}
emitConfigured(["kind": "boot", "text": String(ProcessInfo.processInfo.processIdentifier)])

let engine = DictationEngine(localeIdentifier: locale, forceOnDevice: forceOnDevice)
installSignalHandlers(engine)

// stdin 关闭（父进程 close pipe）也视为停止信号。
// 注意：LS（open）启动时 stdin 是 /dev/null，EOF 立刻到达 → 会瞬间自我停止；
// open 模式（config 存在）不监听 stdin，停止走 SIGTERM。
if watchStdin {
    DispatchQueue.global().async {
        _ = FileHandle.standardInput.readDataToEndOfFile()
        engine.stop()
    }
}

Task {
    let ok = await engine.start()
    if !ok {
        exit(1)
    }
}

// 挂起主线程让 dispatch queue 与识别回调持续跑（进程由 stop()/final 路径 exit）
dispatchMain()
