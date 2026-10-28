// ===== 填表 SQL 通道：AI 输出的 SQL → 校验 → ops =====
//
// 为什么跑在账本副本上：executeSqlSubset 逐句即时应用到传入账本，而填表必须「先校验后落账」——
// runtime.commitOps 是唯一写路径（落账要记账条目 / 时光机 diff / 防抖落盘）。因此在副本上执行拿 ops，
// 由调用方提交；副本同时保留 SQL 的逐句顺序语义（后句 WHERE 看见前句写入）。
//
// 校验口径（严格 fail-loud）：
//   1. 执行器错误（表/列不存在、不支持的语句/表达式）→ 原样回注；
//   2. SELECT → 错误（填表不需要读查询）；
//   3. 写语句 0 命中 → 错误（SQL 的静默 0 行 = 静默丢更新）；
//   4. 必填 / 唯一 / 固定行数 / row_id 禁改 → 逐 op 顺序模拟校验，首个违规处截断（前缀仍为半成功）。
import { applyOp, resolveColumn, specialFormOf, type BookModel, type TableModel } from './book';
import { executeSqlSubset } from './sql-subset';
import { assignSummaryCodes, assignSummarySpans } from './summary-code';
import type { LedgerOp } from './types';

export interface FillSqlOutcome {
  ops: LedgerOp[];
  errors: string[];
  /** 解析出的语句数（0 = 没找到语句）。 */
  statements: number;
}

/** 账本副本（结构可变部分深拷贝：表对象 / headers / rows 行列数组；定义与配置只读共享）。
 *  `tableIds` 给了就只深拷贝这些表，其余共享（只读）——逐 op 校验只可能改到 op 自己指向的表（G4）。 */
export function cloneBookForDryRun(book: BookModel, tableIds?: ReadonlySet<string> | null): BookModel {
  const tables = new Map<string, TableModel>();
  for (const [id, t] of book.tables) {
    if (tableIds && !tableIds.has(id)) { tables.set(id, t); continue; }
    tables.set(id, {
      ...t,
      headers: t.headers.slice(),
      rows: new Map([...t.rows].map(([rowId, cells]) => [rowId, cells.slice()] as const)),
      sourceData: { ...(t.sourceData || ({} as TableModel['sourceData'])) },
    });
  }
  return { mate: { ...book.mate }, tables };
}

/** AI 输出里像不像 SQL（含写语句动词即走 SQL 通道）。 */
export function looksLikeSql(raw: string): boolean {
  return /\b(?:UPDATE|INSERT|REPLACE|DELETE)\b/i.test(String(raw || ''));
}

/** 提取 SQL 文本：剥 markdown 围栏；从第一条「行首动词」起截断（模型常带一句"好的，我来更新："前言）。 */
export function extractSqlText(raw: string): string {
  let text = String(raw || '');
  const blocks: string[] = [];
  const fence = /```[a-zA-Z]*\n?([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) blocks.push(m[1]);
  text = blocks.length > 0 ? blocks.join('\n') : text.replace(/```[a-zA-Z]*\n?/g, '');
  // 只认「行首（可含缩进）动词」——避免把前言行里提到的 UPDATE 当语句起点
  const start = /(?:^|\n)[ \t]*(?:UPDATE|INSERT|REPLACE|DELETE|SELECT)\s/i.exec(text);
  if (start) {
    const at = text[start.index] === '\n' ? start.index + 1 : start.index;
    text = text.slice(at);
  }
  return text.trim();
}

/** 单 op 的约束检查（在模拟态账本上，顺序调用即为批内冲突检测）。返回错误文案或 null。 */
function checkOpAgainstTable(book: BookModel, op: LedgerOp): string | null {
  if (op.kind !== 'cell' && op.kind !== 'row_insert' && op.kind !== 'row_upsert') return null;
  const table = book.tables.get(op.table);
  if (!table) return `未找到表「${op.table}」`;
  const cols = (table.ddlInfo?.columns || []).filter((c) => c.header !== 'row_id');
  const notNullCols = cols.filter((c) => c.notNull);
  const uniqueCols = cols.filter((c) => c.unique);
  const label = (header: string): string => `表「${table.name}」列「${header}」`;

  if (op.kind === 'row_insert') {
    for (const c of notNullCols) {
      const v = op.row?.[c.header];
      if (v === undefined || v === '') return `${label(c.header)}为必填列，新增行未给值`;
    }
    // 唯一列撞值不判错：执行器已把 INSERT 统一成「撞唯一列即原位更新」（容错优先）
    return null;
  }
  const cells = op.kind === 'row_upsert' ? op.cells : table.rows.get(op.rowId);
  if (!cells) return `表「${table.name}」不存在 row_id=${op.rowId} 的行`;
  if (op.kind === 'row_upsert') {
    for (const c of notNullCols) {
      const idx = table.headers.indexOf(c.header);
      if (idx >= 0 && (cells[idx] === undefined || cells[idx] === '')) return `${label(c.header)}为必填列，不能留空`;
    }
  }
  const touched: { header: string; value: string }[] = op.kind === 'cell'
    ? [{ header: op.column, value: op.value }]
    : uniqueCols.map((c) => ({ header: c.header, value: cells[table.headers.indexOf(c.header)] ?? '' }));
  for (const t of touched) {
    const col = cols.find((c) => c.header === t.header);
    if (!col) continue;
    const idx = table.headers.indexOf(t.header);
    if (idx < 0) continue;
    if (col.notNull && (t.value === undefined || t.value === '')) return `${label(t.header)}为必填列，不能置空`;
    if (col.unique && t.value !== undefined && t.value !== '') {
      for (const [rowId, other] of table.rows) {
        if (rowId === op.rowId) continue;
        if (other[idx] === t.value) return `${label(t.header)}已存在值「${t.value}」（row_id=${rowId}），唯一列不能重复`;
      }
    }
  }
  return null;
}

/** 逐 op 顺序模拟校验（副本上应用），返回首个违规位置（-1 = 全通过）。 */
export function validateOpsSequential(book: BookModel, ops: LedgerOp[]): { errors: string[]; badIndex: number } {
  // 只复制 op 触达的表：逐 op 校验/应用不会改到其它表；data_replace/sheet_replace 只改副本的 Map 引用。
  const touched = new Set<string>();
  for (const op of ops) {
    if ('table' in op && (op as { table?: string }).table) touched.add(String((op as { table?: string }).table));
  }
  const sim = cloneBookForDryRun(book, touched);
  for (let i = 0; i < ops.length; i++) {
    const err = checkOpAgainstTable(sim, ops[i]);
    if (err) return { errors: [err], badIndex: i };
    const applied = applyOp(sim, ops[i]);
    if (!applied.ok) return { errors: [applied.error || '操作应用失败'], badIndex: i };
  }
  return { errors: [], badIndex: -1 };
}

/** AI 的 SQL 输出 → 校验通过的 ops（首个违规前的 ops 保留 = 半成功）。 */
export function runFillSql(book: BookModel, raw: string): FillSqlOutcome {
  const errors: string[] = [];
  const sqlText = extractSqlText(raw);
  if (!sqlText) return { ops: [], errors: ['未识别到 SQL 语句（请输出 UPDATE / INSERT / DELETE，一句一行、以分号结尾）'], statements: 0 };
  const clone = cloneBookForDryRun(book);
  // 纪要表的编号先清空：AI 写的重号不参与「撞唯一列→转更新」判定（由 summary-code 在校验前重排）。
  // 时间跨度不清：它不是唯一列；全局当前时间拿不到时要保留 AI 值做兜底（能算时引擎会覆盖）。
  const exec = executeSqlSubset(clone, sqlText, [], {
    clearColumns: (table, row) => {
      if (specialFormOf(table.name, table.v2def) !== 'summary') return;
      const idx = resolveColumn(table, '编码索引');
      if (idx < 0) return;
      const header = table.headers[idx];
      if (header in row) row[header] = '';
    },
  });
  for (const step of exec.steps) {
    if (step.kind === 'select') {
      errors.push(`填表不要输出 SELECT：${step.sql}（要改哪行直接写 UPDATE … WHERE）`);
      continue;
    }
    if (step.error) {
      // B1：保持「半成功」执行模式，但把失败语句与已保留的操作数明确写进告警。
      const kept = step.keptOps || 0;
      const status = step.phase === 'apply'
        ? `（本句有 ${kept} 条操作已在试算中应用；其余在试算中失败，按当前模式仍会尝试落账）`
        : (kept > 0 ? `（本句已产生 ${kept} 条操作，按当前模式保留；未生成的部分不执行）` : '（本句未产生可保留的操作）');
      errors.push(`语句执行失败：${step.sql} — ${step.error}${status}`);
      continue;
    }
    if (step.changes === 0) {
      errors.push(`语句未命中任何行：${step.sql}（核对表名与条件值是否与【已有数据】一致；新增行改用 INSERT）`);
    }
  }
  // 执行器/试算应用的原始错误：步骤文案已点过的去重，避免同一个失败报两遍。
  const stepErrorSet = new Set(exec.steps.map((s) => s.error).filter(Boolean));
  for (const e of exec.errors) if (!stepErrorSet.has(e)) errors.push(e);
  // 纪要类引擎列（编码索引 / 时间跨度）：由引擎补齐——必须赶在必填校验之前（见 core/summary-code.ts）
  assignSummaryCodes(book, exec.ops);
  // 时间跨度取「本轮填出来的全局当前时间」：必须读 SQL 试算后的副本（clone），不是填表前的 book
  assignSummarySpans(book, clone, exec.ops);
  const check = validateOpsSequential(book, exec.ops);
  if (check.errors.length > 0) {
    // B1：逐 op 校验失败也点名「第几条」与「保留了几条」。
    const keptNote = check.badIndex > 0 ? `按当前模式保留前 ${check.badIndex} 条，其余未执行` : '本句操作均未保留';
    errors.push(`第 ${check.badIndex + 1} 条操作校验失败：${check.errors.join('；')}（${keptNote}）`);
  }
  const ops = check.badIndex >= 0 ? exec.ops.slice(0, check.badIndex) : exec.ops;
  return { ops, errors, statements: exec.steps.length };
}
