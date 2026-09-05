import { promises as fs } from "node:fs";
import path from "node:path";
import { assertInsideCwd, resolvePath } from "./fs-utils.js";
import type { Tool } from "./types.js";
import { fail, ok } from "./types.js";

export const writeTool: Tool = {
  name: "write",
  description: "把内容完整写入文件（会覆盖原文件），必要时自动创建目录。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "目标文件路径" },
      content: { type: "string", description: "要写入的完整内容" },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  isMutating: true,

  async execute(args, ctx) {
    const target = resolvePath(ctx.cwd, String(args["path"] ?? ""));
    const guard = assertInsideCwd(ctx.cwd, target);
    if (guard !== null) return fail(guard);

    const content = String(args["content"] ?? "");
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, "utf8");
    } catch (err) {
      return fail(`写入失败：${String(err)}`);
    }

    const lines = content.length === 0 ? 0 : content.split("\n").length;
    return ok(`已写入 ${target}（${Buffer.byteLength(content, "utf8")} 字节，${lines} 行）`);
  },
};
