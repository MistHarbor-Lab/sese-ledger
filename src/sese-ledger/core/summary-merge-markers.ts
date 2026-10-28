// ===== 纪要合并标记（台账独占） =====
//
// 一条纪要的「几合一」= 它累计代表多少条原始纪要。平均合并 / 前略后详都依赖它。
//
// 归属（用户定案）：台账自己的 chat 元数据命名空间 `seseLedgerMerge`。
//   · 不读写状态栏的 chronicle.mergeMarkers；状态栏合并功能后续移除时连带删它自己的
//     标记存储，不会影响这里。
//   · 按聊天持久化：chat_metadata 随聊天保存/复制；fork 会带走。
//   · 旧状态栏标记不迁移：切换台账后旧合并行按 1 合 1 计（权责清楚的代价）。
//
// 键 = 归一化时间跨度（不是 row_id / AM 号）：合并会重排 AM，但同一批原纪要拼出的
// 时间跨度稳定；内容编辑/换模型重生成不破坏命中。归一化口径：去空白、年份至少 4 位
// （1-6 位年份契约）、首条开始为空时键为 `~结束`。

export const SUMMARY_MERGE_META_KEY = 'seseLedgerMerge';
const META_VERSION = 1;

export interface SummaryMergeMarkerHost {
  /** 现取 chat_metadata（不要缓存成闭包快照：聊天加载会整体替换对象）。 */
  getChatMetadata(): Record<string, any> | null;
  /** 落盘 chat_metadata；失败返回 false。 */
  saveChat(): Promise<boolean> | boolean;
}

export interface SummaryMergeMarkerState {
  version: number;
  bySpan: Record<string, number>;
  updatedAt: number;
}

/** 合并产物（成功段）的新标记。 */
export interface MergedProductMarker {
  timeSpan: string;
  count: number;
}

function padYear(s: string): string {
  // 日期部分：YYYY-MM-DD 或 YY-MM-DD → 规范「至少 4 位」年份（021-02-05 → 0021-02-05；14900 原样）
  const m = s.match(/^(\d{1,6})-(\d{1,2})-(\d{1,2})/);
  if (!m) return s;
  return m[1].padStart(4, '0') + '-' + m[2] + '-' + m[3] + s.slice(m[0].length);
}

/** 时间跨度 → 稳定键。返回 null = 不可记录（结束缺失）。 */
export function normalizeSummarySpan(timeSpan: string): string | null {
  const raw = String(timeSpan ?? '').trim();
  if (!raw) return null;
  const idx = raw.indexOf('~');
  if (idx < 0) return '~' + padYear(raw).toUpperCase().replace(/\s+/g, '');
  const start = raw.slice(0, idx).trim();
  const end = raw.slice(idx + 1).trim();
  if (!end) return null;
  return (start ? padYear(start).toUpperCase().replace(/\s+/g, '') : '') + '~' + padYear(end).toUpperCase().replace(/\s+/g, '');
}

function sanitize(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== 'object') return out;
  const bySpan = (raw as any).bySpan;
  if (!bySpan || typeof bySpan !== 'object' || Array.isArray(bySpan)) return out;
  for (const key of Object.keys(bySpan)) {
    const n = Number(bySpan[key]);
    if (!Number.isFinite(n) || n < 1) continue;
    out[key] = Math.floor(n);
  }
  return out;
}

export interface SummaryMergeMarkerStore {
  /** 当前聊天的标记表（副本）。 */
  read(): Record<string, number>;
  /** 写回标记表；返回是否落盘成功。 */
  write(bySpan: Record<string, number>): Promise<boolean>;
  /** 清空当前聊天的标记（批量替换/清除数据/迁移后调用）。 */
  clear(): Promise<boolean>;
  /** 按当前存活时间跨度修剪，返回修剪后的表。 */
  prune(liveTimeSpans: readonly string[]): Record<string, number>;
  /** 单条纪要的合并数（无标记 = 1）。 */
  countOf(bySpan: Record<string, number>, timeSpan: string): number;
  /** 合并提交后写入成功段的新计数，并按存活时间跨度修剪。 */
  applyMerge(newMerged: readonly MergedProductMarker[], liveTimeSpans: readonly string[]): Promise<boolean>;
}

export function createSummaryMergeMarkerStore(host: SummaryMergeMarkerHost): SummaryMergeMarkerStore {
  function read(): Record<string, number> {
    let meta: Record<string, any> | null = null;
    try { meta = host.getChatMetadata(); } catch (_e) { meta = null; }
    if (!meta) return {};
    return sanitize(meta[SUMMARY_MERGE_META_KEY]);
  }

  async function write(bySpan: Record<string, number>): Promise<boolean> {
    let meta: Record<string, any> | null = null;
    try { meta = host.getChatMetadata(); } catch (_e) { meta = null; }
    if (!meta) return false;
    const state: SummaryMergeMarkerState = {
      version: META_VERSION,
      bySpan,
      updatedAt: Date.now(),
    };
    meta[SUMMARY_MERGE_META_KEY] = state;
    try {
      const ok = await host.saveChat();
      return ok !== false;
    } catch (_e) {
      return false;
    }
  }

  async function clear(): Promise<boolean> {
    let meta: Record<string, any> | null = null;
    try { meta = host.getChatMetadata(); } catch (_e) { meta = null; }
    if (!meta) return false;
    try { delete meta[SUMMARY_MERGE_META_KEY]; } catch (_e) { /* ignore */ }
    try {
      const ok = await host.saveChat();
      return ok !== false;
    } catch (_e) {
      return false;
    }
  }

  function prune(liveTimeSpans: readonly string[]): Record<string, number> {
    const cur = read();
    const live = new Set<string>();
    for (const span of liveTimeSpans) {
      const key = normalizeSummarySpan(span);
      if (key) live.add(key);
    }
    const next: Record<string, number> = {};
    for (const key of Object.keys(cur)) {
      if (live.has(key)) next[key] = cur[key];
    }
    return next;
  }

  function countOf(bySpan: Record<string, number>, timeSpan: string): number {
    const key = normalizeSummarySpan(timeSpan);
    if (!key) return 1;
    const n = bySpan[key];
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
  }

  async function applyMerge(
    newMerged: readonly MergedProductMarker[],
    liveTimeSpans: readonly string[],
  ): Promise<boolean> {
    const next = prune(liveTimeSpans);
    for (const m of newMerged) {
      const key = normalizeSummarySpan(m.timeSpan);
      if (!key) continue;
      const n = Number(m.count);
      if (!Number.isFinite(n) || n < 1) continue;
      next[key] = Math.floor(n);
    }
    return write(next);
  }

  return { read, write, clear, prune, countOf, applyMerge };
}
