// ===== 台账运行日志（工作台「日志」页的数据源） =====
//
// 只存内存：页面刷新 / 脚本重注入即从零开始（不落盘、不写 localStorage——「刷新清空」是需求本身，
// 持久化反而要额外写清理逻辑）。采集面＝六类来源（填表/推进/投影/存储/配置/其他）的警告与错误，
// 外加少量「信息」档时间线（装载 / 建账 / 开始填表 / 落账条数 / 投影刷新 / 跳过原因），便于按时间还原现场。
// 开销口径：纯 push（无轮询 / 无定时器 / 无新常驻监听）；面板未打开时零渲染。

export type LedgerLogLevel = 'error' | 'warn' | 'info';

/** 来源固定六类（其余一律归「其他」，防来源标签随调用点漂移）。 */
export const LEDGER_LOG_SOURCES = ['填表', '推进', '投影', '存储', '配置', '其他'] as const;
export type LedgerLogSource = (typeof LEDGER_LOG_SOURCES)[number];

/** 环形缓冲上限（超出丢最旧）。 */
export const LEDGER_LOG_LIMIT = 100;
/** 单条详情截断（超长 SQL / HTTP 错误原文不吃内存）。 */
export const LEDGER_LOG_DETAIL_LIMIT = 2000;
/** 单条「原始 AI 输出」截断（排查用：整段 AI 回复远超此值，8K 足够看清问题）。 */
export const LEDGER_LOG_RAW_LIMIT = 8000;

/** 日志上报事件（填表 / 推进共用；detail＝错误清单等明细，raw＝完整原始 AI 输出）。 */
export interface LedgerLogEvent {
  level: LedgerLogLevel;
  message: string;
  detail?: string;
  /** 完整原始 AI 输出（日志页可展开查看 + 一键复制）。 */
  raw?: string;
}

/** 日志页等级筛选三态（「警告 + 错误」＝nw）。 */
export type LedgerLogFilterLevel = 'all' | 'nw' | 'error';

export interface LedgerLogEntry {
  /** 单调递增序号（列表渲染的展开态、去重键；合并时不改）。 */
  id: number;
  /** 首次出现时间。 */
  at: number;
  /** 最近一次出现时间（合并时更新）。 */
  lastAt: number;
  level: LedgerLogLevel;
  source: LedgerLogSource;
  message: string;
  detail?: string;
  /** 完整原始 AI 输出（填表 / 推进告警与错误携带；超长按 LEDGER_LOG_RAW_LIMIT 截断）。 */
  raw?: string;
  /** 连续相同条目（同级别 + 同来源 + 同文案）的合并计数。 */
  count: number;
  /** 错误条目是否未读（rail 徽章计数；点条目置 false；读过后同类错误再次合并会重新置 true）。
   *  警告 / 信息不参与未读，保持 undefined。 */
  unread?: boolean;
}

export interface LedgerLogCounts { total: number; error: number; warn: number; info: number }

export interface LedgerLog {
  push(level: LedgerLogLevel, source: string, message: string, detail?: string, raw?: string): void;
  /** 最新在前（副本，外部改动不影响内部缓冲）。 */
  list(): LedgerLogEntry[];
  counts(): LedgerLogCounts;
  /** 未读错误条目数（rail 徽章；不是出现次数——连续相同合并后仍算一条）。 */
  unreadErrors(): number;
  /** 标记一条错误为已读（点日志条目）；返回是否发生变化（已读/非错误/不存在＝false）。 */
  markErrorRead(id: number): boolean;
  clear(): void;
  /** 变更订阅（写日志 / 标记已读 / 清空即回调；返回注销器）。 */
  subscribe(cb: (counts: LedgerLogCounts) => void): () => void;
}

/** 未知 / 空来源一律归「其他」。 */
export function normalizeLogSource(source: unknown): LedgerLogSource {
  const text = String(source ?? '').trim();
  return (LEDGER_LOG_SOURCES as readonly string[]).includes(text) ? (text as LedgerLogSource) : '其他';
}

/** 本地时间 `HH:MM:SS`。 */
export function formatLogTime(at: number): string {
  const d = new Date(Number(at) || 0);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 详情截断（保留头部，尾注省略号）。 */
export function truncateLogDetail(detail: unknown, limit = LEDGER_LOG_DETAIL_LIMIT): string {
  const text = String(detail ?? '');
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export function createLedgerLog(deps: { now?: () => number; limit?: number; detailLimit?: number; rawLimit?: number } = {}): LedgerLog {
  const now = deps.now || (() => Date.now());
  const limit = Math.max(1, Math.trunc(Number(deps.limit) || LEDGER_LOG_LIMIT));
  const detailLimit = Math.max(1, Math.trunc(Number(deps.detailLimit) || LEDGER_LOG_DETAIL_LIMIT));
  const rawLimit = Math.max(1, Math.trunc(Number(deps.rawLimit) || LEDGER_LOG_RAW_LIMIT));
  const entries: LedgerLogEntry[] = [];
  const listeners = new Set<(counts: LedgerLogCounts) => void>();
  let seq = 0;

  function counts(): LedgerLogCounts {
    const out: LedgerLogCounts = { total: entries.length, error: 0, warn: 0, info: 0 };
    for (const e of entries) out[e.level] += 1;
    return out;
  }

  function notify(): void {
    const snapshot = counts();
    for (const cb of [...listeners]) { try { cb(snapshot); } catch (_e) { /* 单订阅故障不影响写入 */ } }
  }

  function unreadErrors(): number {
    let n = 0;
    for (const e of entries) if (e.level === 'error' && e.unread === true) n += 1;
    return n;
  }

  function markErrorRead(id: number): boolean {
    const entry = entries.find((e) => e.id === id);
    if (!entry || entry.level !== 'error' || entry.unread !== true) return false;
    entry.unread = false;
    notify();
    return true;
  }

  return {
    push(level, source, message, detail, raw) {
      const text = String(message ?? '').trim();
      if (!text) return;
      const lv: LedgerLogLevel = level === 'error' || level === 'warn' ? level : 'info';
      const src = normalizeLogSource(source);
      const t = now();
      const detailText = detail === undefined || detail === null || String(detail).trim() === '' ? '' : truncateLogDetail(detail, detailLimit);
      const rawText = raw === undefined || raw === null || String(raw).trim() === '' ? '' : truncateLogDetail(raw, rawLimit);
      // 连续相同（紧邻上一条同级别 + 同来源 + 同文案）→ 合并计数，不新增行（自动填表每轮的「无到期分组」不刷屏）
      const last = entries[entries.length - 1];
      if (last && last.level === lv && last.source === src && last.message === text) {
        last.count += 1;
        last.lastAt = t;
        // 读过的错误再次出现：合并计数同时重新点亮，徽章随时能看到「又来了」
        if (lv === 'error') last.unread = true;
        if (!last.detail && detailText) last.detail = detailText;
        if (!last.raw && rawText) last.raw = rawText;
        notify();
        return;
      }
      seq += 1;
      entries.push({
        id: seq, at: t, lastAt: t, level: lv, source: src, message: text,
        ...(detailText ? { detail: detailText } : {}),
        ...(rawText ? { raw: rawText } : {}),
        ...(lv === 'error' ? { unread: true } : {}),
        count: 1,
      });
      if (entries.length > limit) entries.splice(0, entries.length - limit);
      notify();
    },
    list: () => entries.slice().reverse(),
    counts,
    unreadErrors,
    markErrorRead,
    clear() {
      if (entries.length === 0) return;
      entries.length = 0;
      notify();
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
  };
}

/** 等级 / 来源筛选（列表、复制、导出三处共用同一口径，防三份实现漂移）。 */
export function filterLogEntries(
  entries: LedgerLogEntry[],
  opts: { level?: LedgerLogFilterLevel; source?: string } = {},
): LedgerLogEntry[] {
  const level = opts.level || 'all';
  const source = String(opts.source ?? '').trim();
  return (Array.isArray(entries) ? entries : []).filter((e) => {
    if (level === 'error' && e.level !== 'error') return false;
    if (level === 'nw' && e.level === 'info') return false;
    if (source && source !== '全部' && e.source !== source) return false;
    return true;
  });
}

/** 复制全部用纯文本（含详情与原始 AI 输出缩进；「×N」标注合并计数）。 */
export function ledgerLogText(entries: LedgerLogEntry[]): string {
  const label: Record<LedgerLogLevel, string> = { error: '错误', warn: '警告', info: '信息' };
  const indent = (text: string): string => text.split('\n').join('\n    ');
  return (Array.isArray(entries) ? entries : []).map((e) => {
    const head = `[${formatLogTime(e.at)}] ${label[e.level]} · ${e.source}  ${e.message}`;
    const merged = e.count > 1 ? ` ×${e.count}（最近 ${formatLogTime(e.lastAt)}）` : '';
    const detail = e.detail ? `\n    ${indent(e.detail)}` : '';
    const raw = e.raw ? `\n    ── 原始 AI 输出 ──\n    ${indent(e.raw)}` : '';
    return `${head}${merged}${detail}${raw}`;
  }).join('\n');
}

/** 导出 JSON 产物（导出按钮用；纯函数便于测试）。 */
export function ledgerLogExport(entries: LedgerLogEntry[], appVersion = ''): Record<string, unknown> {
  return {
    format: 'sese-ledger-log',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    appVersion: String(appVersion || ''),
    note: '台账运行日志快照（仅本次会话；页面刷新即自动清空）',
    count: (Array.isArray(entries) ? entries : []).length,
    entries: (Array.isArray(entries) ? entries : []).map((e) => ({
      time: formatLogTime(e.at),
      lastTime: formatLogTime(e.lastAt),
      level: e.level,
      source: e.source,
      message: e.message,
      count: e.count,
      ...(e.detail ? { detail: e.detail } : {}),
      ...(e.raw ? { raw: e.raw } : {}),
    })),
  };
}
