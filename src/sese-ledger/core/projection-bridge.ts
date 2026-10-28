// ===== 台账世界书投影桥（唯一 I/O 出口 = 状态栏 worldbook-projection 协调器） =====
//
// 台账不再自己 getWorldbook/replaceWorldbook 做「持续刷新」：
// - 通过共享客户端 core/external-projection-client 注册 `ledger-projections` 外部描述符；
// - 描述符只做纯决策（core/lens.reconcileLedgerProjection）：未落定 skip / 已落定未建账 clear /
//   有账本 project；只读与待恢复态一律不动；
// - 台账自己的 revision 跳过门保留（MESSAGE_RECEIVED 等高频路径不空读整书）；
// - 手工清理工具经 `exclusive()` 与投影共用同一条队列。
//
// 本模块只保留台账特有的「跳过门 + 主世界书预检 + 诊断 + 日志」；桥发现/注册/ready 重试/
// unregister/requestAsync/重填抑制全部由共享客户端统一实现（小手机同款）。

import { reconcileLedgerProjection } from './lens';
import type { LedgerRuntime } from './runtime';
import { resolveCurrentPrimaryWorldbook } from '../../unified-statusbar/core/worldbook-projection';
import { createExternalProjectionClient } from '../../unified-statusbar/core/external-projection-client';

/** 外部投影 id（状态栏 registry 内唯一；同 id 幂等覆盖）。 */
export const LEDGER_PROJECTION_ID = 'ledger-projections';

export interface LedgerProjectionBridgeDeps {
  runtime: LedgerRuntime;
  /** 台账宿主 window（脚本 iframe）；桥实际挂在 parent/顶层状态栏窗口。 */
  window: Window;
  getHelper: () => any;
  log: (level: 'info' | 'warn' | 'error', source: string, message: string) => void;
}

export function createLedgerProjectionBridge(deps: LedgerProjectionBridgeDeps) {
  const { runtime } = deps;
  let lastRequestKey: string | null = null;
  let lastEntryCount = 0;
  let lastRefreshAt = 0;
  let pendingRequest = false;

  const keyOf = (): string => `${runtime.storageId() || ''}|${runtime.revision()}`;

  function markProjected(count: number): void {
    lastEntryCount = count;
    lastRefreshAt = Date.now();
    lastRequestKey = keyOf();
  }

  const descriptor = {
    id: LEDGER_PROJECTION_ID,
    isEnabled: () => true,
    reconcile: (entries: any[], context?: { isCurrent?: () => boolean }): boolean => {
      if (context && typeof context.isCurrent === 'function' && !context.isCurrent()) return false;
      const result = reconcileLedgerProjection(entries, {
        settled: runtime.isChatSettled(),
        book: runtime.book(),
        storageId: runtime.storageId(),
        writeProtected: runtime.isWriteProtected(),
        recoveryNeeded: runtime.recoveryStatus().needed,
      });
      if (result.action === 'skip') return false;
      markProjected(result.desiredCount);
      if (!result.changed) {
        if (result.action === 'project') {
          deps.log('info', '投影', `世界书投影已刷新：${result.desiredCount} 条受管条目（比对无变化）`);
        }
        return false;
      }
      const removed = entries.length - result.next.length;
      entries.splice(0, entries.length, ...result.next);
      if (result.action === 'clear') {
        deps.log('info', '投影', `当前聊天未建账：已清掉上一聊天的 ${removed} 条台账投影`);
      } else {
        deps.log('info', '投影', `世界书投影已刷新：${result.desiredCount} 条受管条目（本轮有变更写入）`);
      }
      return true;
    },
  };

  // 共享客户端在构造期就会尝试注册并回调 onRegistered；用 holder 避免回读尚未赋值的 client。
  const holder: { client: ReturnType<typeof createExternalProjectionClient> | null } = { client: null };

  function flushPending(): void {
    if (!pendingRequest || !holder.client) return;
    if (!runtime.isChatSettled()) return;
    pendingRequest = false;
    void request({ force: true });
  }

  holder.client = createExternalProjectionClient({
    descriptor,
    window: deps.window,
    onRegistered: () => { flushPending(); },
    log: (level, message) => deps.log(level, '投影', message),
  });
  const client = holder.client as ReturnType<typeof createExternalProjectionClient>;

  /** 请求一次投影。force=true 绕过 revision 跳过门（切聊天/显式刷新/删投影后重建）。
   *  返回 true=已请求且协调器执行成功（含比对无变化）/重填抑制；false=无桥、无主世界书或执行失败。 */
  function request(opts: { force?: boolean } = {}): Promise<boolean> {
    const key = keyOf();
    if (!opts.force && key === lastRequestKey) return Promise.resolve(true);
    if (!runtime.isChatSettled()) {
      pendingRequest = true;
      return Promise.resolve(false);
    }
    if (client.isRefillMode()) {
      lastRequestKey = key;
      deps.log('info', '投影', '重填模式：世界书投影已跳过（关闭后自动重建）');
      return Promise.resolve(true);
    }
    if (!resolveCurrentPrimaryWorldbook(deps.getHelper())) {
      deps.log('warn', '投影', '世界书刷新失败：未解析到当前角色卡的主世界书');
      return Promise.resolve(false);
    }
    lastRequestKey = key;
    pendingRequest = false;
    return client.request('data-change').then((ok) => {
      if (!ok) {
        lastRequestKey = null;
        if (!client.isBridgeAvailable()) {
          pendingRequest = true;
          deps.log('warn', '投影', '世界书投影桥未就绪（等待状态栏装载）');
        } else {
          deps.log('warn', '投影', '世界书投影刷新未完成（协调器未执行或无世界书）');
        }
      }
      return ok;
    }).catch((e) => {
      lastRequestKey = null;
      deps.log('warn', '投影', `世界书投影刷新失败：${e instanceof Error ? e.message : String(e)}`);
      return false;
    });
  }

  /** 手工清理 sweep 与投影共用协调器队列；桥不可用时直接执行（启动早期无并发投影）。 */
  function exclusive<T>(task: () => Promise<T>): Promise<T> {
    return client.exclusive(task);
  }

  function diag(): { count: number; at: number } {
    return { count: lastEntryCount, at: lastRefreshAt };
  }

  /** 作废 revision 跳过门（删投影/清除聊天数据后必须让下一次请求重建）。 */
  function invalidate(): void {
    lastRequestKey = null;
    lastEntryCount = 0;
  }

  function dispose(): void {
    client.dispose();
  }

  return {
    request,
    exclusive,
    diag,
    invalidate,
    dispose,
    isRefillMode: () => client.isRefillMode(),
    projectionId: LEDGER_PROJECTION_ID,
  };
}
