/**
 * Context 支柱：程序性记忆（GUI 操作流程记忆）工具。
 *
 * 与 memory 工具的分工：memory 记「事实/偏好/决策」（陈述性记忆，项目级）；
 * procedure 记「某个 App 怎么操作」（程序性记忆，机器级）——
 * 「电脑版微信这样操作、手机版抖音那样操作」属于机器上任何项目都可能复用的经验，
 * 所以存储放用户级 `~/.control-agent/procedures.md`，跨项目共享（env `C_AGENT_PROCEDURES`
 * 可覆盖文件路径，测试用）。
 *
 * 职责边界（设计哲学：模型自己决定记什么、何时查，harness 只管存取与索引注入）：
 * - 模型侧：跑通一个 App 的操作流程后主动 save；动手操作前 search 有没有现成记忆
 * - harness 侧：session.ts 的 collectProcedureIndex 每次开会话把条目索引注入系统提示词
 *
 * 存储：单个追加式 Markdown 文件，条目格式——
 *   ## <app> @<platform>
 *   - 更新: <时间戳>
 *   - 摘要: <一行摘要>          （可选）
 *   <步骤原文>
 * 同 (app, platform) 重复 save = 覆盖更新（像人刷新记忆，不是无限堆积）；
 * 删除不需要专门机制——forget 之外，它就是个普通 md 文件，用 edit 工具改。
 */

import { existsSync, renameSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fail, ok, type Tool } from "./types.js";

/** 单文件条目上限（防止索引与 search 无限膨胀；超过时最旧的被覆盖新条目挤出） */
export const PROCEDURE_MAX_ENTRIES = 200;

/** search 结果正文上限 */
const SEARCH_MAX_CHARS = 4_000;

/** 旧文件迁移只做一次（process 生命周期内） */
let homeMigrated = false;

export function procedureFile(): string {
  const file = process.env["C_AGENT_PROCEDURES"] ?? path.join(os.homedir(), ".control-agent", "procedures.md");
  if (!homeMigrated) {
    homeMigrated = true;
    try {
      const legacy = path.join(os.homedir(), ".c-agent", "procedures.md");
      if (!existsSync(file) && existsSync(legacy)) renameSync(legacy, file);
    } catch {
      // 迁移失败静默：老文件留在原地，不阻塞读写
    }
  }
  return file;
}

export interface ProcedureEntry {
  app: string;
  platform: string;
  /** 摘要行（save 时给 title 参数则有；否则取步骤首行） */
  summary: string;
  /** 环境信息（系统自动盖章 + 模型补充的 App 版本/窗口大小等） */
  env: string;
  updatedAt: string;
  /** 除标题行外的条目正文（含 更新/环境/摘要 行），已 trim */
  body: string;
}

/** 从条目正文里提取摘要：优先 摘要: 行，否则第一条非元数据行 */
function extractSummary(bodyLines: string[]): string {
  for (const line of bodyLines) {
    const m = line.match(/^-\s*摘要:\s*(.+)$/);
    if (m !== null) return m[1]!.trim();
  }
  for (const line of bodyLines) {
    if (/^-\s*(更新|环境):/.test(line)) continue;
    const t = line.replace(/^\d+[.、)）]\s*/, "").trim();
    if (t.length > 0) return t;
  }
  return "";
}

/** 解析整份 procedures.md → 条目数组（纯函数，可测；坏条目静默跳过） */
export function parseProcedures(raw: string): ProcedureEntry[] {
  const entries: ProcedureEntry[] = [];
  const lines = raw.split(/\r?\n/);
  let heading: string | null = null;
  let body: string[] = [];
  const flush = (): void => {
    if (heading === null) return;
    const m = heading.match(/^(.+?)\s+@(\S+)\s*$/);
    if (m !== null) {
      const trimmed = body.join("\n").trim();
      entries.push({
        app: m[1]!.trim(),
        platform: m[2]!,
        summary: extractSummary(body),
        updatedAt: (body.find((l) => /^-\s*更新:/.test(l)) ?? "").replace(/^-\s*更新:\s*/, "").trim(),
        env: (body.find((l) => /^-\s*环境:/.test(l)) ?? "").replace(/^-\s*环境:\s*/, "").trim(),
        body: trimmed,
      });
    }
    heading = null;
    body = [];
  };
  for (const line of lines) {
    if (line.startsWith("## ")) {
      flush();
      heading = line.slice(3).trim();
    } else if (heading !== null) {
      body.push(line);
    }
  }
  flush();
  return entries;
}

/** (app, platform) 保存 = 覆盖更新，其余条目原序保留（纯函数，可测） */
export function upsertProcedure(raw: string, app: string, platform: string, steps: string, title: string, env: string, now: string): string {
  const key = `${app.trim().toLowerCase()}@${platform}`;
  const kept = parseProcedures(raw).filter((e) => `${e.app.toLowerCase()}@${e.platform}` !== key);
  const meta = [
    `- 更新: ${now}`,
    `- 环境: ${env.trim().length > 0 ? `${env.trim()}；系统: ${osStamp()}` : osStamp()}`,
    ...(title.trim().length > 0 ? [`- 摘要: ${title.trim()}`] : []),
  ];
  const block = [`## ${app.trim()} @${platform}`, ...meta, steps.trim()].join("\n");
  const rebuilt = [...kept.map((e) => `## ${e.app} @${e.platform}\n${e.body}`), block];
  // 超上限：挤掉最旧（非本次）条目
  const overflow = Math.max(0, rebuilt.length - PROCEDURE_MAX_ENTRIES);
  return `${rebuilt.slice(overflow).join("\n\n").trim()}\n`;
}

/** 当前执行环境自动盖章（harness 免费知道的系统事实；纯函数便于测） */
export function osStamp(): string {
  const type = os.type() === "Windows_NT" ? "Windows" : os.type() === "Darwin" ? "macOS" : "Linux";
  return `${type} ${os.release()} ${os.arch()}`;
}

/** 条目 → 索引一行（注入系统提示词用；环境信息附在尾部便于模型先核对环境再查详情） */
export function formatIndexLine(e: ProcedureEntry): string {
  const sum = e.summary.length > 0 ? e.summary : "（无摘要）";
  const env = e.env.length > 0 ? `〔${e.env.length > 48 ? `${e.env.slice(0, 45)}...` : e.env}〕` : "";
  return `- ${e.app} @${e.platform}：${sum.length > 80 ? `${sum.slice(0, 77)}...` : sum}${env}`;
}

/** 索引段落（session.ts 注入用；空文件 → 空串） */
export function formatProcedureIndex(raw: string): string {
  const entries = parseProcedures(raw);
  if (entries.length === 0) return "";
  const lines = entries.map(formatIndexLine);
  const shown = lines.length > 40 ? [...lines.slice(0, 40), `- …共 ${lines.length} 条，更多用 procedure 工具 list 查看`] : lines;
  return (
    "## 操作记忆（此前会话保存的 GUI 操作流程；动手操作 App 前先核对条目的环境〔系统/App 版本/分辨率〕与当前是否一致，" +
    "一致才照做，不一致就重新摸索并 save 更新；procedure search 可查完整步骤）\n\n" +
    shown.join("\n")
  );
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const PLATFORMS = ["desktop", "mobile", "browser"] as const;

async function readStore(): Promise<string> {
  try {
    return await readFile(procedureFile(), "utf8");
  } catch {
    return "";
  }
}

export const procedureTool: Tool = {
  name: "procedure",
  description:
    "操作流程记忆（程序性记忆）：把「某个 App 在什么环境下怎么操作」存下来，下次操作同一个 App 前先查——" +
    "像人记住「微信电脑版先点左下角三条杠再点设置」一样。save=保存/更新（同 app+平台覆盖）；" +
    "search=按关键字查现成流程；list=列全部条目索引；forget=删除。" +
    "跨项目共享（用户级存储）。操作桌面/手机 App 成功跑通一条流程后应主动 save，" +
    "并带 env 环境信息（App 版本、窗口大小/分辨率等）——环境不同操作路径可能不同，系统信息会自动记录。",
  isMutating: true,
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["save", "search", "list", "forget"],
        description: "save 保存/更新一条操作流程；search 关键字查找；list 列索引；forget 删除",
      },
      app: { type: "string", description: "App 名（save/forget 必填），如：微信、抖音、MuMu模拟器" },
      platform: {
        type: "string",
        enum: [...PLATFORMS],
        description: "平台（save 必填，forget 可选=删该平台条目；缺省删该 App 全部）：desktop=电脑版 / mobile=手机版 / browser=网页版",
      },
      title: { type: "string", description: "action=save 时可选：一行摘要（用于索引，如「改头像的完整路径」）" },
      env: {
        type: "string",
        description:
          "action=save 时强烈建议：执行环境（系统会自动记录 OS，这里补充 OS 之外的）——" +
          "App 版本号、窗口大小/分辨率、模拟器实例（如 MuMu 实例1 900x1600）、语言/账号状态等影响操作路径的因素",
      },
      steps: {
        type: "string",
        description: "action=save 时必填：具体操作步骤，写到下次不看屏幕也能照做的程度（点哪个按钮、输入什么、快捷键）",
      },
      query: { type: "string", description: "action=search 时必填：关键字（匹配 App 名 / 摘要 / 步骤内容）" },
    },
    required: ["action"],
  },

  async execute(args) {
    const action = String(args["action"] ?? "list");
    const file = procedureFile();

    if (action === "save") {
      const app = String(args["app"] ?? "").trim();
      const platform = String(args["platform"] ?? "").trim();
      const steps = String(args["steps"] ?? "").trim();
      if (app.length === 0) return fail("save 需要非空的 app 参数");
      if (!(PLATFORMS as readonly string[]).includes(platform)) {
        return fail(`platform 必须是 ${PLATFORMS.join(" / ")} 之一`);
      }
      if (steps.length === 0) return fail("save 需要非空的 steps 参数（具体步骤，不是一句话感想）");
      const raw = await readStore();
      const env = String(args["env"] ?? "");
      const next = upsertProcedure(raw, app, platform, steps, String(args["title"] ?? ""), env, timestamp());
      try {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, next, "utf8");
        const entries = parseProcedures(next);
        const hit = entries.find((e) => e.app.toLowerCase() === app.toLowerCase() && e.platform === platform);
        const envNote = hit !== undefined && hit.env.length > 0 ? `\n环境：${hit.env}` : "";
        return ok(`操作记忆已${raw.includes(`## ${app} `) ? "更新" : "保存"}：${app} @${platform}（当前共 ${entries.length} 条）${envNote}${hit !== undefined && hit.summary.length > 0 ? `\n摘要：${hit.summary}` : ""}`);
      } catch (err) {
        return fail(`写入操作记忆失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (action === "search") {
      const query = String(args["query"] ?? "").trim().toLowerCase();
      if (query.length === 0) return fail("search 需要非空的 query 参数");
      const hits = parseProcedures(await readStore()).filter((e) =>
        `${e.app} ${e.platform} ${e.summary} ${e.body}`.toLowerCase().includes(query),
      );
      if (hits.length === 0) return ok(`没有匹配「${query}」的操作记忆——这个 App 可能还没操作过，自己摸索吧。`);
      let out = `找到 ${hits.length} 条操作记忆：\n\n`;
      for (const h of hits) {
        const block = `## ${h.app} @${h.platform}\n${h.body}`;
        out += `${block.length > SEARCH_MAX_CHARS ? `${block.slice(0, SEARCH_MAX_CHARS)}…(截断)` : block}\n\n`;
      }
      return ok(out.trim());
    }

    if (action === "list") {
      const entries = parseProcedures(await readStore());
      if (entries.length === 0) return ok("（还没有任何操作记忆）");
      return ok(`共 ${entries.length} 条操作记忆：\n${entries.map(formatIndexLine).join("\n")}`);
    }

    if (action === "forget") {
      const app = String(args["app"] ?? "").trim();
      const platform = String(args["platform"] ?? "").trim();
      if (app.length === 0) return fail("forget 需要非空的 app 参数");
      const raw = await readStore();
      const key = app.toLowerCase();
      const before = parseProcedures(raw);
      const kept = before.filter((e) => e.app.toLowerCase() !== key || (platform.length > 0 && e.platform !== platform));
      if (kept.length === before.length) return ok(`没有找到「${app}」的操作记忆`);
      const next = kept.length === 0 ? "" : `${kept.map((e) => `## ${e.app} @${e.platform}\n${e.body}`).join("\n\n").trim()}\n`;
      try {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, next, "utf8");
        return ok(`已删除 ${before.length - kept.length} 条「${app}」的操作记忆（剩 ${kept.length} 条）`);
      } catch (err) {
        return fail(`写入操作记忆失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return fail(`未知 action：${action}（可用：save / search / list / forget）`);
  },
};
