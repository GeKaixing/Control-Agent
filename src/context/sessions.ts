/**
 * Context 支柱：.c-agent/ 目录的单一持久化出口（会话树 + 用户配置），一套纪律。
 *
 * 之前会话树纯内存（AgentState.nodes），进程退出即消失——这是 v1 的刻意边界，
 * 本模块把它补上：树结构天然可 JSON 序列化，存取即可，不摘要不清洗
 * （哪些内容值得留是 transformContext 管线的事，这里只管字节）。
 *
 * 存储：<cwd>/.c-agent/sessions/<id>.json。会话 id 带时间戳前缀，
 * 文件名即时间线；原子写（tmp + rename），崩溃最多丢当前轮。
 * 用户配置存 <cwd>/.c-agent/config.json（目前只有 /model 选过的模型），
 * 复用同一套原子写 / 版本校验 / 坏文件静默回退，不另起第二套持久化。
 *
 * 与 memory 工具（项目根 MEMORY.md）的分工：MEMORY.md 是模型自己决定记的
 * 「跨会话有效的事实」，注入系统提示词；sessions 是完整的对话历史（含分支、
 * compact 旧分支），只在 --resume 时整体还原。
 */

import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { activeBranch, type AgentState, type MessageNode } from "./state.js";
import type { ModelRef } from "../types.js";

/** 会话文件目录（相对 cwd）；记忆文件在项目根，会话历史仍是隐藏运行时状态 */
export const SESSIONS_DIR = path.join(".c-agent", "sessions");

const SESSION_VERSION = 1;

interface StoredSession {
  version: number;
  id: string;
  savedAt: number;
  rootId: string | null;
  currentNodeId: string | null;
  nodes: MessageNode[];
}

export interface SessionSummary {
  id: string;
  savedAt: number;
  /** 持久化的节点数（含 toolResult 与 compact 旧分支，大于「对话条数」） */
  nodeCount: number;
}

export function sessionsDir(cwd: string): string {
  return path.join(cwd, SESSIONS_DIR);
}

/** 会话 id：时间戳前缀（文件名即时间线）+ 4 位随机尾巴防同秒碰撞 */
function newSessionId(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const rand = Math.random().toString(36).slice(2, 6);
  return `s${stamp}_${rand}`;
}

/**
 * 把会话树整体落盘。state.sessionId 为空时分配新 id（并写回 state，
 * 让后续保存落到同一个文件、/sessions 能标出「当前」）。
 * @returns 会话 id
 */
export async function saveSession(state: AgentState, cwd: string): Promise<string> {
  const id = state.sessionId ?? newSessionId();
  state.sessionId = id;

  const stored: StoredSession = {
    version: SESSION_VERSION,
    id,
    savedAt: Date.now(),
    rootId: state.rootId,
    currentNodeId: state.currentNodeId,
    nodes: [...state.nodes.values()],
  };

  const dir = sessionsDir(cwd);
  await mkdir(dir, { recursive: true });
  // 原子写：先写 tmp 再 rename，进程崩溃不会留下半截 JSON
  const file = path.join(dir, `${id}.json`);
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(stored), "utf8");
  await rename(tmp, file);
  return id;
}

/**
 * 把指定会话还原进 state（nodes / rootId / ★ / messages 线性视图 / sessionId）。
 * 恢复的是完整树——compact 留下的旧分支原样回来，switchTo 仍可回溯。
 * 文件不存在 / 损坏 / 版本不识别 → false，state 不动。
 */
export async function loadSessionInto(
  state: AgentState,
  cwd: string,
  id: string,
): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(path.join(sessionsDir(cwd), `${id}.json`), "utf8");
  } catch {
    return false;
  }

  let data: StoredSession;
  try {
    const parsed = JSON.parse(raw) as StoredSession;
    if (parsed.version !== SESSION_VERSION || !Array.isArray(parsed.nodes)) return false;
    data = parsed;
  } catch {
    return false;
  }

  // 节点间引用完整性：parent / children 指向的 id 必须都在集合里，否则拒绝载入
  const ids = new Set(data.nodes.map((n) => n.id));
  for (const n of data.nodes) {
    if (n.parent !== null && !ids.has(n.parent)) return false;
    if (!n.children.every((c) => ids.has(c))) return false;
  }
  if (data.currentNodeId !== null && !ids.has(data.currentNodeId)) return false;

  state.nodes = new Map(data.nodes.map((n) => [n.id, n]));
  state.rootId = data.rootId;
  state.currentNodeId = data.currentNodeId;
  state.sessionId = data.id;
  // 线性视图从 ★ 重算，不信任存储里的冗余字段
  state.messages = activeBranch(state);
  return true;
}

/** 列出全部已持久化会话，按保存时间倒序（新的在前）；损坏文件静默跳过 */
export async function listSessions(cwd: string): Promise<SessionSummary[]> {
  let files: string[];
  try {
    files = await readdir(sessionsDir(cwd));
  } catch {
    return [];
  }

  const out: SessionSummary[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = await readFile(path.join(sessionsDir(cwd), f), "utf8");
      const s = JSON.parse(raw) as StoredSession;
      if (s.version !== SESSION_VERSION || typeof s.id !== "string") continue;
      out.push({ id: s.id, savedAt: s.savedAt, nodeCount: s.nodes.length });
    } catch {
      // 单个文件损坏不影响其余
    }
  }
  return out.sort((a, b) => b.savedAt - a.savedAt);
}

/** 最近一次持久化的会话 id；没有任何会话时 null（--resume 不带 id 时用） */
export async function latestSessionId(cwd: string): Promise<string | null> {
  const list = await listSessions(cwd);
  return list[0]?.id ?? null;
}

/** 供测试/清理用：会话文件是否存在（按 stat 而非解析，损坏文件也算存在） */
export async function sessionFileExists(cwd: string, id: string): Promise<boolean> {
  try {
    await stat(path.join(sessionsDir(cwd), `${id}.json`));
    return true;
  } catch {
    return false;
  }
}

/** 会话 id 合法字符：字母数字 + _ @ . -，且不能以点开头——堵死路径穿越（../、\\、绝对路径） */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_@][A-Za-z0-9_.@-]*$/;

/**
 * 删除指定会话文件。id 非法（含路径分隔符等）或文件不存在 → false，不抛错——
 * 与本模块「坏输入静默回退」同一纪律。删除当前会话的拦截在调用方（REPL）做：
 * 这里只管字节，不知道「哪份是活着的」。
 */
export async function deleteSession(cwd: string, id: string): Promise<boolean> {
  if (!SESSION_ID_PATTERN.test(id)) return false;
  try {
    await unlink(path.join(sessionsDir(cwd), `${id}.json`));
    return true;
  } catch {
    return false;
  }
}

// ────────────── 用户配置（.c-agent/config.json） ──────────────

const CONFIG_VERSION = 1;

/**
 * 自定义模型持久值：完整参数自描述（baseUrl/apiKey 无法从 spec 字符串回放，
 * 所以自定义模型存对象不存 spec）。重启后据此直接重建 ModelRef。
 * apiKey 明文落盘——与 .env 放 key 同级风险，.c-agent/ 本就是本地明文目录。
 */
export interface StoredCustomModel {
  /** 协议（ModelRef.provider 原样）：openai / openai-responses / anthropic / gemini */
  provider: string;
  /** 模型 id */
  id: string;
  /** 接口地址（归一后的真值：anthropic 根路径、无尾斜杠） */
  baseUrl: string;
  /** API KEY；"EMPTY" 是桌面端留空占位（本地端点约定） */
  apiKey: string;
  /** 上下文窗口覆写；缺省自动识别 */
  contextWindow?: number;
}

interface StoredConfig {
  version: number;
  /** 上次选定的模型 spec（"provider:id[:strong|budget]"） */
  model?: string;
  /**
   * 工作目录覆写（桌面端专用）：用户显式指定的项目文件夹绝对路径。
   * 缺省 = 桌面端用默认工作区（桌面上的 workspace 文件夹）。
   * CLI 不读这个字段——CLI 的 cwd 本来就是用户 shell 所在目录。
   */
  cwd?: string;
  /** 上次选定的自定义模型完整参数；与 model 互斥——最后一次的选择是唯一真相 */
  customModel?: StoredCustomModel;
  updatedAt?: number;
}

/** config.json 的绝对路径（与 sessions 同在 .c-agent/，同一套落盘纪律） */
export function configPath(cwd: string): string {
  return path.join(cwd, ".c-agent", "config.json");
}

async function readConfig(cwd: string): Promise<StoredConfig | null> {
  let raw: string;
  try {
    raw = await readFile(configPath(cwd), "utf8");
  } catch {
    return null;
  }
  try {
    const data = JSON.parse(raw) as StoredConfig;
    return data.version === CONFIG_VERSION ? data : null;
  } catch {
    return null;
  }
}

/**
 * 读取持久化的模型 spec。文件不存在 / JSON 损坏 / 版本不识别 / model 字段缺失
 * 或空白 → null（调用方回退到 MODEL env / 内置默认），不打日志不抛错。
 */
export async function readSavedModelSpec(cwd: string): Promise<string | null> {
  const data = await readConfig(cwd);
  if (data === null || typeof data.model !== "string") return null;
  const spec = data.model.trim();
  return spec.length > 0 ? spec : null;
}

/**
 * 读取持久化的自定义模型完整参数。字段不完整（provider/id/baseUrl 非空字符串、
 * apiKey 字符串）视为损坏返回 null，调用方回退内置默认。
 */
export async function readSavedCustomModel(cwd: string): Promise<StoredCustomModel | null> {
  const data = await readConfig(cwd);
  const c = data?.customModel;
  if (
    c === undefined ||
    typeof c.provider !== "string" || c.provider.length === 0 ||
    typeof c.id !== "string" || c.id.length === 0 ||
    typeof c.baseUrl !== "string" || c.baseUrl.length === 0 ||
    typeof c.apiKey !== "string"
  ) {
    return null;
  }
  return {
    provider: c.provider,
    id: c.id,
    baseUrl: c.baseUrl,
    apiKey: c.apiKey,
    ...(typeof c.contextWindow === "number" && c.contextWindow > 0
      ? { contextWindow: c.contextWindow }
      : {}),
  };
}

/**
 * 读取用户指定的工作目录（桌面端用）。非空字符串才认；不校验存在性——
 * 存在性/可创建性由调用方决定（不存在可以 mkdir，或报错提示用户改配置）。
 * 缺省返回 null = 调用方走自己的默认值。
 */
export async function readSavedWorkspaceCwd(cwd: string): Promise<string | null> {
  const data = await readConfig(cwd);
  const dir = data?.cwd;
  if (typeof dir !== "string") return null;
  const trimmed = dir.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 原子写入工作目录覆写（桌面端设置弹窗的落盘点）。dir 为 null = 清除覆写，
 * 回到缺省工作区。模型 spec / customModel 原样保留（互不干扰）。
 */
export async function saveWorkspaceCwd(cwd: string, dir: string | null): Promise<void> {
  const prev = await readConfig(cwd);
  await writeConfig(cwd, {
    version: CONFIG_VERSION,
    ...(prev?.model !== undefined ? { model: prev.model } : {}),
    ...(prev?.customModel !== undefined ? { customModel: prev.customModel } : {}),
    ...(dir !== null && dir.trim().length > 0 ? { cwd: dir.trim() } : {}),
    updatedAt: Date.now(),
  });
}

async function writeConfig(cwd: string, stored: StoredConfig): Promise<void> {
  await mkdir(path.join(cwd, ".c-agent"), { recursive: true });
  const file = configPath(cwd);
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(stored), "utf8");
  await rename(tmp, file);
}

/**
 * 原子写入模型 spec（tmp + rename，与 saveSession 同款）。写入失败会抛出，
 * 由调用方决定怎么提示——配置存不上不该打断「切换模型」本身。
 * 互斥：写 spec 清掉 customModel（最后一次的选择是唯一真相）。
 */
export async function saveModelSpec(cwd: string, spec: string): Promise<void> {
  // 先读旧值展开：cwd 等模型无关字段不能因为换模型被抹掉
  const prev = await readConfig(cwd);
  await writeConfig(cwd, {
    version: CONFIG_VERSION,
    ...(prev?.cwd !== undefined ? { cwd: prev.cwd } : {}),
    model: spec,
    updatedAt: Date.now(),
  });
}

/**
 * 原子写入自定义模型完整参数。互斥：写 customModel 清掉 model spec。
 * 恢复路径也会回写（幂等同值），无害。
 */
export async function saveCustomModel(cwd: string, custom: StoredCustomModel): Promise<void> {
  // 先读旧值展开：cwd 等模型无关字段不能因为换模型被抹掉
  const prev = await readConfig(cwd);
  await writeConfig(cwd, {
    version: CONFIG_VERSION,
    ...(prev?.cwd !== undefined ? { cwd: prev.cwd } : {}),
    customModel: custom,
    updatedAt: Date.now(),
  });
}

/** ModelRef → 可回放的 spec 字符串；config.json 存这个而不是用户原始输入 */
export function modelSpecString(model: ModelRef): string {
  const maturity = model.maturity !== undefined ? `:${model.maturity}` : "";
  return `${model.provider}:${model.id}${maturity}`;
}
