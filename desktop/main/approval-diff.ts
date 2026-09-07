/**
 * Permission 支柱：审批弹窗的 diff 预览。
 *
 * 之前审批弹窗只显示 JSON 截断的参数——write/edit 改大文件时用户批准的是
 * 一个看不见内容的改动。这里把「将发生什么」渲染成人能读的形式：
 * - bash：直接给命令原文（命令本身就是内容，JSON 转义反而难读）
 * - write：新旧内容的行级 diff（前缀/后缀比较，零依赖）；新文件给头部预览
 * - edit：oldString → newString 的 `-/+` 预览 + 命中行号 + 唯一性预检
 * - 其余 mutating 工具（含 connector）：退回 JSON 参数摘要
 *
 * 纯函数 + 同步 fs：approvalGate 在执行前调用，读一次文件的成本可接受；
 * 任何读文件异常都退回 JSON 摘要——预览只是增强，绝不阻塞审批主流程。
 */

import { readFileSync } from "node:fs";
import { resolvePath } from "../../src/tools/fs-utils.js";

/** diff 预览最多展示的 `-/+` 行数，超出截断 */
const MAX_DIFF_LINES = 40;
/** 整个 detail 的字符上限（原生 dialog 与 remote-ui 的显示友好线） */
const MAX_DETAIL_CHARS = 2000;
/** 超过这个行数不逐行 diff，只给统计（避免超大文件卡主进程） */
const MAX_DIFF_FILE_LINES = 5000;
/** 新文件头部预览行数 */
const NEW_FILE_PREVIEW_LINES = 10;

export interface ApprovalDetailInput {
  toolName: string;
  args: Record<string, unknown>;
  cwd: string;
}

/** 审批弹窗显示的正文：能生成 diff 就生成，任何异常退回 JSON 摘要 */
export function buildApprovalDetail(input: ApprovalDetailInput): string {
  const { toolName, args } = input;
  try {
    if (toolName === "bash") {
      const cmd = args["command"];
      return typeof cmd === "string" && cmd.length > 0 ? truncate(cmd) : summarizeArgs(args);
    }
    if (toolName === "write") return writeDetail(input);
    if (toolName === "edit") return editDetail(input);
  } catch {
    // 预览失败不阻塞审批，退回最朴素的参数摘要
  }
  return summarizeArgs(args);
}

/** 原 session.ts 的参数摘要：JSON 序列化后截断（兜底路径） */
export function summarizeArgs(args: Record<string, unknown>): string {
  try {
    const raw = JSON.stringify(args);
    return truncate(raw);
  } catch {
    return "(参数无法序列化)";
  }
}

// ------------------------------------------------------------------ write

function writeDetail(input: ApprovalDetailInput): string {
  const target = resolvePath(input.cwd, String(input.args["path"] ?? ""));
  const content = String(input.args["content"] ?? "");
  const newLines = content.length === 0 ? 0 : content.split("\n").length;

  let original: string | undefined;
  try {
    original = readFileSync(target, "utf8");
  } catch {
    original = undefined; // 不存在或不可读都按新文件处理
  }

  if (original === undefined) {
    const preview = content
      .split("\n")
      .slice(0, NEW_FILE_PREVIEW_LINES)
      .map((l) => `  | ${l}`)
      .join("\n");
    const more =
      newLines > NEW_FILE_PREVIEW_LINES ? `\n  …（共 ${newLines} 行）` : "";
    return `新文件：${target}（${newLines} 行）\n${preview}${more}`;
  }

  const oldLines = original.split("\n").length;
  const body =
    oldLines > MAX_DIFF_FILE_LINES || newLines > MAX_DIFF_FILE_LINES
      ? `（文件过大，不生成逐行 diff）`
      : diffLines(original, content);
  return `${target}（行数 ${oldLines} → ${newLines}）\n${body}`;
}

// ------------------------------------------------------------------- edit

function editDetail(input: ApprovalDetailInput): string {
  const target = resolvePath(input.cwd, String(input.args["path"] ?? ""));
  const oldString = String(input.args["oldString"] ?? "");
  const newString = String(input.args["newString"] ?? "");
  if (oldString.length === 0) return summarizeArgs(input.args);

  // 读文件做两个增强：命中行号 + 唯一性预检（执行前就让用户看到「这次会失败」）
  let original: string | undefined;
  try {
    original = readFileSync(target, "utf8");
  } catch {
    original = undefined;
  }

  const notes: string[] = [];
  let lineHint = "";
  if (original !== undefined) {
    const hits = original.split(oldString).length - 1;
    if (hits === 0) notes.push("注意：oldString 在文件中未找到，执行会失败");
    else if (hits > 1) notes.push(`注意：oldString 出现 ${hits} 次，执行会失败（必须唯一）`);
    else {
      const line = original.slice(0, original.indexOf(oldString)).split("\n").length;
      lineHint = `，第 ${line} 行起`;
    }
  }

  const removed = oldString.split("\n").map((l) => `- ${l}`);
  const added = newString.split("\n").map((l) => `+ ${l}`);
  const note = notes.length > 0 ? `\n${notes.join("；")}` : "";
  return `${target}（1 处替换${lineHint}）\n${capDiff(removed, added)}${note}`;
}

// ------------------------------------------------------------------- diff

/**
 * 零依赖行级 diff：找公共前缀/后缀，中间块标 `-`/`+`。
 * 覆盖审批预览的典型场景（局部改写、追加、删段落）；完整 LCS 不值当。
 */
function diffLines(oldText: string, newText: string): string {
  const a = oldText.split("\n");
  const b = newText.split("\n");

  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const removed = a.slice(prefix, a.length - suffix).map((l) => `- ${l}`);
  const added = b.slice(prefix, b.length - suffix).map((l) => `+ ${l}`);
  const unchanged = prefix + suffix;

  const head = unchanged > 0 ? `（前后共 ${unchanged} 行未变）\n` : "";
  return `${head}${capDiff(removed, added)}`;
}

/** `-/+` 行数超限时保留头部并注明省略量 */
function capDiff(removed: string[], added: string[]): string {
  const lines = [...removed, ...added];
  if (lines.length <= MAX_DIFF_LINES) return lines.join("\n");
  const kept = lines.slice(0, MAX_DIFF_LINES).join("\n");
  return `${kept}\n…（diff 共 ${lines.length} 行，已省略 ${lines.length - MAX_DIFF_LINES} 行）`;
}

function truncate(text: string): string {
  return text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS)}…（已截断）` : text;
}
