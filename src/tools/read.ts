import { promises as fs } from "node:fs";
import { readTextFile, resolvePath, truncateLines } from "./fs-utils.js";
import type { Tool } from "./types.js";
import { fail, ok } from "./types.js";

const MAX_LINES = 2000;
const MAX_LINE_CHARS = 2000;

export const readTool: Tool = {
  name: "read",
  description: "读取文件内容并附带行号，用于查看代码、配置或日志。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件绝对路径或相对 cwd 的路径" },
      offset: { type: "integer", description: "从第几行开始读，从 1 计数" },
      limit: { type: "integer", description: "最多读取多少行" },
    },
    required: ["path"],
    additionalProperties: false,
  },
  isMutating: false,

  async execute(args, ctx) {
    const input = String(args["path"] ?? "");
    const abs = resolvePath(ctx.cwd, input);

    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      return fail(`文件不存在：${abs}`);
    }
    if (stat.isDirectory()) return fail(`这是一个目录，不是文件：${abs}`);

    const text = await readTextFile(abs);
    if (text === null) return fail(`无法按文本读取（可能是二进制文件）：${abs}`);

    const all = text.split("\n");
    const offset = Math.max(1, Number(args["offset"] ?? 1));
    const limit = Math.min(MAX_LINES, Math.max(1, Number(args["limit"] ?? MAX_LINES)));
    const slice = all.slice(offset - 1, offset - 1 + limit);

    if (slice.length === 0) {
      return ok(`（${abs} 在第 ${offset} 行之后没有内容，共 ${all.length} 行）`);
    }

    const numbered = slice.map(
      (line, i) => `${String(offset + i).padStart(6)}\t${line}`,
    );
    const { text: body, truncated } = truncateLines(numbered, MAX_LINES, MAX_LINE_CHARS);
    const header = `${abs}（第 ${offset}-${offset + slice.length - 1} 行，共 ${all.length} 行）`;
    return ok(`${header}${truncated ? "（已截断）" : ""}\n${body}`);
  },
};
