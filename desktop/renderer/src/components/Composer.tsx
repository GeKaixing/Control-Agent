import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Mic,
  Square,
  FilePlus,
  Paperclip,
  X,
  CornerDownLeft,
  Play,
  Copy,
  Check,
} from "lucide-react";
import { cn } from "../lib/utils";
import { useSessionStore } from "../store";
import { ModeToggle } from "./ModeToggle";
import { EndpointModelMenu } from "./EndpointModelMenu";
import { ToolsPanel } from "./ToolsPanel";
import { ContextBar, ContextUsageBar } from "./ContextBar";
import { SessionPicker } from "./SessionPicker";
import { SettingsButton } from "./SettingsPopover";
import type { Attachment } from "../../../shared/api";

interface Props {
  status: "idle" | "running" | "error" | "plan_pending";
  onSubmit: (text: string, attachments: Attachment[]) => void;
  onAbort: () => void;
  /** plan mode 下点"继续"按钮时调用 */
  onPlanContinue: () => void;
  onNewSession: () => void;
}

/** textarea 自动高度的下/上限（px） */
const TEXTAREA_MIN_H = 64;
const TEXTAREA_MAX_H = 200;

/** 方向键手势涉及的键位集合 */
const ARROW_KEYS: ReadonlySet<string> = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

/** 历史记录最多保留条数；超出从尾部丢 */
const HISTORY_MAX = 100;

interface MentionState {
  /** "@xxx" 中 xxx 的部分（不含 @）；空表示正在输入新 query */
  query: string;
  /** 在 textarea 文本里的起始位置（指向 "@" 字符） */
  startIdx: number;
  /** 当前选中候选的下标 */
  selected: number;
}

/**
 * 超级输入框（OpenCode 风格「圆角卡片」）。
 *
 *  - 自动高度（min-h 64 / max-h 200）
 *  - 历史记录：上下方向键翻历史（空 query 与重复不入栈）
 *  - 附件上传：拖拽 / 粘贴 / 点 Paperclip → 文件选择器（v1 仅 image）
 *  - @ 文件引用：输入 @" 弹候选 popover，键盘选择
 *  - IME 守卫：中文拼音 composition 期间不抢 Enter
 *  - 快捷键提示 footer
 */
export function Composer({
  status,
  onSubmit,
  onAbort,
  onPlanContinue,
  onNewSession,
}: Props): React.ReactElement {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [mention, setMention] = useState<MentionState | null>(null);
  const [candidates, setCandidates] = useState<string[]>([]);

  // 「自定义模型」已改为弹层子窗口（PopoverHost 的 custom-model id），
  // 不再在主窗口渲染 modal——主窗口是内容即高度的小窗，遮罩层铺不开。

  const ref = useRef<HTMLTextAreaElement | null>(null);
  const isComposingRef = useRef(false);

  const historyRef = useRef<string[]>([]);
  const historyIdxRef = useRef<number>(-1);
  const draftRef = useRef<string>("");

  // 新建会话（sessionSeq 自增）时清空输入历史：↑↓ 翻的那份是渲染层本地 ref，
  // store 里 turns 清了它也还在——不清理的话新会话还能翻出旧会话的提示词。
  const sessionSeq = useSessionStore((s) => s.sessionSeq);
  useEffect(() => {
    if (sessionSeq === 0) return; // 初次挂载不清
    historyRef.current = [];
    historyIdxRef.current = -1;
    draftRef.current = "";
  }, [sessionSeq]);

  const info = useSessionStore((s) => s.info);
  const usage = useSessionStore((s) => s.usage);
  const mode = useSessionStore((s) => s.info?.mode ?? "full");
  const paused = useSessionStore((s) => s.info?.paused ?? false);
  const togglePaused = useSessionStore((s) => s.setPaused);
  /** macOS 听写状态（null = 从未开始过） */
  const dictation = useSessionStore((s) => s.dictation);
  /** ← / → 切会话（store action） */
  const switchSession = useSessionStore((s) => s.switchSession);
  /** 全局通知（会话切换提示等），Composer 顶部浮标展示 */
  const notice = useSessionStore((s) => s.notice);
  /**
   * 本会话最后一条用户消息原文：有历史时输入框 placeholder 显示它
   * （新会话才显示默认的「今天帮你做些什么…」）；也是「复制提示词」按钮的内容。
   */
  const lastUserPrompt = info?.lastUserPrompt ?? null;

  const isRunning = status === "running";

  // 渲染层 isPlanPending 状态：store status + info.planPending 共同决定
  const isPlanPending = status === "plan_pending";

  // 输入完成后聚焦
  useEffect(() => {
    if (status === "idle" && ref.current !== null) ref.current.focus();
  }, [status]);

  // 自动高度：监听 text 变化，把 scrollHeight 写到 style.height
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    el.style.height = "auto";
    const next = Math.min(Math.max(el.scrollHeight, TEXTAREA_MIN_H), TEXTAREA_MAX_H);
    el.style.height = `${next}px`;
  }, [text]);

  // ── macOS 听写：把 dictation 流合并进输入框 ──
  // ready 时刻记录「基线文本」（当时输入框里已有的内容）；
  // partial 到达 → text = 基线 + 识别稿；final 到达 → 定稿；error → 保持基线。
  const textValueRef = useRef("");
  textValueRef.current = text;
  const dictBaseRef = useRef("");
  const dictActiveRef = useRef(false);
  const lastSeqRef = useRef(0);
  useEffect(() => {
    if (dictation === null || dictation.seq === lastSeqRef.current) return;
    lastSeqRef.current = dictation.seq;
    if (dictation.active) {
      if (!dictActiveRef.current) {
        dictBaseRef.current = textValueRef.current;
        dictActiveRef.current = true;
      }
      setText(dictBaseRef.current + dictation.draft);
    } else if (dictation.draft.length > 0) {
      // final：正常路径 = 基线 + 定稿；若没见过 partial（事件丢失/渲染层晚启动）
      // 基线就用当前输入框内容，反正不能把最终转写丢掉。error 时 draft 为空不走这。
      const base = dictActiveRef.current ? dictBaseRef.current : textValueRef.current;
      dictActiveRef.current = false;
      dictBaseRef.current = "";
      setText(base + dictation.draft);
    }
  }, [dictation]);

  const toggleDictation = useCallback(() => {
    if (dictation?.active === true) {
      void window.api.stopDictation();
    } else {
      void window.api.startDictation();
    }
  }, [dictation]);

  // ── 方向键手势（仅空输入框时生效）──
  //  · 单击 ← / →：切换上一个 / 下一个会话（松键生效，按住不算）
  //  · 单击 ↑ / ↓：翻输入历史（原行为，挪到松键时生效）
  //  · ↑↓←→ 四键同时按住：激活 macOS 听写；松开任意一个方向键即停止
  // 多键按下途中（2~3 个）不做任何单击动作，避免组合手势误触会话切换/历史。
  const heldArrowsRef = useRef<Set<string>>(new Set());
  const chordFiredRef = useRef(false);
  const multiArrowRef = useRef(false);

  /** 历史翻页（原 keydown 逻辑挪到这里，松键时调用）。dir -1 上一条 / +1 下一条 */
  const applyHistory = (dir: -1 | 1) => {
    const arr = historyRef.current;
    if (arr.length === 0) return;
    if (dir === -1) {
      if (historyIdxRef.current === -1) {
        draftRef.current = "";
        historyIdxRef.current = arr.length - 1;
      } else if (historyIdxRef.current > 0) {
        historyIdxRef.current -= 1;
      }
    } else {
      if (historyIdxRef.current === -1) return;
      if (historyIdxRef.current < arr.length - 1) {
        historyIdxRef.current += 1;
      } else {
        historyIdxRef.current = -1;
        setText(draftRef.current);
        return;
      }
    }
    setText(arr[historyIdxRef.current] ?? "");
  };

  // notice 浮标：store.notice 一变就显示 2 秒后消失
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (notice === null) return;
    setToast(notice);
    const t = setTimeout(() => setToast(null), 2000);
    return () => clearTimeout(t);
  }, [notice]);

  const submit = useCallback(() => {
    // plan_pending 状态下不允许直接 send，由右侧「继续」按钮接管。
    if (status === "plan_pending") return;
    const trimmed = text.trim();
    // running 也放行：App.handleSubmit 会分流成 steer（运行中插话，立即生效）。
    // 之前这里 return 把运行中输入整个吞掉——「运行时再输入没反应」就是它。
    if (trimmed.length === 0 && attachments.length === 0) return;
    // 入栈（去重、空 query 跳过）
    if (trimmed.length > 0) {
      const arr = historyRef.current;
      const last = arr[arr.length - 1];
      if (last !== trimmed) {
        arr.push(trimmed);
        if (arr.length > HISTORY_MAX) arr.shift();
      }
      historyIdxRef.current = -1;
      draftRef.current = "";
    }
    onSubmit(trimmed, attachments);
    setText("");
    setAttachments([]);
  }, [text, attachments, status, onSubmit]);

  // 拉候选文件列表（mention 状态变化时）
  useEffect(() => {
    if (mention === null) {
      setCandidates([]);
      return;
    }
    let cancelled = false;
    void window.api.listFiles(mention.query).then((res) => {
      if (cancelled) return;
      setCandidates(res.files.slice(0, 50));
    });
    return () => {
      cancelled = true;
    };
  }, [mention]);

  const updateMentionFromCaret = useCallback((value: string, caret: number) => {
    // 从 caret 向前找最近的 "@"，要求前面是空白或行首
    let i = caret - 1;
    while (i >= 0) {
      const ch = value[i];
      if (ch === "@") {
        const prev = i > 0 ? value[i - 1] : " ";
        if (prev === " " || prev === "\n" || prev === "\t" || i === 0) {
          const query = value.slice(i + 1, caret);
          // query 不能含空白（多 token 的 @ 引用暂不支持）
          if (/\s/.test(query)) {
            setMention(null);
            return;
          }
          setMention({ query, startIdx: i, selected: 0 });
          return;
        }
        setMention(null);
        return;
      }
      if (ch === " " || ch === "\n" || ch === "\t") break;
      i -= 1;
    }
    setMention(null);
  }, []);

  const insertMention = useCallback(
    (path: string) => {
      if (mention === null) return;
      const before = text.slice(0, mention.startIdx);
      const afterCursor = text.slice(mention.startIdx + 1 + mention.query.length);
      const inserted = `@${path} `;
      const next = `${before}${inserted}${afterCursor}`;
      setText(next);
      setMention(null);
      // 把光标移到 inserted 末尾
      requestAnimationFrame(() => {
        const el = ref.current;
        if (el === null) return;
        const pos = before.length + inserted.length;
        el.focus();
        el.setSelectionRange(pos, pos);
      });
    },
    [mention, text],
  );

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = e.target.value;
    setText(next);
    updateMentionFromCaret(next, e.target.selectionStart);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 中文输入法 IME 期间，Enter 给输入法而不是发送
    if (isComposingRef.current || e.nativeEvent.isComposing) return;
    // @ popover 打开时，方向键/Enter/Esc 都被 popover 接管
    if (mention !== null) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMention((m) => (m === null ? null : { ...m, selected: Math.min(m.selected + 1, candidates.length - 1) }));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMention((m) => (m === null ? null : { ...m, selected: Math.max(m.selected - 1, 0) }));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        const target = candidates[mention.selected];
        if (target !== undefined) {
          e.preventDefault();
          insertMention(target);
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMention(null);
        return;
      }
    }
    // 方向键手势（仅空输入框）：↓ 统一 preventDefault（空框无光标可移），
    // 单击动作在 keyup 生效；四键同按激活听写。非空输入框走默认光标移动。
    if (text.length === 0 && ARROW_KEYS.has(e.key)) {
      e.preventDefault();
      const held = heldArrowsRef.current;
      if (!held.has(e.key)) held.add(e.key);
      if (held.size >= 2) multiArrowRef.current = true;
      if (held.size === 4 && !chordFiredRef.current) {
        // ↑↓←→ 同时按住 → 激活 macOS 听写
        chordFiredRef.current = true;
        void window.api.startDictation();
      }
      return;
    }
    if (e.key !== "Enter") return;
    if (e.shiftKey) return; // Shift+Enter = 换行
    e.preventDefault();
    submit();
  };

  // 方向键 keyup：单击动作在这里生效（keydown 只负责记录按住状态与四键和弦）
  const onKeyUp = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!ARROW_KEYS.has(e.key)) return;
    const held = heldArrowsRef.current;
    held.delete(e.key);
    if (chordFiredRef.current) {
      // 和弦进行中：松开任意方向键 → 停止听写
      if (held.size < 4) {
        chordFiredRef.current = false;
        void window.api.stopDictation();
      }
      return;
    }
    if (held.size > 0) return; // 还有方向键按着：等全部松开
    const wasMulti = multiArrowRef.current;
    multiArrowRef.current = false;
    if (wasMulti) return; // 2~3 键组合未成 → 不当单击处理
    if (text.length !== 0) return;
    if (e.key === "ArrowLeft") void switchSession(-1);
    else if (e.key === "ArrowRight") void switchSession(1);
    else if (e.key === "ArrowUp") applyHistory(-1);
    else if (e.key === "ArrowDown") applyHistory(1);
  };

  const onBlurTextarea = () => {
    // 焦点丢失时按住状态不可信，全部复位（听写交给系统/用户手动停）
    heldArrowsRef.current.clear();
    chordFiredRef.current = false;
    multiArrowRef.current = false;
  };

  // 附件：点 Paperclip → file picker
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const handlePickFiles = () => fileInputRef.current?.click();

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const arr = Array.from(files).filter((f) => f.type.startsWith("image/"));
    const readAsDataUrl = (f: File): Promise<Attachment> =>
      new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => {
          resolve({
            id: crypto.randomUUID(),
            kind: "image",
            name: f.name,
            dataUrl: typeof r.result === "string" ? r.result : "",
            size: f.size,
          });
        };
        r.onerror = () => reject(r.error);
        r.readAsDataURL(f);
      });
    try {
      const loaded = await Promise.all(arr.map(readAsDataUrl));
      setAttachments((prev) => [...prev, ...loaded].slice(0, 8)); // 最多 8 张
    } catch {
      // 单张失败忽略
    }
  }, []);

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData.items;
    const files: File[] = [];
    for (let i = 0; i < items.length; i += 1) {
      const it = items[i];
      if (it === null) continue;
      if (it.kind === "file") {
        const f = it.getAsFile();
        if (f !== null && f.type.startsWith("image/")) files.push(f);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      void addFiles(files);
    }
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (e.dataTransfer.files.length > 0) void addFiles(e.dataTransfer.files);
  };

  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  };

  const hasContent = text.trim().length > 0 || attachments.length > 0;

  const mentionActive = mention !== null && candidates.length > 0;

  return (
    <div className="border-t border-border bg-card/30 p-3">
      <div
        className={cn(
          "relative flex flex-col rounded-xl border border-border bg-background shadow-sm transition-colors",
          "focus-within:border-ring/50 focus-within:ring-1 focus-within:ring-ring/30",
        )}
        onDrop={onDrop}
        onDragOver={onDragOver}
      >
        {/* 通知浮标（会话切换 / 新会话等） */}
        {toast !== null && (
          <div className="absolute left-1/2 top-1.5 z-40 -translate-x-1/2 rounded-full border border-border bg-popover px-3 py-1 text-[11px] text-popover-foreground shadow-md">
            {toast}
          </div>
        )}
        {/* 附件缩略图条 */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 border-b border-border px-3 py-2">
            {attachments.map((a) => (
              <div key={a.id} className="group relative h-12 w-12 overflow-hidden rounded-md border border-border bg-muted">
                <img src={a.dataUrl} alt={a.name} className="h-full w-full object-cover" />
                <button
                  type="button"
                  onClick={() => removeAttachment(a.id)}
                  className="absolute right-0 top-0 hidden h-4 w-4 items-center justify-center rounded-bl-md bg-black/60 text-white group-hover:flex"
                  title="移除"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        <textarea
          ref={ref}
          value={text}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          onBlur={onBlurTextarea}
          onCompositionStart={() => (isComposingRef.current = true)}
          onCompositionEnd={() => (isComposingRef.current = false)}
          onPaste={onPaste}
          placeholder={lastUserPrompt ?? "今天帮你做些什么？ @引用文件 · /调用技能与指令"}
          rows={2}
          className={cn(
            "min-h-[64px] max-h-[200px] w-full resize-none bg-transparent px-3.5 pt-3 text-sm",
            "placeholder:text-muted-foreground focus-visible:outline-none",
          )}
          style={{ height: `${TEXTAREA_MIN_H}px` }}
        />

        {/* @ 候选 popover（绝对定位，浮在 textarea 下方；限高防撑高窗口） */}
        {mentionActive && (
          <div className="absolute z-50 max-h-[calc(100vh-10rem)] w-80 overflow-y-auto rounded-md border border-border bg-popover text-popover-foreground shadow-md" style={{ top: "2.5rem", left: "0.5rem" }}>
            {candidates.length === 0 ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">没有匹配的文件</div>
            ) : (
              candidates.map((f, i) => (
                <button
                  key={f}
                  type="button"
                  onMouseDown={(e) => {
                    // 用 onMouseDown 而非 onClick：textarea 失焦会先关 popover
                    e.preventDefault();
                    insertMention(f);
                  }}
                  onMouseEnter={() => setMention((m) => (m === null ? null : { ...m, selected: i }))}
                  className={cn(
                    "block w-full truncate px-3 py-1.5 text-left text-xs",
                    i === mention?.selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/40",
                  )}
                >
                  {f}
                </button>
              ))
            )}
          </div>
        )}

        <div className="flex flex-nowrap items-center gap-1 overflow-hidden px-2 pb-2 pt-1">
          <div className="flex min-w-0 items-center gap-1">
            {info !== null && (
              <>
                <ToolsPanel />
                <button
                  type="button"
                  onClick={handlePickFiles}
                  title="添加图片附件"
                  className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
                >
                  <Paperclip className="h-3.5 w-3.5" />
                </button>
                <EndpointModelMenu info={info} />
                <ModeToggle value={mode} />
                <SessionPicker />
                <ContextBar />
                <ContextUsageBar usage={usage} contextWindow={info?.contextWindow ?? 128000} />
                <CopyPromptButton text={lastUserPrompt} />
                {/* 设置弹层（齿轮）：审批模式 / 自动压缩等开关 */}
                <SettingsButton />
              </>
            )}
          </div>

          <div className="min-w-0 flex-1" />

          <div className="ml-auto flex shrink-0 items-center gap-1">
            <MicButton
              dictating={dictation?.active ?? false}
              errorMessage={dictation?.errorMessage ?? null}
              onToggle={toggleDictation}
            />
            <button
              type="button"
              onClick={onNewSession}
              title="新任务（清空当前对话）"
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
            >
              <FilePlus className="h-3.5 w-3.5" />
            </button>
            {/* 运行态主按钮二态合一：跑着 → ■ 点击停止；已暂停 → ▶ 点击继续。
                （原独立 PauseButton 已并入这里，暂停后点 ▶ 恢复） */}
            {isRunning ? (
              paused ? (
                <button
                  type="button"
                  onClick={() => void togglePaused(false)}
                  title="继续输出"
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-foreground text-background transition-colors hover:opacity-90"
                >
                  <Play className="h-3.5 w-3.5 fill-current" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={onAbort}
                  title="停止"
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-foreground text-background transition-colors hover:opacity-90"
                >
                  <Square className="h-3 w-3 fill-current" />
                </button>
              )
            ) : isPlanPending ? (
              <button
                type="button"
                onClick={onPlanContinue}
                title="继续"
                className="flex h-7 items-center gap-1 rounded-full bg-foreground px-3 text-xs text-background transition-colors hover:opacity-90"
              >
                <Play className="h-3 w-3 fill-current" />
                继续
              </button>
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={!hasContent}
                title="发送（Enter）"
                className="flex h-8 w-8 items-center justify-center rounded-full bg-foreground text-background transition-colors disabled:cursor-not-allowed disabled:opacity-30 hover:opacity-90"
              >
                <ArrowUp className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        {/* 快捷键提示 footer */}
        <div className="flex items-center gap-3 border-t border-border px-3.5 py-1 text-[10px] text-muted-foreground">
          <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap">
            <CornerDownLeft className="h-2.5 w-2.5" /> 发送
          </span>
          <span className="shrink-0 whitespace-nowrap">Shift+Enter 换行</span>
          <span className="shrink-0 whitespace-nowrap">↑↓ 历史</span>
          <span className="shrink-0 whitespace-nowrap">@ 文件</span>
          <span className="ml-auto shrink-0 whitespace-nowrap">{text.length} 字 · {attachments.length} 附件</span>
        </div>
      </div>

      {/* 隐藏的 file picker */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files !== null) void addFiles(e.target.files);
          e.target.value = "";
        }}
      />
    </div>
  );
}

/**
 * 「复制提示词」：把用户最后输入的提示词原文复制到剪贴板。
 * 还没有用户消息时禁用。成功后图标变 ✓ 1.5 秒。
 */
function CopyPromptButton({ text }: { text: string | null }): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const handleCopy = async (): Promise<void> => {
    if (text === null) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // 剪贴板不可用：静默失败
    }
  };

  return (
    <button
      type="button"
      onClick={() => void handleCopy()}
      disabled={text === null}
      title={text === null ? "还没有输入过提示词" : "复制上次输入的提示词"}
      className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

/** 语音按钮：听写开关。错误到达时自动弹出错误气泡（曾因错误文本为空而「无声失败」）。 */
function MicButton({
  dictating,
  errorMessage,
  onToggle,
}: {
  dictating: boolean;
  /** 最近一次听写 error；正常为 null */
  errorMessage: string | null;
  onToggle: () => void;
}): React.ReactElement {
  const [hint, setHint] = useState(false);
  useEffect(() => {
    if (!hint) return;
    const t = setTimeout(() => setHint(false), 2400);
    return () => clearTimeout(t);
  }, [hint]);
  // 错误到达 → 自动弹气泡并停留久一点（6s），不依赖用户再点一次才发现
  useEffect(() => {
    if (errorMessage === null) return;
    setHint(true);
    const t = setTimeout(() => setHint(false), 6000);
    return () => clearTimeout(t);
  }, [errorMessage]);
  const title = errorMessage !== null ? `听写出错：${errorMessage}` : dictating ? "停止听写" : "语音输入（macOS 听写）";
  return (
    <span className="relative inline-flex">
      <button
        type="button"
        onClick={() => {
          setHint(true);
          onToggle();
        }}
        title={title}
        className={cn(
          "flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground",
          dictating && "bg-red-500/10 text-red-500 hover:bg-red-500/20 hover:text-red-500",
          errorMessage !== null && !dictating && "text-red-500",
        )}
      >
        <Mic className={cn("h-3.5 w-3.5", dictating && "animate-pulse")} />
      </button>
      {hint && (
        <span
          className={cn(
            "absolute bottom-full right-0 z-50 mb-1 w-max max-w-64 rounded-md border border-border bg-popover px-2 py-1 text-[10px] text-popover-foreground shadow-md",
            errorMessage !== null && "border-red-500/40 text-red-500",
          )}
        >
          {errorMessage !== null
            ? errorMessage
            : dictating
              ? "听写中… 再点一次结束"
              : "点击开始听写（macOS 语音识别）"}
        </span>
      )}
    </span>
  );
}