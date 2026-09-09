/**
 * Windows 听写 helper：WinRT Windows.Media.SpeechRecognition 连续听写。
 *
 * 与 macOS 版（desktop/native/dictate.swift，SFSpeechRecognizer）职责对齐：
 *   - stdout 每行一个 JSON 事件（UTF-8 无 BOM）：
 *       {"kind":"ready"}               麦克风 + 识别器就绪
 *       {"kind":"partial","text":"…"}  中间结果（HypothesisGenerated）
 *       {"kind":"final","text":"…"}    最终结果（收到后自行退出）
 *       {"kind":"error","message":"…"} 失败（权限被拒 / 引擎错误）
 *   - 优雅停机：stdin 关闭（EOF）或收到 "stop" 行 → StopAsync → 输出 final → exit 0。
 *     Electron 侧直接 spawn（Windows 无 TCC 归属问题，不需要 macOS 的 open 模式），
 *     父进程拿得到句柄和管道，比 macOS 的配置文件轮询简单得多。
 *   - 强杀：Windows 上 SIGTERM 等价 TerminateProcess，进程不会有机会输出 final——
 *     停机必须走 stdin EOF 这条路，kill 只做兜底。
 *
 * 编译（见 scripts/build-dictate-win.cjs）：
 *   csc /r:Windows.Foundation.winmd /r:Windows.Media.winmd /r:Windows.Globalization.winmd
 *       /r:System.Runtime.WindowsRuntime.dll  →  dictate.exe
 *   winmd 直接引用 C:\Windows\System32\WinMetadata\（系统自带，无需装 SDK）。
 *
 * 权限：桌面应用共享「设置 → 隐私 → 麦克风 → 允许桌面应用访问」开关；
 * zh-CN 识别还需要「设置 → 语音 → 在线语音识别」（系统会自动弹授权框）。
 */

using System;
using System.Text;
using System.Threading.Tasks;
using Windows.Foundation;
using Windows.Globalization;
using Windows.Media.SpeechRecognition;

/**
 * WinRT async → Task 的最小适配：不走 System.Runtime.WindowsRuntime 的
 * WindowsRuntimeSystemExtensions（不同机器上该桥接程序集的形态不一致，
 * 引用它曾直接 CS4028）。WinRT 完成回调挂 TaskCompletionSource 的手写版
 * 对本 helper 的三种等待（CompileConstraints / Start / Stop）足够了。
 * 注意：Completed 属性只能赋值一次，两个 AsTask 都是一次性赋值。
 */
internal static class WinRtAwait
{
    public static Task<T> AsTask<T>(this IAsyncOperation<T> operation)
    {
        var tcs = new TaskCompletionSource<T>();
        operation.Completed = (info, status) =>
        {
            if (status == AsyncStatus.Completed) tcs.SetResult(info.GetResults());
            else if (status == AsyncStatus.Error) tcs.SetException(info.ErrorCode);
            else tcs.SetCanceled();
        };
        return tcs.Task;
    }

    public static Task AsTask(this IAsyncAction action)
    {
        var tcs = new TaskCompletionSource<bool>();
        action.Completed = (info, status) =>
        {
            if (status == AsyncStatus.Completed) tcs.SetResult(true);
            else if (status == AsyncStatus.Error) tcs.SetException(info.ErrorCode);
            else tcs.SetCanceled();
        };
        return tcs.Task;
    }
}

internal static class Dictate
{
    /** ResultGenerated 定稿累积（连续识别按短语多次触发，stop 后拼接成 final） */
    private static readonly StringBuilder Segments = new StringBuilder();
    /** 最近一次假设（partial），停机时若未被定稿覆盖则并入 final */
    private static string lastHypothesis = string.Empty;
    private static readonly object Gate = new object();

    private static int Main(string[] args)
    {
        // stdout 走无 BOM 的 UTF-8：Electron 侧按 utf8 解码，带 BOM 会污染第一行 JSON
        Console.OutputEncoding = new UTF8Encoding(false);
        var locale = "zh-CN";
        for (var i = 0; i < args.Length - 1; i++)
        {
            if (args[i] == "--locale") locale = args[i + 1];
        }
        try
        {
            return RunAsync(locale).GetAwaiter().GetResult();
        }
        catch (Exception ex)
        {
            Emit("error", Describe(ex));
            return 1;
        }
    }

    private static async Task<int> RunAsync(string locale)
    {
        SpeechRecognizer recognizer;
        try
        {
            recognizer = new SpeechRecognizer(new Language(locale));
        }
        catch
        {
            // 请求语言缺语音功能包（HResult 0x800455A0）时退回系统默认识别语言
            try
            {
                recognizer = new SpeechRecognizer();
            }
            catch (Exception ex)
            {
                Emit(
                    "error",
                    "创建识别器失败：" + Describe(ex) +
                    "。多数情况是缺少语音识别功能包：设置 → 时间和语言 → 语言和区域 →" +
                    "中文（简体）→ 语言选项 → 勾选/下载「语音识别」；管理员 PowerShell 可执行" +
                    " Add-WinCapability -Name 'Language.Speech~~~zh-CN~0.0.1.0'"
                );
                return 1;
            }
        }

        // 中间结果：假设流（macOS 版 partial 的对等物）
        recognizer.HypothesisGenerated += (s, e) =>
        {
            lastHypothesis = e.Hypothesis.Text ?? string.Empty;
            Emit("partial", lastHypothesis);
        };
        // 定稿片段：连续识别每收完一句触发一次，先攒着，停机时统一拼接
        recognizer.ContinuousRecognitionSession.ResultGenerated += (s, e) =>
        {
            var text = e.Result.Text ?? string.Empty;
            lock (Gate)
            {
                if (Segments.Length > 0) Segments.Append(' ');
                Segments.Append(text);
            }
            Emit("partial", text);
        };

        var compile = await recognizer.CompileConstraintsAsync().AsTask();
        if (compile.Status != SpeechRecognitionResultStatus.Success)
        {
            Emit(
                "error",
                "识别约束编译失败（状态 " + compile.Status + "）：请检查「设置 → 隐私 → 麦克风」" +
                "与「设置 → 语音 → 在线语音识别」是否开启"
            );
            return 1;
        }

        try
        {
            await recognizer.ContinuousRecognitionSession.StartAsync().AsTask();
        }
        catch (Exception ex)
        {
            Emit("error", "启动听写失败（多半是麦克风权限被拒）：" + Describe(ex));
            return 1;
        }

        Emit("ready", string.Empty);

        // 等停机信号：stdin EOF（父进程 end 管道）或 "stop" 行
        await Task.Run(() =>
        {
            string line;
            while ((line = Console.ReadLine()) != null)
            {
                if (line.Trim() == "stop") return;
            }
        });

        try
        {
            await recognizer.ContinuousRecognitionSession.StopAsync().AsTask();
            // StopAsync 返回后仍可能有最后一句在路上的定稿事件，留窗口收尾
            await Task.Delay(500);
        }
        catch
        {
            // 停机失败不影响已有结果的输出
        }

        string final;
        lock (Gate)
        {
            final = Segments.ToString();
        }
        if (lastHypothesis.Length > 0 && !final.Contains(lastHypothesis))
        {
            final = final.Length > 0 ? final + " " + lastHypothesis : lastHypothesis;
        }
        Emit("final", final);
        return 0;
    }

    /** 单行 JSON 事件输出（emitError 用 message 字段，与 macOS helper 的 dictate.swift 一致） */
    private static void Emit(string kind, string text)
    {
        var field = kind == "error" ? "message" : "text";
        Console.Out.Write("{\"kind\":\"" + kind + "\",\"" + field + "\":" + Quote(text) + "}\n");
        Console.Out.Flush();
    }

    /** 最小 JSON 字符串转义：引号、反斜杠与 <0x20 控制字符 */
    private static string Quote(string s)
    {
        if (s == null) return "\"\"";
        var sb = new StringBuilder(s.Length + 8);
        sb.Append('"');
        foreach (var ch in s)
        {
            switch (ch)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (ch < ' ')
                    {
                        sb.Append("\\u").Append(((int)ch).ToString("x4"));
                    }
                    else
                    {
                        sb.Append(ch);
                    }
                    break;
            }
        }
        sb.Append('"');
        return sb.ToString();
    }

    /** 异常摘要：message + HResult（权限/引擎错误排查的关键线索） */
    private static string Describe(Exception ex)
    {
        var msg = ex.Message ?? string.Empty;
        return msg + " (HResult 0x" + ex.HResult.ToString("X8") + ")";
    }
}
