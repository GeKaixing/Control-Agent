/**
 * 显示路由：把「事件 → DisplaySink connector」的分发逻辑抽成纯函数。
 *
 * 为什么独立成文件：
 * - 装配代码（desktop/main/index.ts）在 electron 环境里，不好直接单测；
 *   把路由逻辑放在 src/connector 里，就能用 fake connector 写单元测试。
 * - 语义上这是 ConnectorRuntime 的「反向路由」：execute 是 Agent → connector，
 *   display route 是 事件生产者（SessionManager）→ DisplaySink connector。
 *
 * 路由规则：
 * - Registry 里有实现 DisplaySink 能力的 connector → 广播给所有 sink
 *   （默认内置的 IPC sink 与未来加载的 websocket sink 可并存，事件都发）
 * - 一个 sink 都没有 → fallback（通常是直连 IPC，保证 UI 永远有数据显示）
 */

import { asDisplaySink, type DisplaySink } from "../core/types.js";

export type DisplayRoute = (event: unknown) => void;

/** 路由所需的最小 Registry 形状（ConnectorRuntime 满足；测试可传 fake） */
export interface RegistryHost {
  registry: { all(): Array<{ instance: unknown }> };
}

/**
 * 构造一个显示事件路由函数。
 *
 * @param registryHost 拥有 registry 的对象（通常是 ConnectorRuntime）
 * @param fallback     没有任何 DisplaySink connector 时走的直连通道
 */
export function createDisplayRoute(registryHost: RegistryHost, fallback: (event: unknown) => void): DisplayRoute {
  return (event: unknown): void => {
    const sinks = collectDisplaySinks(registryHost);
    if (sinks.length === 0) {
      fallback(event);
      return;
    }
    for (const sink of sinks) {
      try {
        sink.emit(event);
      } catch {
        // 显示是 best-effort：单个 sink 挂了不影响其他 sink 与主流程
      }
    }
  };
}

function collectDisplaySinks(registryHost: RegistryHost): DisplaySink[] {
  const out: DisplaySink[] = [];
  for (const loaded of registryHost.registry.all()) {
    const instance = loaded.instance;
    if (instance === undefined || instance === null) continue;
    const sink = asDisplaySink(instance as Parameters<typeof asDisplaySink>[0]);
    if (sink !== null) out.push(sink);
  }
  return out;
}
