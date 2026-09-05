/** 文件系统相关的公共辅助：路径解析、目录遍历、输出截断。 */

import { promises as fs } from "node:fs";
import path from "node:path";

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".cache",
  ".workbuddy",
  "vendor",
]);

/** 相对路径按 cwd 解析，绝对路径原样返回；~ 展开为家目录 */
export function resolvePath(cwd: string, input: string): string {
  const expanded = input.startsWith("~")
    ? path.join(process.env["HOME"] ?? "", input.slice(1))
    : input;
  const abs = path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
  return path.normalize(abs);
}

export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.6);
  const tail = maxChars - head;
  const omitted = text.length - maxChars;
  return `${text.slice(0, head)}\n\n… 已省略 ${omitted} 个字符 …\n\n${text.slice(text.length - tail)}`;
}

export function truncateLines(
  lines: string[],
  maxLines: number,
  maxCharsPerLine: number,
): { text: string; truncated: boolean } {
  const clipped = lines.map((l) =>
    l.length > maxCharsPerLine ? `${l.slice(0, maxCharsPerLine)} …（行被截断）` : l,
  );
  if (clipped.length <= maxLines) {
    return { text: clipped.join("\n"), truncated: false };
  }
  const head = clipped.slice(0, Math.floor(maxLines * 0.7));
  const tail = clipped.slice(clipped.length - Math.ceil(maxLines * 0.3));
  const text = [
    ...head,
    `… 已省略 ${clipped.length - head.length - tail.length} 行 …`,
    ...tail,
  ].join("\n");
  return { text, truncated: true };
}

export interface FileEntry {
  /** 相对 root 的路径，统一使用 / 分隔符以便 glob 匹配 */
  rel: string;
  abs: string;
  mtimeMs: number;
  size: number;
}

export async function walkFiles(
  root: string,
  options?: { maxFiles?: number; includeIgnored?: boolean },
): Promise<FileEntry[]> {
  const maxFiles = options?.maxFiles ?? 5000;
  const includeIgnored = options?.includeIgnored ?? false;
  const out: FileEntry[] = [];
  const stack: string[] = [root];

  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) return out;
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (entry.isDirectory()) {
        if (!includeIgnored && (IGNORED_DIRS.has(entry.name) || entry.name.startsWith("."))) {
          continue;
        }
        stack.push(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!includeIgnored && entry.name.startsWith(".")) continue;
      let stat;
      try {
        stat = await fs.stat(abs);
      } catch {
        continue;
      }
      out.push({ rel, abs, mtimeMs: stat.mtimeMs, size: stat.size });
    }
  }

  return out;
}

/** 读取文本文件；二进制（含 NUL 字节）返回 null */
export async function readTextFile(abs: string, maxBytes = 2_000_000): Promise<string | null> {
  let handle;
  try {
    handle = await fs.open(abs, "r");
  } catch {
    return null;
  }
  try {
    const size = (await handle.stat()).size;
    const buffer = Buffer.alloc(Math.min(size, maxBytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const slice = buffer.subarray(0, bytesRead);
    if (slice.includes(0)) return null;
    return slice.toString("utf8");
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

export async function pathExists(abs: string): Promise<boolean> {
  try {
    await fs.access(abs);
    return true;
  } catch {
    return false;
  }
}
