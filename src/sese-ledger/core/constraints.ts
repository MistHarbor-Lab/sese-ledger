// ===== 蓝图约束层：外部 DDL 读取（仅导入期） + TS 校验器 + 紧凑约束行 =====
//
// 台账自身的表/列**只用中文名**：v2 列定义不含英文物理名，运行时也不解析英文名。
// parseDdl 只服务「读外部模板/旧账本」这一件事——标准模板（docs/色色灵感数据库模板V*.json）
// 与存量 v1 账本带的是英文 DDL，导入时读一次拿列顺序/必填/唯一/行数上限，读完即弃
// （不落库、不参与寻址、不进运行时）。

import { parseDdlCheckRules, type DdlCheckRules } from '../../unified-statusbar/core/db-ddl-check-parser';
import type { LedgerSheetDef } from './types';

/** 外部 DDL 解析出的列（含英文物理名；只在导入期存在）。 */
export interface ParsedDdlColumn {
  physical: string;
  header: string;
  type: string;
  notNull: boolean;
  unique: boolean;
}

export interface ParsedDdl {
  physicalTable: string;
  headerName: string;
  columns: ParsedDdlColumn[];
  /** row_id CHECK 推出的行数上限（CHECK(row_id=1)→1；BETWEEN 1 AND N→N）。 */
  maxRowCount: number;
  checkRules: DdlCheckRules;
}

/** 无注释行里会被误当列的表级约束开头关键字（只对缺注释行生效）。 */
const DDL_CONSTRAINT_KEYWORDS = new Set(['PRIMARY', 'FOREIGN', 'UNIQUE', 'CHECK', 'CONSTRAINT', 'KEY', 'INDEX', 'REFERENCES']);

/** 解析 `CREATE TABLE 物理名 ( -- 中文表名` + 行尾 `-- 中文列名` 注释形态的 DDL。
 *  模板 DDL 全部符合该形态（行级对齐）；不认识的行跳过不抛。
 *  注释可缺省：外部库「保留列重建」重写的 DDL 会省掉 row_id（及 header==物理名 的列）的行尾注释，
 *  此时按物理名作占位表头（否则该行会被跳过、列数与表头错位——真实迁移事故形态）。 */
export function parseDdl(ddl: string): ParsedDdl | null {
  const text = String(ddl || '');
  const head = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`\[]?([A-Za-z_][\w]*)["'`\]]?\s*\((.*)$/i.exec(
    text.split('\n')[0] || '',
  );
  if (!head) return null;
  const headerComment = /--\s*(.*?)\s*$/.exec(text.split('\n')[0]);
  const columns: ParsedDdlColumn[] = [];
  let maxRowCount = 0;
  const lines = text.split('\n').slice(1);
  for (const rawLine of lines) {
    const commentMatch = /--\s*(.*?)\s*$/.exec(rawLine);
    const header = commentMatch?.[1]?.trim() || '';
    const def = rawLine.replace(/--[^]*$/, '').trim().replace(/[,;]\s*$/, '').trim();
    if (!def || def === ');' || def === ')') continue;
    const nameMatch = /^["'`\[]?([A-Za-z_]\w*)["'`\]]?\s+([A-Za-z]+(?:\s*\([^)]*\))?)/.exec(def);
    if (!nameMatch) continue;
    const physical = nameMatch[1];
    if (!header && DDL_CONSTRAINT_KEYWORDS.has(physical.toUpperCase())) continue;
    const type = nameMatch[2].replace(/\s+/g, '');
    const notNull = /NOT\s+NULL/i.test(def);
    const unique = /\bUNIQUE\b/i.test(def);
    // 主键列的中文名恒归一为 row_id（引擎维护，DDL 注释里写「行号」等一律不采信）
    columns.push({ physical, header: physical === 'row_id' ? 'row_id' : (header || physical), type, notNull, unique });
    if (physical === 'row_id') {
      const eq = /row_id\s*=\s*(\d+)/i.exec(def);
      if (eq) maxRowCount = Math.max(maxRowCount, Number(eq[1]));
      const between = /row_id\s+BETWEEN\s+(\d+)\s+AND\s+(\d+)/i.exec(def);
      if (between) maxRowCount = Math.max(maxRowCount, Number(between[2]));
    }
  }
  if (columns.length === 0) return null;
  const headers = columns.map((c) => c.header);
  return {
    physicalTable: head[1],
    headerName: headerComment?.[1] || '',
    columns,
    maxRowCount,
    checkRules: parseDdlCheckRules(text, headers),
  };
}

// ===== v2：约束 / DDL 由列定义自生成（不存 DDL 原文，也不存英文名） =====

/** 运行时约束列（中文列名口径；无物理名）。 */
export interface DdlColumn {
  header: string;
  type: string;
  notNull: boolean;
  unique: boolean;
}

export interface DdlInfo {
  columns: DdlColumn[];
  /** row_id CHECK 推出的行数上限（v2 由 def.maxRowCount 保留）。 */
  maxRowCount: number;
  checkRules: DdlCheckRules;
}

/** 唯一列单选口径：一表至多一列 unique（保留首个，其余清除）。返回被清除的列名（空=无变化）。
 *  动机：多列唯一会让「INSERT 撞唯一列 → 转更新」的目标行不确定；收敛统一由这一处裁决。
 *  （放 constraints 而非 blueprint：book.ts 需要它做结构材料化兜底，而 blueprint→book 已单向依赖，此处可双向复用。） */
export function clampSingleUnique(def: LedgerSheetDef): string[] {
  const dropped: string[] = [];
  let seen = false;
  for (const col of def.columns || []) {
    if (col.unique !== true) continue;
    if (seen) { col.unique = false; dropped.push(String(col.header || '')); }
    else seen = true;
  }
  return dropped;
}

/** 外部 DDL → 运行时约束（丢物理名；v1 账本装载用）。 */
export function ddlInfoFromParsed(parsed: ParsedDdl): DdlInfo {
  return {
    columns: parsed.columns.map((c) => ({ header: c.header, type: c.type, notNull: c.notNull, unique: c.unique })),
    maxRowCount: parsed.maxRowCount,
    checkRules: parsed.checkRules,
  };
}

/** v2 列定义 → DdlInfo（枚举/范围/长度分支恒空——v2 只有 text+唯一+必填；maxRowCount 保留 row_id CHECK 语义）。 */
export function ddlInfoFromDef(def: LedgerSheetDef): DdlInfo {
  const columns: DdlColumn[] = [
    { header: 'row_id', type: 'INTEGER', notNull: true, unique: false },
    ...def.columns.map((c) => ({ header: c.header, type: 'TEXT', notNull: c.notNull === true, unique: c.unique === true })),
  ];
  // 唯一列单选（引擎边界兜底）：一表至多一列 unique，保留首个——多列唯一会让「INSERT 撞唯一 → 转更新」目标不确定。
  let seenUnique = false;
  for (const c of columns) {
    if (!c.unique) continue;
    if (seenUnique) c.unique = false;
    else seenUnique = true;
  }
  return {
    columns,
    maxRowCount: Math.max(0, Math.trunc(Number(def.maxRowCount) || 0)),
    checkRules: { enums: [], ranges: [], maxLength: [], minLength: [] },
  };
}

/** v2 列定义 → DDL 原文（表名/列名一律中文；投影给旧消费方看形状用，引擎自己不解析）。 */
export function buildDdlFromDef(def: LedgerSheetDef): string {
  const tableName = String(def.name || def.tableId || '台账表');
  const lines: string[] = [`CREATE TABLE ${tableName} ( -- ${tableName}`];
  const rowIdConstraint = def.maxRowCount && def.maxRowCount > 0 ? ` CHECK (row_id BETWEEN 1 AND ${def.maxRowCount})` : '';
  lines.push(`  row_id INTEGER PRIMARY KEY${rowIdConstraint}, -- row_id`);
  def.columns.forEach((c, i) => {
    const constraints = [c.notNull ? ' NOT NULL' : '', c.unique ? ' UNIQUE' : ''].join('');
    lines.push(`  ${c.header} TEXT${constraints}${i < def.columns.length - 1 ? ',' : ''} -- ${c.header}`);
  });
  lines.push(');');
  return lines.join('\n');
}

function ruleFor(rules: DdlCheckRules, header: string) {
  return {
    enumRule: rules.enums.find((r) => r.columnName === header),
    range: rules.ranges.find((r) => r.columnName === header),
    maxLength: rules.maxLength.find((r) => r.columnName === header)?.maxLength,
    minLength: rules.minLength.find((r) => r.columnName === header)?.minLength,
  };
}

export interface ColumnValidator {
  header: string;
  notNull: boolean;
  unique: boolean;
  isRowId: boolean;
  enumValues?: string[];
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  numeric: boolean;
}

/** 从 DdlInfo 构建运行时校验器集合（按中文表头键）。 */
export function buildValidators(ddlInfo: DdlInfo): Map<string, ColumnValidator> {
  const map = new Map<string, ColumnValidator>();
  for (const col of ddlInfo.columns) {
    const r = ruleFor(ddlInfo.checkRules, col.header);
    const t = col.type.toUpperCase();
    map.set(col.header, {
      header: col.header,
      notNull: col.notNull,
      unique: col.unique,
      isRowId: col.header === 'row_id',
      enumValues: r.enumRule?.values,
      min: r.range?.min ?? r.range?.minExclusive,
      max: r.range?.max ?? r.range?.maxExclusive,
      minLength: r.minLength,
      maxLength: r.maxLength,
      numeric: t.startsWith('INT') || t.startsWith('REAL') || t.startsWith('NUMERIC') || t.startsWith('FLOAT'),
    });
  }
  return map;
}

const BLANK_RE = /^(|无|-|—|null|NULL)$/;

/** 校验单值；返回错误清单（空数组=通过）。value 统一为字符串形态。 */
export function validateValue(validator: ColumnValidator | undefined, header: string, value: string): string[] {
  if (!validator || validator.isRowId) return [];
  const errors: string[] = [];
  const blank = value === undefined || value === null || BLANK_RE.test(String(value));
  if (validator.notNull && blank) {
    return [`列「${header}」为必填列，不能留空（无内容时也要给出合理值）`];
  }
  if (blank) return [];
  const text = String(value);
  if (validator.enumValues && !validator.enumValues.includes(text)) {
    errors.push(`列「${header}」只能是：${validator.enumValues.join(' / ')}（收到 "${text.slice(0, 30)}"）`);
  }
  if (validator.numeric) {
    const num = Number(text);
    if (!Number.isFinite(num)) {
      errors.push(`列「${header}」必须是数字（收到 "${text.slice(0, 30)}"）`);
    } else {
      if (validator.min !== undefined && num < validator.min) errors.push(`列「${header}」不能小于 ${validator.min}`);
      if (validator.max !== undefined && num > validator.max) errors.push(`列「${header}」不能大于 ${validator.max}`);
    }
  }
  if (validator.maxLength !== undefined && text.length > validator.maxLength) {
    errors.push(`列「${header}」长度不能超过 ${validator.maxLength} 字（收到 ${text.length} 字）`);
  }
  if (validator.minLength !== undefined && text.length < validator.minLength) {
    errors.push(`列「${header}」长度不能少于 ${validator.minLength} 字`);
  }
  return errors;
}
