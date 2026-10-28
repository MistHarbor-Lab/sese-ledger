// ===== 账本核心：行式内存模型 =====
//
// 内存权威 = 行式模型（无 SQL 引擎、无 WASM）：Table{headers, rows: Map<rowId, cells>}。
// - row_id 稳定自增不复用（高水位线）；
// - **表/列一律中文名**（唯一口径）：表寻址两路（中文名 / uid），列寻址＝中文表头精确匹配
//   （迁移边界的历史改名由 migrator 在数据进入账本前对齐，运行时不认第二套名字）；
// - 投影 exportTableAsJson 旧形状零成本等价（兼容锚：sheet_<uid> 键 + content[][] + row_id 首列）。

import type { ExportConfig, LedgerGroupDef, LedgerOp, LedgerSheetDef, SheetJson, SourceData, UpdateConfig, WorkbookJson } from './types';
import type { LedgerTableBlockConfig } from './ai-request';
import { buildDdlFromDef, clampSingleUnique, ddlInfoFromDef, ddlInfoFromParsed, parseDdl, type DdlInfo } from './constraints';

export interface TableModel {
  tableId: string;
  name: string;
  headers: string[];
  ddlInfo: DdlInfo | null;
  orderNo: number;
  sourceData: SourceData;
  updateConfig: UpdateConfig;
  exportConfig: ExportConfig;
  seedRows?: string[][];
  /** rowId → 行单元格（对齐 headers，含首列 row_id 位）。 */
  rows: Map<number, string[]>;
  rowIdHighWater: number;
  /** v2 表定义（v1 表为 null；有无此定义即 v2/v1 判据）。 */
  v2def: LedgerSheetDef | null;
}

export interface BookModel {
  mate: Record<string, unknown>;
  tables: Map<string, TableModel>;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map((c) => (c === null || c === undefined ? '' : String(c))) : [];
}

export const LEDGER_GROUPS_MATE_KEY = 'ledgerGroups';

/** 读取 book 级 v2 分组注册表（mate.ledgerGroups；缺失时空数组）。 */
export function groupsOf(book: BookModel): LedgerGroupDef[] {
  const raw = (book.mate as any)?.[LEDGER_GROUPS_MATE_KEY];
  return Array.isArray(raw) ? raw.filter((g) => g && typeof g === 'object') : [];
}

/** 写 book 级分组注册表（同组 id 覆盖）。 */
export function setGroupsOf(book: BookModel, groups: LedgerGroupDef[]): void {
  (book.mate as any)[LEDGER_GROUPS_MATE_KEY] = groups.map((g) => ({ ...g }));
}

export function findGroup(groups: LedgerGroupDef[], id: number): LedgerGroupDef | undefined {
  return groups.find((g) => Number(g.id) === Number(id));
}

/** 「停用组」判定（分组频率 0 的三条规则单出口）：
 *  组内表 ① 不自动更新（原有语义）② 不参与任何填表（自动 / 手动 / 定向重填）③ **不注入世界书**（无视表自己的
 *  worldbook.enabled 选项——选项本身保留，挪回频率 >0 的分组即原样恢复）。
 *  口径＝updateConfigFromDef 的同一处 clamp；**组缺失不算停用**（表回落全局默认频率）。 */
export function isStoppedGroup(g: LedgerGroupDef | null | undefined): boolean {
  if (!g) return false;
  return Math.max(0, Math.trunc(Number(g.frequency) || 0)) === 0;
}

/** 表是否在停用组。口径＝合成值 `updateConfig.updateFrequency`（与 computeUpdatePlan / pickManualTables 同源；
 *  组缺失合成 -1 ⇒ 非停用）。**停用判定只此一处**：lens 注入、手动填表选表、面板显示都读它。 */
export function isStoppedTable(t: TableModel): boolean {
  return Number(t.updateConfig?.updateFrequency) === 0;
}

/** v2 → 旧形状 sourceData（DDL 自生成；note/三框来自 def）。 */
function sourceDataFromDef(def: LedgerSheetDef): SourceData {
  const t = def.triggerNotes || {};
  return {
    note: String(def.note || ''),
    insertNode: String(t.insert || ''),
    updateNode: String(t.update || ''),
    deleteNode: String(t.delete || ''),
    ddl: buildDdlFromDef(def),
  };
}

/** v2 → 旧形状 exportConfig（纪要特殊形态用冻结配置；普通表 = 标签包裹形态（含注入方式与插入位置））。 */
export function exportConfigFromDef(def: LedgerSheetDef): ExportConfig {
  if (def.lensForm === 'summary' && def.frozenExport) return { ...def.frozenExport, enabled: def.worldbook.enabled !== false };
  const wrapTag = String(def.worldbook.wrapTag || defaultWrapTagOf(def.name));
  return {
    enabled: def.worldbook.enabled === true,
    splitByRow: true,
    entryName: def.name,
    entryType: def.worldbook.mode === 'constant' ? 'constant' : 'keyword',
    keywords: String(def.worldbook.keywordsColumn || ''),
    preventRecursion: true,
    injectionTemplate: wrapTag ? `<${wrapTag}>\n$1\n</${wrapTag}>` : '$1',
    extraIndexEnabled: false,
    ...(def.worldbook.placement ? { entryPlacement: { ...def.worldbook.placement } } : {}),
  };
}

/** 包裹标签默认名 = 表名本身（自解释：`<重要角色表-王二>`）。 */
export function defaultWrapTagOf(tableName: string): string {
  const n = String(tableName || '').trim();
  return n || 'data';
}

/** 人物关系表表名（引擎特判：条目名/包裹标签＝`人物关系表：A与B的关系`，内容不再重复两列人名）。 */
export const RELATION_TABLE_NAME = '人物关系表';

/** 特殊形态表（引擎特判名称与条目形态；工作台标特殊符号并禁删）：
 *  - `summary`＝纪要表（lensForm='summary'，每行一条目＝`时间跨度|纪要|重要对话` + AM 码 keys，
 *    整组由 `<过往记忆>` / `</过往记忆>` 两条常量标签条目（顺序 9985/9995）包住，行条目顺序 9990；
 *    组头正文带列格式说明）；
 *  - `relation`＝人物关系表（成对条目命名 + 内容去重人名）。 */
export type SpecialTableForm = '' | 'relation' | 'summary';

export function specialFormOf(name: string, def?: LedgerSheetDef | null): SpecialTableForm {
  if (def?.lensForm === 'summary' || String(name || '').trim() === '纪要表') return 'summary';
  if (String(name || '').trim() === RELATION_TABLE_NAME) return 'relation';
  return '';
}

/** 特殊形态表的中文名（工作台展示与提示文案共用）。 */
export function specialFormLabel(form: SpecialTableForm): string {
  return form === 'summary' ? '纪要表' : form === 'relation' ? '人物关系表' : '';
}

/** v2 def + 分组 → 旧形状 updateConfig（调度合成：groupId + 组频率；其余全局默认）。 */
export function updateConfigFromDef(def: LedgerSheetDef, groups: LedgerGroupDef[]): UpdateConfig {
  const g = findGroup(groups, def.groupId);
  return {
    uiSentinel: -1,
    contextDepth: -1,
    updateFrequency: g ? Math.max(0, Math.trunc(Number(g.frequency) || 0)) : -1,
    batchSize: -1,
    skipFloors: -1,
    sendLatestRows: -1,
    groupId: g ? g.id : 1,
    sendRowsSqlTemplate: '',
  };
}

/** 同步全部 v2 表的合成 updateConfig（分组编辑后调用；v1 表不动）。 */
export function syncV2UpdateConfigs(book: BookModel): void {
  const groups = groupsOf(book);
  for (const t of book.tables.values()) {
    if (t.v2def) t.updateConfig = updateConfigFromDef(t.v2def, groups);
  }
}

/** 结构材料化时深拷贝 v2 def：账本里的表结构不能与模板缓存共享同一对象。
 *  否则分组编辑（`t.v2def.groupId = …`）/`clampSingleUnique` 会改到模板本体；G1 的模板解析缓存会把这个污染长期保留。 */
function cloneDef(def: LedgerSheetDef): LedgerSheetDef {
  const wb = def.worldbook;
  return {
    ...def,
    columns: (def.columns || []).map((c) => ({ ...c })),
    triggerNotes: def.triggerNotes ? { ...def.triggerNotes } : def.triggerNotes,
    worldbook: wb ? {
      ...wb,
      ...(wb.placement ? { placement: { ...wb.placement } } : {}),
      ...(wb.overview ? { overview: { ...wb.overview, columns: Array.isArray(wb.overview.columns) ? wb.overview.columns.slice() : wb.overview.columns } } : {}),
    } : wb,
    seedRows: def.seedRows ? def.seedRows.map((r) => r.slice()) : def.seedRows,
    frozenExport: def.frozenExport
      ? { ...def.frozenExport, ...(def.frozenExport.entryPlacement ? { entryPlacement: { ...def.frozenExport.entryPlacement } } : {}) }
      : def.frozenExport,
  };
}

/** 把 v2 def 套到既有表上（表头/行数据由调用方协调；此处只同步派生元信息）。 */
export function applyV2DefToTable(table: TableModel, def: LedgerSheetDef | null): void {
  const next = def ? cloneDef(def) : null;
  table.v2def = next;
  if (!next) return;
  clampSingleUnique(next); // 唯一列单选：结构材料化时收敛（旧数据/外部改动带进多列唯一一律保留首列）
  table.ddlInfo = ddlInfoFromDef(next);
  table.sourceData = sourceDataFromDef(next);
  table.exportConfig = exportConfigFromDef(next);
  table.name = next.name || table.name;
  table.orderNo = Number.isFinite(Number(next.orderNo)) ? Number(next.orderNo) : table.orderNo;
}

/** 从旧形状 SheetJson 建行式表模型（模板/迁移/sheet_replace 共用入口）。 */
export function createTableModel(sheetKey: string, sheet: SheetJson): TableModel {
  const content = Array.isArray(sheet.content) ? sheet.content : [];
  const def = sheet.ledgerV2 && Array.isArray(sheet.ledgerV2.columns) ? sheet.ledgerV2 : null;
  const headers = asStringArray(content[0]);
  let ddlInfo: DdlInfo | null;
  let sourceData: SourceData;
  let v2def: LedgerSheetDef | null = null;
  if (def) {
    v2def = cloneDef(def);
    ddlInfo = ddlInfoFromDef(v2def);
    sourceData = sourceDataFromDef(v2def);
  } else {
    // v1 表：外部 DDL 只在装载期读一次拿约束，读完即弃（不留英文名）
    const parsed = parseDdl(String(sheet.sourceData?.ddl || ''));
    ddlInfo = parsed ? ddlInfoFromParsed(parsed) : null;
    // 说明面缺失也不炸（落盘快照的 v2 表不带它；v1 表理论上恒有）
    sourceData = sheet.sourceData || { note: '', deleteNode: '', updateNode: '', insertNode: '', ddl: '' };
  }
  const rows = new Map<number, string[]>();
  let highWater = 0;
  for (let i = 1; i < content.length; i++) {
    const cells = asStringArray(content[i]);
    const rowId = Number(cells[0]);
    if (!Number.isInteger(rowId) || rowId <= 0) continue;
    while (cells.length < headers.length) cells.push('');
    rows.set(rowId, cells);
    if (rowId > highWater) highWater = rowId;
  }
  return {
    tableId: sheetKey,
    name: String(sheet.name || sheetKey),
    headers,
    ddlInfo,
    orderNo: Number(sheet.orderNo ?? 999),
    sourceData,
    updateConfig: { ...(sheet.updateConfig || {}) },
    exportConfig: v2def ? exportConfigFromDef(v2def) : { ...(sheet.exportConfig || {}) },
    seedRows: sheet.seedRows,
    rows,
    rowIdHighWater: highWater,
    v2def,
  };
}

/** 蓝图/全库 JSON → 行式账本（v2 表同步合成调度配置）。 */
export function createBook(workbook: WorkbookJson): BookModel {
  const book: BookModel = { mate: { ...(workbook.mate as any) }, tables: new Map() };
  for (const key of Object.keys(workbook)) {
    if (!key.startsWith('sheet_')) continue;
    const sheet = workbook[key] as SheetJson;
    if (!sheet || typeof sheet !== 'object') continue;
    book.tables.set(key, createTableModel(key, sheet));
  }
  syncV2UpdateConfigs(book);
  return book;
}

// ===== 寻址 =====

export function resolveTable(book: BookModel, nameOrKey: string): TableModel | null {
  if (!nameOrKey) return null;
  const key = String(nameOrKey).trim();
  const direct = book.tables.get(key);
  if (direct) return direct;
  for (const t of book.tables.values()) {
    if (t.name === key) return t;
  }
  return null;
}

/** 列寻址（中文表头精确匹配）→ 列下标；-1=未命中。 */
export function resolveColumn(table: TableModel, name: string): number {
  const raw = String(name || '').trim();
  if (!raw) return -1;
  return table.headers.indexOf(raw);
}

export function allocateRowId(table: TableModel): number {
  table.rowIdHighWater += 1;
  return table.rowIdHighWater;
}

/** 表数据块取值（推进固定块；纯函数、无缓存）：
 *  - 给了 行定位列 + 定位值 → 取该行；再给取值列则只取该列（为空即「取不到」）；
 *  - 不给定位（或定位列/值任一为空）→ 整表投影（表头 + 各行，| 拼接）；
 *  - 表/行/列不存在、值或表为空 → 返回 ''（调用方据此整块不出条）。 */
export function readTableBlockValue(book: BookModel, cfg: LedgerTableBlockConfig | undefined | null): string {
  const table = cfg?.table ? resolveTable(book, cfg.table) : null;
  if (!table) return '';
  const label = String(cfg?.label || '').trim() || String(cfg?.valueColumn || '').trim() || table.name;
  const heading = `【${label}】`;
  const keyCol = String(cfg?.matchColumn || '').trim();
  const keyVal = String(cfg?.matchValue ?? '').trim();
  if (keyCol && keyVal) {
    const keyIdx = resolveColumn(table, keyCol);
    if (keyIdx < 0) return '';
    const row = [...table.rows.keys()].sort((a, b) => a - b)
      .map((rowId) => table.rows.get(rowId)!)
      .find((cells) => String(cells[keyIdx] ?? '').trim() === keyVal);
    if (!row) return '';
    const valueCol = String(cfg?.valueColumn || '').trim();
    if (valueCol) {
      const valueIdx = resolveColumn(table, valueCol);
      if (valueIdx < 0) return '';
      const value = String(row[valueIdx] ?? '').trim();
      return value ? `${heading}\n${value}` : '';
    }
    const line = row.map((cell) => String(cell ?? '')).join('|').trim();
    return line ? `${heading}\n${line}` : '';
  }
  const lines: string[] = [table.headers.join('|')];
  for (const rowId of [...table.rows.keys()].sort((a, b) => a - b)) {
    lines.push(table.rows.get(rowId)!.map((cell) => String(cell ?? '')).join('|'));
  }
  return lines.length > 1 ? `${heading}\n${lines.join('\n')}` : '';
}

// ===== 数据库注入语法：`{[db.表.where('列','值').get('列')]}` =====
//
// 真数据库插件在提示词文本里解析这类占位符（`replaceDbSqlVariables`；填表与推进入口都会跑），
// 台账的提示词素材（表说明 / 触发提示 / 填表提示词段）同样解析——否则 AI 只会看到占位符原文，
// 「全局数据表 → 已探索地点概览」这条链就断了（本表 note 里就有该占位符）。
// 支持子集（与插件同口径的常用形态）：
//   db.<表名>.where('列','值')*.orderBy('列'[,'DESC'|'ASC'])?.limit(n)?.offset(n)? → get('列') / list('列') / all() / count()
// 规范：取不到（表/列缺失、行不存在、值为空）→ 注入「（无记录）」；**解析不了（形态超出子集）→ 原样保留占位符**（不静默吞内容）。

/** 占位符外形：`{[ db. … ]}`（跨行安全；非贪婪到最近的 `]}`）。 */
const DB_PLACEHOLDER_RE = /\{\[\s*db\.[\s\S]*?\]\}/g;

interface DbCall { name: string; args: string[] }

/** `db.表.where('a','b').get('c')` → { table:'表', calls:[{name:'where',args:['a','b']},…] }；解析失败返回 null。 */
function parseDbExpression(expr: string): { table: string; calls: DbCall[] } | null {
  const text = String(expr || '').trim();
  if (!/^db\./.test(text)) return null;
  let i = 3;
  // 表名：到下一个 '.' 或 '(' 为止（中文表名天然可用；不含点）
  let table = '';
  while (i < text.length && text[i] !== '.' && text[i] !== '(') table += text[i++];
  table = table.trim();
  if (!table) return null;
  const calls: DbCall[] = [];
  while (i < text.length) {
    if (text[i] !== '.') return null;
    i += 1;
    let name = '';
    while (i < text.length && /[A-Za-z_]/.test(text[i])) name += text[i++];
    if (!name) return null;
    while (i < text.length && /\s/.test(text[i])) i += 1;
    if (text[i] !== '(') return null;
    i += 1;
    const args: string[] = [];
    let current = '';
    let quoted: string | null = null;
    let closed = false;
    for (; i < text.length; i += 1) {
      const ch = text[i];
      if (quoted) {
        if (ch === quoted) {
          if (text[i + 1] === quoted) { current += ch; i += 1; continue; } // 引号内 '' 转义
          quoted = null;
          continue;
        }
        current += ch;
        continue;
      }
      if (ch === "'" || ch === '"') { quoted = ch; continue; }
      if (ch === ',') { args.push(current.trim()); current = ''; continue; }
      if (ch === ')') { closed = true; i += 1; break; }
      current += ch;
    }
    if (!closed) return null;
    if (current.trim() || args.length > 0) args.push(current.trim());
    calls.push({ name: name.toLowerCase(), args });
  }
  return calls.length > 0 ? { table, calls } : null;
}

/** 求值单个占位符：返回注入文本；`null` = 解析不了（调用方原样保留）。 */
function resolveDbPlaceholder(book: BookModel, placeholder: string): string | null {
  const inner = placeholder.replace(/^\{\[\s*/, '').replace(/\]\}$/, '');
  const parsed = parseDbExpression(inner);
  if (!parsed) return null;
  const table = resolveTable(book, parsed.table);
  if (!table) return `（未找到表「${parsed.table}」）`;
  const sortedRowIds = (): number[] => [...table.rows.keys()].sort((a, b) => a - b);
  let rowIds = sortedRowIds();
  const cellOf = (rowId: number, column: string): string | null => {
    const idx = resolveColumn(table, column);
    if (idx < 0) return null;
    return String(table.rows.get(rowId)?.[idx] ?? '').trim();
  };
  for (let c = 0; c < parsed.calls.length; c += 1) {
    const call = parsed.calls[c];
    const last = c === parsed.calls.length - 1;
    if (call.name === 'where') {
      if (call.args.length < 2) return null;
      const [col, val] = call.args;
      const idx = resolveColumn(table, col);
      if (idx < 0) return `（未找到列「${col}」）`;
      rowIds = rowIds.filter((rowId) => String(table.rows.get(rowId)?.[idx] ?? '').trim() === val.trim());
      continue;
    }
    if (call.name === 'orderby') {
      if (call.args.length < 1) return null;
      const idx = resolveColumn(table, call.args[0]);
      if (idx < 0) return `（未找到列「${call.args[0]}」）`;
      const desc = String(call.args[1] || '').toUpperCase() === 'DESC';
      rowIds = [...rowIds].sort((a, b) => {
        const av = String(table.rows.get(a)?.[idx] ?? '');
        const bv = String(table.rows.get(b)?.[idx] ?? '');
        return desc ? (av < bv ? 1 : av > bv ? -1 : a - b) : (av < bv ? -1 : av > bv ? 1 : a - b);
      });
      continue;
    }
    if (call.name === 'limit' || call.name === 'offset') {
      const n = Math.max(0, Math.trunc(Number(call.args[0])));
      if (!Number.isFinite(n)) return null;
      rowIds = call.name === 'limit' ? rowIds.slice(0, n) : rowIds.slice(n);
      continue;
    }
    if (!last) return null; // 终结方法必须在链尾
    if (call.name === 'count') return String(rowIds.length);
    if (call.name === 'get') {
      if (call.args.length < 1) return null;
      const rowId = rowIds[0];
      if (rowId === undefined) return '（无记录）';
      const value = cellOf(rowId, call.args[0]);
      if (value === null) return `（未找到列「${call.args[0]}」）`;
      return value || '（无记录）';
    }
    if (call.name === 'list') {
      if (call.args.length < 1) return null;
      const values: string[] = [];
      for (const rowId of rowIds) {
        const value = cellOf(rowId, call.args[0]);
        if (value === null) return `（未找到列「${call.args[0]}」）`;
        if (value) values.push(value);
      }
      return values.length > 0 ? values.join('、') : '（无记录）';
    }
    if (call.name === 'all') {
      if (rowIds.length === 0) return '（无记录）';
      const lines: string[] = [table.headers.join('|')];
      for (const rowId of rowIds) lines.push(table.rows.get(rowId)!.map((cell) => String(cell ?? '')).join('|'));
      return lines.join('\n');
    }
    return null; // 未支持的终结方法（如 value('SQL 表达式')）→ 原样保留
  }
  return null; // 无终结方法
}

/** 展开提示词素材里的 `{[db…]}` 占位符（表说明 / 触发提示 / 填表提示词段共用）。
 *  可解析 → 注入值（空结果注入「（无记录）」）；不可解析 → 原样保留（保证任何素材都不会被静默吞掉）。 */
export function expandTablePlaceholders(book: BookModel | null | undefined, text: string): string {
  const raw = String(text ?? '');
  if (!book || !raw.includes('{[db.')) return raw;
  return raw.replace(DB_PLACEHOLDER_RE, (match) => {
    try {
      const value = resolveDbPlaceholder(book, match);
      return value === null ? match : value;
    } catch (_e) {
      return match;
    }
  });
}

// ===== 投影（旧形状，兼容锚） =====

/**
 * 单表投影为旧形状 SheetJson。
 * `forStorage` ＝ 落盘快照专用：v2 表**不带 sourceData**（笔记/三框与 `ledgerV2` 逐字重复，占快照约 36%）。
 * 为什么不影响行为：装载时 v2 表一律走 `createTableModel` 的 def 分支（`sourceData = sourceDataFromDef(def)`，
 * 快照里那份**根本不读**），装载后 `convergeBookToTemplate` 又用绑定模板覆盖 sourceData/v2def。
 * v1 表（无 ledgerV2）的 sourceData 装载时要读（DDL/说明），任何模式下都保留。
 */
export function projectSheet(table: TableModel, opts?: { forStorage?: boolean }): SheetJson {
  const content: string[][] = [table.headers.slice()];
  for (const rowId of [...table.rows.keys()].sort((a, b) => a - b)) {
    content.push(table.rows.get(rowId)!.slice());
  }
  const sheet: SheetJson = {
    uid: table.tableId,
    name: table.name,
    content,
    updateConfig: { ...table.updateConfig },
    exportConfig: { ...table.exportConfig },
    orderNo: table.orderNo,
  };
  if (!(opts?.forStorage && table.v2def)) sheet.sourceData = table.sourceData;
  if (table.seedRows) sheet.seedRows = table.seedRows;
  if (table.v2def) sheet.ledgerV2 = { ...table.v2def, columns: table.v2def.columns.map((c) => ({ ...c })) };
  return sheet;
}

/** exportTableAsJson 同形状全量投影（同步返回，兼容面/canonical 共用；v2 分组随 mate 携带）。
 *  `forStorage` 只用于落盘快照（见 projectSheet）；导出/面板/时光机视图一律走默认（带 sourceData 的完整旧形状）。 */
export function projectWorkbook(book: BookModel, opts?: { forStorage?: boolean }): WorkbookJson {
  const out: WorkbookJson = { mate: { ...(book.mate as any) } };
  const ordered = [...book.tables.values()].sort((a, b) => a.orderNo - b.orderNo || a.tableId.localeCompare(b.tableId));
  for (const t of ordered) out[t.tableId] = projectSheet(t, opts);
  return out;
}

// ===== 表内容签名（真实 diff 校准用：防空洞记账条目） =====

export function tableSignature(table: TableModel): string {
  const parts: string[] = [];
  for (const rowId of [...table.rows.keys()].sort((a, b) => a - b)) {
    parts.push(rowId + ':' + JSON.stringify(table.rows.get(rowId)));
  }
  return parts.join('|');
}

export function workbookSignatures(book: BookModel): Map<string, string> {
  const map = new Map<string, string>();
  for (const t of book.tables.values()) map.set(t.tableId, tableSignature(t));
  return map;
}

/** 签名比对 → 真实发生变化的表清单。 */
export function diffChangedTables(book: BookModel, before: Map<string, string>): string[] {
  const changed: string[] = [];
  for (const t of book.tables.values()) {
    if (before.get(t.tableId) !== tableSignature(t)) changed.push(t.tableId);
  }
  return changed;
}

// ===== 记账操作应用（引擎级；严格校验在 scribe 层） =====

export interface ApplyOpResult { ok: boolean; error?: string; rowId?: number }

function emptyRow(table: TableModel, rowId: number): string[] {
  const cells = new Array(table.headers.length).fill('');
  cells[0] = String(rowId);
  return cells;
}

/** 应用单条原生操作（就地修改）。SQL 桥/迁移/前端写共用。 */
export function applyOp(book: BookModel, op: LedgerOp): ApplyOpResult {
  switch (op.kind) {
    case 'data_replace': {
      const fresh = createBook(op.data || {});
      book.mate = fresh.mate;
      book.tables = fresh.tables;
      return { ok: true };
    }
    case 'sheet_replace': {
      if (!op.table || !op.sheet) return { ok: false, error: 'sheet_replace 缺少表' };
      book.tables.set(op.table, createTableModel(op.table, op.sheet));
      return { ok: true };
    }
  }
  const table = resolveTable(book, op.table);
  if (!table) return { ok: false, error: `未找到表「${op.table}」` };
  switch (op.kind) {
    case 'cell': {
      const idx = resolveColumn(table, op.column);
      if (idx < 0) return { ok: false, error: `表「${table.name}」不存在列「${op.column}」` };
      if (idx === 0) return { ok: false, error: `表「${table.name}」的 row_id 列禁改` };
      const cells = table.rows.get(op.rowId);
      if (!cells) return { ok: false, error: `表「${table.name}」不存在 row_id=${op.rowId} 的行` };
      cells[idx] = op.value === null || op.value === undefined ? '' : String(op.value);
      return { ok: true };
    }
    case 'row_insert': {
      const limit = table.ddlInfo?.maxRowCount || 0;
      if (limit > 0 && table.rows.size >= limit) {
        return { ok: false, error: `表「${table.name}」为固定 ${limit} 行表，禁止增行` };
      }
      const rowId = allocateRowId(table);
      const cells = emptyRow(table, rowId);
      for (const [col, value] of Object.entries(op.row || {})) {
        const idx = resolveColumn(table, col);
        if (idx > 0) cells[idx] = value === null || value === undefined ? '' : String(value);
      }
      table.rows.set(rowId, cells);
      return { ok: true, rowId };
    }
    case 'row_upsert': {
      const limit = table.ddlInfo?.maxRowCount || 0;
      let rowId = op.rowId;
      if (rowId === null || rowId === undefined || !Number.isInteger(Number(rowId)) || Number(rowId) <= 0) {
        if (limit > 0 && table.rows.size >= limit) {
          return { ok: false, error: `表「${table.name}」为固定 ${limit} 行表，禁止增行` };
        }
        rowId = allocateRowId(table);
      } else {
        rowId = Number(rowId);
        if (rowId > table.rowIdHighWater) table.rowIdHighWater = rowId;
      }
      const cells = emptyRow(table, rowId);
      const src = op.cells || [];
      for (let i = 1; i < table.headers.length && i < src.length + 1; i++) {
        cells[i] = src[i] === null || src[i] === undefined ? '' : String(src[i]);
      }
      table.rows.set(rowId, cells);
      return { ok: true, rowId };
    }
    case 'row_delete': {
      if (!table.rows.delete(op.rowId)) return { ok: false, error: `表「${table.name}」不存在 row_id=${op.rowId} 的行` };
      return { ok: true };
    }
    case 'meta': {
      const m = op.meta || {};
      if (m.name !== undefined) table.name = String(m.name);
      if (m.orderNo !== undefined) table.orderNo = Number(m.orderNo);
      if (m.updateConfig) table.updateConfig = { ...table.updateConfig, ...m.updateConfig };
      if (m.exportConfig) table.exportConfig = { ...table.exportConfig, ...m.exportConfig };
      if (m.sourceData) {
        table.sourceData = {
          ...table.sourceData,
          ...m.sourceData,
          // ddl 禁改（对齐原库 meta_update 语义）
          ddl: table.sourceData.ddl,
        };
      }
      return { ok: true };
    }
  }
  return { ok: false, error: `未知操作 ${(op as LedgerOp).kind}` };
}

/** 条目集合重放（seq 升序；锚点过滤由调用方先做——floor-scope 职责）。 */
export function replayEntries(book: BookModel, entries: { ops: LedgerOp[] }[]): void {
  for (const entry of entries) {
    for (const op of entry.ops || []) applyOp(book, op);
  }
}
