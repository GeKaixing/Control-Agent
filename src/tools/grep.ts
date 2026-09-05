import { globToRegExp } from "./glob-matcher.js";
import { readTextFile, resolvePath, walkFiles } from "./fs-utils.js";
import type { Tool } from "./types.js";
import { fail, ok } from "./types.js";

const DEFAULT_MAX_RESULTS = 100;
const MAX_LINE_CHARS = 500;

export const grepTool: Tool = {
  name: "grep",
  description:
    "在文件内容中按正则搜索，输出 路径:行号:内容。适合定位函数、符号、字符串出现在哪里。",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "正则表达式，如 function\\s+foo" },
      path: { type: "string", description: "搜索根目录，默认 cwd" },
      include: { type: "string", description: "只搜索匹配该 glob 的文件，如 **/*.ts" },
      ignoreCase: { type: "boolean", description: "是否忽略大小写，默认 false" },
      maxResults: { type: "integer", description: "最多返回多少条，默认 100" },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  isMutating: false,

  async execute(args, ctx) {
    const pattern = String(args["pattern"] ?? "");
    if (pattern.length === 0) return fail("pattern 不能为空");

    let regex: RegExp;
    try {
      regex = new RegExp(pattern, args["ignoreCase"] === true ? "i" : "");
    } catch (err) {
      return fail(`正则表达式非法：${String(err)}`);
    }

    const includeRaw = args["include"];
    const includeRegex =
      typeof includeRaw === "string" && includeRaw.length > 0
        ? globToRegExp(includeRaw)
        : null;

    const maxResults = Math.min(
      1000,
      Math.max(1, Number(args["maxResults"] ?? DEFAULT_MAX_RESULTS)),
    );
    const root = resolvePath(ctx.cwd, String(args["path"] ?? ctx.cwd));
    const files = await walkFiles(root, { maxFiles: 5000 });

    const hits: string[] = [];
    let scanned = 0;

    for (const file of files) {
      if (hits.length >= maxResults) break;
      if (includeRegex !== null && !includeRegex.test(file.rel)) continue;

      const text = await readTextFile(file.abs);
      if (text === null) continue;
      scanned += 1;

      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (hits.length >= maxResults) break;
        const line = lines[i] ?? "";
        if (!regex.test(line)) continue;
        const clipped =
          line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)} …` : line;
        hits.push(`${file.rel}:${i + 1}: ${clipped}`);
      }
    }

    if (hits.length === 0) {
      return ok(`扫描了 ${scanned} 个文件，没有匹配 /${pattern}/ 的内容`);
    }
    const suffix = hits.length >= maxResults ? `\n… 结果已达上限 ${maxResults} 条` : "";
    return ok(`${hits.join("\n")}${suffix}`);
  },
};
