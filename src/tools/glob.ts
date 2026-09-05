import { globToRegExp } from "./glob-matcher.js";
import { resolvePath, walkFiles } from "./fs-utils.js";
import type { Tool } from "./types.js";
import { fail, ok } from "./types.js";

const MAX_RESULTS = 200;

export const globTool: Tool = {
  name: "glob",
  description:
    "按模式匹配文件，例如 **/*.ts、src/**/*.{ts,tsx}、*.md。结果按修改时间从新到旧排序。",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "glob 模式，如 **/*.ts" },
      path: { type: "string", description: "搜索根目录，默认 cwd" },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  isMutating: false,

  async execute(args, ctx) {
    const pattern = String(args["pattern"] ?? "");
    if (pattern.trim().length === 0) return fail("pattern 不能为空");

    const root = resolvePath(ctx.cwd, String(args["path"] ?? ctx.cwd));
    let regex: RegExp;
    try {
      regex = globToRegExp(pattern);
    } catch {
      return fail(`glob 模式非法：${pattern}`);
    }

    const files = await walkFiles(root, { maxFiles: 5000 });
    const matched = files
      .filter((f) => regex.test(f.rel))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    if (matched.length === 0) return ok(`没有匹配 ${pattern} 的文件`);

    const shown = matched.slice(0, MAX_RESULTS);
    const suffix =
      matched.length > MAX_RESULTS
        ? `\n… 另有 ${matched.length - MAX_RESULTS} 个匹配项未列出`
        : "";
    return ok(`匹配 ${matched.length} 个文件：\n${shown.map((f) => f.rel).join("\n")}${suffix}`);
  },
};
