/**
 * Context 支柱：会话持久化。
 *
 * 之前会话树纯内存（AgentState.nodes），进程退出即消失——这是 v1 的刻意边界，
 * 本模块把它补上：树结构天然可 JSON 序列化，存取即可，不摘要不清洗
 * （哪些内容值得留是 transformContext 管线的事，这里只管字节）。
 *
 * 存储：<cwd>/.c-agent/sessions/<id>.json。会话 id 带时间戳前缀，
 * 文件名即时间线；原子写（tmp + rename），崩溃最多丢当前轮。
 *
 * 与 memory 工具（项目根 MEMORY.md）的分工：MEMORY.md 是模型自己决定记的
 * 「跨会话有效的事实」，注入系统提示词；sessions 是完整的对话历史（含分支、
 * compact 旧分支），只在 --resume 时整体还原。
 */

import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { activeBranch, type AgentState, type MessageNode } from "./state.js";

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
