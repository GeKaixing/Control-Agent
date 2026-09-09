/**
 * agent 本地服务检测（纯函数，无副作用）。
 *
 * 从 bash 工具的输出文本里提取「agent 启动了本地服务」的线索：
 *  - 显式地址：localhost:PORT / 127.0.0.1:PORT / 0.0.0.0:PORT / [::1]:PORT
 *  - 监听语句：同一行里出现 listening / running / available / serving 等词 + 端口号
 *
 * 检测放在主进程（SessionManager 消费 tool_end 事件时调用），而不是渲染层：
 * info() 是所有窗口共享的单一事实来源，弹层子窗口 / 消息小窗不用各自重放
 * 事件流也能拿到全量列表。调用方（session.ts）负责把结果合并进会话状态。
 */

import type { LocalServerInfo } from "../shared/api.js";

/** 列表容量上限：超过时淘汰最久没再出现的服务，防止长会话里无限堆积。 */
const MAX_SERVERS = 20;

/** 显式的 host:port 形式（覆盖 localhost / 127.0.0.1 / 0.0.0.0 / [::1]）。 */
const HOST_PORT_RE = /(?:^|[^\w.])(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1):(\d{2,5})(?![\w.])/g;

/** 监听语句：同一行先出现监听类关键词、再出现端口（port 5173 / on 3000）。 */
const LISTEN_LINE_RE = /\b(listen|listening|running|available|serving|started|server)\b/i;
const LISTEN_PORT_RE = /\b(?:port\s+|on\s+(?:port\s+)?)(\d{2,5})\b/i;

function validPort(raw: string): number | null {
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

/**
 * 从一段文本中提取本地服务线索（不去重、不保序保证——去重合并交给 merge）。
 * 逐行扫描：host:port 任意位置命中都算；纯端口号只认「监听语句所在行」，
 * 避免把文档里随口提到的 port 443 误报成服务。
 */
export function extractLocalServers(text: string): Array<Pick<LocalServerInfo, "host" | "port">> {
  const found: Array<Pick<LocalServerInfo, "host" | "port">> = [];
  for (const line of text.split(/\r?\n/)) {
    for (const m of line.matchAll(HOST_PORT_RE)) {
      const port = validPort(m[2] ?? "");
      if (port !== null) found.push({ host: m[1] ?? "localhost", port });
    }
    if (LISTEN_LINE_RE.test(line)) {
      const m = line.match(LISTEN_PORT_RE);
      const port = m !== null ? validPort(m[1] ?? "") : null;
      if (port !== null) found.push({ host: "localhost", port });
    }
  }
  return found;
}

/**
 * 把新提取的服务合并进现有列表（原地修改 existing）：
 *  - 按 url（规范化后）去重，重复命中只刷新 lastSeenAt / hits
 *  - 0.0.0.0 / [::1] 等不可浏览主机统一规范化成 localhost
 *  - 列表按 lastSeenAt 降序维护，容量超过 MAX_SERVERS 时淘汰最旧的
 *
 * 返回 true 表示列表发生了变化（调用方据此决定要不要让 UI 重拉 info）。
 */
export function mergeLocalServers(
  existing: LocalServerInfo[],
  found: Array<Pick<LocalServerInfo, "host" | "port">>,
  now: number,
): boolean {
  let changed = false;
  for (const item of found) {
    const url = `http://localhost:${item.port}`;
    const known = existing.find((s) => s.url === url);
    if (known !== undefined) {
      known.lastSeenAt = now;
      known.hits += 1;
      continue;
    }
    existing.push({ url, host: item.host, port: item.port, lastSeenAt: now, hits: 1 });
    changed = true;
  }
  if (changed) {
    // 新出现的排在最前（最近发现的服务用户最关心），超出容量时淘汰最旧的
    existing.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    if (existing.length > MAX_SERVERS) existing.length = MAX_SERVERS;
  }
  return changed;
}
