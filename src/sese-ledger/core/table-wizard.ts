// ===== 建表向导 =====
//
// 一句话描述 → AI 产出 v2 单表定义（严格 JSON schema 校验 + 错误回注重试，沿用填表协议纠错模式）
// → convergeBookToTemplate 引入（新表/新列补空/改名认领/模板外丢弃）→ 模板库可选存回。
// 模式：新建（一句话描述）/ 修改（选现有表 + 修改要求）；参考注入 = 现有表结构摘要（对齐数据库"参考表格注入范围"）。
import type { BookModel, TableModel } from './book';
import { clampSingleUnique } from './blueprint';
import type { LedgerSheetDef, LedgerTemplateV2 } from './types';
import type { DriverPromptMessage } from './director';

export interface WizardInput {
  mode: 'create' | 'modify';
  /** 新建：一句话描述；修改：修改要求。 */
  description: string;
  /** 修改模式的目标表名。 */
  targetTable?: string;
  /** 参考注入：true=现有表结构摘要。 */
  includeStructure: boolean;
}

const WIZARD_SYSTEM_PROMPT = [
  '你是表格结构设计师。根据用户的描述输出一张数据表的 JSON 定义，不要输出任何解释、markdown 代码块或多余文字。',
  '输出必须是单个 JSON 对象，schema 如下：',
  '{',
  '  "name": "表名（中文，以「表」字结尾）",',
  '  "columns": [ { "header": "列名（中文）", "unique": false, "notNull": true } ],',
  '  "readMode": "all | trigger | none",',
  '  "note": "表说明（一句话）",',
  '  "triggerNotes": { "insert": "增行时机", "update": "改格时机", "delete": "删行时机" },',
  '  "worldbook": { "enabled": false, "mode": "constant | keyword", "keywordsColumn": "列名（启用时必填；同时是「按触发」判定用的关键词列）", "wrapTag": "英文标签名", "placement": { "position": "before_character_definition | at_depth_as_system", "depth": 2, "order": 10000 } }',
  '}',
  '硬性要求：',
  '1. 首列建议 unique=true 且 notNull=true（新增行查重依据）。**整张表最多只能有一列 unique=true**（多列一律只保留首列）。',
  '2. 列名一律中文、不可重复、不得用 row_id；全部类型为 text（无枚举/长度/数字限制）。',
  '3. readMode="trigger" 时必须同时启用世界书注入并给 keywordsColumn（关键词列）；不需要 AI 参考数据又不想投影的用 "none"。',
  '4. 修改模式：只改用户提到的部分，未提到的列原样保留。',
].join('\n');

/** 现有表结构摘要（参考注入预览用）。 */
export function buildBookStructureSummary(book: BookModel, limit = 30): string {
  const tables = [...book.tables.values()].sort((a, b) => a.orderNo - b.orderNo).slice(0, limit);
  return tables.map((t) => `- ${t.name}：${t.headers.slice(1).join(' / ')}`).join('\n') || '（当前无表）';
}

/** 组装向导请求（messages 经 canonical.aiRequest 直发：走 1A 传输但无台账固定块）。 */
export function buildWizardMessages(book: BookModel, input: WizardInput): DriverPromptMessage[] {
  const parts: string[] = [];
  if (input.includeStructure) {
    parts.push('【现有表结构摘要（参考命名风格与结构，避免重复造表）】\n' + buildBookStructureSummary(book));
  }
  if (input.mode === 'modify' && input.targetTable) {
    const table = findTableByName(book, input.targetTable);
    if (table) {
      const def = table.v2def;
      const current = def
        ? {
            name: def.name,
            columns: def.columns.map((c) => ({ header: c.header, unique: c.unique, notNull: c.notNull })),
            readMode: def.readMode,
            note: def.note,
            triggerNotes: def.triggerNotes,
            worldbook: { ...def.worldbook },
          }
        : { name: table.name, columns: table.headers.slice(1).map((h) => ({ header: h, unique: false, notNull: false })), readMode: 'all', note: table.sourceData?.note || '' };
      parts.push(`【要修改的表（当前定义，未提到的部分保持原样）】\n${JSON.stringify(current, null, 1)}`);
    }
    parts.push(`【修改要求】\n${input.description}`);
  } else {
    parts.push(`【一句话描述】\n${input.description}`);
  }
  return [
    { role: 'system', content: WIZARD_SYSTEM_PROMPT },
    { role: 'user', content: parts.join('\n\n') },
  ];
}

function findTableByName(book: BookModel, name: string): TableModel | null {
  for (const t of book.tables.values()) {
    if (t.name === name) return t;
  }
  return null;
}

export interface WizardParseResult {
  ok: boolean;
  def: LedgerSheetDef | null;
  errors: string[];
}

/** AI 输出 → v2 单表定义（严格校验；坏输出拒绝并回错误供重试）。 */
export function parseWizardOutput(raw: string, existingTableId?: string): WizardParseResult {
  const errors: string[] = [];
  const text = String(raw || '').trim().replace(/^```[a-zA-Z]*\n?/, '').replace(/```\s*$/, '').trim();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, def: null, errors: [`JSON 解析失败：${e instanceof Error ? e.message : String(e)}`] };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, def: null, errors: ['输出不是 JSON 对象'] };
  }
  const name = String(parsed.name || '').trim();
  if (!name) errors.push('缺少表名（name）');
  const columnsRaw = parsed.columns;
  if (!Array.isArray(columnsRaw) || columnsRaw.length === 0) errors.push('缺少列定义（columns）');
  const seenHeader = new Set<string>();
  const columns: LedgerSheetDef['columns'] = [];
  for (const c of Array.isArray(columnsRaw) ? columnsRaw : []) {
    const header = String(c?.header || '').trim();
    if (!header) { errors.push('存在空列名'); continue; }
    if (header === 'row_id') { errors.push('列名不能用 row_id（主键列由引擎自动维护）'); continue; }
    if (seenHeader.has(header)) { errors.push(`列名「${header}」重复`); continue; }
    seenHeader.add(header);
    columns.push({ header, type: 'text', unique: c?.unique === true, notNull: c?.notNull === true });
  }
  const readMode = String(parsed.readMode || 'all');
  if (!['all', 'trigger', 'none'].includes(readMode)) errors.push(`readMode 非法：${readMode}`);
  const wb = (parsed.worldbook && typeof parsed.worldbook === 'object' ? parsed.worldbook : {}) as any;
  const wbEnabled = wb.enabled === true;
  const wbMode = wb.mode === 'constant' ? 'constant' : 'keyword';
  let keywordsColumn = String(wb.keywordsColumn || '').trim();
  if (keywordsColumn && !columns.some((c) => c.header === keywordsColumn)) {
    errors.push(`worldbook.keywordsColumn「${keywordsColumn}」不在列清单中`);
  }
  if (readMode === 'trigger' && (!wbEnabled || wbMode === 'keyword') && !keywordsColumn) {
    // 「按触发」的判定与绿灯注入共用关键词列：缺失时回落首列（引擎自愈）
    keywordsColumn = columns[0]?.header || '';
  }
  if (errors.length > 0) return { ok: false, def: null, errors };

  const def: LedgerSheetDef = {
    tableId: existingTableId || newTableId(),
    name,
    orderNo: 990,
    groupId: 1,
    note: String(parsed.note || ''),
    triggerNotes: {
      insert: String(parsed.triggerNotes?.insert || '') || undefined,
      update: String(parsed.triggerNotes?.update || '') || undefined,
      delete: String(parsed.triggerNotes?.delete || '') || undefined,
    },
    columns,
    readMode: readMode as LedgerSheetDef['readMode'],
    worldbook: {
      enabled: wbEnabled,
      mode: wbEnabled ? wbMode : undefined,
      keywordsColumn: keywordsColumn || undefined,
      wrapTag: wb.wrapTag ? String(wb.wrapTag) : undefined,
      ...(wb.placement && typeof wb.placement === 'object' ? { placement: { ...wb.placement } } : {}),
    },
  };
  clampSingleUnique(def); // 一表至多一列唯一（AI 生成多列时保留首列）
  return { ok: true, def, errors: [] };
}

function makeUid(): string {
  return `wz${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

/** 新建表的 tableId（内部键，用户不可见；建表向导与表格页「新增表」共用）。 */
export function newTableId(): string {
  return `sheet_${makeUid()}`;
}

/** 向导 def → 可 reconcile 的单表 WorkbookJson 片段（交给调用方走协调器引入）。 */
export function wizardDefToSheet(def: LedgerSheetDef): { uid: string; name: string; content: string[][]; sourceData: any; updateConfig: any; exportConfig: any; orderNo: number; ledgerV2: LedgerSheetDef } {
  const headers = ['row_id', ...def.columns.map((c) => c.header)];
  return {
    uid: def.tableId,
    name: def.name,
    content: [headers],
    sourceData: { note: def.note || '', insertNode: '', updateNode: '', deleteNode: '', ddl: '' },
    updateConfig: {},
    exportConfig: {},
    orderNo: def.orderNo,
    ledgerV2: def,
  };
}

/** 模板整体导出用的 v2 视图合成（向导应用后存回预设用）。 */
export function templateOfBook(book: BookModel, groups: any[], name: string): LedgerTemplateV2 | null {
  const tables: LedgerSheetDef[] = [];
  for (const t of [...book.tables.values()].sort((a, b) => a.orderNo - b.orderNo)) {
    if (t.v2def) tables.push(t.v2def);
  }
  if (tables.length === 0) return null;
  return { schemaVersion: 2, name, groups, tables };
}
