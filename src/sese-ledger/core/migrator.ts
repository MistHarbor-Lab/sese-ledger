// ===== 存量迁移：原数据库消息帧 → 台账账本 =====
//
// 流程（规格 §8.1）：
// 1. 结构基线：chat_metadata（优先）或 chat[0] 的 InternalSheetGuide[域].data → 台账蓝图
//    （域表直挂与真数据库 {version,tags:{域}} 两种形态都认）；无指南回退标准模板；
//    列名对齐表级别名（年龄→生日，纯改名保位置——行单元格按位不受影响）。
// 2. 帧遍历：顺序扫 chat 的 TavernDB_ACU_IsolatedData[域].storageFrame（V2 按结构证据判定；V1 残留跳过）。
// 3. 转译重放：full checkpoint → 快照基底（连前史条目一并折叠）；logEntries 各 op → 台账条目；
//    无法识别的 op 记录并截断（fail-closed，不静默丢）。
// 4. 推进历史：用户楼 qrf_plot* 字段发现 → 报告（平移动作由调用方执行）。
// 5. 验证：迁移态自洽 + 原数据库在场时逐表逐格比对，不一致整本不落盘。
//
// 限制（如实告知）：原库滚动清理（≈20 楼）已删数据不可恢复；迁移是一次性拷贝，之后二选一。

import type { LedgerEntry, LedgerOp, LedgerTemplateV2, WorkbookJson } from './types';
import { applyOp, createBook, projectWorkbook, resolveColumn, resolveTable, type BookModel } from './book';
import { convergeBookToTemplate, convertV1Template } from './blueprint';
import { executeSqlSubset, splitStatements, splitValueList, stripComments, unquoteIdent } from './sql-subset';
import { parseDdl } from './constraints';
import { aiFloorOrdinalAt, isAnchorCandidate, ledgerAnchorFor } from './floor-scope';

const GUIDE_FIELD = 'TavernDB_ACU_InternalSheetGuide';
const ISO_FIELD = 'TavernDB_ACU_IsolatedData';

/** 表级列别名（对齐主项目模板修复语义：旧列名→新列名，同位改名）。 */
const SHEET_COLUMN_ALIASES: Record<string, Record<string, string>> = {
  主角信息表: { 年龄: '生日' },
  恋爱对象表: { 年龄: '生日' },
  重要角色表: { 年龄: '生日' },
};

export interface MigrationPlotFloor { messageIndex: number; preset: string; textLength: number }

export interface MigrationReport {
  ok: boolean;
  /** 迁移产物：快照基底（最后一个 full checkpoint 的对齐态）+ 其后转译条目。 */
  snapshot: WorkbookJson | null;
  entries: LedgerEntry[];
  /** 统计。 */
  sheetCount: number;
  rowCount: number;
  frameCount: number;
  checkpointCount: number;
  /** 发现的推进历史楼。 */
  plotFloors: MigrationPlotFloor[];
  /** 无法识别的操作（截断迁移）。 */
  unknownOps: { kind: string; aiFloor: number; entryId?: string }[];
  truncated: boolean;
  /** 与在场原数据库逐格比对结果（null=未比对）。 */
  verified: boolean | null;
  mismatches: string[];
  warnings: string[];
  /** 快照基底锚点与 AI 楼序（落盘 book 文件用）。 */
  snapshotAnchor: string;
  snapshotAiFloor: number;
}

function deepClone<T>(v: T): T {
  return v === undefined || v === null ? v : JSON.parse(JSON.stringify(v));
}

function parseIsolatedData(message: any): Record<string, any> | null {
  const raw = message?.[ISO_FIELD];
  if (!raw) return null;
  if (typeof raw === 'string') {
    try { const parsed = JSON.parse(raw); return parsed && typeof parsed === 'object' ? parsed : null; } catch (_e) { return null; }
  }
  return typeof raw === 'object' ? raw : null;
}

function frameOf(message: any): any | null {
  const iso = parseIsolatedData(message);
  if (!iso) return null;
  const tag = iso[''] || Object.values(iso)[0];
  const frame = tag?.storageFrame;
  if (!frame || typeof frame !== 'object') return null;
  // V2 判定：结构证据（version===2 或 logEntries 数组）
  if (frame.version === 2 || Array.isArray(frame.logEntries)) return frame;
  return null;
}

/** 列名对齐：同位改名（保行单元格按位有效）。 */
function alignWorkbookHeaders(data: any): any {
  if (!data || typeof data !== 'object') return data;
  const out: any = { ...data };
  for (const key of Object.keys(out)) {
    if (!key.startsWith('sheet_')) continue;
    const sheet = out[key];
    if (!sheet || !Array.isArray(sheet.content) || sheet.content.length === 0) continue;
    const alias = SHEET_COLUMN_ALIASES[String(sheet.name || '')];
    if (!alias) continue;
    const headers = sheet.content[0].map((cell: unknown) => alias[String(cell)] ?? cell);
    sheet.content = [headers, ...sheet.content.slice(1)];
  }
  return out;
}

// ===== 外来 SQL 的名字对照（迁移边界；台账唯一读英文名的地方） =====
//
// DB 帧里的 SQL 写的是数据库的英文物理名（wupinbiao / item_name …），台账只认中文名。
// 对照表从 DDL 建（读完即弃，不落库、不进运行时），在把语句交给台账 SQL 引擎之前按 token 换成中文——
// 引擎侧完全不认识英文名。来源按权威度递进并入：标准/原始模板 → chat_metadata 指南 → 帧结构快照
//（checkpoint / sheet_replace / data_replace——真数据库的结构以帧内 DDL 为准，随迁移推进滚动更新）。

interface ForeignNameMap {
  /** 英文物理表名 → 中文表名。 */
  tables: Map<string, string>;
  /** 中文表名 → { 英文物理列名 → 中文列名 }。 */
  columns: Map<string, Map<string, string>>;
}

/** 空对照表（每次迁移自建，不复用全局缓存——迁移中随帧快照持续并入，缓存会串场）。 */
export function createForeignNameMap(): ForeignNameMap {
  return { tables: new Map(), columns: new Map() };
}

/** 把一份工作簿（模板/指南/帧快照）的 DDL 对照并入：物理表名 → 中文表名、物理列名 → 中文列头。
 *  同名物理名后并入者覆盖（调用方按权威度递进：标准模板 → 指南 → 帧快照）。 */
export function mergeForeignNames(map: ForeignNameMap, workbook: WorkbookJson | null | undefined): void {
  if (!workbook || typeof workbook !== 'object') return;
  for (const key of Object.keys(workbook)) {
    if (!key.startsWith('sheet_')) continue;
    const sheet = (workbook as any)[key];
    if (!sheet || typeof sheet !== 'object') continue;
    const name = String(sheet.name || key);
    const parsed = parseDdl(String(sheet.sourceData?.ddl || ''));
    if (!parsed) continue;
    map.tables.set(parsed.physicalTable, name);
    let colMap = map.columns.get(name);
    if (!colMap) { colMap = new Map(); map.columns.set(name, colMap); }
    for (const c of parsed.columns) if (c.physical !== 'row_id') colMap.set(c.physical, c.header);
  }
}

const IDENT_TOKEN_RE = /[A-Za-z_][A-Za-z0-9_]*/g;

/** 外来 SQL → 中文名 SQL：按 token 精确替换（不做子串替换，故无「name 命中 item_name」类误伤）；
 *  字符串字面量与注释原样跳过；列名按语句定位到的表取对照（同名物理列在不同表映射不同中文名时不混淆）。 */
export function translateForeignSql(sql: string, map: ForeignNameMap): string {
  const text = String(sql || '');
  // 1) 表名先换（物理表名在全模板内唯一）
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < text.length) {
        out += text[i];
        if (text[i] === quote) {
          if (text[i + 1] === quote) { out += text[i + 1]; i += 2; continue; }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    IDENT_TOKEN_RE.lastIndex = i;
    const m = IDENT_TOKEN_RE.exec(text);
    if (m && m.index === i) {
      out += map.tables.get(m[0]) || m[0];
      i += m[0].length;
      continue;
    }
    out += ch;
    i += 1;
  }
  // 2) 列名：定位本语句的目标表（换过表名后按中文表名找）
  let target: string | null = null;
  for (const name of map.columns.keys()) {
    if (new RegExp(`(^|[^\\w])${name}([^\\w]|$)`).test(out)) { target = name; break; }
  }
  const colMap = target ? map.columns.get(target) : null;
  if (!colMap || colMap.size === 0) return out;
  let final = '';
  i = 0;
  while (i < out.length) {
    const ch = out[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      final += ch;
      i += 1;
      while (i < out.length) {
        final += out[i];
        if (out[i] === quote) {
          if (out[i + 1] === quote) { final += out[i + 1]; i += 2; continue; }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    IDENT_TOKEN_RE.lastIndex = i;
    const m = IDENT_TOKEN_RE.exec(out);
    if (m && m.index === i) {
      final += colMap.get(m[0]) || m[0];
      i += m[0].length;
      continue;
    }
    final += ch;
    i += 1;
  }
  return final;
}

const SQL_TARGET_RE = /^(\s*)(INSERT\s+(?:OR\s+(?:REPLACE|IGNORE|ABORT|FAIL|ROLLBACK)\s+)?INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)(\s+)([A-Za-z_][A-Za-z0-9_]*|`[^`]+`|"[^"]+"|\[[^\]]+\])/i;

/**
 * 迁移边界：日志项带 `sheetKey` 时，按它把语句的目标表钉到账本表的中文名。
 * 真数据库帧里 SQL 的物理表名可能与自身 DDL 不一致（实测：帧 SQL 写 jueselichengbeibiao，
 * checkpoint DDL 却叫 jiaoselichengbeibiao，角→决 一字之差）——只靠 DDL 外文名对照会整批失败。
 * `sql_sheet_batch` 的语句都是单表语句，只改首条目标表即可；不带 sheetKey 的批次原样返回。
 */
export function retargetSheetSql(sql: string, tableName: string | null | undefined): string {
  const name = String(tableName || '').trim();
  if (!name) return String(sql || '');
  return String(sql || '').replace(SQL_TARGET_RE, (_m, pad: string, head: string, ws: string) => `${pad}${head}${ws}${name}`);
}

/** 顶层（引号/括号外）关键字位置；找不到返回 -1。 */
function topLevelKeywordIndex(text: string, keyword: string): number {
  const re = new RegExp(`^${keyword}\\b`, 'i');
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) {
        if (text[i + 1] === quote) i++;
        else quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(') { depth += 1; continue; }
    if (ch === ')') { depth = Math.max(0, depth - 1); continue; }
    if (depth !== 0 || !re.test(text.slice(i, i + keyword.length))) continue;
    const next = text[i + keyword.length];
    if (next === undefined || !/[A-Za-z0-9_]/.test(next)) return i;
  }
  return -1;
}

/** 从 '(' 起找配对右括号的下一位；引号感知；不闭合返回 -1。 */
function matchingParenEnd(text: string, openIndex: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) {
        if (text[i + 1] === quote) i++;
        else quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** 多行 VALUES → 逐行单句（迁移边界）：`INSERT/REPLACE … VALUES (…),(…)` 台账引擎只认单行形态
 *  （整句会被判「值个数超过列数」而拒绝）；此处按括号/引号深度切值组、逐行重发，
 *  `ON CONFLICT …` 尾巴原样复制到每句（SQLite 逐行语义等价）。非多行/形态不认识 → 原样返回，
 *  交给引擎按原语义点名报错（不静默改写）。 */
export function expandMultiRowValueStatements(sql: string): string[] {
  const raw = String(sql || '');
  const text = raw.trim();
  if (!/^(INSERT|REPLACE)\b/i.test(text)) return [raw];
  const valuesAt = topLevelKeywordIndex(text, 'VALUES');
  if (valuesAt < 0) return [raw];
  const prefix = text.slice(0, valuesAt).trimEnd();
  const rest = text.slice(valuesAt + 'VALUES'.length);
  const groups: string[] = [];
  let tail = '';
  let i = 0;
  while (i < rest.length) {
    const ch = rest[i];
    if (ch === ',' || /\s/.test(ch)) { i += 1; continue; }
    if (ch !== '(') { tail = rest.slice(i).trim(); break; }
    const end = matchingParenEnd(rest, i);
    if (end < 0) return [raw];
    groups.push(rest.slice(i, end));
    i = end;
  }
  if (groups.length <= 1) return [raw];
  if (!tail.replace(/[;\s]/g, '')) tail = '';
  // 尾巴只认引擎支持的 ON CONFLICT 形态；其余（如拼接的多语句）原样返回，交引擎点名报错
  if (tail && !/^ON\b/i.test(tail)) return [raw];
  const suffix = tail ? ` ${tail}` : '';
  return groups.map((g) => `${prefix} VALUES ${g}${suffix}`);
}

/** 引号外 `?` 计数（引擎按序消费 params；分批执行时用于对齐参数起点）。 */
function countPlaceholders(sql: string): number {
  let count = 0;
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      if (ch === quote) {
        if (sql[i + 1] === quote) i++;
        else quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '?') count += 1;
  }
  return count;
}

/** 值文本 → 字面量（'x' / "x" / 数字 / NULL / ?）；非字面量（子查询/表达式）返回 null。 */
function foreignLiteralValue(raw: string, params: unknown[], paramIndex: { i: number }): string | null {
  const s = String(raw ?? '').trim();
  if (s === '?') {
    const v = params[paramIndex.i++];
    return v === null || v === undefined ? '' : String(v);
  }
  if (/^'[\s\S]*'$/.test(s)) return s.slice(1, -1).replace(/''/g, "'");
  if (/^"[\s\S]*"$/.test(s)) return s.slice(1, -1);
  if (/^null$/i.test(s)) return '';
  if (/^[-+]?\d+(?:\.\d+)?$/.test(s)) return s;
  return null;
}

/** 显式 row_id 的 REPLACE 形态 → row_upsert（迁移边界）：`INSERT OR REPLACE|REPLACE INTO t (row_id, …) VALUES (n, …)`。
 *  台账引擎表达不了该语义（INSERT 纪律剥离 row_id，行号由引擎分配），而真数据库的固定行表（检定建议表等）
 *  正是靠它原位改写 1..N 行；此处直译为 row_upsert（保行号、保原位）。非该形态/含非字面量 → null（交回引擎）。 */
function explicitRowReplaceOp(book: BookModel, sql: string, params: unknown[], paramIndex: { i: number }): LedgerOp | null {
  const m = /^(?:INSERT\s+OR\s+REPLACE|REPLACE)\s+INTO\s+([\w\u4e00-\u9fff\/`"\[\]]+)\s*\(([^)]*)\)\s*VALUES\s*\(([\s\S]+?)\)\s*$/i.exec(String(sql || '').trim().replace(/;+$/, ''));
  if (!m) return null;
  const table = resolveTable(book, unquoteIdent(m[1]));
  if (!table) return null;
  const colNames = m[2].split(',').map((c) => unquoteIdent(c.trim())).filter(Boolean);
  if (!colNames.some((c) => /^row_id$/i.test(c))) return null;
  const values = splitValueList(m[3]);
  if (values.length !== colNames.length) return null;
  const probe = { i: paramIndex.i };
  let rowId = 0;
  const cells = table.headers.map(() => '');
  for (let i = 0; i < colNames.length; i++) {
    const literal = foreignLiteralValue(values[i], params, probe);
    if (literal === null) return null;
    if (/^row_id$/i.test(colNames[i])) {
      const n = Number(literal);
      if (!Number.isInteger(n) || n <= 0) return null;
      rowId = n;
      continue;
    }
    const idx = resolveColumn(table, colNames[i]);
    if (idx <= 0) return null;
    cells[idx] = literal;
  }
  if (rowId <= 0) return null;
  paramIndex.i = probe.i;
  cells[0] = String(rowId);
  return { kind: 'row_upsert', table: table.tableId, rowId, cells };
}

/** 读蓝图：chat_metadata 优先，回退 chat[0].chat_metadata，再回退标准模板。 */
function readGuide(chat: any[], chatMetadata: Record<string, any> | undefined, standardTemplate: WorkbookJson): { data: WorkbookJson; source: 'guide' | 'standard' } {
  const tryParse = (raw: unknown): WorkbookJson | null => {
    if (!raw || typeof raw !== 'object') return null;
    const unwrap = (value: unknown): WorkbookJson | null => {
      if (!value || typeof value !== 'object') return null;
      const domains = value as Record<string, any>;
      const domain = domains[''] || Object.values(domains)[0];
      const data = domain?.data ?? domain;
      if (!data || typeof data !== 'object') return null;
      const sheetKeys = Object.keys(data).filter((k) => k.startsWith('sheet_'));
      if (sheetKeys.length === 0) return null;
      return data as WorkbookJson;
    };
    // 形态一：域表直挂（{ '': { data } } / { '': { sheet_* } }）
    const direct = unwrap(raw);
    if (direct) return direct;
    // 形态二：真数据库落盘形态——域表外层再包一层 { version, tags: { '': { data } } }
    const tags = (raw as Record<string, any>).tags;
    return tags && typeof tags === 'object' ? unwrap(tags) : null;
  };
  const fromMeta = tryParse(chatMetadata?.[GUIDE_FIELD]);
  if (fromMeta) return { data: alignWorkbookHeaders(deepClone(fromMeta)), source: 'guide' };
  const fromChat0 = tryParse(chat?.[0]?.chat_metadata?.[GUIDE_FIELD]);
  if (fromChat0) return { data: alignWorkbookHeaders(deepClone(fromChat0)), source: 'guide' };
  return { data: standardTemplate, source: 'standard' };
}

/** 旧 DSL 命令解析（对齐原库 extractTableEditDslCommands/parseDslArgs 语义）。 */
function extractDslCommands(text: string): { command: string; args: unknown[] }[] {
  const cleaned = String(text || '').replace(/<!--|-->/g, '');
  const out: { command: string; args: unknown[] }[] = [];
  const pattern = /(?:insertRow|updateRow|deleteRow)\s*\(/g;
  let searchStart = 0;
  while (searchStart < cleaned.length) {
    pattern.lastIndex = searchStart;
    const match = pattern.exec(cleaned);
    if (!match) break;
    const openParen = cleaned.indexOf('(', match.index);
    let depth = 0;
    let inString = false;
    let stringChar = '';
    let escaped = false;
    let end = -1;
    for (let i = openParen; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === stringChar) inString = false;
        continue;
      }
      if (ch === '"' || ch === "'") { inString = true; stringChar = ch; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    if (end === -1) break;
    const call = cleaned.slice(match.index, end).trim().replace(/;$/, '');
    const m = /^(insertRow|deleteRow|updateRow)\s*\((.*)\)$/s.exec(call);
    if (m) {
      const args = parseDslArgs(m[2]);
      if (args) out.push({ command: m[1], args });
    }
    searchStart = end;
  }
  return out;
}

function parseDslArgs(argsString: string): unknown[] | null {
  try {
    const firstBracket = argsString.indexOf('{');
    if (firstBracket === -1) return JSON.parse(`[${argsString}]`);
    const paramsPart = argsString.substring(0, firstBracket).trim();
    const jsonPart = argsString.substring(firstBracket);
    const initialArgs = JSON.parse(`[${paramsPart.replace(/,$/, '')}]`);
    return [...initialArgs, JSON.parse(jsonPart)];
  } catch (_e) { return null; }
}

/** 表序号 → 排序后 sheet 键（对齐原库 getSortedSheetKeys：orderNo 升序）。 */
function sortedSheetKeys(book: BookModel): string[] {
  return [...book.tables.values()].sort((a, b) => a.orderNo - b.orderNo || a.tableId.localeCompare(b.tableId)).map((t) => t.tableId);
}

/** 单条旧 DSL 命令 → 台账 ops（content 位置口径当场换算）。 */
function translateDslCommand(book: BookModel, command: string, args: unknown[]): LedgerOp[] {
  const keys = sortedSheetKeys(book);
  const tableId = keys[Number(args[0])];
  if (!tableId) return [];
  const table = book.tables.get(tableId);
  if (!table) return [];
  const rowIds = [...table.rows.keys()].sort((a, b) => a - b);
  if (command === 'insertRow') {
    const data = (args[1] || {}) as Record<string, unknown>;
    const row: Record<string, string> = {};
    // DSL 列下标 0 起且不含 row_id（对齐原库 headers.slice(1) 语义）
    for (const [k, v] of Object.entries(data)) {
      const idx = Number(k);
      if (Number.isInteger(idx) && idx + 1 < table.headers.length) {
        row[table.headers[idx + 1]] = v === null || v === undefined ? '' : String(v);
      }
    }
    return [{ kind: 'row_insert', table: tableId, row }];
  }
  if (command === 'deleteRow') {
    const rowIndex = Number(args[1]);
    const rowId = rowIds[rowIndex];
    return Number.isInteger(rowIndex) && rowId !== undefined ? [{ kind: 'row_delete', table: tableId, rowId }] : [];
  }
  if (command === 'updateRow') {
    const rowIndex = Number(args[1]);
    const rowId = rowIds[rowIndex];
    if (!Number.isInteger(rowIndex) || rowId === undefined) return [];
    const data = (args[2] || {}) as Record<string, unknown>;
    const ops: LedgerOp[] = [];
    for (const [k, v] of Object.entries(data)) {
      const idx = Number.parseInt(k, 10);
      if (Number.isInteger(idx) && idx + 1 < table.headers.length) {
        ops.push({ kind: 'cell', table: tableId, rowId, column: table.headers[idx + 1], value: v === null || v === undefined ? '' : String(v) });
      }
    }
    return ops;
  }
  return [];
}

function applyOpsToBook(book: BookModel, ops: LedgerOp[]): string[] {
  const errors: string[] = [];
  for (const op of ops) {
    const r = applyOp(book, op);
    if (!r.ok && r.error) errors.push(r.error);
  }
  return errors;
}

function tablesOfOps(book: BookModel, ops: LedgerOp[]): string[] {
  const set = new Set<string>();
  for (const op of ops) {
    const ref = (op as any).table;
    if (typeof ref !== 'string' || !ref) continue;
    const t = resolveTable(book, ref);
    if (t) set.add(t.tableId);
  }
  return [...set];
}

/**
 * 迁移主函数（纯计算，不落盘不写消息）。
 * @param deps.chat 宿主聊天数组（原地只读）
 * @param deps.chatMetadata 宿主 chat metadata
 * @param deps.standardTemplate 标准模板（指南缺失回退）
 * @param deps.foreignNameTemplate 外文名对照的 DDL 来源（台账标准模板是 v2 转换产物、无 DDL；
 *        调用方传原始 v1 模板。缺省=standardTemplate；指南与帧快照会在此之上继续并入）
 * @param deps.dbExport 原数据库在场时的当前全量投影（null=不在场，跳过比对）
 */
export function migrateFromDbFrames(deps: {
  chat: any[];
  chatMetadata?: Record<string, any>;
  standardTemplate: WorkbookJson;
  foreignNameTemplate?: WorkbookJson;
  dbExport?: WorkbookJson | null;
}): MigrationReport {
  const report: MigrationReport = {
    ok: false, snapshot: null, entries: [], sheetCount: 0, rowCount: 0,
    frameCount: 0, checkpointCount: 0, plotFloors: [], unknownOps: [],
    truncated: false, verified: null, mismatches: [], warnings: [],
    snapshotAnchor: '', snapshotAiFloor: 0,
  };
  const { chat, standardTemplate } = deps;
  if (!Array.isArray(chat) || chat.length === 0) {
    report.warnings.push('聊天为空，无可迁移内容');
    return report;
  }
  const guide = readGuide(chat, deps.chatMetadata, standardTemplate);
  if (guide.source === 'standard') report.warnings.push('未找到数据库指南，以标准模板为结构基线');
  const foreignNames = createForeignNameMap();
  mergeForeignNames(foreignNames, deps.foreignNameTemplate || standardTemplate);
  if (guide.source === 'guide') mergeForeignNames(foreignNames, guide.data);

  let book = createBook(deepClone(guide.data) as WorkbookJson);
  let snapshotBase: WorkbookJson | null = null;
  let baseAnchor = '';
  let baseAiFloor = 0;
  let seq = 0;
  const entries: LedgerEntry[] = [];
  /**
   * 真正阻断迁移的失败（转译异常 / 自洽校验失败）。行级落空（UPDATE/DELETE 命中 0 行）、
   * 单条 SQL 无法执行（表/列版本漂移）一律降级为报告里的警告——迁移是尽力而为，
   * 不能因为一条历史语句不认识就把整本账锁死（否则报告显示出来也永远点不了「应用」）。
   */
  let hardFailures = 0;
  let softFailures = 0;
  const recordOpFailures = (errors: string[], where: string, count = true): void => {
    // 重放遍（count=false）与遍历遍应用的是同一批 op：失败明细只报一次，重放差异由自洽校验兜底。
    if (errors.length === 0 || !count) return;
    softFailures += errors.length;
    for (const e of errors.slice(0, 5)) report.warnings.push(`${where}：${e}（已跳过）`);
    if (errors.length > 5) report.warnings.push(`${where}：另有 ${errors.length - 5} 条同类失败已跳过`);
  };
  /** SQL 批执行失败同样按「跳过该句」处理；逐句明细进警告，不阻断应用。 */
  const recordSqlFailure = (aiFloor: number, message: string): void => {
    softFailures += 1;
    report.warnings.push(`楼${aiFloor} SQL 未能执行（已跳过）：${message}`);
  };

  for (let i = 0; i < chat.length; i++) {
    const msg = chat[i];
    if (!msg) continue;
    // 推进历史在用户楼（qrf_plot 落用户消息字段）——先扫再跳过用户楼
    if (msg.qrf_plot || (msg.qrf_plot_tasks && Object.keys(msg.qrf_plot_tasks).length > 0)) {
      report.plotFloors.push({ messageIndex: i, preset: String(msg.qrf_plot_preset || ''), textLength: String(msg.qrf_plot || '').length });
    }
    if (msg.is_user === true) continue;
    const frame = frameOf(msg);
    if (!frame) continue;
    if (!isAnchorCandidate(msg)) continue;
    report.frameCount++;
    // 与运行时同口径（多变体选中变体 0 时优先消息级锚点）：迁移条目导入后才能被 activeAnchors 看见。
    const anchor = ledgerAnchorFor(msg, i);
    if (!anchor) continue;
    const aiFloor = aiFloorOrdinalAt(chat, i);

    // full checkpoint → 新基底（前史折叠进快照）
    const checkpoint = frame.checkpoint;
    if (checkpoint && checkpoint.kind === 'full' && checkpoint.data && typeof checkpoint.data === 'object') {
      report.checkpointCount++;
      const merged = deepClone(checkpoint.data) as any;
      // perSheetCheckpoints 合并（单表快照覆盖对应表）
      const perSheet = frame.perSheetCheckpoints;
      if (perSheet && typeof perSheet === 'object') {
        for (const [key, value] of Object.entries(perSheet)) {
          const sheetData = (value as any)?.data;
          if (sheetData && typeof sheetData === 'object') merged[key] = deepClone(sheetData);
        }
      }
      const aligned = alignWorkbookHeaders(merged);
      // 帧内结构快照 = 数据库当前结构（DDL 带物理名）：并入外文名对照，随后续语句用
      mergeForeignNames(foreignNames, aligned);
      book = createBook(deepClone(aligned) as WorkbookJson);
      snapshotBase = deepClone(aligned);
      baseAnchor = anchor;
      baseAiFloor = aiFloor;
      entries.length = 0;
      seq = 0;
    }

    const logEntries = Array.isArray(frame.logEntries) ? frame.logEntries : [];
    for (const logEntry of logEntries) {
      const operations = Array.isArray(logEntry?.operations) ? logEntry.operations : [];
      const ops: LedgerOp[] = [];
      for (const operation of operations) {
        const kind = String(operation?.kind || '');
        try {
          if (kind === 'sql_batch' || kind === 'sql_sheet_batch') {
            const statements: unknown[] = Array.isArray(operation.statements) ? operation.statements : [operation.statements];
            const paramsList: unknown = operation.params;
            // 日志项自带的 sheetKey 是目标表的权威线索（帧 SQL 的物理表名可能与 DDL 不一致）
            const targetTable = operation.sheetKey ? resolveTable(book, String(operation.sheetKey)) : null;
            statements.forEach((st, idx) => {
              const sqlText = String(st || '');
              if (!sqlText.trim()) return;
              const params = Array.isArray(paramsList) && Array.isArray(paramsList[idx]) ? paramsList[idx] : [];
              // 迁移边界规范化：逐句拆条 →（有 sheetKey 则）钉目标表 → 外文名换中文 → 多行 VALUES 逐行展开
              const pieces = splitStatements(stripComments(sqlText))
                .map((one) => retargetSheetSql(one, targetTable?.name))
                .flatMap((one) => expandMultiRowValueStatements(translateForeignSql(one, foreignNames)));
              const paramIndex = { i: 0 };
              const pending: string[] = [];
              // 其余 SQL 保序成段交台账引擎执行；单句失败按「跳过该句」记警告，不锁死整本迁移
              const flush = (): boolean => {
                if (pending.length === 0) return true;
                const text = pending.join(';\n');
                pending.length = 0;
                const exec = executeSqlSubset(book, text, params.slice(paramIndex.i));
                paramIndex.i += countPlaceholders(text);
                ops.push(...exec.ops);
                if (!exec.ok) recordSqlFailure(aiFloor, exec.errors[0] || '未知错误');
                return exec.ok;
              };
              for (const one of pieces) {
                // 显式 row_id 的 REPLACE：直译 row_upsert（引擎 INSERT 剥离 row_id，表达不了原位覆盖）
                const direct = explicitRowReplaceOp(book, one, params as unknown[], paramIndex);
                if (!direct) { pending.push(one); continue; }
                if (!flush()) return;
                ops.push(direct);
                recordOpFailures(applyOpsToBook(book, [direct]), '历史操作应用失败');
              }
              flush();
            });
          } else if (kind === 'table_edit_dsl') {
            for (const { command, args } of extractDslCommands(String(operation.text || ''))) {
              const dslOps = translateDslCommand(book, command, args);
              ops.push(...dslOps);
              recordOpFailures(applyOpsToBook(book, dslOps), '历史操作应用失败');
            }
          } else if (kind === 'row_upsert') {
            const op: LedgerOp = { kind: 'row_upsert', table: String(operation.sheetKey || ''), rowId: Number(operation.rowId), cells: (operation.cells || []).map((c: unknown) => (c === null || c === undefined ? '' : String(c))) };
            ops.push(op); recordOpFailures(applyOpsToBook(book, [op]), '历史操作应用失败');
          } else if (kind === 'row_delete') {
            const op: LedgerOp = { kind: 'row_delete', table: String(operation.sheetKey || ''), rowId: Number(operation.rowId) };
            ops.push(op); recordOpFailures(applyOpsToBook(book, [op]), '历史操作应用失败');
          } else if (kind === 'meta_update') {
            const meta = { ...(operation.meta || {}) } as Record<string, unknown>;
            if (meta.sourceData && typeof meta.sourceData === 'object') delete (meta.sourceData as any).ddl;
            const op: LedgerOp = { kind: 'meta', table: String(operation.sheetKey || ''), meta: meta as any };
            ops.push(op); recordOpFailures(applyOpsToBook(book, [op]), '历史操作应用失败');
          } else if (kind === 'sheet_replace') {
            const sheet = alignWorkbookHeaders(deepClone(operation.sheet)) as any;
            mergeForeignNames(foreignNames, { [String(operation.sheetKey || 'sheet_replaced')]: sheet } as WorkbookJson);
            const op: LedgerOp = { kind: 'sheet_replace', table: String(operation.sheetKey || ''), sheet };
            ops.push(op); recordOpFailures(applyOpsToBook(book, [op]), '历史操作应用失败');
          } else if (kind === 'data_replace') {
            const data = alignWorkbookHeaders(deepClone(operation.data)) as WorkbookJson;
            mergeForeignNames(foreignNames, data);
            const op: LedgerOp = { kind: 'data_replace', data: data as any };
            ops.push(op); recordOpFailures(applyOpsToBook(book, [op]), '历史操作应用失败');
          } else {
            report.unknownOps.push({ kind, aiFloor, entryId: logEntry?.entryId });
          }
        } catch (e) {
          hardFailures += 1;
          report.mismatches.push(`楼${aiFloor} ${kind} 转译异常：${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (ops.length > 0) {
        seq += 1;
        entries.push({
          seq,
          at: { anchor, aiFloor },
          source: 'migrate',
          ops,
          changedTables: tablesOfOps(book, ops),
          atTime: Date.now(),
        });
      }
    }
    if (report.unknownOps.length > 0) {
      report.truncated = true;
      report.warnings.push(`遇到无法识别的操作（${report.unknownOps.map((u) => u.kind).join(', ')}），迁移在该楼截断`);
      break;
    }
  }

  if (report.frameCount === 0) {
    report.warnings.push('聊天中未发现数据库存储帧（可能此聊天从未用过数据库）');
    return report;
  }

  // 终态自洽校验：snapshot 基底 + 条目重放 ≡ 遍历终态
  const finalState = book;
  const snapshot = snapshotBase || (guide.source === 'guide' ? (guide.data as WorkbookJson) : standardTemplate);
  const replayBook = createBook(deepClone(snapshot) as WorkbookJson);
  recordOpFailures(applyOpsToBook(replayBook, entries.flatMap((e) => e.ops)), '自洽重放失败', false);
  report.snapshot = snapshot;
  report.entries = entries;

  const stateProj = projectWorkbook(finalState);
  const replayProj = projectWorkbook(replayBook);
  report.sheetCount = Object.keys(replayProj).filter((k) => k.startsWith('sheet_')).length;
  report.rowCount = Object.values(replayProj).reduce((n: number, s: unknown) => n + (Array.isArray((s as any)?.content) ? Math.max(0, (s as any).content.length - 1) : 0), 0);

  const selfConsistent = workbookEquals(stateProj, replayProj);
  if (!selfConsistent) report.mismatches.push('迁移自洽校验失败（转译重放与遍历终态不一致）');

  // 原数据库在场 → 逐表逐格比对
  if (deps.dbExport) {
    report.verified = workbookEquals(replayProj, deps.dbExport);
    if (!report.verified) {
      for (const key of Object.keys(deps.dbExport)) {
        if (!key.startsWith('sheet_')) continue;
        const expect = (deps.dbExport as any)[key];
        const got = (replayProj as any)[key];
        if (!got) { report.mismatches.push(`缺表 ${key}（${expect?.name || key}）`); continue; }
        const ec = expect?.content || [];
        const gc = got.content || [];
        if (ec.length !== gc.length) { report.mismatches.push(`表「${expect?.name || key}」行数不一致（库 ${ec.length - 1} vs 台账 ${gc.length - 1}）`); continue; }
        outer: for (let r = 0; r < ec.length; r++) {
          const er = ec[r] || [];
          const gr = gc[r] || [];
          for (let c = 0; c < Math.max(er.length, gr.length); c++) {
            const ev = String(er[c] ?? '');
            const gv = String(gr[c] ?? '');
            if (ev !== gv) {
              report.mismatches.push(`表「${expect?.name || key}」第${Math.max(0, r)}行第${c}列不一致（库 "${ev.slice(0, 20)}" vs 台账 "${gv.slice(0, 20)}"）`);
              break outer;
            }
          }
        }
      }
    }
  }

  // 截断（unknownOps）不算失败——按"报告截断而非静默丢"语义迁移到截断点，由用户看报告决定。
  // 行级落空 / 单句 SQL 失败只进 warnings：迁移仍可应用（best-effort），明细全部摆在报告里。
  report.ok = selfConsistent && hardFailures === 0;
  if (softFailures > 0) {
    report.warnings.push(`迁移期间共跳过 ${softFailures} 条无法落账的历史操作/SQL（明细见上；其余数据照常迁移）`);
  }
  report.snapshotAnchor = baseAnchor;
  report.snapshotAiFloor = baseAiFloor;
  if (baseAnchor === '' && snapshotBase === null && entries.length > 0) {
    // 无 full checkpoint 的裸条目史：基底=蓝图结构
    report.warnings.push('未发现 full checkpoint，以蓝图结构为基底（无锚点前史按原库语义属压缩降级态）');
  }
  return report;
}

function workbookEquals(a: WorkbookJson, b: WorkbookJson): boolean {
  const ka = Object.keys(a).filter((k) => k.startsWith('sheet_')).sort();
  const kb = Object.keys(b).filter((k) => k.startsWith('sheet_')).sort();
  if (ka.length !== kb.length) return false;
  for (const key of ka) {
    const sa = (a as any)[key];
    const sb = (b as any)[key];
    const ca = sa?.content || [];
    const cb = sb?.content || [];
    if (ca.length !== cb.length) return false;
    for (let r = 0; r < ca.length; r++) {
      const ra = ca[r] || [];
      const rb = cb[r] || [];
      if (ra.length !== rb.length) return false;
      for (let c = 0; c < ra.length; c++) {
        if (String(ra[c] ?? '') !== String(rb[c] ?? '')) return false;
      }
    }
  }
  return true;
}

// ===== 迁移向导 v2：按当前模板对齐 + 四 Case 差异报告 + 数据行容错 =====

export interface TemplateAlignmentReport {
  templateName: string;
  tableCount: number;
  groupCount: number;
  columnCount: number;
  /** Case1 一致表（表名）。 */
  caseConsistent: string[];
  /** Case2 列调整：改名认领 / 多余列丢弃 / 新增列补空。 */
  caseAdjusted: { table: string; details: string[] }[];
  /** Case3 多余表（数据库有、模板无 → 落库时按用户选择：并入一份新模板 / 丢弃）。 */
  caseExtra: string[];
  /** Case4 待建表（模板有、数据库无 → 建空结构 + seed 行）。 */
  caseMissing: string[];
  /** 数据行容警告。 */
  rowWarnings: string[];
  /** 报告全文（迁移 tab 展示）。 */
  text: string;
}

export interface TemplateAlignmentResult {
  report: TemplateAlignmentReport;
  /** 对齐后的全量数据（结构=模板，行=迁移数据经容错）。 */
  aligned: WorkbookJson;
  /** 传入 entries 时返回：已按改名映射重写、模板外操作已剔除的迁移历史条目。 */
  entries?: LedgerEntry[];
}

export interface TemplateAlignmentOptions {
  /** 迁移历史条目：有条目时保留原 row_id、不自动删重复行，并把历史 op 的列名/行数据按模板改名重写。 */
  entries?: LedgerEntry[];
}

/** 迁移产物里「模板外」的数据表（key=sheet_<uid>，name=中文表名）：模板缺表 → 由用户在迁移页选并入/丢弃。 */
export function collectExtraTables(migrated: WorkbookJson, templateWorkbook: WorkbookJson): { key: string; name: string }[] {
  const templateKeys = new Set(Object.keys(templateWorkbook).filter((k) => k.startsWith('sheet_')));
  const templateNames = new Set(Object.values(templateWorkbook).filter((v) => v && typeof v === 'object' && (v as any).name).map((v) => String((v as any).name)));
  const out: { key: string; name: string }[] = [];
  for (const key of Object.keys(migrated)) {
    if (!key.startsWith('sheet_')) continue;
    const sheet = migrated[key] as any;
    const name = String(sheet?.name || key);
    if (templateKeys.has(key) || templateNames.has(name)) continue;
    out.push({ key, name });
  }
  return out;
}

/** 把「模板外数据表」并进一份**新** v2 模板（该角色卡专用；不写回原共享模板）。返回合并结果与新增表名。 */
export function mergeExtraTablesIntoV2Template(
  templateV2: LedgerTemplateV2,
  migrated: WorkbookJson,
  extras: { key: string; name: string }[],
  name: string,
): { template: LedgerTemplateV2; merged: string[] } | null {
  if (extras.length === 0) return { template: templateV2, merged: [] };
  const subset: WorkbookJson = { mate: (migrated.mate as any) || {} };
  for (const e of extras) subset[e.key] = (migrated as any)[e.key];
  const converted = convertV1Template(subset, `${name}·并入`);
  if (!converted.ok || !converted.template) return null;
  const baseOrder = Math.max(0, ...templateV2.tables.map((t) => Number(t.orderNo) || 0));
  const groups = [...templateV2.groups];
  const merged: LedgerTemplateV2['tables'] = converted.template.tables.map((t, i) => {
    // 并入表沿用其转换分组（超出既有分组时补注册；频率沿用转换结果）
    const gid = Number(t.groupId) || 1;
    while (groups.length < gid) groups.push({ id: groups.length + 1, name: `分组${groups.length + 1}`, frequency: 1 });
    return { ...t, orderNo: baseOrder + 1 + i };
  });
  return { template: { ...templateV2, groups, tables: [...templateV2.tables, ...merged] }, merged: merged.map((t) => t.name) };
}

/**
 * 表名认领：旧库的表 key（uid）与当前模板 key 不同、但**中文表名相同** → 把账本表改挂到模板 key。
 * 迁移产物来自外部数据库，模板换代后 key 会变（如 sheet_zhu_jue_xin_xi_biao → sheet_protagonist）；
 * convergeBookToTemplate 只按 key 匹配，不先认领会把所有旧表判成「模板外」整表丢弃（迁移搬空）。
 * 返回 旧 key → 新 key 映射（历史条目重写用）。
 */
export function adoptTablesByTemplateName(book: BookModel, templateWorkbook: WorkbookJson): Map<string, string> {
  const templateKeys = new Set<string>();
  const keyByName = new Map<string, string>();
  for (const key of Object.keys(templateWorkbook)) {
    if (!key.startsWith('sheet_')) continue;
    templateKeys.add(key);
    const name = String((templateWorkbook[key] as any)?.name || '').trim();
    if (name) keyByName.set(name, key);
  }
  const renames = new Map<string, string>();
  for (const [oldKey, table] of [...book.tables.entries()]) {
    if (templateKeys.has(oldKey)) continue;
    const target = keyByName.get(String(table.name || '').trim());
    if (!target || book.tables.has(target)) continue;
    book.tables.delete(oldKey);
    table.tableId = target;
    book.tables.set(target, table);
    renames.set(oldKey, target);
  }
  return renames;
}

/**
 * 把迁移产物（帧转译终态）按当前选择的台账模板对齐：
 * 结构走收敛语义（表/列改名认领、新增列补空、模板外内容丢弃；多余表由用户在迁移页选并入新模板或丢弃），
 * 数据行做容错（notNull 缺失补空串、unique 冲突保留首行、row_id 全表重排为连续序号）。
 */
export function planTemplateAlignment(
  migrated: WorkbookJson,
  templateWorkbook: WorkbookJson,
  templateName: string,
  opts: TemplateAlignmentOptions = {},
): TemplateAlignmentResult {
  const book = createBook(deepClone(migrated) as WorkbookJson);
  // 先做表名认领，再快照表头（row_upsert 的 cells 按旧列序排列，重写时要靠它映射到新列）。
  const tableRenames = adoptTablesByTemplateName(book, templateWorkbook);
  const oldHeaders = new Map<string, string[]>();
  for (const [id, t] of book.tables) oldHeaders.set(id, t.headers.slice());
  const hasEntries = Array.isArray(opts.entries) && opts.entries.length > 0;
  const reconcile = convergeBookToTemplate(book, templateWorkbook);
  const report: TemplateAlignmentReport = {
    templateName,
    tableCount: 0, groupCount: 0, columnCount: 0,
    caseConsistent: [], caseAdjusted: [], caseExtra: [], caseMissing: [], rowWarnings: [],
    text: '',
  };

  // 模板侧概览
  const templateKeys = Object.keys(templateWorkbook).filter((k) => k.startsWith('sheet_'));
  report.tableCount = templateKeys.length;
  report.groupCount = Array.isArray((templateWorkbook.mate as any)?.ledgerGroups) ? (templateWorkbook.mate as any).ledgerGroups.length : 0;
  report.columnCount = templateKeys.reduce((n, k) => n + Math.max(0, ((templateWorkbook[k] as any)?.content?.[0] || []).length - 1), 0);

  // 四 Case 归类
  const adjustedByTable = new Map<string, string[]>();
  for (const c of reconcile.claimedRenames) {
    const list = adjustedByTable.get(c.table) || [];
    list.push(`数据库「${c.from}」→ 模板「${c.to}」（列别名认领，数据迁移）`);
    adjustedByTable.set(c.table, list);
  }
  for (const a of reconcile.addedColumns) {
    const list = adjustedByTable.get(a.table) || [];
    list.push(`模板新增列「${a.columns.join('、')}」（现有行补空串）`);
    adjustedByTable.set(a.table, list);
  }
  for (const k of reconcile.droppedColumns) {
    const list = adjustedByTable.get(k.table) || [];
    list.push(`数据库多余列「${k.columns.join('、')}」（模板外，落库时按收敛口径丢弃）`);
    adjustedByTable.set(k.table, list);
  }
  for (const droppedId of reconcile.droppedTables) {
    const dropped = createBook(deepClone(migrated) as WorkbookJson).tables.get(droppedId);
    if (dropped) report.caseExtra.push(dropped.name);
  }
  for (const t of book.tables.values()) {
    if (reconcile.addedTables.includes(t.tableId)) { report.caseMissing.push(t.name); continue; }
    const details = adjustedByTable.get(t.name);
    if (details && details.length > 0) report.caseAdjusted.push({ table: t.name, details });
    else report.caseConsistent.push(t.name);
  }

  // 数据行容错：notNull 补空 / unique 去重 / row_id 重排
  for (const t of book.tables.values()) {
    const notNullIdx: number[] = [];
    const uniqueIdx: number[] = [];
    (t.ddlInfo?.columns || []).forEach((c, i) => {
      if (c.notNull && i > 0) notNullIdx.push(i);
      if (c.unique && i > 0) uniqueIdx.push(i);
    });
    for (const idx of notNullIdx) {
      let filled = 0;
      for (const cells of t.rows.values()) {
        if (String(cells[idx] ?? '').trim() === '') { cells[idx] = ''; filled++; }
      }
      if (filled > 0) report.rowWarnings.push(`⚠ ${t.name} 必填列「${t.headers[idx]}」有 ${filled} 行为空 → 补空串迁移`);
    }
    for (const idx of uniqueIdx) {
      const seen = new Map<string, number>();
      const dupRowIds: number[] = [];
      for (const [rowId, cells] of [...t.rows.entries()].sort((a, b) => a[0] - b[0])) {
        const v = String(cells[idx] ?? '').trim();
        if (!v) continue;
        if (seen.has(v)) dupRowIds.push(rowId);
        else seen.set(v, rowId);
      }
      if (hasEntries) {
        // 有历史改动时**不删行**：历史 op 可能正指向这些 row_id，删了会错行/丢改动。
        if (dupRowIds.length > 0) report.rowWarnings.push(`⚠ ${t.name} 列「${t.headers[idx]}」重复 ${dupRowIds.length} 行（唯一列）：因存在历史改动，未自动删除，请迁移后手动处理`);
        continue;
      }
      for (const rowId of dupRowIds) t.rows.delete(rowId);
      if (dupRowIds.length > 0) report.rowWarnings.push(`⚠ ${t.name} 列「${t.headers[idx]}」重复 ${dupRowIds.length} 行（唯一列）→ 保留首行，丢弃重复`);
    }
    if (hasEntries) {
      // 有历史改动时**不重排 row_id**：op 里的 rowId 是绝对值，重排会写到错误行。
      let high = 0;
      for (const id of t.rows.keys()) if (id > high) high = id;
      t.rowIdHighWater = Math.max(high, t.rows.size, 1);
    } else {
      // row_id 重排为连续序号
      const ids = [...t.rows.keys()].sort((a, b) => a - b);
      ids.forEach((oldId, i) => {
        const newId = i + 1;
        if (oldId === newId) return;
        const cells = t.rows.get(oldId)!;
        cells[0] = String(newId);
        t.rows.delete(oldId);
        t.rows.set(newId, cells);
      });
      t.rowIdHighWater = Math.max(t.rows.size, 1);
    }
  }
  report.rowWarnings.push(hasEntries
    ? '存在历史改动：row_id 保留原值（不重排）、重复唯一行不自动删除，避免历史改动写到错误行'
    : 'row_id 全表重排为连续序号（旧值保留在日志映射）');

  // 有历史改动：把 op 里的旧列名/旧行数据按模板改名重写；模板外内容随收敛丢弃（并计数）。
  let remappedEntries: LedgerEntry[] | undefined;
  if (hasEntries) {
    let dropped = 0;
    remappedEntries = remapAlignmentEntries(opts.entries!, book, oldHeaders, reconcile.claimedRenames, tableRenames, () => { dropped += 1; });
    if (dropped > 0) report.rowWarnings.push(`⚠ ${dropped} 条历史改动指向模板外内容（已随列/表丢弃，不再回放）`);
    const hasStructural = remappedEntries.some((e) => (e.ops || []).some((op) => op.kind === 'data_replace' || op.kind === 'sheet_replace'));
    if (hasStructural) report.rowWarnings.push('⚠ 历史改动里包含结构替换（data_replace/sheet_replace）：应用后可能覆盖当前模板结构，请核对');
  }

  const lines: string[] = [];
  lines.push(`模板概览：${templateName}——${report.tableCount} 表 · ${report.groupCount} 分组 · ${report.columnCount} 列`);
  lines.push('');
  lines.push('表级差异（数据库数据 → 当前模板）：');
  lines.push(`✓ 一致（${report.caseConsistent.length}）：${report.caseConsistent.join('、') || '无'}`);
  lines.push(`△ 列调整（${report.caseAdjusted.length}）：`);
  for (const c of report.caseAdjusted) lines.push(`    ${c.table}：${c.details.join('；')}`);
  if (report.caseAdjusted.length === 0) lines.push('    无');
  lines.push(`□ 多余（${report.caseExtra.length}）：${report.caseExtra.map((n) => `「${n}」→ 应用时选择：并入一份新模板（该卡专用）或丢弃`).join('、') || '无'}`);
  lines.push(`＋ 待建（${report.caseMissing.length}）：${report.caseMissing.map((n) => `${n}（模板有数据库无）→ 建空结构 + 种子行`).join('、') || '无'}`);
  lines.push('');
  lines.push('数据行容错：');
  lines.push(...report.rowWarnings);
  report.text = lines.join('\n');

  const aligned = projectWorkbook(book);
  return { report, aligned, ...(remappedEntries ? { entries: remappedEntries } : {}) };
}

/** 迁移历史条目重写：旧表 key → 模板表 key；旧列名 → 模板新列名；row_upsert 的 cells 按旧表头映射到新表头。
 *  模板外内容（表/列被收敛丢弃）直接剔除并由调用方计数——它们本来就不会再存在于账本。 */
function remapAlignmentEntries(
  entries: LedgerEntry[],
  book: BookModel,
  oldHeaders: Map<string, string[]>,
  renamesList: { table: string; tableId?: string; from: string; to: string }[],
  tableRenames: Map<string, string>,
  onDrop: () => void,
): LedgerEntry[] {
  const renames = new Map<string, Map<string, string>>();
  for (const c of renamesList) {
    if (!c.tableId) continue;
    let m = renames.get(c.tableId);
    if (!m) { m = new Map(); renames.set(c.tableId, m); }
    m.set(c.from, c.to);
  }
  const out: LedgerEntry[] = [];
  const alignedWorkbook = projectWorkbook(book);
  for (const entry of entries) {
    const ops: LedgerOp[] = [];
    for (const op of entry.ops || []) {
      const mapped = remapAlignmentOp(op, book, alignedWorkbook, oldHeaders, renames, tableRenames);
      if (mapped) ops.push(mapped);
      else onDrop();
    }
    // 表 key 随认领改写后，账本条目的 changedTables 也必须同步（否则落盘后按旧 key 找不到表）
    const changedTables: string[] = [];
    for (const id of entry.changedTables || []) {
      const next = tableRenames.get(id) || id;
      if (book.tables.has(next) && !changedTables.includes(next)) changedTables.push(next);
    }
    out.push({ ...entry, ops, changedTables });
  }
  return out;
}

/** 结构快照（data_replace / sheet_replace）按模板收敛：
 *  只保留模板内表；每张表的数据行按模板表头重排（同名列搬数据、新列补空、模板外列丢弃）。
 *  否则回放时一份旧快照会整本书替换回来——已丢弃的模板外表复活、旧表头覆盖模板结构。 */
function convergeStructuralSheet(src: any, tplSheet: any, rename?: Map<string, string>): any {
  const tplHeaders: string[] = Array.isArray(tplSheet?.content?.[0]) ? tplSheet.content[0].map(String) : ['row_id'];
  const srcHeaders: string[] = Array.isArray(src?.content?.[0]) ? src.content[0].map(String) : [];
  // rename 存的是「旧列名 → 新列名」；这里要从模板表头（新名）反查旧名取数据。
  const inverse = new Map<string, string>();
  if (rename) for (const [from, to] of rename) inverse.set(to, from);
  const content: unknown[][] = [tplHeaders];
  for (let r = 1; r < (Array.isArray(src?.content) ? src.content.length : 0); r++) {
    const srcRow = src.content[r] || [];
    content.push(tplHeaders.map((header, i) => {
      if (i === 0) return String(srcRow[0] ?? '');
      const lookup = inverse.get(header) || header;
      let si = srcHeaders.indexOf(lookup);
      // 载荷里的列名可能早于全局改名映射（结构快照自有版本）：同位置且旧名不在模板表头 → 视为改名认领。
      if (si < 0 && i < srcHeaders.length && !tplHeaders.includes(srcHeaders[i])) si = i;
      return si >= 0 ? String(srcRow[si] ?? '') : '';
    }));
  }
  return { ...tplSheet, content };
}

function convergeStructuralWorkbook(data: WorkbookJson, aligned: WorkbookJson, renames: Map<string, Map<string, string>>): WorkbookJson {
  const out: any = { mate: { ...(aligned.mate as any) } };
  for (const key of Object.keys(aligned)) {
    if (!key.startsWith('sheet_')) continue;
    out[key] = convergeStructuralSheet((data as any)?.[key], (aligned as any)[key], renames.get(key));
  }
  return out as WorkbookJson;
}

function remapAlignmentOp(
  op: LedgerOp,
  book: BookModel,
  alignedWorkbook: WorkbookJson,
  oldHeaders: Map<string, string[]>,
  renames: Map<string, Map<string, string>>,
  tableRenames: Map<string, string>,
): LedgerOp | null {
  const rawTableId = 'table' in op ? String((op as { table?: string }).table || '') : '';
  const tableId = tableRenames.get(rawTableId) || rawTableId;
  const table = tableId ? book.tables.get(tableId) || null : null;
  const rename = tableId ? renames.get(tableId) : undefined;
  const tplSheet = tableId ? (alignedWorkbook as any)[tableId] : undefined;
  switch (op.kind) {
    case 'cell': {
      if (!table) return null;
      const column = rename?.get(op.column) || op.column;
      return table.headers.indexOf(column) >= 0 ? { ...op, table: tableId, column } : null;
    }
    case 'row_insert': {
      if (!table) return null;
      const row: Record<string, string> = {};
      for (const [key, value] of Object.entries(op.row || {})) {
        const header = rename?.get(key) || key;
        if (table.headers.indexOf(header) >= 0) row[header] = value;
      }
      return { ...op, table: tableId, row };
    }
    case 'row_upsert': {
      if (!table) return null;
      const old = oldHeaders.get(tableId);
      if (!old) return null;
      const cells: string[] = new Array(table.headers.length).fill('');
      cells[0] = op.cells?.[0] ?? '';
      for (let i = 1; i < old.length; i += 1) {
        const header = rename?.get(old[i]) || old[i];
        const nextIdx = table.headers.indexOf(header);
        if (nextIdx > 0 && op.cells?.[i] !== undefined) cells[nextIdx] = String(op.cells[i] ?? '');
      }
      return { ...op, table: tableId, cells };
    }
    case 'row_delete':
      return table ? { ...op, table: tableId } : null;
    case 'data_replace': {
      const data: any = {};
      for (const [key, value] of Object.entries(op.data || {})) {
        if (key.startsWith('sheet_') && tableRenames.has(key)) data[tableRenames.get(key)!] = value;
        else data[key] = value;
      }
      return { ...op, data: convergeStructuralWorkbook(data, alignedWorkbook, renames) };
    }
    case 'sheet_replace': {
      if (!table || !tplSheet) return null;
      return { ...op, table: tableId, sheet: convergeStructuralSheet(op.sheet, tplSheet, rename) };
    }
    case 'meta':
      return { ...op, table: tableId };
    default:
      return op;
  }
}
