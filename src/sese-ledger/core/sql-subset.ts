// ===== SQL 子集执行器（兼容门面核心） =====
//
// 契约语料 = 两项目实际发出的语句 + 存量聊天帧采样（规格 §5）：
// - INSERT 不写 row_id ＝追加（引擎自分配）；**`INSERT OR REPLACE` / `REPLACE INTO` 的显式 row_id ＝定位写**
//   （行在→只改给出的列、不在→建该行 ⇒「空表建行 / 满表就地替换」一条语句两态通吃）；其余 INSERT 形态照旧剥离 row_id；
// - INSERT `(SELECT COALESCE(MAX(row_id),0)+1 FROM 表)` 子查询形态（小手机备忘录）；
// - **INSERT 家族统一口径**：`INSERT` / `INSERT OR REPLACE|IGNORE` / `REPLACE` 一律「撞唯一列即原位更新」
//   （值列表支持**多组元组** `VALUES (…),(…),…`：逐元组产出一条 op，固定行数表「一句写满全部行」靠它）
//   （只覆盖本条给出的列，其余保留原值），不再以「唯一值已存在」失败——插行容错；
// - REPLACE INTO / INSERT OR REPLACE / ON CONFLICT(col) DO UPDATE SET c=excluded.c（地图总览 UPSERT）；
// - UPDATE/DELETE … WHERE row_id= / 业务列=（AND 连接，= != <> > < >= <= IN IS NULL）；
// - UPDATE SET 取值三形态：字面量 / ? / **列名 || 后缀**（接续追加）与 **列名 ± 数字**（加减，SQLite 语义：
//   空值当 0，非数字非空值点名报错）；其余表达式形态一律点名报错（旧版静默落字面串＝数据污染）；
// - 参数化 ?（按索引绑定）、同串多语句分号切分、`<!-- -->` 与 `--` / `/* */` 注释剥离、表名中文/uid 两路寻址；
// - 列/表标识符允许中文与「/」（身高/体重 这类列名可裸写）；
// - SELECT 简化形态（供 querySql 探测门面，两项目不直接用）。
//
// 每句执行产出 SqlStepReport（kind/changes/ops/error）：填表通道据此把「UPDATE/DELETE 未命中任何行」
// 判为错误回注（否则静默丢更新），见 core/fill-sql.ts。

import type { LedgerOp } from './types';
import { applyOp, resolveColumn, resolveTable, type BookModel, type TableModel } from './book';

export interface SqlExecOptions {
  /** 写入前清理引擎托管列（纪要表：编码索引）——值置空，避免 AI 写的编号撞唯一列把 INSERT 转成更新。 */
  clearColumns?: (table: TableModel, row: Record<string, string>) => void;
}

export interface SqlExecResult {
  ok: boolean;
  ops: LedgerOp[];
  errors: string[];
  /** 涉及表（tableId）。 */
  tables: string[];
  /** 受影响行数（行级操作计数，对齐原库 changes 语义）。 */
  changes: number;
  /** 逐句报告（顺序同 statements；填表通道判 0 命中用）。 */
  steps: SqlStepReport[];
  /** SELECT 查询结果（仅 querySql 路径）。 */
  rows?: Record<string, unknown>[];
  columns?: string[];
}

export interface SqlStepReport {
  /** 语句原文（截断展示）。 */
  sql: string;
  kind: 'select' | 'write';
  /** 本句影响行数（写句；select 恒 0）。 */
  changes: number;
  /** 本句产出 op 数。 */
  ops: number;
  /** 失败语句：本次尝试中已产生（执行器错误）/已成功应用（应用失败）的 op 数；用于告警里说明「保留了哪些」。 */
  keptOps?: number;
  /** 失败阶段：parse=解析/生成期失败；apply=试算应用期失败。 */
  phase?: 'parse' | 'apply';
  error?: string;
}

/** 注释剥离（引号感知：# 行注释、块注释、HTML 注释都在引号外才剥——值里出现 `--`/`/*` 不受影响）。 */
export function stripComments(sql: string): string {
  const text = String(sql || '');
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (quote) {
      out += ch;
      if (ch === quote) {
        if (next === quote) { out += next; i++; }
        else quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; out += ch; continue; }
    if (ch === '-' && next === '-') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 1;
      out += ' ';
      continue;
    }
    if (ch === '<' && text.startsWith('<!--', i)) {
      i += 4;
      while (i < text.length && !text.startsWith('-->', i)) i++;
      i += 2;
      out += ' ';
      continue;
    }
    out += ch;
  }
  return out;
}

/** 按分号切多语句（尊重引号与括号深度）。 */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      cur += ch;
      if (ch === quote) {
        if (sql[i + 1] === quote) { cur += quote; i++; }
        else quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ';' && depth === 0) {
      const t = cur.trim();
      if (t) out.push(t);
      cur = '';
      continue;
    }
    cur += ch;
  }
  const t = cur.trim();
  if (t) out.push(t);
  return out;
}

/** 值列表切分（尊重引号/括号深度；? 占位符原样保留）。 */
export function splitValueList(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      cur += ch;
      if (ch === quote) {
        if (text[i + 1] === quote) { cur += quote; i++; }
        else quote = null;
      }
      continue;
    }
    if (ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  const t = cur.trim();
  if (t) out.push(t);
  return out;
}

/** 标识符（列/表）去包裹：`x` "x" [x] */
/** 多行 VALUES 切元组：`(1,'a'),(2,'b')` → `["1,'a'", "2,'b'"]`（引号与嵌套括号感知——子查询里的括号不会被误切）。 */
export function splitValueTuples(body: string): string[] {
  const text = String(body || '');
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && (text[i] === ',' || /\s/.test(text[i]))) i++;
    if (i >= text.length) break;
    if (text[i] !== '(') throw new Error(`VALUES 子句形态不正确（应为 (…)[,(…)…]）：${text.slice(0, 40)}`);
    let depth = 0;
    let quote: string | null = null;
    let j = i;
    for (; j < text.length; j++) {
      const ch = text[j];
      if (quote) {
        if (ch === quote) {
          if (text[j + 1] === quote) j++;
          else quote = null;
        }
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) break; }
    }
    if (depth !== 0) throw new Error('VALUES 子句括号不配对');
    out.push(text.slice(i + 1, j));
    i = j + 1;
  }
  return out;
}

export function unquoteIdent(raw: string): string {
  const s = String(raw || '').trim();
  if (s.length >= 2 && ((s[0] === '`' && s.endsWith('`')) || (s[0] === '"' && s.endsWith('"')) || (s[0] === '[' && s.endsWith(']')))) {
    return s.slice(1, -1);
  }
  return s;
}

/** 字面量求值：'str'（''还原'，可跨行）/ 数字 / NULL / ?（params 绑定）/ (SELECT MAX...) 子查询→ROWID_AUTO 标记。
 *  裸标识符与表达式一律点名报错防静默写脏（表达式只在 UPDATE SET 里支持，见 parseSetValue）。 */
const ROWID_AUTO = Symbol('rowid-auto');
function evalLiteral(raw: string, params: unknown[], paramIndex: { i: number }, where = '值：'): string | null | typeof ROWID_AUTO {
  const s = String(raw ?? '').trim();
  if (/^\(?\s*SELECT\s+COALESCE\s*\(\s*MAX\s*\(\s*row_id\s*\)/i.test(s)) return ROWID_AUTO;
  if (s === '?') {
    const v = params[paramIndex.i++];
    if (v === null || v === undefined) return null;
    if (typeof v === 'boolean') return v ? '1' : '0';
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    return String(v);
  }
  if (/^'[\s\S]*'$/.test(s)) return s.slice(1, -1).replace(/''/g, "'");
  if (/^"[\s\S]*"$/.test(s)) return s.slice(1, -1);
  if (/^null$/i.test(s)) return null;
  if (/^[-+]?\d+(?:\.\d+)?$/.test(s)) return s;
  if (/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?$/.test(s)) throw new Error(`不支持列引用值「${s}」（${where}只能写字面量或 ?）`);
  if (/\|\||[()]|\b(?:SELECT|CASE|CAST|LOWER|UPPER|TRIM|SUBSTR|REPLACE|COALESCE|MAX|MIN|SUM)\b/i.test(s)) {
    throw new Error(`不支持的取值表达式「${s}」（${where}只支持字面量、?，以及 UPDATE SET 的 列名 || 后缀 / 列名 ± 数字）`);
  }
  return s;
}

/** UPDATE SET 取值规格：字面量 / 列名‖后缀（接续追加）/ 列名±数字（加减）。 */
type SetSpec =
  | { kind: 'literal'; value: string }
  | { kind: 'concat'; base: string; suffix: string }
  | { kind: 'arith'; base: string; delta: number };

/** 解析 SET 取值。表达式按 SQLite 语义落到「取当前值算终值」——引擎算，不需要 AI 复述旧文。 */
function parseSetValue(raw: string, table: TableModel, params: unknown[], paramIndex: { i: number }): SetSpec {
  const s = String(raw ?? '').trim();
  // 列名 || 后缀（后缀 = 字面量 / ?；空串合法）
  const concat = /^([\w\u4e00-\u9fff\/`"\[\]]+)\s*\|\|\s*([\s\S]+)$/.exec(s);
  if (concat) {
    const base = headerFor(table, unquoteIdent(concat[1]));
    const suffixRaw = concat[2].trim();
    const v = evalLiteral(suffixRaw, params, paramIndex, `列「${base}」拼接后缀：`);
    if (v === ROWID_AUTO) throw new Error(`列「${base}」拼接后缀不能是子查询`);
    return { kind: 'concat', base, suffix: v === null ? '' : String(v) };
  }
  // 列名 ± 数字
  const arith = /^([\w\u4e00-\u9fff\/`"\[\]]+)\s*([+\-])\s*([-+]?\d+(?:\.\d+)?)$/.exec(s);
  if (arith) {
    const base = headerFor(table, unquoteIdent(arith[1]));
    const delta = Number(arith[3]) * (arith[2] === '-' ? -1 : 1);
    return { kind: 'arith', base, delta };
  }
  // 其它 列名 <运算符> …（如 列名 + 'x'、列名 * 2）：点名报错，绝不静默落字面串
  const looksExpr = /^[\w\u4e00-\u9fff\/`"\[\]]+\s*(?:\|\||[+\-*/%])\s*[\s\S]/.exec(s);
  if (looksExpr) throw new Error(`不支持的 SET 表达式「${s}」（只支持 列名 || 后缀 与 列名 ± 数字）`);
  const v = evalLiteral(raw, params, paramIndex, 'SET 取值：');
  if (v === ROWID_AUTO) throw new Error('SET 取值不能是 row_id 子查询');
  return { kind: 'literal', value: v === null ? '' : String(v) };
}

interface Condition { col: string; op: string; value: string | null; list: unknown[] }

function isNumeric(s: string | null): boolean {
  return s !== null && s !== '' && Number.isFinite(Number(s));
}

function cellMatches(cell: string, cond: Condition): boolean {
  const cellText = cell === undefined || cell === null ? '' : String(cell);
  if (cond.op === 'ISNULL') return cellText === '' || cellText === '无' || cellText === '-';
  if (cond.op === 'NOTNULL') return !(cellText === '' || cellText === '无' || cellText === '-');
  if (cond.op === 'IN') {
    return cond.list.some((raw) => { const v = raw === null || raw === undefined ? null : String(raw); return v === null ? cellText === '' : v === cellText || (isNumeric(v) && isNumeric(cellText) && Number(v) === Number(cellText)); });
  }
  const v = cond.value;
  if (cond.op === '=' || cond.op === '!=') {
    if (v === null) return cond.op === '=' ? cellText === '' : cellText !== '';
    const eq = (v === cellText) || (isNumeric(v) && isNumeric(cellText) && Number(v) === Number(cellText));
    return cond.op === '=' ? eq : !eq;
  }
  if (!isNumeric(v) || !isNumeric(cellText)) return false;
  const a = Number(cellText);
  const b = Number(v);
  switch (cond.op) {
    case '>': return a > b;
    case '<': return a < b;
    case '>=': return a >= b;
    case '<=': return a <= b;
  }
  return false;
}

function findRows(table: TableModel, conds: Condition[]): number[] {
  const rowIds: number[] = [];
  for (const [rowId, cells] of table.rows) {
    let match = true;
    for (const c of conds) {
      const idx = resolveColumn(table, c.col);
      if (idx < 0) { match = false; break; }
      if (!cellMatches(cells[idx], c)) { match = false; break; }
    }
    if (match) rowIds.push(rowId);
  }
  return rowIds.sort((a, b) => a - b);
}

/** WHERE 子句解析：AND 连接的 col op value（支持 IN / IS NULL / IS NOT NULL）。 */
function parseWhere(clause: string, params: unknown[], paramIndex: { i: number }): Condition[] {
  const conds: Condition[] = [];
  // 按 AND 切（大小写不敏感，尊重引号）
  const parts: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let depth = 0;
  const upper = clause.toUpperCase();
  for (let i = 0; i < clause.length; i++) {
    const ch = clause[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && upper.startsWith(' AND ', i) && !upper.startsWith(' AND ', i + 1)) {
      parts.push(cur.trim()); cur = ''; i += 4; continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  for (const part of parts) {
    let m = /^([\w\u4e00-\u9fff\/`"\[\]]+)\s+IS\s+(NOT\s+)?NULL$/i.exec(part);
    if (m) { conds.push({ col: unquoteIdent(m[1]), op: m[2] ? 'NOTNULL' : 'ISNULL', value: null, list: [] }); continue; }
    m = /^([\w\u4e00-\u9fff\/`"\[\]]+)\s+IN\s*\((.*)\)$/i.exec(part);
    if (m) {
      const list = splitValueList(m[2]).map((v) => evalLiteral(v, params, paramIndex) as string | null);
      conds.push({ col: unquoteIdent(m[1]), op: 'IN', value: null, list });
      continue;
    }
    m = /^([\w\u4e00-\u9fff\/`"\[\]]+)\s*(=|!=|<>|>=|<=|>|<)\s*(.+)$/i.exec(part);
    if (m) { conds.push({ col: unquoteIdent(m[1]), op: m[2], value: evalLiteral(m[3], params, paramIndex) as string | null, list: [] }); continue; }
    throw new Error(`无法解析条件「${part}」`);
  }
  return conds;
}

function resolveOrThrow(book: BookModel, name: string): TableModel {
  const t = resolveTable(book, name);
  if (!t) throw new Error(`未找到表「${name}」`);
  return t;
}

/** 执行一批 SQL（写语句即时应用到账本并收集为 LedgerOp；SELECT 附带 rows）。
 *  即时应用是批次语义的关键：同批后句的 WHERE 必须看见前句的写入（对齐 SQLite 逐句执行）。
 *  某句失败即中止后续（对齐原库批处理行为），已成功语句保持应用。 */
export function executeSqlSubset(book: BookModel, sqlText: string, params: unknown[] = [], opts?: SqlExecOptions): SqlExecResult {
  const result: SqlExecResult = { ok: true, ops: [], errors: [], tables: [], changes: 0, steps: [] };
  const paramIndex = { i: 0 };
  const statements = splitStatements(stripComments(String(sqlText || '')));
  if (statements.length === 0) { result.ok = false; result.errors.push('空 SQL'); return result; }
  for (const stmt of statements) {
    const beforeChanges = result.changes;
    const beforeOps = result.ops.length;
    const trimmed = stmt.trim();
    try {
      execOne(book, stmt, params, paramIndex, result, opts);
      // 逐句即时应用（后续语句的 WHERE 看见本句写入）
      let applied = 0;
      let applyError: string | null = null;
      for (const op of result.ops.slice(beforeOps)) {
        const r = applyOp(book, op);
        if (!r.ok) {
          result.ok = false;
          applyError = r.error || '语句应用失败';
          result.errors.push(applyError);
          break;
        }
        applied += 1;
      }
      result.steps.push({
        sql: trimmed.slice(0, 120),
        kind: /^SELECT\b/i.test(trimmed) ? 'select' : 'write',
        changes: result.changes - beforeChanges,
        ops: result.ops.length - beforeOps,
        ...(applyError ? { keptOps: applied, phase: 'apply' as const, error: applyError } : {}),
      });
      if (!result.ok) break;
    } catch (e) {
      result.ok = false;
      const message = e instanceof Error ? e.message : String(e);
      result.errors.push(message);
      // 当前执行模式保留本句已产出的前缀 op（不改变半成功语义），把「保留了几条」写进步骤报告供告警展示。
      result.steps.push({ sql: trimmed.slice(0, 120), kind: /^SELECT\b/i.test(trimmed) ? 'select' : 'write', changes: 0, ops: result.ops.length - beforeOps, keptOps: result.ops.length - beforeOps, phase: 'parse', error: message });
      break;
    }
  }
  return result;
}

function touched(result: SqlExecResult, tableId: string): void {
  if (!result.tables.includes(tableId)) result.tables.push(tableId);
}

function execOne(book: BookModel, stmt: string, params: unknown[], paramIndex: { i: number }, result: SqlExecResult, opts?: SqlExecOptions): void {
  const s = stmt.trim().replace(/;+$/, '');
  // ---- SELECT（探测门面用，简化形态） ----
  if (/^SELECT\b/i.test(s)) {
    const m = /^SELECT\s+(.+?)\s+FROM\s+([\w\u4e00-\u9fff\/`"\[\]]+)(?:\s+WHERE\s+(.+?))?(?:\s+LIMIT\s+(\d+))?\s*$/i.exec(s);
    if (!m) throw new Error('SELECT 形态不支持');
    const table = resolveOrThrow(book, unquoteIdent(m[2]));
    const colSpec = m[1].trim() === '*' ? table.headers.slice() : m[1].split(',').map((c) => unquoteIdent(c.trim()));
    const conds = m[3] ? parseWhere(m[3], params, paramIndex) : [];
    const rowIds = findRows(table, conds).slice(0, m[4] ? Number(m[4]) : 1000);
    const rows = rowIds.map((rid) => {
      const cells = table.rows.get(rid)!;
      const obj: Record<string, unknown> = {};
      // 输出键 = 调用方写的列名（中文口径；台账不再有第二套英文名）
      colSpec.forEach((c) => {
        const idx = resolveColumn(table, c);
        obj[c] = idx >= 0 ? (cells[idx] === '' ? null : cells[idx]) : null;
      });
      return obj;
    });
    result.rows = rows;
    result.columns = colSpec;
    return;
  }
  // ---- INSERT 家族（含 OR REPLACE / OR IGNORE / REPLACE）----
  // 统一口径：撞唯一列即原位更新（只覆盖本条给出的列，其余保留原值）——插行容错，不再以「已存在」失败。
  // 值列表支持**多组元组**（`VALUES (…),(…),…`——固定行数表「一句写满全部行」就是这么写的）：逐元组产出一条 op。
  // **显式 row_id 只在 REPLACE 语义下生效**（`INSERT OR REPLACE` / `REPLACE INTO`）＝定位写（行在→只改给出的列、
  // 不在→建该行）——「空表建行 / 满表就地替换」一条语句两态通吃；其余形态（INSERT / OR IGNORE / …）照旧剥离 row_id＝追加。
  // 逐句应用仍由调用方在整句结束后统一做 ⇒ 同语句内后一元组看不见前一元组的写入（唯一列查重以语句开始时为准）。
  let m = /^(INSERT|INSERT\s+OR\s+(?:REPLACE|IGNORE|ABORT|FAIL|ROLLBACK)|REPLACE)\s+INTO\s+([\w\u4e00-\u9fff\/`"\[\]]+)\s*(?:\(([^)]*)\))?\s*VALUES\s*([\s\S]+)$/i.exec(s);
  if (m) {
    const table = resolveOrThrow(book, unquoteIdent(m[2]));
    touched(result, table.tableId);
    const replaceSemantics = /^REPLACE$/i.test(m[1].trim()) || /OR\s+REPLACE$/i.test(m[1].trim());
    // ON CONFLICT(col) DO UPDATE SET c=excluded.c2（显式指定冲突列：优先于唯一列推断）——先摘尾，再切元组
    let body = m[4];
    let onConflict: { col: string; sets: string[] } | null = null;
    const oc = /\s+ON\s+CONFLICT\s*\(([^)]+)\)\s*DO\s+UPDATE\s+SET\s+([\s\S]+)$/i.exec(body);
    if (oc) {
      onConflict = { col: oc[1].split(',')[0].trim(), sets: oc[2].split(',').map((x) => x.trim()) };
      body = body.slice(0, oc.index);
    }
    const tuples = splitValueTuples(body);
    if (tuples.length === 0) throw new Error(`表「${table.name}」INSERT 的 VALUES 没有值`);
    // 列清单：显式或全列（DDL 序）
    let colNames: string[];
    if (m[3]) colNames = m[3].split(',').map((c) => unquoteIdent(c.trim())).filter(Boolean);
    else colNames = table.headers.slice();
    for (const tupleText of tuples) {
      const values = splitValueList(tupleText);
      if (values.length > colNames.length) throw new Error(`表「${table.name}」INSERT 值个数（${values.length}）超过列数（${colNames.length}）`);
      // 组装键值：**REPLACE 语义下显式 row_id 被尊重**（行在就写那行、不在就建那行；见下方定位写分支）；
      // 其余形态照旧剥离 row_id（子查询形态 ROWID_AUTO 也吸收）＝追加，引擎自分配。
      const row: Record<string, string> = {};
      let explicitRowId: number | null = null;
      for (let i = 0; i < colNames.length; i++) {
        const col = colNames[i];
        const v = i < values.length ? evalLiteral(values[i], params, paramIndex) : null;
        if (/^row_id$/i.test(col)) {
          if (replaceSemantics) {
            const n = Number(String(v ?? '').trim());
            if (Number.isInteger(n) && n > 0) explicitRowId = n;
          }
          continue;
        }
        if (v === ROWID_AUTO) continue;
        const header = headerFor(table, col);
        row[header] = v === null ? '' : String(v);
      }
      // 引擎托管列（纪要表）先置空：旧模板让 AI 写重号时，不能让它撞唯一列把普通 INSERT 转成更新旧行。
      // REPLACE 语义是按固定行号定位写（表说明明确禁止用于纪要表），保留原值走既有口径。
      if (!replaceSemantics) opts?.clearColumns?.(table, row);
      // ON CONFLICT：命中冲突列 → 列级更新；未命中 → 普通插入
      if (onConflict) {
        const conflictHeader = headerFor(table, onConflict.col);
        const conflictVal = row[conflictHeader] ?? '';
        const existing = findRows(table, [{ col: conflictHeader, op: '=', value: conflictVal, list: [] }]);
        if (existing.length > 0) {
          for (const set of onConflict.sets) {
            const sm = /^([\w\u4e00-\u9fff\/`"\[\]]+)\s*=\s*(.+)$/i.exec(set);
            if (!sm) continue;
            const target = headerFor(table, sm[1]);
            const src = /^excluded\.([\w\u4e00-\u9fff\/`"\[\]]+)$/i.exec(sm[2].trim());
            const value = src ? (row[headerFor(table, src[1])] ?? '') : String(evalLiteral(sm[2], params, paramIndex) ?? '');
            if (resolveColumn(table, target) > 0) result.ops.push({ kind: 'cell', table: table.tableId, rowId: existing[0], column: target, value });
          }
          result.changes += 1;
          continue;
        }
        result.ops.push({ kind: 'row_insert', table: table.tableId, row });
        result.changes += 1;
        continue;
      }
      // 撞唯一列 → 原位更新（列级写：只改本条给出的列，其余保留原值；唯一列口径：一表至多一列）
      const collision = (table.ddlInfo?.columns || [])
        .filter((c) => c.unique && c.header !== 'row_id')
        .map((c) => ({ header: c.header, value: row[c.header] }))
        .find((c) => c.value !== undefined && c.value !== '' && findRows(table, [{ col: c.header, op: '=', value: c.value, list: [] }]).length > 0);
      if (collision) {
        const hit = findRows(table, [{ col: collision.header, op: '=', value: String(collision.value), list: [] }])[0];
        for (const [header, value] of Object.entries(row)) {
          if (header === collision.header) continue;
          result.ops.push({ kind: 'cell', table: table.tableId, rowId: hit, column: header, value });
        }
        result.changes += 1;
        continue;
      }
      // 显式 row_id（仅 REPLACE 语义下非空；`INSERT OR REPLACE (row_id, …) VALUES (1, …)` 形态）→ **定位写**：
      //   行存在 → 只改本条给出的列（未给的列保留原值；口径与「撞唯一列转更新」一致，不整行清空）；
      //   行不存在 → 用该 row_id 建行（固定行数表满员时按上限拦下）。
      if (explicitRowId !== null) {
        if (table.rows.has(explicitRowId)) {
          for (const [header, value] of Object.entries(row)) {
            result.ops.push({ kind: 'cell', table: table.tableId, rowId: explicitRowId, column: header, value });
          }
        } else {
          const limit = Number(table.ddlInfo?.maxRowCount) || 0;
          if (limit > 0 && table.rows.size >= limit) {
            throw new Error(`表「${table.name}」为固定 ${limit} 行表，禁止增行（row_id ${explicitRowId} 不存在，且已满 ${limit} 行）`);
          }
          result.ops.push({
            kind: 'row_upsert',
            table: table.tableId,
            rowId: explicitRowId,
            cells: table.headers.map((h) => (String(h) === 'row_id' ? '' : (row[String(h)] ?? ''))),
          });
        }
        result.changes += 1;
        continue;
      }
      result.ops.push({ kind: 'row_insert', table: table.tableId, row });
      result.changes += 1;
    }
    return;
  }
  // ---- UPDATE ----
  m = /^UPDATE\s+(?:OR\s+\w+\s+)?([\w\u4e00-\u9fff\/`"\[\]]+)\s+SET\s+([\s\S]+?)\s+WHERE\s+([\s\S]+)$/i.exec(s);
  if (m) {
    const table = resolveOrThrow(book, unquoteIdent(m[1]));
    touched(result, table.tableId);
    const sets: { header: string; spec: SetSpec }[] = [];
    for (const piece of splitValueList(m[2])) {
      const sm = /^([\w\u4e00-\u9fff\/`"\[\]]+)\s*=\s*([\s\S]+)$/i.exec(piece.trim());
      if (!sm) throw new Error(`无法解析 SET 子句「${piece}」`);
      const header = headerFor(table, unquoteIdent(sm[1]));
      if (header === 'row_id') throw new Error('row_id 列禁改');
      sets.push({ header, spec: parseSetValue(sm[2], table, params, paramIndex) });
    }
    const conds = parseWhere(m[3], params, paramIndex);
    for (const rowId of findRows(table, conds)) {
      const cells = table.rows.get(rowId)!;
      for (const set of sets) {
        let value: string;
        if (set.spec.kind === 'literal') {
          value = set.spec.value;
        } else if (set.spec.kind === 'concat') {
          const idx = resolveColumn(table, set.spec.base);
          value = String(cells[idx] ?? '') + set.spec.suffix;
        } else {
          const idx = resolveColumn(table, set.spec.base);
          const current = String(cells[idx] ?? '').trim();
          if (current !== '' && !Number.isFinite(Number(current))) {
            throw new Error(`列「${set.spec.base}」当前值「${current.slice(0, 30)}」不是数字，不能做加减`);
          }
          value = String((current === '' ? 0 : Number(current)) + set.spec.delta);
        }
        result.ops.push({ kind: 'cell', table: table.tableId, rowId, column: set.header, value });
      }
      result.changes += 1;
    }
    return;
  }
  // ---- DELETE ----
  m = /^DELETE\s+FROM\s+([\w\u4e00-\u9fff\/`"\[\]]+)\s+WHERE\s+([\s\S]+)$/i.exec(s);
  if (m) {
    const table = resolveOrThrow(book, unquoteIdent(m[1]));
    touched(result, table.tableId);
    const conds = parseWhere(m[2], params, paramIndex);
    for (const rowId of findRows(table, conds)) {
      result.ops.push({ kind: 'row_delete', table: table.tableId, rowId });
      result.changes += 1;
    }
    return;
  }
  throw new Error(`不支持的语句：${s.slice(0, 60)}…`);
}

function headerFor(table: TableModel, col: string): string {
  const idx = resolveColumn(table, col);
  if (idx < 0) throw new Error(`表「${table.name}」不存在列「${col}」`);
  return table.headers[idx];
}
