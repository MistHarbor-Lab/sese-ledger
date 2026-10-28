// ===== 蓝图：模板系统 =====
//
// V3.x 模板 JSON 零改动迁入（字段=数据兼容锚）：{mate, sheet_<uid>:{uid,name,sourceData（note + 增/改/删 三框；初始化框不迁入）,
// content, updateConfig, exportConfig, orderNo, seedRows?}}。
// - 全局预设库存 extensionSettings（与原库同策略：{templateStr, updatedAt}）；
// - 协调器（模板套到已有账本上）：加表=引入 / 加列=补空 / 同位改名=认领 / 模板外表列=丢弃（结构真源＝模板）。
import { validateTemplateStructure } from '../../unified-statusbar/core/db-ddl-check-parser';
import type { ExportConfig, LedgerGroupDef, LedgerSheetDef, LedgerTemplateV2, SheetJson, UpdateConfig, WorkbookJson } from './types';
import {
  applyV2DefToTable,
  createTableModel,
  defaultWrapTagOf,
  exportConfigFromDef,
  isStoppedGroup,
  specialFormOf,
  syncV2UpdateConfigs,
  type BookModel,
  type TableModel,
} from './book';
import { clampSingleUnique, parseDdl } from './constraints';

export { clampSingleUnique };
import { parseSeedColumns } from './scribe';

export const DEFAULT_UPDATE_CONFIG: UpdateConfig = {
  uiSentinel: -1,
  contextDepth: -1,
  updateFrequency: -1,
  batchSize: -1,
  skipFloors: -1,
  sendLatestRows: -1,
  groupId: 1,
  sendRowsSqlTemplate: '',
};

export const DEFAULT_EXPORT_CONFIG: ExportConfig = {
  enabled: false,
  splitByRow: false,
  entryName: '',
  entryType: 'constant',
  keywords: '',
  preventRecursion: true,
  injectionTemplate: '',
  extraIndexEnabled: false,
  extraIndexEntryName: '',
  extraIndexColumns: [],
  extraIndexColumnModes: {},
  extraIndexInjectionTemplate: '',
  sqlInjectionTemplate: '',
  entryPlacement: { position: 'before_character_definition', depth: 2, order: 10000 },
  extraIndexPlacement: { position: 'before_character_definition', depth: 2, order: 10010 },
  fixedEntryPlacement: { position: 'before_character_definition', depth: 2, order: 99990 },
  fixedIndexPlacement: { position: 'before_character_definition', depth: 2, order: 99991 },
};

/** 归一化单表：只补缺失默认值，不改用户已有值（模板资产零改动语义）。 */
function normalizeSheet(sheet: SheetJson): SheetJson {
  return {
    ...sheet,
    updateConfig: { ...DEFAULT_UPDATE_CONFIG, ...(sheet.updateConfig || {}) },
    exportConfig: { ...DEFAULT_EXPORT_CONFIG, ...(sheet.exportConfig || {}) },
  };
}

export interface NormalizedTemplate {
  ok: boolean;
  errors: string[];
  template: WorkbookJson | null;
}

/** 模板 JSON → 归一化模板（结构强校验 + 默认值补齐）。 */
export function normalizeTemplate(input: unknown): NormalizedTemplate {
  const check = validateTemplateStructure(input);
  if (!check.ok) return { ok: false, errors: check.errors, template: null };
  const src = input as WorkbookJson;
  const out: WorkbookJson = { mate: { ...(src.mate as any) } };
  for (const key of Object.keys(src)) {
    if (!key.startsWith('sheet_')) continue;
    out[key] = normalizeSheet(src[key] as SheetJson);
  }
  return { ok: true, errors: [], template: out };
}

export interface ConvergeReport {
  /** 模板有、账本无 → 新建（结构 + seed 行）。 */
  addedTables: string[];
  /** 表名认领：模板 key 与账本 key 不同但中文表名相同 → 保留账本 key，把模板结构套上去。 */
  adoptedTables: { templateKey: string; tableKey: string; name: string }[];
  /** 账本有、模板无 → 整表丢弃（结构真源＝模板；不再「隐藏保留」）。 */
  droppedTables: string[];
  addedColumns: { table: string; columns: string[] }[];
  /** 账本有、模板无 → 整列丢弃。 */
  droppedColumns: { table: string; columns: string[] }[];
  /** 改名认领：旧列数据迁到新列名（tableId 供迁移重写历史条目用）。 */
  claimedRenames: { table: string; tableId?: string; from: string; to: string }[];
}

/**
 * 收敛账本到模板（结构真源＝模板；**回放后调用**：切预设/装配/初始装载/时光机 bake 同口径）。
 * - 模板有、账本无 → 先按中文表名认领（模板换代 key 变化时不清空数据），认领不到才建结构与 seed 行；
 * - 账本有、模板无 → **整表丢弃**（不再「隐藏保留」：用户定案——模板外内容不再保留）；
 * - 列同理：新列补空、改名认领、模板外列整列丢弃；
 * - 表元信息（orderNo/updateConfig/exportConfig/name/sourceData/v2def）一律以模板为准。
 * 数据行只在「模板内表 × 模板内列」内保留；丢弃是不可逆的——**物理清理发生在结转**（快照=收敛后的书）。
 *
 * 认领口径（P0）：账本 key 是流水里 `op.table` 的寻址键，**保留账本 key**、只把模板结构套上去——
 * 这样不需要重写历史条目；`v2def.tableId` 同步改回账本 key，避免投影/写回再生成第二套 key。
 * 同名多张（非法状态）不猜，保持原行为（模板 key 新建、其余按模板外丢弃）。
 */
export function convergeBookToTemplate(book: BookModel, template: WorkbookJson): ConvergeReport {
  const report: ConvergeReport = { addedTables: [], adoptedTables: [], droppedTables: [], addedColumns: [], droppedColumns: [], claimedRenames: [] };
  const templateSheets = new Map<string, SheetJson>();
  for (const key of Object.keys(template)) {
    if (key.startsWith('sheet_')) templateSheets.set(key, normalizeSheet(template[key] as SheetJson));
  }
  const templateKeys = new Set(templateSheets.keys());
  const adoptedKeys = new Set<string>();
  // 1) 模板有、账本无 → 先按中文表名认领，认领不到才引入（结构 + seed 行）
  for (const [key, sheet] of templateSheets) {
    let existing = book.tables.get(key);
    if (!existing && sheet.name) {
      const name = String(sheet.name).trim();
      let candidateKey: string | null = null;
      for (const [oldKey, table] of book.tables) {
        if (templateKeys.has(oldKey) || adoptedKeys.has(oldKey)) continue;
        if (String(table.name || '').trim() !== name) continue;
        if (candidateKey !== null) { candidateKey = null; break; } // 同名多张：不猜
        candidateKey = oldKey;
      }
      if (candidateKey !== null) {
        existing = book.tables.get(candidateKey)!;
        adoptedKeys.add(candidateKey);
        report.adoptedTables.push({ templateKey: key, tableKey: candidateKey, name });
      }
    }
    if (!existing) {
      book.tables.set(key, createTableModel(key, sheet));
      report.addedTables.push(key);
      continue;
    }
    reconcileColumns(existing, sheet, report);
    // 结构元信息以模板为准（orderNo/updateConfig/exportConfig/name/sourceData）；
    // v2 模板可不带 sourceData（它由 def 派生，下一行 applyV2DefToTable 会重建）——缺则保留现值
    existing.orderNo = sheet.orderNo;
    existing.updateConfig = { ...DEFAULT_UPDATE_CONFIG, ...(sheet.updateConfig || {}) };
    existing.exportConfig = { ...DEFAULT_EXPORT_CONFIG, ...(sheet.exportConfig || {}) };
    existing.sourceData = sheet.sourceData || existing.sourceData;
    if (sheet.name) existing.name = sheet.name;
    // v2：def 随模板替换（派生元信息由 applyV2DefToTable 同步）
    applyV2DefToTable(existing, sheet.ledgerV2 && Array.isArray(sheet.ledgerV2.columns) ? sheet.ledgerV2 : null);
    // 认领表保留账本 key：模板 def 的 tableId 跟账本走（否则写回/投影会再生成一套 key）
    if (existing.v2def && existing.v2def.tableId !== existing.tableId) existing.v2def.tableId = existing.tableId;
  }
  // 2) 账本有、模板无 → 整表丢弃（被认领的旧 key 保留）
  for (const key of [...book.tables.keys()]) {
    if (templateSheets.has(key) || adoptedKeys.has(key)) continue;
    book.tables.delete(key);
    report.droppedTables.push(key);
  }
  if ('mate' in template && template.mate) {
    book.mate = { ...(template.mate as any) };
  } else {
    delete (book.mate as any).ledgerGroups;
  }
  syncV2UpdateConfigs(book);
  return report;
}

/** 两个表头共有的字符数（唯一字符；只用于“数量不等”时的改名配对打分）。 */
function sharedHeaderChars(a: string, b: string): number {
  const left = new Set([...String(a)]);
  let n = 0;
  for (const ch of new Set([...String(b)])) if (left.has(ch)) n += 1;
  return n;
}

function reconcileColumns(table: TableModel, sheet: SheetJson, report: ConvergeReport): void {
  const newHeaders: string[] = Array.isArray(sheet.content?.[0]) ? sheet.content[0].map(String) : table.headers;
  const oldSet = new Set(table.headers);
  const newSet = new Set(newHeaders);
  const oldToNew = new Map<string, string>();
  // 改名认领：只在「旧表头消失、新表头从未出现」的候选里配对。
  // 1) 先按字符重合度做唯一最佳配对：删列 + 改名混排时，**不能按位置猜**
  //    （删「性别」+ 把「生日」改名会把「女」写进「出生日期」）；没有唯一最佳就不认领。
  // 2) 再跑原「同位置才认领」兜底：覆盖名字毫无共同字符的纯改名；已被上一步认领的不再抢。
  //    这样「删中间一列、末尾加一列」仍保持新列补空（不会因数量相等而被误判成改名）。
  const removedHeaders = table.headers.filter((h) => !newSet.has(h));
  const newOnlyHeaders = newHeaders.filter((h) => !oldSet.has(h));
  const usedOld = new Set<string>();
  const mappedNew = new Set<string>();
  for (const newH of newOnlyHeaders) {
    let best = '';
    let bestScore = 0;
    let tied = false;
    for (const oldH of removedHeaders) {
      if (usedOld.has(oldH)) continue;
      const score = sharedHeaderChars(oldH, newH);
      if (score > bestScore) { best = oldH; bestScore = score; tied = false; }
      else if (score > 0 && score === bestScore) tied = true;
    }
    if (best && !tied) { oldToNew.set(best, newH); usedOld.add(best); mappedNew.add(newH); }
  }
  const commonLen = Math.min(table.headers.length, newHeaders.length);
  for (let i = 0; i < commonLen; i += 1) {
    const oldH = table.headers[i];
    const newH = newHeaders[i];
    if (oldH === newH || oldToNew.has(oldH) || mappedNew.has(newH)) continue;
    if (!newSet.has(oldH) && !oldSet.has(newH)) {
      oldToNew.set(oldH, newH);
      mappedNew.add(newH);
    }
  }
  for (const [from, to] of oldToNew) {
    report.claimedRenames.push({ table: table.name, tableId: table.tableId, from, to });
  }
  // 重建表头（保留旧列顺序优先，新列追加；改名列原位替换）
  const nextHeaders: string[] = [];
  const headerSource = new Map<string, number>(); // 新表头 → 旧列下标（-1=新列）
  for (let i = 0; i < table.headers.length; i++) {
    const old = table.headers[i];
    const renamed = oldToNew.get(old);
    nextHeaders.push(renamed || old);
    headerSource.set(renamed || old, i);
  }
  const added: string[] = [];
  for (const h of newHeaders) {
    if (h === 'row_id' || nextHeaders.includes(h)) continue;
    nextHeaders.push(h);
    headerSource.set(h, -1);
    added.push(h);
  }
  if (added.length) report.addedColumns.push({ table: table.name, columns: added });
  // 模板外列整列丢弃（数据同丢；物理清理在结转）
  const dropped: string[] = [];
  const finalHeaders: string[] = [];
  for (const h of nextHeaders) {
    if (h === 'row_id' || newHeaders.includes(h)) finalHeaders.push(h);
    else dropped.push(h);
  }
  if (dropped.length) report.droppedColumns.push({ table: table.name, columns: dropped });
  table.headers = finalHeaders;
  rebuildRows(table, finalHeaders, headerSource);
}

function rebuildRows(table: TableModel, nextHeaders: string[], headerSource: Map<string, number>): void {
  for (const [rowId, cells] of table.rows) {
    const next = new Array(nextHeaders.length).fill('');
    next[0] = String(rowId);
    for (let i = 1; i < nextHeaders.length; i++) {
      const oldIdx = headerSource.get(nextHeaders[i]);
      if (oldIdx !== undefined && oldIdx >= 0 && cells[oldIdx] !== undefined) next[i] = cells[oldIdx];
    }
    table.rows.set(rowId, next);
  }
}

// ===== v2 模板：转换 / 校验 / 投影 =====

export interface ConvertV1Result {
  ok: boolean;
  errors: string[];
  template: LedgerTemplateV2 | null;
  /** 转换报告（UI 展示后再落库）。 */
  report: string[];
}

/** v1（数据库/旧台账）模板 JSON → v2 模板。DDL→列定义（枚举/长度/数字限制丢弃）、
 *  seed 模板→按触发读取、纯文本模板→不读取、updateConfig 调度→分组注册表、注入配置极简化。 */
export function convertV1Template(input: unknown, name = '转换模板'): ConvertV1Result {
  const check = validateTemplateStructure(input);
  if (!check.ok) return { ok: false, errors: check.errors, template: null, report: [] };
  const src = input as WorkbookJson;
  const report: string[] = [];
  // 1) 分组注册表：updateConfig.groupId 去重升序 → 分组N；组频率由成员表频率归纳（全<=0 且含 0 → 0，否则取正频最大值/默认1）
  const groupIds = new Set<number>();
  const sheetKeys = Object.keys(src).filter((k) => k.startsWith('sheet_'));
  for (const key of sheetKeys) {
    const gid = Number((src[key] as SheetJson)?.updateConfig?.groupId);
    groupIds.add(Number.isFinite(gid) && gid > 0 ? Math.trunc(gid) : 1);
  }
  const orderedGroupIds = [...groupIds].sort((a, b) => a - b);
  const groupIdMap = new Map<number, number>();
  orderedGroupIds.forEach((gid, i) => groupIdMap.set(gid, i + 1));
  const groups: LedgerGroupDef[] = [];
  const freqByNewId = new Map<number, number[]>();
  for (const key of sheetKeys) {
    const gid = groupIdMap.get(Number((src[key] as SheetJson)?.updateConfig?.groupId) || 1) || 1;
    const f = Number((src[key] as SheetJson)?.updateConfig?.updateFrequency);
    if (!freqByNewId.has(gid)) freqByNewId.set(gid, []);
    freqByNewId.get(gid)!.push(Number.isFinite(f) ? f : -1);
  }
  for (const [newId, freqs] of freqByNewId) {
    const allNonPositive = freqs.every((f) => f <= 0);
    const hasZero = freqs.some((f) => f === 0);
    const frequency = allNonPositive && hasZero ? 0 : Math.max(1, ...freqs.map((f) => (f > 0 ? f : 1)));
    groups.push({ id: newId, name: `分组${newId}`, frequency });
  }
  // 2) 逐表转换
  const tables: LedgerSheetDef[] = [];
  let order = 0;
  for (const key of sheetKeys) {
    const sheet = src[key] as SheetJson;
    // v1 DDL 只在转换期读一次：拿列顺序/必填/唯一/行数上限与英文名→中文列的对照，读完即弃
    const parsed = parseDdl(String(sheet.sourceData?.ddl || ''));
    const headers = (Array.isArray(sheet.content?.[0]) ? sheet.content[0] : []).map(String);
    const columns = headers.slice(1).map((header, i) => {
      const ddlCol = parsed?.columns?.[i + 1];
      return {
        header,
        type: 'text' as const,
        unique: ddlCol?.unique === true,
        notNull: ddlCol?.notNull === true,
      };
    });
    // 读取模式推断（触发关键词统一由「世界书注入 → 关键词列」提供）
    const tpl = String(sheet.updateConfig?.sendRowsSqlTemplate || '');
    const seedPhysical = parseSeedColumns(tpl);
    let readMode: LedgerSheetDef['readMode'] = 'all';
    if (seedPhysical && seedPhysical.length > 0) {
      readMode = 'trigger';
    } else if (tpl.trim()) {
      readMode = 'none';
    }
    if (readMode !== 'all') report.push(`表「${sheet.name}」读取模式 → ${readMode === 'trigger' ? '按触发（关键词列见世界书注入）' : '不读取'}`);
    // 世界书注入（v2 完整形态：触发方式 + 关键词列 + 包裹标签 + 插入位置）
    const ec = sheet.exportConfig || ({} as ExportConfig);
    const isSummary = String(sheet.name) === '纪要表' && ec.extraIndexEnabled === true;
    // v1 关键词写的是物理名 → 转换期按 DDL 行序翻回中文表头；无关键词列时退回首个非 row_id 列
    const keywordHeader = (() => {
      const raw = String(ec.keywords || '').trim();
      if (raw) {
        const idx = ['row_id', ...(parsed?.columns || []).map((c) => c.physical)].indexOf(raw);
        if (idx >= 1) return columns[idx - 1]?.header;
        if (headers.includes(raw)) return raw;
      }
      return columns[0]?.header;
    })();
    const def: LedgerSheetDef = {
      tableId: key,
      name: String(sheet.name || key),
      orderNo: Number.isFinite(Number(sheet.orderNo)) ? Number(sheet.orderNo) : order,
      groupId: groupIdMap.get(Number(sheet.updateConfig?.groupId) || 1) || 1,
      note: String(sheet.sourceData?.note || ''),
      triggerNotes: {
        insert: String(sheet.sourceData?.insertNode || '') || undefined,
        update: String(sheet.sourceData?.updateNode || '') || undefined,
        delete: String(sheet.sourceData?.deleteNode || '') || undefined,
        // 「初始化」（initNode）不迁入：台账没有初始化阶段，该通道整条删除（内置模板的 initNode
        // 仍留给真数据库插件用，台账读到即弃）。
      },
      columns,
      readMode,
      worldbook: {
        enabled: ec.enabled === true,
        mode: ec.entryType === 'constant' ? 'constant' : 'keyword',
        keywordsColumn: keywordHeader,
        wrapTag: extractWrapTag(ec.injectionTemplate) || defaultWrapTagOf(String(sheet.name || key)),
        ...(ec.entryPlacement ? { placement: { ...ec.entryPlacement } } : {}),
      },
      ...(parsed && parsed.maxRowCount > 0 ? { maxRowCount: parsed.maxRowCount } : {}),
      ...(isSummary ? { lensForm: 'summary' as const, frozenExport: { ...ec } } : {}),
      ...(Array.isArray(sheet.seedRows) && sheet.seedRows.length ? { seedRows: sheet.seedRows } : {}),
    };
    if (isSummary) report.push(`表「${sheet.name}」保留纪要特判形态（行条目＝时间跨度|纪要|重要对话 + AM 码 keys；<过往记忆> 标签条目包裹；概览索引条目不再创建）`);
    if (ec.enabled === true && !isSummary && ec.extraIndexEnabled === true) report.push(`表「${sheet.name}」的索引条目（extraIndex）按 v2 形态丢弃`);
    const droppedUnique = clampSingleUnique(def);
    if (droppedUnique.length > 0) report.push(`表「${sheet.name}」DDL 含多列唯一（${droppedUnique.join('、')}）——一表至多一列唯一，已保留首列`);
    tables.push(def);
    order += 1;
  }
  tables.sort((a, b) => a.orderNo - b.orderNo || a.tableId.localeCompare(b.tableId));
  // 频率 0 分组＝停用组：导入时点名，否则用户不知道这批表为何不填表、不进世界书
  const stoppedGroups = groups.filter(isStoppedGroup);
  if (stoppedGroups.length > 0) {
    const membersOfGroup = (gid: number): string => tables.filter((d) => Number(d.groupId) === gid).map((d) => d.name).join('、');
    report.push(`频率 0 分组（停用组）：${stoppedGroups.map((g) => `分组${g.id}${membersOfGroup(g.id) ? `（${membersOfGroup(g.id)}）` : ''}`).join('、')}——组内表不自动更新、不参与手动/定向填表、不注入世界书`);
  }
  report.unshift(`分组注册表：${groups.length} 组（${groups.map((g) => `分组${g.id}=${isStoppedGroup(g) ? '停用' : `每${g.frequency}层`}`).join('、')}）`);
  const mate = (src.mate && typeof src.mate === 'object') ? { ...src.mate } : undefined;
  return { ok: true, errors: [], template: { schemaVersion: 2, name, groups, tables, ...(mate ? { mate } : {}) }, report };
}

/** 从 v1 注入模板提取包裹标签名（`<tag>…$1…</tag>` → tag）。 */
function extractWrapTag(template: unknown): string {
  const m = /<([A-Za-z_][\w-]*)>\s*\$1\s*<\/\1>/.exec(String(template || ''));
  return m ? m[1] : '';
}

/** v2 模板强校验（列名/英文名/重复/readMode/分组引用）。 */
export function validateV2Template(t: unknown): { ok: boolean; errors: string[]; warnings: string[] } {  const errors: string[] = [];
  const warnings: string[] = [];
  const tpl = t as LedgerTemplateV2;
  if (!tpl || typeof tpl !== 'object') return { ok: false, errors: ['不是合法的 JSON 对象'], warnings: [] };
  if (tpl.schemaVersion !== 2) errors.push('schemaVersion 必须为 2');
  if (!Array.isArray(tpl.groups) || tpl.groups.length === 0) errors.push('至少需要一个分组');
  const groupIds = new Set<number>((tpl.groups || []).map((g) => Number(g.id)));
  const seenNames = new Set<string>();
  for (const def of tpl.tables || []) {
    if (!def || typeof def !== 'object') { errors.push('存在非法表定义'); continue; }
    if (!def.name || !String(def.name).trim()) errors.push('存在缺少表名的表');
    if (seenNames.has(def.name)) errors.push(`表名「${def.name}」重复`);
    seenNames.add(def.name);
    if (!Array.isArray(def.columns) || def.columns.length === 0) errors.push(`表「${def.name}」至少需要一列`);
    if (!groupIds.has(Number(def.groupId))) errors.push(`表「${def.name}」引用了不存在的分组 ${def.groupId}`);
    const seenHeaders = new Set<string>();
    for (const c of def.columns || []) {
      const header = String(c?.header || '').trim();
      if (!header) errors.push(`表「${def.name}」存在空列名`);
      if (seenHeaders.has(header)) errors.push(`表「${def.name}」列名「${header}」重复`);
      seenHeaders.add(header);
    }
    if (def.readMode && !['all', 'trigger', 'none'].includes(def.readMode)) errors.push(`表「${def.name}」读取模式非法：${def.readMode}`);
    if (def.worldbook && def.worldbook.mode && !['constant', 'keyword'].includes(def.worldbook.mode)) errors.push(`表「${def.name}」注入方式非法：${def.worldbook.mode}`);
    // 唯一列单选（自愈不判错：保留首列，其余清除并提示）
    const droppedUnique = clampSingleUnique(def);
    if (droppedUnique.length > 0) {
      const kept = String((def.columns || []).find((c) => c.unique === true)?.header || '');
      warnings.push(`表「${def.name}」存在多列唯一（${droppedUnique.join('、')}）——一表至多一列唯一，已保留首列「${kept}」`);
    }
    if (def.readMode === 'trigger' && def.worldbook?.enabled !== false && def.worldbook?.mode !== 'constant') {
      // 关键词触发/按触发判定都需要有效关键词列：缺失或失效一律回落首列（引擎自愈，不判错）
      const headers = (def.columns || []).map((c) => String(c.header || '').trim()).filter(Boolean);
      const known = new Set(headers);
      const current = String(def.worldbook?.keywordsColumn || '').trim();
      def.worldbook = { ...(def.worldbook || { enabled: true }), keywordsColumn: known.has(current) ? current : (headers[0] || '') };
    }
    // 第二关键词列自愈：逻辑为与/或但第二列缺失/失效/与首列相同 → 清掉列与逻辑（退回只看第一列）
    {
      const wb = def.worldbook || ({} as any);
      if (wb.keywordsLogic === 'and' || wb.keywordsLogic === 'or') {
        const headers = (def.columns || []).map((c) => String(c.header || '').trim()).filter(Boolean);
        const known = new Set(headers);
        const c2 = String(wb.keywordsColumn2 || '').trim();
        if (!c2 || !known.has(c2) || c2 === String(wb.keywordsColumn || '').trim()) {
          def.worldbook = { ...wb, keywordsColumn2: undefined, keywordsLogic: undefined };
        }
      }
    }
    // 总览条目自愈（仅关键词触发）：列失效一律剔除（按表内列顺序保留），一列不剩＝自动关闭。
    {
      const wb = def.worldbook || ({} as any);
      if (wb.overview && typeof wb.overview === 'object') {
        const headers = (def.columns || []).map((c) => String(c.header || '').trim()).filter(Boolean);
        const picked = Array.isArray(wb.overview.columns) ? wb.overview.columns.map((c: unknown) => String(c)) : [];
        const cols = headers.filter((h) => picked.includes(h));
        def.worldbook = { ...wb, overview: { enabled: wb.overview.enabled === true && cols.length > 0, columns: cols } };
      }
    }
  }
  // 纪要表不许进频率 0 的分组（停用组：不填表、不注入世界书——用户定案的硬约束）。
  // 自愈不判错：挪到第一个频率 > 0 的分组并点名（存量预设/手工改 JSON 的违例状态装载即修）；全都停用 → 判错。
  {
    const groups: LedgerGroupDef[] = Array.isArray(tpl.groups) ? tpl.groups : [];
    for (const def of tpl.tables || []) {
      if (!def || typeof def !== 'object' || specialFormOf(def.name, def) !== 'summary') continue;
      const from = groups.find((g) => Number(g.id) === Number(def.groupId));
      if (!isStoppedGroup(from)) continue;
      const dest = groups.find((g) => !isStoppedGroup(g));
      if (!dest) {
        errors.push(`纪要表「${def.name}」在频率 0 的分组里，且没有频率 > 0 的分组可放——纪要表不允许进入停用组`);
        continue;
      }
      def.groupId = Number(dest.id);
      warnings.push(`纪要表「${def.name}」不允许进入频率 0 的分组（${String(from?.name || `分组${from?.id}`)}）——已自动移到「${String(dest.name || `分组${dest.id}`)}」`);
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

/** v2 模板 → WorkbookJson（ledgerV2 随表携带 + mate.ledgerGroups；结构满足 v1 校验器，投影消费方零感知）。 */
export function v2TemplateToWorkbook(t: LedgerTemplateV2): WorkbookJson {
  const out: WorkbookJson = { mate: { ...(t.mate as any), type: 'chatSheets', ledgerGroups: t.groups.map((g) => ({ ...g })) } };
  for (const def of t.tables) {
    const headers = ['row_id', ...def.columns.map((c) => c.header)];
    const sheet: SheetJson = {
      uid: def.tableId,
      name: def.name,
      content: [headers, ...(def.seedRows || [])],
      sourceData: { note: def.note || '', insertNode: def.triggerNotes?.insert || '', updateNode: def.triggerNotes?.update || '', deleteNode: def.triggerNotes?.delete || '', ddl: '' },
      updateConfig: {},
      exportConfig: exportConfigFromDef(def),
      orderNo: def.orderNo,
      ...(def.seedRows ? { seedRows: def.seedRows } : {}),
      ledgerV2: def,
    };
    out[def.tableId] = sheet;
  }
  return out;
}

/** WorkbookJson（含 ledgerV2）→ v2 模板（编辑/导出用）。 */
export function workbookToV2Template(wb: WorkbookJson, name: string): LedgerTemplateV2 | null {
  const tables: LedgerSheetDef[] = [];
  for (const key of Object.keys(wb)) {
    if (!key.startsWith('sheet_')) continue;
    const def = (wb[key] as SheetJson)?.ledgerV2;
    if (def && Array.isArray(def.columns)) tables.push(def);
  }
  if (tables.length === 0) return null;
  const groups = Array.isArray((wb.mate as any)?.ledgerGroups) ? (wb.mate as any).ledgerGroups : [{ id: 1, name: '分组1', frequency: 1 }];
  tables.sort((a, b) => a.orderNo - b.orderNo || a.tableId.localeCompare(b.tableId));
  return { schemaVersion: 2, name, groups, tables };
}

export interface NormalizedAnyTemplate {
  ok: boolean;
  errors: string[];
  /** v1/v2 统一投影为 WorkbookJson（v2 经 v2TemplateToWorkbook）。 */
  workbook: WorkbookJson | null;
  /** 输入为 v2 模板时的原样引用（UI 编辑用）。 */
  v2: LedgerTemplateV2 | null;
  /** 输入为 v1 模板时的转换报告。 */
  report: string[];
  /** 自愈类提示（不拦导入）：如「多列唯一已保留首列」。 */
  warnings?: string[];
}

/** 模板归一化（v1 直通 / v2 校验+投影；预设导入与模板切换共用入口）。 */
export function normalizeTemplateAny(input: unknown): NormalizedAnyTemplate {
  if (input && typeof input === 'object' && (input as any).schemaVersion === 2) {
    const check = validateV2Template(input);
    if (!check.ok) return { ok: false, errors: check.errors, workbook: null, v2: null, report: [], warnings: [] };
    const tpl = input as LedgerTemplateV2;
    return { ok: true, errors: [], workbook: v2TemplateToWorkbook(tpl), v2: tpl, report: [], warnings: check.warnings };
  }
  const v1 = normalizeTemplate(input);
  if (!v1.ok || !v1.template) return { ok: false, errors: v1.errors, workbook: null, v2: null, report: [], warnings: [] };
  const converted = convertV1Template(v1.template, '导入模板');
  if (!converted.ok || !converted.template) return { ok: false, errors: converted.errors, workbook: null, v2: null, report: [], warnings: [] };
  return { ok: true, errors: [], workbook: v2TemplateToWorkbook(converted.template), v2: converted.template, report: converted.report, warnings: [] };
}

