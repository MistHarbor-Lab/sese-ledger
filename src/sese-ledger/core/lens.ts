// ===== 世界书投影（lens） =====
//
// 按模板投影配置渲染到角色主世界书（getWorldbook/replaceWorldbook 通道）。
// 命名契约（V2 1A 化后 / 2026-10-18 十一批：纪要形态精简 + 注入不显示 row_id）：
// - 条目名前缀 `SeseLedger-`（台账自身英文简称词根）；主项目 chronicle-blocks 与小手机经共享常量
//   识别此词根做扫描钩 suspend（纪要单通道防双重注入）——改词根必须同步主项目 LEGACY_CHRONICLE_WB_PREFIXES；
// - **注入一律不显示 row_id**（表头与数据行都去首列）：row_id 只对填表（SQL 定位行）有意义，正文注入是噪音
//   （填表/推进请求的【数据投影】另路保留 row_id，见 scribe.rowProjectionLine）；
// - **常量注入**：整表一条目，条目名＝表名（`SeseLedger-备忘录`），表头并入条目内容（不单独出表头条目）；
//   0 行（空表）不产出条目——只含表头的空条目不再注入；有任意数据行才建，删空后随刷新整族删除；
// - **关键词触发**：每行一条目，条目名＝`表名-主关键词值`、包裹标签＝`包裹标签名-主关键词值`
//   （如 `SeseLedger-重要角色表-王二` / `<重要角色表-王二>`）；内容＝逐列 `列名：值`（无表头，故逐列点明含义）；
// - **人物关系表特判**：条目名与包裹标签均＝`人物关系表：A与B的关系`，内容不再重复人物A/人物B 两列；
// - **纪要表特判**：每行一条目（keys＝编码索引列 AM 码拆分，推进召回写码即触发），内容＝`时间跨度|纪要|重要对话`
//   （不带 row_id/概览/AM 号、不加标签），顺序 9990；组头组尾＝两条常量 `<过往记忆>` / `</过往记忆>`
//   （顺序 9985 / 9995，同槽位包住整组，见 buildSummaryEntries）；组头正文另带一行列格式说明
//   （行内无标签，不说明则每段是什么全靠猜；「空段省略」必须写明）；「纪要索引（概览）」常驻条目已退役
//   （概览由推进资料块供给）+ AM 码格式（AM0001）；
// - 数据库系（`TavernDB-ACU-*`，真数据库插件同名族）与台账受管族严格分家：刷新/删除投影只碰 SeseLedger-*，
//   数据库系条目改由「删除所有数据库世界书」显式清理（填表搜索钩另将两族一并剔除）。
//   数据库系判定除前缀族外还含两类**无前缀例外**（插件整表导出裸名 + 总结/重要人物裸名词根，
//   见 isDatabaseEntryName；裸名族须由调用方喂模板 exportName 集合，否则会漏删）。
// 单表投影故障隔离不阻塞其余（规格 §9）。

import type { BookModel, TableModel } from './book';
import type { ExportConfig } from './types';
import { defaultWrapTagOf, isStoppedTable, RELATION_TABLE_NAME, resolveColumn, specialFormOf } from './book';

export const CUSTOM_EXPORT_PREFIX = 'SeseLedger-';
/** 纪要成组标签条目名（引擎特判形态，落 `SeseLedger-纪要` 前缀族 ⇒ 主项目 chronicle suspend 一并认领）。 */
const MEMORY_WRAP_START_COMMENT = `${CUSTOM_EXPORT_PREFIX}纪要-过往记忆Start`;
const MEMORY_WRAP_END_COMMENT = `${CUSTOM_EXPORT_PREFIX}纪要-过往记忆End`;
const MEMORY_WRAP_OPEN = '<过往记忆>';
const MEMORY_WRAP_CLOSE = '</过往记忆>';
/** 组头正文＝标签 + 列格式说明：行条目正文是无标签的 `时间跨度|纪要|重要对话`，且空段省略（段数可少于 3）。
 *  只写裸表头会被当成一条数据行，故用「每条格式：」起头。组头恒常量，无召回时也随标签对出现。 */
const MEMORY_WRAP_START_CONTENT = `${MEMORY_WRAP_OPEN}\n（每条格式：时间跨度|纪要|重要对话；空段省略）`;
/** 纪要组顺序：行条目 9990、组头 9985、组尾 9995——同一 (depth, role) 桶内 ST 按 order **升序**拼接
 *  （world-info.js：`sortFn` 降序遍历 + 逐条 unshift），故这三个数恰好把整组包成 `<过往记忆> … </过往记忆>`。 */
const SUMMARY_ENTRY_ORDER = 9990;
const SUMMARY_WRAP_START_ORDER = 9985;
const SUMMARY_WRAP_END_ORDER = 9995;
/** 纪要特判形态默认槽位（冻结配置的 position/depth 优先；顺序一律走上面的常量）。 */
const SUMMARY_SLOT = { position: 'at_depth_as_system', depth: 999 };
/** 数据库系词根 = 真数据库插件的命名族（台账换词根前的旧投影/旧包裹条目同名族）。
 *  只用于「删除所有数据库世界书」与填表扫描剔除，绝不用于新建；台账刷新一律不碰此族（真库在场时删了会毁真库）。 */
export const DATABASE_ENTRY_PREFIX = 'TavernDB-ACU-';
/** 数据库系「固定裸名」词根：插件总结/重要人物注入的条目名不带 TavernDB-ACU- 前缀
 *  （injection-engine-entries.ts：`总结条目N`/`小总结条目N`/`重要人物条目…`）——与插件自身 isDbGenerated 口径一致。 */
export const DATABASE_BARE_PREFIXES = ['总结条目', '小总结条目', '重要人物条目'] as const;
/** 数据库系「模板裸名」派生后缀：插件**整表/合并导出**路径（injection-engine-custom.ts 的 getMergedEntryComment_ACU，
 *  非外部导入恒 `${exportPrefix}${entryName}`）只写 entryName 本身、不带 TavernDB-ACU-CustomExport-，
 *  派生件 = -表头（无包裹模板）/ -包裹-上 / -包裹-下（有包裹模板）。按行拆分导出恒带前缀，不列此族。 */
export const DATABASE_TABLE_SUFFIXES = ['', '-表头', '-包裹-上', '-包裹-下'] as const;
/** 插件数据隔离前缀（dataIsolationEnabled 时 `ACU-[code]-` 会加在一切数据库系条目名之前；判定前须剥除）。 */
const DATABASE_ISOLATION_PREFIX_RE = /^ACU-\[[^\]]*\]-/;

/** 剥除插件数据隔离前缀（无则原样返回）。 */
export function stripDatabaseIsolationPrefix(name: string): string {
  return String(name || '').replace(DATABASE_ISOLATION_PREFIX_RE, '');
}

export interface LensPosition {
  type: string;
  role: string;
  depth: number;
  order: number;
}

export interface LensEntry {
  comment: string;
  content: string;
  constant: boolean;
  keys: string[];
  position: LensPosition;
  /** 次关键词（仅「与」逻辑用：logic='and_any' 的 keys；缺省时与 keys 同值——兼容既有形态）。 */
  secondaryKeys?: string[];
}

/** exportConfig 的 position 字符串（如 at_depth_as_system / before_character_definition）→ 条目 position。 */
function toLensPosition(placement: { position?: string; depth?: number; order?: number } | undefined, fallbackOrder: number): LensPosition {
  const raw = String(placement?.position || 'before_character_definition');
  let type = raw;
  let role = 'system';
  const asRole = /_(as_system|as_user|as_assistant)$/.exec(raw);
  if (asRole) {
    type = raw.slice(0, asRole.index);
    role = asRole[1] === 'as_user' ? 'user' : asRole[1] === 'as_assistant' ? 'assistant' : 'system';
  }
  return { type, role, depth: Number(placement?.depth ?? 2), order: Number(placement?.order ?? fallbackOrder) };
}

function markdownRow(cells: string[]): string {
  return `| ${cells.map((c) => String(c ?? '')).join(' | ')} |`;
}

/** 去 row_id 首列（表头首列恒为 row_id＝v2 结构契约，见 book.createTableModel；非该形态原样返回）。
 *  世界书注入不显示 row_id：它只对填表（SQL `WHERE row_id = ?`）有意义，正文里是噪音。 */
function withoutRowIdColumn(table: TableModel, cells: string[]): string[] {
  return table.headers[0] === 'row_id' ? cells.slice(1) : cells;
}

function splitKeys(text: string): string[] {
  return String(text || '')
    .split(/[,，、;；\s]+/)
    .map((k) => k.trim())
    .filter(Boolean);
}

/** 逐列 `列名：值`（跳过 row_id、空值与 skip 列）——无表头的逐行条目靠它点明每列含义。
 *  关键词触发行会另跳「主关键词列」（其值已进条目名与包裹标签）。 */
function labeledColumnLines(table: TableModel, cells: string[], skip: ReadonlySet<string> = new Set()): string {
  const lines: string[] = [];
  for (let i = 1; i < table.headers.length; i += 1) {
    const header = String(table.headers[i] ?? '');
    if (!header || skip.has(header)) continue;
    const value = String(cells[i] ?? '').trim();
    if (!value) continue;
    lines.push(`${header}：${value}`);
  }
  return lines.join('\n');
}

/** v2 普通表投影（形态按注入方式分流）：
 *  - `constant`（常量）：**整表一条目**，条目名＝表名，表头与全部数据行一并包进包裹标签
 *    （表头并入内容、不单独出表头条目——对齐数据库整表注入，同时免掉「-表头」派生件）；
 *    **0 行不产出**（不注入只有表头的空条目；有行后自动恢复，删空后随刷新删除）；
 *  - 关键词触发（默认）：每行一条目，条目名＝`表名-主关键词值`、包裹标签＝`包裹标签名-主关键词值`
 *    （如 `SeseLedger-重要角色表-王二` / `<重要角色表-王二>`），内容＝逐列 `列名：值`；
 *  - 人物关系表特判：条目名与包裹标签均＝`人物关系表：A与B的关系`，内容跳过人物A/人物B（名字已在条目名里）。
 *  关键词逻辑（wb.keywordsLogic，对齐世界书次关键词逻辑）：
 *  - 缺省（无）：keys = 主关键词列的多值拆分（多 key = OR）；
 *  - `and`（与，＝世界书「与任意」）：主关键词 = 第一列值，次关键词 keys_secondary(and_any) = 第二列值；
 *  - `or`（或）：两列值合并进主关键词（任一命中即激活）。
 *  第二列缺值（与/或）时退回只看第一列（防条目恒不触发）；条目名/标签一律只带**主关键词**。
 *  **停用组闸门**：所在分组频率 0 的表一律不注入（忽略该表自己的「世界书注入」选项；选项保留在模板里，
 *  挪回频率 >0 的分组即原样恢复）——见 book.isStoppedTable。 */
function buildV2Entries(table: TableModel, index: number): LensEntry[] {
  const def = table.v2def!;
  if (isStoppedTable(table)) return [];
  const wb = def.worldbook || ({} as any);
  if (wb.enabled !== true) return [];
  const wrapTag = String(wb.wrapTag || defaultWrapTagOf(table.name));
  const placement: LensPosition = toLensPosition(wb.placement, 10000 + index);
  const rowIds = [...table.rows.keys()].sort((a, b) => a - b);
  const wrap = (tag: string, body: string): string => (tag ? `<${tag}>\n${body}\n</${tag}>` : body);

  // 常量注入：整表一条目（表头 + 数据行都在里面；两者都去 row_id 首列）。
  // 空表（0 行）不产出：只有表头的空条目没有注入价值，删空后旧条目由 reconcile 整族删除。
  if (wb.mode === 'constant') {
    if (rowIds.length === 0) return [];
    const body = [markdownRow(withoutRowIdColumn(table, table.headers)), ...rowIds.map((rowId) => markdownRow(withoutRowIdColumn(table, table.rows.get(rowId)!)))].join('\n');
    return [{
      comment: `${CUSTOM_EXPORT_PREFIX}${table.name}`,
      content: wrap(wrapTag, body),
      constant: true,
      keys: [],
      position: placement,
    }];
  }

  const out: LensEntry[] = [];

  // 总览条目（仅关键词触发 + 用户显式开启）：额外一条**常量**注入，汇总所选列的全部行。
  // 位置沿用本表 placement（position/depth），order 往前提 1 位（排在逐行条目之前）；空表不产出。
  const overview = (wb as { overview?: { enabled?: boolean; columns?: unknown } }).overview;
  if (overview?.enabled === true && rowIds.length > 0) {
    const wanted = Array.isArray(overview.columns) ? overview.columns.map(String) : [];
    const dataHeaders = table.headers[0] === 'row_id' ? table.headers.slice(1) : table.headers;
    const picked = dataHeaders.filter((h) => wanted.includes(h));
    if (picked.length > 0) {
      const indexes = picked.map((h) => table.headers.indexOf(h));
      const body = [
        markdownRow(picked),
        markdownRow(picked.map(() => '---')),
        ...rowIds.map((rowId) => markdownRow(indexes.map((i) => String(table.rows.get(rowId)![i] ?? '')))),
      ].join('\n');
      out.push({
        comment: `${CUSTOM_EXPORT_PREFIX}${table.name}-总览`,
        content: wrap(`${wrapTag}-总览`, body),
        constant: true,
        keys: [],
        position: { ...placement, order: placement.order - 1 },
      });
    }
  }

  const logic: 'none' | 'and' | 'or' = wb.keywordsLogic === 'and' || wb.keywordsLogic === 'or' ? wb.keywordsLogic : 'none';
  const keyIdx = typeof wb.keywordsColumn === 'string' && wb.keywordsColumn ? table.headers.indexOf(wb.keywordsColumn) : -1;
  const key2Idx = logic !== 'none' && typeof wb.keywordsColumn2 === 'string' && wb.keywordsColumn2
    ? table.headers.indexOf(wb.keywordsColumn2)
    : -1;
  const isRelation = specialFormOf(table.name, def) === 'relation';
  const aIdx = isRelation ? resolveColumn(table, '人物A') : -1;
  const bIdx = isRelation ? resolveColumn(table, '人物B') : -1;
  for (const rowId of rowIds) {
    const cells = table.rows.get(rowId)!;
    const keywordValue = keyIdx >= 0 ? String(cells[keyIdx] ?? '').trim() : '';
    const keywordValue2 = key2Idx >= 0 ? String(cells[key2Idx] ?? '').trim() : '';
    // 主关键词值（条目名与包裹标签的公共后缀；缺值退回行号，保证二者恒非空）
    const suffix = keywordValue || `row${rowId}`;
    const primaryKeys = keyIdx >= 0 ? splitKeys(keywordValue) : [];
    const secondKeys = splitKeys(keywordValue2);
    let keys = primaryKeys;
    let secondaryKeys = primaryKeys;
    if (logic === 'and' && secondKeys.length > 0) {
      secondaryKeys = secondKeys;
    } else if (logic === 'or' && secondKeys.length > 0) {
      keys = [...primaryKeys, ...secondKeys];
      secondaryKeys = keys;
    }
    const aVal = aIdx > 0 ? String(cells[aIdx] ?? '').trim() : '';
    const bVal = bIdx > 0 ? String(cells[bIdx] ?? '').trim() : '';
    if (isRelation && aVal && bVal) {
      // 人物关系表特判：条目名与包裹标签＝`人物关系表：A与B的关系`；内容跳过人物A/人物B（名字已进条目名）
      const pairLabel = `${RELATION_TABLE_NAME}：${aVal}与${bVal}的关系`;
      out.push({
        comment: `${CUSTOM_EXPORT_PREFIX}${pairLabel}`,
        content: wrap(pairLabel, labeledColumnLines(table, cells, new Set(['人物A', '人物B']))),
        constant: false,
        keys,
        secondaryKeys,
        position: placement,
      });
      continue;
    }
    out.push({
      comment: `${CUSTOM_EXPORT_PREFIX}${table.name}-${suffix}`,
      // 主关键词列的值已进条目名与标签 → 内容不再重复该列（其余列逐列 `列名：值`）
      content: wrap(`${wrapTag}-${suffix}`, labeledColumnLines(table, cells, new Set(keyIdx > 0 ? [String(table.headers[keyIdx])] : []))),
      constant: false,
      keys,
      secondaryKeys,
      position: placement,
    });
  }
  return out;
}

/** 纪要表特判形态（`lensForm='summary'`，引擎掌管、不进 UI 配置）。
 *  每行一条目：keys＝编码索引列 AM 码拆分（推进召回写出 AM 码即触发该行）；
 *  内容＝`时间跨度|纪要|重要对话`（空段省略；**不带** row_id/概览/AM 号，也不加标签包裹）；
 *  组头组尾＝两条常量 `<过往记忆>`/`</过往记忆>`（顺序 9985/9995）与行条目同槽位——
 *  组头正文另带列格式说明（见 MEMORY_WRAP_START_CONTENT）；同 (depth, role) 桶内 ST 按 order 升序拼接，
 *  故整组恒包成一段 `<过往记忆> … </过往记忆>`（无召回时是空对）。
 *  槽位 position/depth 取冻结配置（缺省 at_depth_as_system/999），顺序一律用常量。
 *  全组只在「启用注入 + 表内至少一行有内容」时产出：空表/关注入 → 空数组，旧条目随刷新整族删除。
 *  **不吃停用组闸门**：纪要表由硬约束挡在频率 0 的分组外（blueprint.validateV2Template 自愈 + 面板四入口拦截），
 *  这里不判频率——万一出现违例状态（手工改 JSON 等），宁可不静默断掉推进召回。 */
function buildSummaryEntries(table: TableModel, cfg: ExportConfig): LensEntry[] {
  if (cfg.enabled !== true) return [];
  const base = CUSTOM_EXPORT_PREFIX + String(cfg.entryName || table.name || '').trim();
  const spanIdx = resolveColumn(table, '时间跨度');
  const textIdx = resolveColumn(table, '纪要');
  const dialogueIdx = resolveColumn(table, '重要对话');
  const byConfig = resolveColumn(table, String(cfg.keywords || '').trim());
  const keyIdx = byConfig >= 0 ? byConfig : resolveColumn(table, '编码索引');
  const placement = cfg.entryPlacement || ({} as any);
  const slot = { position: String(placement.position || SUMMARY_SLOT.position), depth: Number(placement.depth ?? SUMMARY_SLOT.depth) };
  const at = (order: number): LensPosition => toLensPosition({ ...slot, order }, order);
  const out: LensEntry[] = [
    { comment: MEMORY_WRAP_START_COMMENT, content: MEMORY_WRAP_START_CONTENT, constant: true, keys: [], position: at(SUMMARY_WRAP_START_ORDER) },
  ];
  [...table.rows.keys()].sort((a, b) => a - b).forEach((rowId, i) => {
    const cells = table.rows.get(rowId)!;
    const line = [spanIdx, textIdx, dialogueIdx]
      .map((idx) => (idx >= 0 ? String(cells[idx] ?? '').trim() : ''))
      .filter(Boolean)
      .join('|');
    if (!line) return; // 空行不产出条目（也不占序号）
    out.push({
      comment: `${base}-${i + 1}`,
      content: line,
      constant: false,
      keys: keyIdx >= 0 ? splitKeys(String(cells[keyIdx] ?? '')) : [],
      position: at(SUMMARY_ENTRY_ORDER),
    });
  });
  if (out.length === 1) return []; // 全表无内容 → 连标签条目一起不建（整族删除）
  out.push({ comment: MEMORY_WRAP_END_COMMENT, content: MEMORY_WRAP_CLOSE, constant: true, keys: [], position: at(SUMMARY_WRAP_END_ORDER) });
  return out;
}

/** 单表 → 条目族（故障隔离由调用方逐表 try/catch）。 */
export function buildTableEntries(table: TableModel, index: number): LensEntry[] {
  if (specialFormOf(table.name, table.v2def) === 'summary') {
    return buildSummaryEntries(table, table.exportConfig || ({} as any));
  }
  if (!table.v2def) return [];
  return buildV2Entries(table, index);
}

/** 全部目标条目（逐表故障隔离；纪要的组头组尾标签由 buildSummaryEntries 随该表一并产出）。 */
export function buildDesiredEntries(book: BookModel): LensEntry[] {
  const out: LensEntry[] = [];
  const tables = [...book.tables.values()].sort((a, b) => a.orderNo - b.orderNo);
  tables.forEach((table, i) => {
    try {
      out.push(...buildTableEntries(table, i));
    } catch (_e) { /* 单表故障隔离 */ }
  });
  return out;
}

/** 条目名归一化读取：酒馆助手 4.x 的 WorldbookEntry 条目名字段是 name（fromWorldbookEntry: set('comment', entry.name ?? '')），旧版是 comment；写侧双写、读侧双查。 */
export function entryNameOf(entry: any): string {
  return String(entry?.comment ?? entry?.name ?? '');
}

/** 受管条目判定（清理+增量更新共用；只认台账词根前缀）。 */
export function isManagedEntry(entry: any): boolean {
  return entryNameOf(entry).startsWith(CUSTOM_EXPORT_PREFIX);
}

/** 数据库系条目名判定（名称级；可选隔离前缀剥除 + 三路命中）：
 *  ① `TavernDB-ACU-` 全族（含 `ACU-[code]-` 隔离前缀形态）；
 *  ② 固定裸名词根（总结条目 / 小总结条目 / 重要人物条目）；
 *  ③ 模板裸名族（entryName 及 -表头 / -包裹-上 / -包裹-下 派生件）——须由调用方给 bareNames
 *     （见 collectTemplateExportEntryNames：插件整表导出会漏掉 TavernDB-ACU- 前缀，不认这族即「漏网之鱼」）。 */
export function isDatabaseEntryName(rawName: unknown, bareNames?: ReadonlySet<string> | null): boolean {
  const name = stripDatabaseIsolationPrefix(String(rawName ?? '').trim());
  if (!name) return false;
  if (name.startsWith(DATABASE_ENTRY_PREFIX)) return true;
  if (DATABASE_BARE_PREFIXES.some((p) => name.startsWith(p))) return true;
  if (bareNames && bareNames.size > 0) {
    if (bareNames.has(name)) return true;
    for (const suffix of DATABASE_TABLE_SUFFIXES) {
      if (suffix && name.endsWith(suffix) && bareNames.has(name.slice(0, -suffix.length))) return true;
    }
  }
  return false;
}

/** 数据库系条目判定（真数据库注入条目 / 台账旧词根投影与包裹条目——同名族）。
 *  bareNames = 模板整表导出条目名集合（collectTemplateExportEntryNames）；不传只认带前缀族。 */
export function isDatabaseEntry(entry: any, bareNames?: ReadonlySet<string> | null): boolean {
  return isDatabaseEntryName(entryNameOf(entry), bareNames);
}

/** 剔除全部受管条目（删除所有世界书投影用；只删台账受管，不碰其他条目）。 */
export function stripManagedEntries(entries: any[]): { changed: boolean; kept: any[] } {
  const kept = entries.filter((e) => !isManagedEntry(e));
  return { changed: kept.length !== entries.length, kept };
}

/** 剔除全部数据库系条目（删除所有数据库世界书用；不碰台账投影与其他条目）。 */
export function stripDatabaseEntries(entries: any[], bareNames?: ReadonlySet<string> | null): { changed: boolean; kept: any[] } {
  const kept = entries.filter((e) => !isDatabaseEntry(e, bareNames));
  return { changed: kept.length !== entries.length, kept };
}

/** v1 形状工作簿（模板 JSON / 账本投影）→ 数据库系「整表导出」条目名候选。
 *  只收 `splitByRow !== true` 的表：按行拆分导出恒带 TavernDB-ACU-CustomExport- 前缀（已被前缀判定覆盖），
 *  只有整表/合并导出会写成裸名（条目名 = exportConfig.entryName，空则回落表名）。
 *  注意：v1→v2 转换会丢 entryName，故调用方必须喂**原形**（内置标准模板 JSON / 账本 v1 表 / 预设解析结果）。 */
export function collectTemplateExportEntryNames(workbook: unknown): string[] {
  const out: string[] = [];
  const src = workbook as Record<string, any> | null | undefined;
  if (!src || typeof src !== 'object') return out;
  for (const key of Object.keys(src)) {
    if (!key.startsWith('sheet_')) continue;
    const sheet = src[key] as any;
    if (!sheet || typeof sheet !== 'object') continue;
    const ec = sheet.exportConfig || {};
    if (ec.splitByRow === true) continue;
    const name = String(ec.entryName || sheet.name || '').trim();
    if (name) out.push(name);
  }
  return out;
}

/** 汇总数据库系裸名集合（trim + 去空 + 去重）。 */
export function collectDatabaseBareNames(...lists: Array<Iterable<unknown> | null | undefined>): Set<string> {
  const out = new Set<string>();
  for (const list of lists) {
    if (!list) continue;
    for (const raw of list) {
      const name = String(raw ?? '').trim();
      if (name) out.add(name);
    }
  }
  return out;
}

/** 受管条目语义归一（只取引擎掌管、且能稳定往返的字段）。
 *
 *  对比基准 = 酒馆助手 worldbook.ts 的 toWorldbookEntry/fromWorldbookEntry 实测映射：
 *  - 回读侧 strategy 恒被补全（常量条目也带 keys/keys_secondary，且必带 scan_depth:'same_as_global'）
 *    ⇒ 拿写入形状与回读形状整体 JSON.stringify 比永不相等（曾导致每次刷新都误判「有变更」、
 *    全量重写整本世界书）；这里改为逐字段归一后比较；
 *  - scan_depth / probability / effect / uid / 隐式 keys 非引擎掌管字段，一律不参与比对——
 *    用户在编辑器里的手工修改不触发回写；
 *  - 缺省归一：strategy.keys_secondary.logic→'and_any'、position.role→'system'、
 *    recursion.delay_until 仅正数有语义（null/false/0 等价）。
 *  注意：新增/改动写入字段时必须同步本归一器，否则该字段的变化将永远不被察觉。 */
function canonicalManagedSignature(e: any): string {
  const s = e?.strategy || {};
  const pos = e?.position || {};
  const rec = e?.recursion || {};
  const toKeys = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
  const canonical: Record<string, unknown> = {
    name: entryNameOf(e),
    content: String(e?.content ?? ''),
    enabled: e?.enabled !== false,
    type: String(s.type || 'constant'),
  };
  if (canonical.type === 'selective') {
    canonical.keys = toKeys(s.keys);
    canonical.secLogic = String(s.keys_secondary?.logic || 'and_any');
    canonical.secKeys = toKeys(s.keys_secondary?.keys);
  }
  canonical.position = [
    String(pos.type || ''),
    String(pos.role || 'system'),
    Number(pos.depth ?? 0),
    Number(pos.order ?? 0),
  ];
  canonical.recursion = [
    rec.prevent_incoming === true,
    rec.prevent_outgoing === true,
    typeof rec.delay_until === 'number' && rec.delay_until > 0 ? rec.delay_until : null,
  ];
  return JSON.stringify(canonical);
}

/** 把目标条目族合并进现有条目数组（受管整族替换；插入位置=原受管首位置）。 */
export function reconcileManagedEntries(entries: any[], desired: LensEntry[]): { changed: boolean; next: any[] } {
  const managedIndex = entries.findIndex((e) => isManagedEntry(e));
  const kept = entries.filter((e) => !isManagedEntry(e));
  const nextManaged = desired.map((d) => ({
    name: d.comment,
    comment: d.comment,
    content: d.content,
    enabled: true,
    strategy: d.constant ? { type: 'constant' } : {
      type: 'selective',
      keys: d.keys,
      // 「与」逻辑：次关键词 = 第二关键词列（and_any = 与任意）；其余形态镜像主关键词（历史形态逐字不变）
      keys_secondary: { logic: 'and_any', keys: d.secondaryKeys && d.secondaryKeys.length > 0 ? d.secondaryKeys : d.keys },
    },
    position: { type: d.position.type, role: d.position.role, depth: d.position.depth, order: d.position.order },
    recursion: { prevent_incoming: true, prevent_outgoing: true, delay_until: null },
  }));
  const insertAt = managedIndex >= 0 ? Math.min(managedIndex, kept.length) : kept.length;
  const next = [...kept.slice(0, insertAt), ...nextManaged, ...kept.slice(insertAt)];
  const prevManaged = entries.filter((e) => isManagedEntry(e));
  const changed = entries.length !== next.length
    || nextManaged.length !== prevManaged.length
    || nextManaged.some((e, i) => canonicalManagedSignature(e) !== canonicalManagedSignature(prevManaged[i]));
  return { changed, next };
}

export type LedgerProjectionAction = 'project' | 'clear' | 'skip';

export interface LedgerProjectionState {
  /** 聊天切换是否已落定：未落定一律不动（装载中不能把 null book 当「未建账」）。 */
  settled: boolean;
  book: BookModel | null;
  /** 当前聊天是否已解析出稳定身份（storageId）。欢迎页/无卡上下文 = null：
   *  此时 book 也为 null，但绝不能按「新聊天未建账」清掉上一聊天的投影。 */
  storageId: string | null;
  /** 只读保护 / 待恢复：账本可能有效但读不到，不得按空投影清世界书。 */
  writeProtected: boolean;
  recoveryNeeded: boolean;
}

/**
 * 统一投影语义（台账→状态栏协调器的 reconcile 唯一决策点）：
 * - 未落定 → skip（等落定后的请求）
 * - 已落定 + 无聊天身份 → skip（欢迎页/无卡上下文，不动世界书）
 * - 已落定 + 有身份 + 无 book + 无保护态 → clear（新聊天清掉上一聊天受管族）
 * - 已落定 + 有 book → project（按当前账本整族重建）
 *
 * 返回 next 而不是就地改 entries，便于纯函数测试；调用方只在 changed 时 splice 回协调器的副本。
 */
export function reconcileLedgerProjection(
  entries: any[],
  state: LedgerProjectionState,
): { changed: boolean; next: any[]; action: LedgerProjectionAction; desiredCount: number } {
  if (!state.settled) return { changed: false, next: entries, action: 'skip', desiredCount: 0 };
  if (!state.book) {
    if (!state.storageId || state.writeProtected || state.recoveryNeeded) {
      return { changed: false, next: entries, action: 'skip', desiredCount: 0 };
    }
    const { changed, next } = reconcileManagedEntries(entries, []);
    return { changed, next, action: 'clear', desiredCount: 0 };
  }
  const desired = buildDesiredEntries(state.book);
  const { changed, next } = reconcileManagedEntries(entries, desired);
  return { changed, next, action: 'project', desiredCount: desired.length };
}
