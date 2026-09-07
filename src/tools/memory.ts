/**
 * Context 支柱：跨会话记忆工具。
 *
 * 职责边界（设计哲学：模型自己决定记什么，harness 只管存与注入）：
 * - 模型侧：用户说「记住…」、或出现跨会话仍有效的长期事实/偏好/决策时调用 append
 * - harness 侧：collectProjectMemory 每次开会话把记忆文件读回系统提示词
 *
 * 存储：<cwd>/MEMORY.md（项目根目录，用户定调：可见、可直接编辑），
 * 追加式 Markdown 列表。删除/改写不需要专门 action——它就是一个普通 md 文件，
 * 用 edit 工具改。懒创建：首次 append 才写盘。
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fail, ok, type Tool } from "./types.js";

export const MEMORY_FILE = "MEMORY.md";

/** read 时最多返回的字符数（保留尾部——越新的记忆越靠下） */
const MEMORY_MAX_CHARS = 8_000;

export function memoryPath(cwd: string): string {
  return path.join(cwd, MEMORY_FILE);
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const memoryTool: Tool = {
  name: "memory",
  description:
    "跨会话记忆：把值得长期保留的事实/偏好/决策追加到项目记忆文件（下次会话自动注入系统提示词），" +
    "或读取已有记忆。只记「跨会话仍有效」的信息——用户偏好、项目约定、重要决策；" +
    "不记一次性任务细节。用户明确说「记住」时必须调用。",
  isMutating: true,
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["append", "read"],
        description: "append=追加一条记忆；read=读取全部已有记忆",
      },
      content: {
        type: "string",
        description: "action=append 时必填：要记住的一句话（跨会话仍有效的事实/偏好/决策）",
      },
    },
    required: ["action"],
  },

  async execute(args, ctx) {
    const action = String(args["action"] ?? "read");
    const file = memoryPath(ctx.cwd);

    if (action === "read") {
      try {
        const raw = (await readFile(file, "utf8")).trim();
        if (raw.length === 0) return ok("（记忆文件为空，还没有任何跨会话记忆）");
        // 保留尾部：追加式文件里越靠下越新
        return ok(`${file}\n\n${raw.length > MEMORY_MAX_CHARS ? raw.slice(-MEMORY_MAX_CHARS) : raw}`);
      } catch {
        return ok("（记忆文件不存在，还没有任何跨会话记忆）");
      }
    }

    if (action === "append") {
      const content = String(args["content"] ?? "").trim();
      if (content.length === 0) return fail("append 需要非空的 content 参数");
      const line = `- [${timestamp()}] ${content}\n`;
      try {
        await mkdir(path.dirname(file), { recursive: true });
        await appendFile(file, line, "utf8");
        return ok(`已写入跨会话记忆：${content}`);
      } catch (err) {
        return fail(`写入记忆失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return fail(`未知 action：${action}（可用：append / read）`);
  },
};
