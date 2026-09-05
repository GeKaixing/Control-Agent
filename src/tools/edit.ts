import { promises as fs } from "node:fs";
import { assertInsideCwd, resolvePath } from "./fs-utils.js";
import type { Tool } from "./types.js";
import { fail, ok } from "./types.js";

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

export const editTool: Tool = {
  name: "edit",
  description:
    "对文件做精确字符串替换。oldString 必须在文件里唯一，否则会报错。比整文件重写更省 token。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "目标文件路径" },
      oldString: { type: "string", description: "要被替换的原始文本，必须唯一" },
      newString: { type: "string", description: "替换后的新文本" },
    },
    required: ["path", "oldString", "newString"],
    additionalProperties: false,
  },
  isMutating: true,

  async execute(args, ctx) {
    const target = resolvePath(ctx.cwd, String(args["path"] ?? ""));
    const guard = assertInsideCwd(ctx.cwd, target);
    if (guard !== null) return fail(guard);

    const oldString = String(args["oldString"] ?? "");
    const newString = String(args["newString"] ?? "");
    if (oldString.length === 0) return fail("oldString 不能为空");

    let original: string;
    try {
      original = await fs.readFile(target, "utf8");
    } catch {
      return fail(`文件不存在或无法读取：${target}`);
    }

    const hits = countOccurrences(original, oldString);
    if (hits === 0) {
      return fail(`在 ${target} 中找不到 oldString，请确认内容完全一致（含缩进与换行）`);
    }
    if (hits > 1) {
      return fail(
        `oldString 在 ${target} 中出现 ${hits} 次，必须唯一。请补充更多上下文后重试，或改用 write 重写整个文件。`,
      );
    }

    const updated = original.replace(oldString, newString);
    try {
      await fs.writeFile(target, updated, "utf8");
    } catch (err) {
      return fail(`写入失败：${String(err)}`);
    }

    const beforeLines = original.split("\n").length;
    const afterLines = updated.split("\n").length;
    return ok(`已修改 ${target}（行数 ${beforeLines} → ${afterLines}）`);
  },
};
