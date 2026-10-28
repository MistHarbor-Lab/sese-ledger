// ===== 纪要数量阈值提醒（单一口径） =====
//
// 阈值是全局设置（LedgerSettings.summaryWarnThreshold）；条数按当前聊天的纪要表实时读。
// 判据严格「超过」：count > limit；limit = 0 表示关闭提醒。
// 只在低频点读取（工作台打开/表更新/填表完成），不轮询。

import { specialFormOf, type BookModel } from './book';
import type { LedgerSettings } from './settings-store';

export const DEFAULT_SUMMARY_WARN_THRESHOLD = 200;

export interface SummaryWarningState {
  count: number;
  limit: number;
  over: boolean;
  diff: number;
  tableName?: string;
}

/** 设置值归一：缺省/非法 → 200；0 合法（关闭提醒）；负数按 0。 */
export function summaryWarnThresholdOf(settings: LedgerSettings | null | undefined): number {
  const raw = settings?.summaryWarnThreshold;
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.max(0, Math.trunc(raw));
  return DEFAULT_SUMMARY_WARN_THRESHOLD;
}

export function summaryWarning(book: BookModel | null, settings: LedgerSettings | null | undefined): SummaryWarningState {
  let tableName: string | undefined;
  let count = 0;
  if (book) {
    for (const table of book.tables.values()) {
      if (specialFormOf(table.name, table.v2def) === 'summary') {
        tableName = table.name;
        count = table.rows.size;
        break;
      }
    }
  }
  const limit = summaryWarnThresholdOf(settings);
  const over = limit > 0 && count > limit;
  return { count, limit, over, diff: Math.max(0, count - limit), tableName };
}
