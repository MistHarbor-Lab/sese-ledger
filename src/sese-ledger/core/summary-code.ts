// ===== 纪要类引擎列：编码索引 / 时间跨度 =====
//
// 为什么在引擎侧：纪要表的【已有数据】只说「纪要表无需参考已有数据」（历史纪要不进请求），
// AI 既看不到既有编号、也不该推算——所以新行由引擎在**校验之前**补齐两个引擎列：
//   · 编码索引：按现有最大值 +1 分配（纪要表一律重分配，无视 AI 写的值——防旧模板/旧预设写重号）；
//   · 时间跨度：`上一条纪要的结束时间 ~ 本轮全局数据表的当前时间`。
//     第一条没有上一条 → `~ 当前时间`（开始留空、结束仍写）；全局当前时间末尾的「周X」去掉。
// 单列成模块（而非放 scribe）是为了让 fill-sql 在**校验之前**就能补列，且不产生 scribe ↔ fill-sql 循环依赖。
// 只认「存在唯一列 编码索引 的表」补号；时间跨度只补 `specialFormOf==='summary'` 的纪要表。

import { resolveColumn, resolveTable, specialFormOf, type BookModel, type TableModel } from './book';
import { buildValidators } from './constraints';
import type { LedgerOp } from './types';

const GLOBAL_TABLE_NAME = '全局数据表';
const CURRENT_TIME_HEADER = '当前时间';
const SUMMARY_SPAN_HEADER = '时间跨度';

/** 由现有编码索引推下一条（AM0006 → AM0007）：取最大数字后缀 +1、同宽补零；无可用编码 → AM0001。 */
export function nextSummaryCode(codes: string[]): string {
  let prefix = 'AM';
  let width = 4;
  let max = 0;
  let found = false;
  for (const raw of codes) {
    const m = /^([^\d]*)(\d+)$/.exec(String(raw || '').trim());
    if (!m) continue;
    const n = Number(m[2]);
    if (!Number.isFinite(n)) continue;
    if (!found || n >= max) { max = n; prefix = m[1] || prefix; width = Math.max(m[2].length, 1); }
    found = true;
  }
  if (!found) return 'AM0001';
  return prefix + String(max + 1).padStart(width, '0');
}

/** 该表是否需要引擎补号（有 编码索引 列且该列唯一）。 */
function codeColumnOf(table: TableModel): { idx: number; header: string } | null {
  const idx = resolveColumn(table, '编码索引');
  if (idx < 0) return null;
  const header = table.headers[idx];
  if (!table.ddlInfo) return null;
  if (!buildValidators(table.ddlInfo).get(header)?.unique) return null;
  return { idx, header };
}

/** 纪要表（引擎特判形态）：编码索引/时间跨度都由引擎掌管。 */
function isSummaryTable(table: TableModel): boolean {
  return specialFormOf(table.name, table.v2def) === 'summary';
}

/** 现有编号 + 同批已补编号 → 下一条。 */
function nextCodeForTable(table: TableModel, col: { idx: number }, pending: string[]): string {
  const codes = [...table.rows.values()]
    .map((cells) => String(cells[col.idx] ?? '').trim())
    .filter(Boolean)
    .concat(pending);
  return nextSummaryCode(codes);
}

/**
 * 取/补一条编码索引：`value` 留空或写占位（如 AMXXXX，即不含数字）→ 返回引擎编号；
 * 已给带数字的编号 → undefined（尊重 AI 给的值；**纪要表不走这里**，见 assignSummaryCodes）。
 * `pending` 传同批已补的编号 ⇒ 连插多行依次递增。
 */
export function nextSummaryCodeForValue(table: TableModel, value: string, pending: string[] = []): string | undefined {
  const col = codeColumnOf(table);
  if (!col) return undefined;
  if (/\d/.test(String(value ?? ''))) return undefined;
  return nextCodeForTable(table, col, pending);
}

/**
 * 批内补号（就地改 op.row）。纪要表一律由引擎重新分配（无视 AI 写的任何编号）；
 * 其余自建同构表沿用旧口径（占位/留空补号、写了数字就尊重）。
 */
export function assignSummaryCodes(book: BookModel, ops: LedgerOp[]): void {
  const pending = new Map<string, string[]>();
  for (const op of ops) {
    if (op.kind !== 'row_insert') continue;
    const table = book.tables.get(op.table);
    if (!table) continue;
    const col = codeColumnOf(table);
    if (!col) continue;
    const assigned = isSummaryTable(table)
      ? nextCodeForTable(table, col, pending.get(table.tableId) || [])
      : nextSummaryCodeForValue(table, String(op.row?.[col.header] ?? ''), pending.get(table.tableId) || []);
    if (!assigned) continue;
    op.row = { ...(op.row || {}), [col.header]: assigned };
    const list = pending.get(table.tableId) || [];
    list.push(assigned);
    pending.set(table.tableId, list);
  }
}

/** 去掉全局当前时间末尾的「周X/星期X/礼拜X」，并归一空白；空值 → ''。 */
function normalizeClockText(raw: unknown): string {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.replace(/\s*(?:周|星期|礼拜)[一二三四五六日天]\s*$/, '').trim();
}

/** 时间跨度右侧（结束时间）：兼容 `A ~ B`、`~ B`、单值 `B` 三种存量形态。 */
function spanEndOf(raw: unknown): string {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  const idx = text.lastIndexOf('~');
  return normalizeClockText(idx >= 0 ? text.slice(idx + 1) : text);
}

/** 读全局数据表第 1 行（无 row_id=1 时取最小行号）的「当前时间」。 */
function readGlobalCurrentTime(book: BookModel): string {
  const table = resolveTable(book, GLOBAL_TABLE_NAME);
  if (!table) return '';
  const col = resolveColumn(table, CURRENT_TIME_HEADER);
  if (col < 0) return '';
  const ids = [...table.rows.keys()].sort((a, b) => a - b);
  if (ids.length === 0) return '';
  const rowId = ids.includes(1) ? 1 : ids[0];
  return normalizeClockText(table.rows.get(rowId)?.[col]);
}

/** 上一条纪要的结束时间：按 row_id 从新到旧找第一条可解析的时间跨度（空跨度跳过，继续往前找）。 */
function latestSummaryEnd(table: TableModel, spanIdx: number): string {
  const ids = [...table.rows.keys()].sort((a, b) => b - a);
  for (const rowId of ids) {
    const end = spanEndOf(table.rows.get(rowId)?.[spanIdx]);
    if (end) return end;
  }
  return '';
}

/**
 * 批内补时间跨度（就地改 op.row）：
 *   有上一条结束 → `上一条结束 ~ 本轮全局当前时间`；
 *   无上一条     → `~ 本轮全局当前时间`（开始留空）；
 *   同一批插多条 → 第一条接上一条结束，后续以本轮的当前时间为开始。
 *
 * `book` 是填表前的账本（取上一条结束），`appliedBook` 是 SQL 试算后的副本（取本轮刚填出来的全局当前时间）。
 * 拿不到全局当前时间（表/行/列缺失或为空）→ 不覆盖 AI 写的时间跨度，下一轮再按上一条结束续接。
 */
export function assignSummarySpans(book: BookModel, appliedBook: BookModel, ops: LedgerOp[]): void {
  const currentTime = readGlobalCurrentTime(appliedBook);
  if (!currentTime) return;
  const lastEndByTable = new Map<string, string>();
  for (const op of ops) {
    if (op.kind !== 'row_insert') continue;
    const table = book.tables.get(op.table);
    if (!table || !isSummaryTable(table)) continue;
    const spanIdx = resolveColumn(table, SUMMARY_SPAN_HEADER);
    if (spanIdx < 0) continue;
    if (!lastEndByTable.has(table.tableId)) {
      lastEndByTable.set(table.tableId, latestSummaryEnd(table, spanIdx));
    }
    const previousEnd = lastEndByTable.get(table.tableId) || '';
    const span = previousEnd ? `${previousEnd} ~ ${currentTime}` : `~ ${currentTime}`;
    op.row = { ...(op.row || {}), [table.headers[spanIdx]]: span };
    lastEndByTable.set(table.tableId, currentTime);
  }
}
