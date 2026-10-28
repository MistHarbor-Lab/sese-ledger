// ===== AI 填表（SQL 输出 + 严格校验 + 调度） =====
//
// 调度语义对齐在用副本（auto-update-plan 实证）：
// - contextDepth（触达层数）-1/0→全局默认 5；updateFrequency -1→全局默认 1、**0=不参与自动更新**；
//   skipFloors -1→全局默认 0；batchSize -1→全局默认 3；groupId 分组合批。
// - 触发 = 未记录楼层数 ≥ frequency 且待记录楼与"最近 threshold 层"窗口相交。
// - 表级配置 -1 时回落全局默认；同签名（groupId|threshold|freq|skip|batch|indices）合一个请求。
//
// 请求结构（1A 同构，与主项目共享件对齐；见 core/host-ai.ts）：
//   结构头（破限头；任务段＝填表提示词，不挂反八股）→ 内容项（段与固定块混排＝settings.fillPrompt；
//   固定块：参考资料块＝1A 原生中段槽位 / 资料块【当前台账】 / 上下文块【当前正文】）→ 输出要求句 → 结构尾（尾部破限）。
//   三块的抬头与功能说明由本层拼（块正文只带数据）：参考资料块＝世界书激活条目+角色卡设定（填表背景，非正文）/
//   台账＝本轮需要填的表及已有内容（每表一行「表 N/M：表名」分隔线，声明填表范围）/ 正文＝填表唯一事实依据。
//   触发注入素材＝本组待填楼层正文（只喂绿灯扫描，不进提示词）；扫描钩剔除台账受管族 + 数据库系条目（两族都不进填表提示词）。
//   上下文只含 AI 回复（group.indices 恒为 AI 楼层），过主项目「上下文标签剥离」。
//
// 【当前台账】数据是否进入按「读取设置 × 世界书注入」四档决策（见 projectTableForPrompt）：
//   全量→恒进入；不读取→投影位置显式写「【已有数据】空」；按触发+注入关→同上；
//   按触发+注入开·常量→恒进入；
//   按触发+注入开·关键词触发→关键词列的值命中处理后的正文段才进入（v2RowEntersPrompt）。
//   纪要表（lensForm='summary'）＝一句话「纪要表无需参考已有数据」——历史由世界书/推进资料块回放，
//   新行编码索引由引擎补号（nextSummaryCodeForValue），AI 不需要也不应该推算。
//
// 输出格式＝SQL（唯一通道；判别不出可执行内容一律报错回注，绝不静默当"无变化"通过）：
//     UPDATE 表名 SET 列名 = '新值', 列名2 = '值2' WHERE row_id = 3;
//     UPDATE 表名 SET 列名 = 列名 || '追加内容' WHERE 列名 = '值';   -- 接续（引擎算，不用复述旧文）
//     UPDATE 表名 SET 计数 = 计数 + 2 WHERE row_id = 3;             -- 加减（引擎算）
//     INSERT INTO 表名 (列1, 列2) VALUES ('值1', '值2'); / DELETE FROM 表名 WHERE row_id = 3;
// SQL 通道校验见 core/fill-sql.ts（0 命中/约束违规/表达式错误一律回注重试）。

import type { LedgerGroupDef, LedgerOp } from './types';
import type { BookModel, TableModel } from './book';
import { findGroup, groupsOf, isStoppedTable, syncV2UpdateConfigs, expandTablePlaceholders } from './book';
import { buildValidators, type ColumnValidator } from './constraints';
import { runFillSql } from './fill-sql';
import { fillFailureText, type FillProgressEvent } from './fill-notify';
import type { LedgerLogEvent } from './ledger-log';
import { describeErrorDetail, describeErrorSummary } from './error-detail';
import { stripWithContextConfig } from '../../unified-statusbar/core/context-strip';
import { aiFloorOfAnchor, aiFloorOrdinalAt, isAnchorCandidate, ledgerAnchorFor } from './floor-scope';
import {
  FILL_BLOCK_IDS,
  defaultPromptSpecs,
  normalizePromptSpecs,
  specsToItems,
  type LedgerBlockContents,
  type LedgerPromptItem,
  type LedgerPromptItemSpec,
} from './ai-request';
import type { LedgerRuntime, LedgerWriteTarget } from './runtime';

// ===== 调度 =====

export interface ScheduleGlobals {
  autoUpdateEnabled: boolean;
  autoUpdateFrequency: number;
  autoUpdateThreshold: number;
  skipUpdateFloors: number;
  updateBatchSize: number;
}

export const DEFAULT_SCHEDULE_GLOBALS: ScheduleGlobals = {
  autoUpdateEnabled: true,
  autoUpdateFrequency: 1,
  autoUpdateThreshold: 5,
  skipUpdateFloors: 0,
  updateBatchSize: 3,
};

export interface UpdateGroup {
  key: string;
  tableIds: string[];
  tableNames: string[];
  /** 待记录的 AI 消息下标。 */
  indices: number[];
  batchSize: number;
  /** 分组编号（v2 分组注册表；手动/重填路径无分组）。 */
  groupId?: number;
  /** 分组名（进度通知展示用）。 */
  groupName?: string;
}

function sortedTables(book: BookModel): TableModel[] {
  return [...book.tables.values()].sort((a, b) => a.orderNo - b.orderNo);
}

/** 进度通知标签：「分组1（核心）」/「分组2」。 */
export function groupLabelOf(group: Pick<UpdateGroup, 'groupId' | 'groupName'>): string {
  const id = Number(group?.groupId) > 0 ? Math.trunc(Number(group.groupId)) : 1;
  const name = String(group?.groupName || '').trim();
  return name && name !== `分组${id}` ? `分组${id}（${name}）` : `分组${id}`;
}

/** 表所属分组 id（与 computeFillStatus / updateConfigFromDef 同口径：无 v2def 或非法值＝1）。 */
export function groupIdOfTable(table: TableModel): number {
  const raw = table.v2def ? Number(table.v2def.groupId) : 1;
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 1;
}

/** 按分组切表：**不同组的表不进同一次请求**（对齐自动填表的分组口径）。
 *  组序＝groupId 升序；组内保持传入序（调用方按 orderNo 排好）。 */
export function splitTablesByGroup(tables: TableModel[], groups: LedgerGroupDef[]): { groupId: number; groupName: string; tables: TableModel[] }[] {
  const buckets = new Map<number, TableModel[]>();
  for (const t of tables) {
    const gid = groupIdOfTable(t);
    const list = buckets.get(gid);
    if (list) list.push(t); else buckets.set(gid, [t]);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([groupId, list]) => ({ groupId, groupName: String(findGroup(groups, groupId)?.name || ''), tables: list }));
}

/** 自动填表计划分桶：**待填楼层窗口相同＝同一批**（同批各分组并发请求，一批收齐再落账、再换下一批——
 *  对齐数据库插件的 bucket 语义：bucketKey = 落点楼层|批号|模式）。窗口不同＝不同批，按原顺序串行。 */
export function bucketPlanByWindow(plan: UpdateGroup[]): UpdateGroup[][] {
  const buckets = new Map<string, UpdateGroup[]>();
  for (const g of plan) {
    const key = (Array.isArray(g.indices) ? g.indices : []).join(',');
    const list = buckets.get(key);
    if (list) list.push(g); else buckets.set(key, [g]);
  }
  return [...buckets.values()];
}

/** 手动填表进度标签：单组＝「手动填表 1/2 批」；多组＝「手动填表 · 分组1（角色组） 1/2 批」。 */
function manualFillLabel(scopeName: string, bucket: Pick<UpdateGroup, 'groupId' | 'groupName'>, multiGroup: boolean, batchIndex: number, batchCount: number): string {
  const batchSuffix = batchCount > 1 ? ` ${batchIndex + 1}/${batchCount} 批` : '';
  return multiGroup ? `${scopeName} · ${groupLabelOf(bucket)}${batchSuffix}` : `${scopeName}${batchSuffix}`;
}

/** 计算自动填表计划（纯函数）。schedule: tableId → lastFilledAiFloor。 */
export function computeUpdatePlan(book: BookModel, chat: any[], schedule: Record<string, number>, globals: ScheduleGlobals): UpdateGroup[] {
  const aiIndices: number[] = [];
  for (let i = 0; i < chat.length; i++) {
    if (isAnchorCandidate(chat[i])) aiIndices.push(i);
  }
  const totalAi = aiIndices.length;
  const groups = new Map<string, UpdateGroup>();
  for (const table of sortedTables(book)) {
    const cfg = (table.updateConfig || {}) as Record<string, number | undefined>;
    const rawDepth = Number.isFinite(cfg.contextDepth) ? (cfg.contextDepth as number) : -1;
    const rawFreq = Number.isFinite(cfg.updateFrequency) ? (cfg.updateFrequency as number) : -1;
    const rawSkip = Number.isFinite(cfg.skipFloors) ? (cfg.skipFloors as number) : -1;
    const rawBatch = Number.isFinite(cfg.batchSize) ? (cfg.batchSize as number) : -1;
    const rawGroupId = Number.isFinite(cfg.groupId) ? Math.trunc(cfg.groupId as number) : -1;
    const threshold = (rawDepth === -1 || rawDepth === 0) ? globals.autoUpdateThreshold : Math.max(0, rawDepth);
    const frequency = rawFreq === -1 ? globals.autoUpdateFrequency : rawFreq;
    const skipFloors = Math.max(0, rawSkip === -1 ? globals.skipUpdateFloors : rawSkip);
    const lastFilled = Math.max(0, Number(schedule[table.tableId]) || 0);
    const unrecorded = Math.max(0, (totalAi - skipFloors) - lastFilled);
    if (frequency <= 0 || threshold <= 0 || unrecorded < frequency) continue;
    const effective = skipFloors > 0 ? aiIndices.slice(0, -skipFloors) : aiIndices;
    if (lastFilled >= effective.length) continue;
    const unupdated = effective.slice(lastFilled);
    const scope = new Set(effective.slice(-threshold));
    const indices = unupdated.filter((idx) => scope.has(idx));
    if (indices.length === 0) continue;
    const batchSize = rawBatch === -1 || rawBatch <= 0 ? globals.updateBatchSize : rawBatch;
    const key = [rawGroupId, threshold, frequency, skipFloors, rawBatch, indices.join(',')].join('|');
    let g = groups.get(key);
    if (!g) {
      const gid = rawGroupId > 0 ? Math.trunc(rawGroupId) : 1;
      groups.set(key, (g = { key, tableIds: [], tableNames: [], indices, batchSize, groupId: gid, groupName: String(findGroup(groupsOf(book), gid)?.name || '') }));
    }
    g.tableIds.push(table.tableId);
    g.tableNames.push(table.name);
  }
  return [...groups.values()];
}

// ===== 各表填表状态（工作台填表页；口径对齐数据库「上次更新 / 下次触发」） =====

export interface FillStatusRow {
  tableId: string;
  name: string;
  groupId: number;
  groupName: string;
  /** 分组频率（0 = 停用组：不参与任何填表（自动/手动/定向重填）、不注入世界书）。 */
  frequency: number;
  /** 上次填写到第几层 AI 楼（0 = 从未填写；自动/手动/重填都会推进）。 */
  lastFilled: number;
  /** 下次自动更新触发层 = 上次填写 + 频率 + 跳过楼层（频率 0 时为 0 = 不自动更新）。 */
  nextUpdateFloor: number;
}

export interface FillStatusReport {
  /** 上下文总层数（仅 AI 回复楼层）。 */
  aiCount: number;
  skipFloors: number;
  rows: FillStatusRow[];
}

/** 逐表填表状态（纯函数：分组频率取注册表，缺组回落全局默认——与 computeUpdatePlan 同口径）。 */
export function computeFillStatus(book: BookModel, chat: any[], schedule: Record<string, number>, globals: ScheduleGlobals): FillStatusReport {
  const aiCount = (Array.isArray(chat) ? chat : []).filter((m) => isAnchorCandidate(m)).length;
  const skipFloors = Math.max(0, Math.trunc(Number(globals?.skipUpdateFloors) || 0));
  const groups = groupsOf(book);
  const rows: FillStatusRow[] = sortedTables(book).map((table) => {
    const rawGroupId = table.v2def ? Number(table.v2def.groupId) : 1;
    const groupId = Number.isFinite(rawGroupId) && rawGroupId > 0 ? Math.trunc(rawGroupId) : 1;
    const g = table.v2def ? findGroup(groups, groupId) : undefined;
    // 分组在注册表里就取组频率；否则回落全局（与 computeUpdatePlan 同口径）
    const frequency = g
      ? Math.max(0, Math.trunc(Number(g.frequency) || 0))
      : Math.max(0, Math.trunc(Number(globals.autoUpdateFrequency) || 0));
    const lastFilled = Math.max(0, Number(schedule?.[table.tableId]) || 0);
    return {
      tableId: table.tableId,
      name: table.name,
      groupId,
      groupName: String(g?.name || (table.v2def ? `分组${groupId}` : '')),
      frequency,
      lastFilled,
      nextUpdateFloor: frequency > 0 ? lastFilled + frequency + skipFloors : 0,
    };
  });
  return { aiCount, skipFloors, rows };
}

// ===== seed 列探测（只在 v1 模板转换时用：判 readMode） =====

/** 从 sendRowsSqlTemplate 的 `<if seed='…COALESCE(col)…&…COALESCE(col2)…'>` 构造段探测 seed 列。
 *  v1 模板里写的是英文物理名——只用于转换期判「按触发」，读完即弃（台账运行时不认英文名）。 */
export function parseSeedColumns(sendRowsSqlTemplate: string): string[] | null {
  const text = String(sendRowsSqlTemplate || '');
  if (!text.includes("<if seed='")) return null;
  const head = text.split("CHAR(34) || '>'")[0];
  if (!head) return null;
  const cols: string[] = [];
  const re = /COALESCE\(\s*([A-Za-z_]\w*)\s*,\s*''\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(head)) !== null) {
    if (!cols.includes(m[1])) cols.push(m[1]);
  }
  return cols.length > 0 ? cols : null;
}

// ===== 校验结果形态 =====

export interface ValidationOutcome {
  ops: LedgerOp[];
  errors: string[];
  /** 半成功：有合法操作同时有违规行。 */
  partial: boolean;
}

// ===== 提示词组装 =====

function rowProjectionLine(cells: string[]): string {
  return cells.map((c) => String(c ?? '')).join('|');
}

export interface FillPromptContext {
  /** 剧情正文（只含 AI 回复、不含推进内容、已过主项目「上下文标签剥离」）。 */
  storyText: string;
  /** 关键词判定正文（＝ storyText 剥离后口径；「按触发」用它匹配条目关键词）。缺省回退 storyText。 */
  keywordText?: string;
  /** 本次附加要求（追加进输出要求句，一次性；留空不追加）。 */
  extraRequest?: string;
  /** 当前账本（供提示词素材展开 `{[db…]}` 占位符；缺省＝不展开——纯函数测试与旧调用零改动）。 */
  book?: BookModel;
}

/** 表段分隔线（抬头 / 结束线）。多表连排时表名与段边界必须显眼：
 *  表名缺席 + 段间只有空行 ⇒ 模型无法判断「该写哪张表」，只能自创表名（引擎精确匹配 → 整句拒绝）。 */
function tableSectionRule(label: string): string {
  return `──────── ${label} ────────`;
}

/** 表段标题：带序号（本轮第几张 / 共几张表，即填表范围）；不带 opts 只用表名（纯函数旧调用零改动）。 */
export function tableSectionLabel(table: TableModel, opts?: { index?: number; total?: number }): string {
  const index = Math.trunc(Number(opts?.index) || 0);
  const total = Math.trunc(Number(opts?.total) || 0);
  return index > 0 && total > 0 ? `表 ${index}/${total}：${table.name}` : `表：${table.name}`;
}

/**
 * 单表投影段：分隔线抬头（表 N/M：表名）+ 表说明 + 操作规则 + 已有数据 + 结束分隔线
 * （默认段 = 【当前台账】的成员；【列约束】段已删——见下方注释）。
 * 数据是否进入按「读取设置 × 世界书注入」四档决策：
 *   · 全量 → 恒进入；
 *   · 不读取 → 不进入（投影位置显式写「空」——缺席的段会被当成"没这张表"或"空表"）；
 *   · 按触发 + 注入关 → 同上写「空」；
 *   · 按触发 + 注入开·常量 → 恒进入；
 *   · 按触发 + 注入开·关键词触发 → 关键词命中才进入（用处理后的正文段匹配条目关键词）。
 * 表说明/操作规则里的 `{[db…]}` 占位符在带 ctx.book 时就地展开（对齐真数据库：全局数据表说明里的
 * 「已探索地点概览 → 杂表」链由此接通）；纪要表（lensForm='summary'）改走精简投影（见 projectSummaryTable）。
 */
/** 数据未随请求提供的表现形态：一律「【已有数据】空」（用户定案——把行数/行号写进这段会让 AI 把元信息当数据）。
 *  固定行数表（检定建议表 6 行 / 主角信息表 1 行）靠**表说明里的固定行数**自洽：说明写明 row_id 恒定范围，
 *  写法按「先逐行 UPDATE；引擎回注未命中说明还没建行，再逐行 INSERT」两段式，无需读已有数据即可完成。 */
export function absentProjectionLine(): string {
  return '【已有数据】空';
}

export function projectTableForPrompt(table: TableModel, ctx: FillPromptContext, opts?: { index?: number; total?: number }): string {
  const label = tableSectionLabel(table, opts);
  const parts: string[] = [];
  const sd = table.sourceData || ({} as any);
  const expand = (text: string): string => expandTablePlaceholders(ctx.book, text);
  if (sd.note) parts.push(`【表说明】\n${expand(sd.note)}`);
  const rules: string[] = [];
  if (sd.insertNode) rules.push(`[增行时机] ${expand(sd.insertNode)}`);
  if (sd.updateNode) rules.push(`[更新时机] ${expand(sd.updateNode)}`);
  if (sd.deleteNode) rules.push(`[删行时机] ${expand(sd.deleteNode)}`);
  if (rules.length) parts.push(`【操作规则】\n${rules.join('\n')}`);
  // 【列约束】段已删（用户定案：DDL 派生约束行几乎只有「文本/必填/唯一」，表说明的 [列定义] 已写清口径，
  // 每表一段纯占 token；约束仍由引擎侧 validateValue 校验 + 违规回注，不靠模型自觉）。
  // 已有数据（纪要表走精简投影；其余按四档决策，数据未进入＝显式写「空」）
  if (table.v2def?.lensForm === 'summary') {
    parts.push(projectSummaryTable(table));
  } else if (v2DataEntersPrompt(table, ctx)) {
    const lines: string[] = [table.headers.join('|')];
    // G5：trigger 模式的关键词清单/小写正文只算一次（原来每行都重扫全表 + 重做 toLowerCase）。
    const needsRowGate = table.v2def?.readMode === 'trigger';
    let rowGate: RowGateContext | undefined;
    for (const rowId of [...table.rows.keys()].sort((a, b) => a - b)) {
      const cells = table.rows.get(rowId)!;
      if (needsRowGate && !rowGate) rowGate = prepareRowGate(table, ctx);
      if (!v2RowEntersPrompt(table, cells, ctx, rowGate)) continue;
      lines.push(rowProjectionLine(cells));
    }
    parts.push(`【已有数据】（列顺序如下；无行=空表）\n${lines.join('\n')}`);
  } else {
    parts.push(absentProjectionLine());
  }
  return [tableSectionRule(label), ...parts, tableSectionRule(`${label} · 结束`)].join('\n\n');
}

/** 纪要表精简投影（lensForm='summary'）：一句话带过。
 *  历史纪要不铺进请求（由世界书条目 + 推进资料块回放），新行的编码索引也不需要 AI 推算——
 *  引擎在落账前按现有编号补号（见 nextSummaryCodeForValue），所以这里只说"无需参考"。 */
export function projectSummaryTable(_table: TableModel): string {
  return '【已有数据】纪要表无需参考已有数据';
}

/** 表级四档决策：该表数据是否进【当前台账】。 */
export function v2DataEntersPrompt(table: TableModel, _ctx: FillPromptContext): boolean {
  const def = table.v2def;
  if (!def) return false;
  const readMode = def.readMode || 'all';
  if (readMode === 'none') return false;
  if (readMode === 'all') return true;
  // 按触发
  const wb = def.worldbook || ({} as any);
  if (wb.enabled !== true) return false;
  if (wb.mode === 'constant') return true;
  return gatingKeywordsOf(table).length > 0;
}

/** 行内关键词列取值（列缺失/空值 → []）。 */
function keywordValuesOf(table: TableModel, cells: string[], column: unknown): string[] {
  const col = String(column || '');
  if (!col) return [];
  const idx = table.headers.indexOf(col);
  if (idx < 0) return [];
  return splitKeywordValues(String(cells[idx] ?? '').trim());
}

/** 行级判定：关键词触发表按行匹配（与绿灯注入同一逻辑，见 types.ts 的 keywordsLogic）：
 *  - 无：任一拆分关键词出现在处理后的正文段即放行；
 *  - 与：两列都要命中（第一列 AND 第二列）；
 *  - 或：任一列命中即可。 */
/** 行级判定的预计算（G5）：关键词清单与小写正文在表级算一次，行循环里直接复用。 */
export interface RowGateContext { keywords: string[]; text: string; }

export function prepareRowGate(table: TableModel, ctx: FillPromptContext): RowGateContext {
  return {
    keywords: gatingKeywordsOf(table),
    text: String((ctx.keywordText ?? ctx.storyText) || '').toLowerCase(),
  };
}

export function v2RowEntersPrompt(table: TableModel, cells: string[], ctx: FillPromptContext, prepared?: RowGateContext): boolean {
  const def = table.v2def;
  if (!def) return false;
  const readMode = def.readMode || 'all';
  if (readMode !== 'trigger') return true;
  const wb = def.worldbook || ({} as any);
  if (wb.enabled !== true || wb.mode === 'constant') return true;
  const keywords = prepared ? prepared.keywords : gatingKeywordsOf(table);
  if (keywords.length === 0) return false;
  const text = prepared ? prepared.text : String((ctx.keywordText ?? ctx.storyText) || '').toLowerCase();
  if (!text) return false;
  const matched = (values: string[]): boolean => values.some((k) => text.includes(k.toLowerCase()));
  const primary = keywordValuesOf(table, cells, wb.keywordsColumn);
  const logic = wb.keywordsLogic === 'and' || wb.keywordsLogic === 'or' ? wb.keywordsLogic : 'none';
  if (logic === 'none') return matched(primary);
  const secondary = keywordValuesOf(table, cells, wb.keywordsColumn2);
  if (secondary.length === 0) return matched(primary); // 第二列缺值：退回只看第一列（与投影同口径）
  return logic === 'and' ? (matched(primary) && matched(secondary)) : (matched(primary) || matched(secondary));
}

/** 该表全部关键词列的值清单（逻辑为与/或时含第二列；空 → []）。 */
export function gatingKeywordsOf(table: TableModel): string[] {
  const def = table.v2def;
  if (!def) return [];
  const cols: string[] = [];
  const primary = String(def.worldbook?.keywordsColumn || '').trim();
  if (primary) cols.push(primary);
  const logic = def.worldbook?.keywordsLogic;
  const secondary = String(def.worldbook?.keywordsColumn2 || '').trim();
  if ((logic === 'and' || logic === 'or') && secondary && secondary !== primary) cols.push(secondary);
  const out: string[] = [];
  for (const col of cols) {
    const idx = table.headers.indexOf(col);
    if (idx < 0) continue;
    for (const cells of table.rows.values()) {
      const v = String(cells[idx] ?? '').trim();
      if (v) out.push(v);
    }
  }
  return out;
}

/** 关键词值拆分（逗号/顿号/分号/空白，对齐世界书条目 keys 口径）。 */
export function splitKeywordValues(value: string): string[] {
  return String(value || '')
    .split(/[,，、;；\s]+/)
    .map((k) => k.trim())
    .filter(Boolean);
}

/**
 * 内置填表提示词（示例里的 `{{表}}`/`{{列}}` 等标记在装配时按本轮台账的真实表名、列名替换，
 * 见 fillPromptSampleOf / renderFillPromptTemplate）。
 * 为什么不用「表名/列名」这种占位词：它本身就是像样的中文标识符，模型会照抄进 SQL，
 * 而引擎按表名精确匹配（resolveTable）——名字写错整句被拒。示例给真名才能锚住写法。
 */
export const FILL_SYSTEM_PROMPT = [
  '你是严谨的表格记录员，负责根据剧情正文维护数据表。',
  '只输出 SQL 语句（SQLite 语法），以分号结尾；不要输出解释、markdown 代码块或多余文字。示例如下（示例里的表名与列名都取自本轮台账，照这个写法逐字照抄）：',
  "UPDATE {{表}} SET {{列}} = '新值1', {{列2}} = '新值2' WHERE row_id = 3;",
  "UPDATE {{长表}} SET {{长列}} = {{长列}} || '接续的新内容' WHERE row_id = 3;   -- 长文本接续",
  'UPDATE {{数表}} SET {{数列}} = {{数列}} + 2 WHERE row_id = 3;               -- 数字加减（引擎计算，不用心算）',
  "INSERT INTO {{表}} ({{列}}, {{列2}}) VALUES ('值1', '值2');   -- 一句可带多行：VALUES ('v1','v2'),('v3','v4');",
  "INSERT OR REPLACE INTO {{表}} (row_id, {{列}}, {{列2}}) VALUES (3, '新值', '值2');   -- 按固定行号写：行在就地替换、不在则建行（写法限这条）",
  'DELETE FROM {{表}} WHERE row_id = 3;',
  '硬性纪律：',
  '1. 表名、列名一律写中文，逐字照抄本轮【当前台账】：表名见每张表分隔线上的「表 N/M：表名」；自创、简写、翻译或用台账以外的表，都会被引擎整句拒绝。',
  '2. row_id 只用于定位：WHERE 条件，或 INSERT OR REPLACE 的行号（表说明要求按固定行号写时）；普通 INSERT 不要写 row_id。UPDATE / DELETE 必须带 WHERE。',
  '3. 字符串用半角单引号，值内的单引号写成两个；列名含「/」时用反引号（例：`身高/体重`）。',
  '4. 严格遵守每列的约束；增行前先核对【已有数据】：已存在的行必须 UPDATE，不得重复 INSERT。',
  '5. 没有需要记录的变化时，输出空（什么都不写）。',
].join('\n');

/** 示例素材：本轮台账里的真实表名/列名（键＝模板标记名）。取不到时回落中性字面量，保证标记永不残留。 */
export interface FillPromptSample {
  表: string;
  列: string;
  列2: string;
  长表: string;
  长列: string;
  数表: string;
  数列: string;
}

/** 长文本列的名字线索（示例取材用；只影响示例像不像真话，不影响任何校验）。
 *  强线索＝整段成篇的字段；弱线索＝可能长也可能短的描述性字段。 */
const LONG_TEXT_STRONG = ['经历', '日记', '纪要', '记录', '过往'];
const LONG_TEXT_HINTS = ['内容', '描述', '介绍', '状态', '近况', '备注', '说明', '心情'];

/** 数字列的名字线索：v2 列定义一律 TEXT（类型判不出数字），示例取材靠「名字 + 现有取值」双证据。 */
const NUMERIC_NAME_HINTS = ['值', '次数', '数量', '能量', '等级'];

/** 数字列分值：名字像数字且有实测数字值 > 只看名字。有非数字值即否决。 */
function numericSampleScore(v: ColumnValidator, table: TableModel): number {
  const header = String(v.header);
  if (!NUMERIC_NAME_HINTS.some((hint) => header.includes(hint))) return 0;
  const idx = table.headers.indexOf(header);
  if (idx < 0) return 0;
  let seen = 0;
  for (const cells of table.rows.values()) {
    const text = String(cells[idx] ?? '').trim();
    if (!text) continue;
    if (!/^-?\d+(\.\d+)?$/.test(text)) return 0;
    seen += 1;
  }
  return seen > 0 ? 50 : 20;
}

/** 分组内按分值挑一列（row_id 不参选）；无命中返回 null。 */
function bestSampleColumn(
  tables: TableModel[],
  score: (v: ColumnValidator, table: TableModel) => number,
): { table: TableModel; header: string } | null {
  let best: { table: TableModel; header: string; s: number } | null = null;
  for (const table of tables) {
    if (!table?.ddlInfo) continue;
    for (const [header, validator] of buildValidators(table.ddlInfo)) {
      if (validator.isRowId || !header) continue;
      const s = score(validator, table);
      if (s > 0 && (!best || s > best.s)) best = { table, header, s };
    }
  }
  return best ? { table: best.table, header: best.header } : null;
}

/** 内置提示词的示例素材：本轮分组内的真实表名与列名（列按语义线索择优：长文本列 / 数字列）。
 *  主示例表挑「没有行数上限」的表——示例里有 INSERT，固定行数表（如主角信息表=1 行）照抄会被引擎拒。 */
export function fillPromptSampleOf(tables: TableModel[]): FillPromptSample {
  const list = (tables || []).filter((t): t is TableModel => !!t);
  const first = list.find((t) => !(Number(t.ddlInfo?.maxRowCount) > 0)) || list[0];
  const firstHeaders = first?.ddlInfo
    ? [...buildValidators(first.ddlInfo)].filter(([header, v]) => !v.isRowId && header).map(([header]) => header)
    : [];
  const col = firstHeaders[0] || '列名';
  const col2 = firstHeaders[1] || col;
  const long = bestSampleColumn(list, (v) => {
    // 有长度约束的列优先（越长越是长文本），其次看名字线索（强线索 > 弱线索）
    if (typeof v.maxLength === 'number') return 1000 + v.maxLength;
    const header = String(v.header);
    if (LONG_TEXT_STRONG.some((hint) => header.includes(hint))) return 20;
    return LONG_TEXT_HINTS.some((hint) => header.includes(hint)) ? 10 : 0;
  });
  const num = bestSampleColumn(list, numericSampleScore);
  return {
    表: first ? first.name : '表名',
    列: col,
    列2: col2,
    长表: long?.table.name || (first ? first.name : '表名'),
    长列: long?.header || col,
    数表: num?.table.name || (first ? first.name : '表名'),
    数列: num?.header || '计数',
  };
}

/** 模板标记替换（`{{表}}` 等）。无素材时原样返回（纯函数旧调用零改动，也保住「留空=内置」的文本比对语义）。 */
export function renderFillPromptTemplate(text: string, sample?: FillPromptSample | null): string {
  const raw = String(text ?? '');
  if (!sample || !raw.includes('{{')) return raw;
  const map: Record<string, string> = sample as unknown as Record<string, string>;
  return raw.replace(/\{\{([^}]+)\}\}/g, (match, key: string) => {
    const hit = map[String(key).trim()];
    return hit === undefined ? match : hit;
  });
}

/** 填表系统提示词（开放编辑：设置覆盖 > 内置）。
 *  sample 给了就替换示例标记里的真实表名/列名；不给则原样回（UI 的「留空=内置」比对依赖原文一致）。 */
export function fillSystemPromptOf(settings: { fillSystemPrompt?: string }, sample?: FillPromptSample | null): string {
  const custom = String(settings?.fillSystemPrompt || '').trim();
  if (!custom) return sample ? renderFillPromptTemplate(FILL_SYSTEM_PROMPT, sample) : FILL_SYSTEM_PROMPT;
  return sample ? renderFillPromptTemplate(custom, sample) : custom;
}

/** 填表内容项清单（段 + 固定块混排；缺省＝三块默认顺序）。 */
export function fillPromptSpecsOf(settings: { fillPrompt?: unknown }): LedgerPromptItemSpec[] {
  if (Array.isArray(settings?.fillPrompt)) {
    const specs = normalizePromptSpecs(settings.fillPrompt, FILL_BLOCK_IDS);
    if (specs.length > 0) return specs;
  }
  return defaultPromptSpecs(FILL_BLOCK_IDS);
}

/**
 * 编号补号实现见 core/summary-code.ts（SQL 通道在 fill-sql 校验之前调用 assignSummaryCodes）。
 */

/** AI 输出 → 校验结果：走 SQL 通道；空输出＝无变化直接通过，判别不出可执行内容＝点名报错（绝不静默当"无变化"通过）。 */
export function parseFillOutput(book: BookModel, raw: string): ValidationOutcome {
  const text = String(raw || '');
  if (!text.trim()) return { ops: [], errors: [], partial: false };
  const r = runFillSql(book, text); // 纪要编号在 fill-sql 内补（校验之前；见 core/summary-code.ts）
  const outcome: ValidationOutcome = { ops: r.ops, errors: r.errors, partial: r.ops.length > 0 && r.errors.length > 0 };
  if (outcome.ops.length === 0 && outcome.errors.length === 0) {
    // 示例用尖括号占位（不用「表名/列名」这种像真名的词——会被照抄进 SQL）
    outcome.errors.push("未识别到可执行内容（只输出 SQL 语句，形如 UPDATE <表名> SET <列名> = '值' WHERE row_id = 1，表名/列名照抄【当前台账】；一句一行、以分号结尾）");
  }
  return outcome;
}

/** 输出要求句（恒在块之后、尾部破限之前；附加要求追加其后）。逐表核对 + 表名逐字照抄是本句的重点：
 *  分组表清单是隐式的（只体现为资料块里有哪些表段），不点名就等于让模型自己猜该填哪几张。
 *  口径（用户定案）：只留可执行规则——固定行数表的 INSERT OR REPLACE 写法在**表说明**里给（本句不复述）。 */
export const FILL_OUTPUT_INSTRUCTION = [
  '【输出要求】请逐表核对上面【当前台账】里的每一张表（按「表 N/M：表名」的顺序，一张都别跳过），只输出本轮【当前正文】中确实发生变化的内容：',
  '1. 表名、列名逐字照抄台账：表名取每张表分隔线上的「表 N/M：表名」，列名取该表[列定义]/已有数据表头；不得自创、简写、翻译表名。',
  '2. 已存在的行一律 UPDATE … WHERE row_id = ?（row_id 见已有数据首列）；普通新增行才 INSERT，且不写 row_id。',
  '3. 投影写「【已有数据】空」的表：本轮没有可参照的数据，按表说明里的要求插入新行。',
  '4. 每条语句一行、以分号结尾；不要输出解释、markdown 代码块，也不要输出 SELECT。',
  '5. 某张表本轮没有变化就不输出它；所有表都没有变化时输出空（什么都不写）。',
].join('\n');

/** 一次填表请求的 1A 规格（传输层按此装配；重试时只替换输出要求句）。 */
export interface FillRequestSpec {
  task: string;
  items: LedgerPromptItem[];
  blocks: LedgerBlockContents;
  /** 触发注入素材＝本组待填楼层正文（只喂绿灯扫描，不进提示词）。 */
  scanText: string;
  /** 本请求所属分组（按分组独立时选 API；缺省回落分组1）。 */
  groupId: number;
}

/** 组装分组填表请求：结构头任务段＝填表提示词；内容项＝填表内容项清单（段与固定块混排）+ 输出要求句。
 *  提示词素材（表说明/触发提示/任务段/用户段）里的 `{[db…]}` 占位符在此按当前账本就地展开（对齐真数据库插件）；
 *  三个固定块的抬头与功能说明也在此拼（块正文只带数据，抬头随请求种类不同：填表=【当前台账】/推进=【已有纪要】）。 */
export function buildFillRequest(
  book: BookModel,
  group: UpdateGroup,
  ctx: FillPromptContext,
  settings: { fillSystemPrompt?: string; fillPrompt?: unknown },
  instructionOverride?: string,
): FillRequestSpec {
  const tables = group.tableIds
    .map((tableId) => book.tables.get(tableId))
    .filter((t): t is TableModel => !!t);
  const dossierParts = tables.map((table, i) =>
    projectTableForPrompt(table, { ...ctx, book }, { index: i + 1, total: tables.length }));
  const contextBody = String(ctx.storyText || '').trim();
  const blocks: LedgerBlockContents = {
    // 台账抬头＝填表范围声明（配合每表分隔线的「表 N/M：表名」，模型才知道该写哪几张表）
    dossier: dossierParts.length
      ? '【当前台账】\n下面为本轮需要填的表及已有内容：每张表由一行「表 N/M：表名」分隔线框出，只允许填写这里列出的表。\n\n' + dossierParts.join('\n\n')
      : '',
    context: contextBody ? '【当前正文】\n下面为本轮剧情正文，是填表的唯一事实依据。\n\n' + contextBody : '',
    scan: '下面为与本轮填表相关的背景设定与知识条目（世界书条目里关键词命中的参考资料＋当前角色卡设定：用户人设 / 角色卡描述 / 角色性格 / 场景 / 示例对话），供理解人物、地点、关系与既有设定用，不属于本轮正文。',
  };
  let instruction = instructionOverride || FILL_OUTPUT_INSTRUCTION;
  if (ctx.extraRequest && ctx.extraRequest.trim()) {
    instruction += `\n\n【本次附加要求】\n${ctx.extraRequest.trim()}`;
  }
  const items: LedgerPromptItem[] = [
    ...specsToItems(fillPromptSpecsOf(settings)),
    { kind: 'segment', role: 'user', content: instruction },
  ];
  return {
    task: expandTablePlaceholders(book, fillSystemPromptOf(settings, fillPromptSampleOf(tables))),
    items: items.map((item) => (item.kind === 'segment' ? { ...item, content: expandTablePlaceholders(book, item.content) } : item)),
    blocks,
    scanText: contextBody,
    groupId: Number(group.groupId) > 0 ? Math.trunc(Number(group.groupId)) : 1,
  };
}

/** 重试时的错误回注句（保留原输出要求，附上次问题清单）。 */
export function buildFillRetryInstruction(errors: string[]): string {
  return FILL_OUTPUT_INSTRUCTION
    + '\n\n【上次输出存在以下问题，请修正后重新输出全部 SQL 语句（不要解释）】\n'
    + errors.slice(0, 12).map((e) => '- ' + e).join('\n');
}

/** 调度状态推进到指定 AI 楼序（落点已按锚点解析成当前楼层号；**不再**用 raw index 反查）。 */
export function advanceScheduleToFloor(
  schedule: Record<string, number>,
  group: Pick<UpdateGroup, 'tableIds'>,
  aiFloor: number,
): Record<string, number> {
  const floor = Math.max(0, Math.trunc(Number(aiFloor) || 0));
  const next = { ...schedule };
  for (const tableId of group.tableIds) next[tableId] = Math.max(Number(next[tableId]) || 0, floor);
  return next;
}

/** 调度状态推进：组内表全部记到组内最大 AI 楼序（兼容旧签名；内部填表路径一律走 advanceScheduleToFloor）。 */
export function advanceSchedule(schedule: Record<string, number>, group: UpdateGroup, chat: any[]): Record<string, number> {
  let aiFloor = 0;
  let max = 0;
  for (let i = 0; i < chat.length; i++) {
    if (isAnchorCandidate(chat[i])) {
      aiFloor++;
      if (group.indices.includes(i)) max = Math.max(max, aiFloor);
    }
  }
  return advanceScheduleToFloor(schedule, group, max);
}

// ===== 填表执行器（调度 → 请求 → 严格校验 → 错误回注重试 → 落账 → 调度推进） =====

export interface FillerSettings {
  autoFillEnabled?: boolean;
  autoUpdateFrequency?: number;
  autoUpdateThreshold?: number;
  skipUpdateFloors?: number;
  updateBatchSize?: number;
  /** 填表系统提示词覆盖（开放编辑；空 = 内置）。 */
  fillSystemPrompt?: string;
  /** 填表内容项清单（段 + 固定块混排；缺省=三块默认顺序）。 */
  fillPrompt?: unknown;
  /** 校验失败重试次数上限（含首次；缺省 3）。填表与建表向导共用。 */
  fillMaxAttempts?: number;
}

export interface FillerDeps {
  runtime: LedgerRuntime;
  getChat(): any[];
  readSettings(): FillerSettings;
  /** 1A 请求：结构头任务段 + 固定块 + 触发注入 + 扫描钩（受保 generateRaw）。 */
  requestFill(spec: FillRequestSpec, opts?: { signal?: AbortSignal }): Promise<string>;
  refreshWorldbook?(): Promise<boolean> | void;
  warn?(message: string): void;
  /** 进度上报（index.ts 接常驻 toast，原位改文案；三入口共用）。 */
  progress?(event: FillProgressEvent): void;
  /** 失败上报（常驻失败通知；文案由 scribe 汇总错误清单）。 */
  fail?(message: string): void;
  /** 运行日志上报（工作台「日志」页；来源由调用方固定为「填表」）。 */
  report?(event: FillLogEvent): void;
  /** 「在场角色表」所在分组本轮落账完成（自动/手动/定向重填共用）。
   *  状态栏据此做一次在场所角色立绘更新——台账接管时这是立绘更新的**唯一**触发源。 */
  onPresenceTableFilled?(payload: { aiFloor: number; tableNames: string[] }): void;
}

/** 运行日志上报事件（等级与负载照 core/ledger-log 口径；raw＝完整原始 AI 输出，日志页可展开 + 一键复制）。 */
export type FillLogEvent = LedgerLogEvent;

export interface FillSummary {
  skipped: boolean;
  reason?: string;
  groups: number;
  filledOps: number;
  errors: string[];
}

/** 校验失败重试的默认尝试次数（含首次；设置页「重试次数」的缺省值）。 */
export const DEFAULT_FILL_MAX_ATTEMPTS = 3;
/** 尝试次数硬上限：防止误填把一次填表烧成几十次请求。 */
export const FILL_MAX_ATTEMPTS_LIMIT = 10;

/** 「重试次数」解析（填表/建表向导共用；未设置或非法值回落默认，超出上限按上限）。 */
export function resolveFillMaxAttempts(settings?: Pick<FillerSettings, 'fillMaxAttempts'> | null): number {
  const n = Math.trunc(Number(settings?.fillMaxAttempts));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_FILL_MAX_ATTEMPTS;
  return Math.min(n, FILL_MAX_ATTEMPTS_LIMIT);
}

/** 全局调度参数解析（设置覆盖 > 内置默认；缺省值语义见 DEFAULT_SCHEDULE_GLOBALS）。 */
export function resolveScheduleGlobals(settings: FillerSettings): ScheduleGlobals {
  const g = { ...DEFAULT_SCHEDULE_GLOBALS };
  if (settings.autoFillEnabled === false) g.autoUpdateEnabled = false;
  if (Number.isFinite(settings.autoUpdateFrequency) && (settings.autoUpdateFrequency as number) > 0) g.autoUpdateFrequency = settings.autoUpdateFrequency as number;
  if (Number.isFinite(settings.autoUpdateThreshold) && (settings.autoUpdateThreshold as number) > 0) g.autoUpdateThreshold = settings.autoUpdateThreshold as number;
  if (Number.isFinite(settings.skipUpdateFloors) && (settings.skipUpdateFloors as number) >= 0) g.skipUpdateFloors = settings.skipUpdateFloors as number;
  if (Number.isFinite(settings.updateBatchSize) && (settings.updateBatchSize as number) > 0) g.updateBatchSize = settings.updateBatchSize as number;
  return g;
}

function storyTextOfIndices(chat: any[], indices: number[]): string {
  return indices
    .map((i) => (chat[i] && typeof chat[i].mes === 'string' ? chat[i].mes : ''))
    .filter(Boolean)
    .join('\n\n');
}

/** 一批填表的钉住上下文：落点＝窗口最后一个 AI 楼；sources＝本次请求实际读过的全部楼层锚点。 */
interface PinnedFillTarget {
  target: LedgerWriteTarget;
  sources: string[];
}

/** 钉住本组落点与全部来源楼层（indices 恒为升序 AI 楼层下标）。 */
function pinGroupTarget(chat: any[], indices: number[]): PinnedFillTarget | null {
  if (!Array.isArray(indices) || indices.length === 0) return null;
  const sources: string[] = [];
  let target: LedgerWriteTarget | null = null;
  for (const idx of indices) {
    const msg = Array.isArray(chat) ? chat[idx] : null;
    if (!msg || !isAnchorCandidate(msg)) return null;
    const anchor = ledgerAnchorFor(msg, idx);
    if (!anchor) return null;
    if (!sources.includes(anchor)) sources.push(anchor);
    target = { anchor, aiFloor: aiFloorOrdinalAt(chat, idx) };
  }
  return target ? { target, sources } : null;
}

/** 落账前重解析钉住目标：锚点仍在当前聊天时返回**当前**楼层号；已失联返回 null（结果作废）。 */
function resolvePinnedTarget(chat: any[], target: LedgerWriteTarget | null): LedgerWriteTarget | null {
  if (!target) return null;
  const aiFloor = aiFloorOfAnchor(chat, target.anchor);
  return aiFloor === null ? null : { anchor: target.anchor, aiFloor };
}

/** 落账前校验整批钉住上下文：落点活着 + 本次读过的来源楼层都还在。
 *  返回 { target } 或 { error }（错误文案已区分「目标楼」/「上下文中较早楼层」）。 */
function resolvePinnedFillTarget(
  chat: any[],
  pinned: PinnedFillTarget | null,
): { target: LedgerWriteTarget | null; error: string | null } {
  if (!pinned) return { target: null, error: TARGET_GONE };
  const target = resolvePinnedTarget(chat, pinned.target);
  if (!target) return { target: null, error: TARGET_GONE };
  for (const anchor of pinned.sources) {
    if (aiFloorOfAnchor(chat, anchor) === null) return { target: null, error: SOURCE_GONE };
  }
  return { target, error: null };
}

/** 落点失效的统一文案（三入口共用，日志/失败汇总可 grep）。 */
const TARGET_GONE = '目标楼层已失效（填表期间被删除或重生成）：本组结果已作废，请重跑';
/** 来源楼层（本次请求读过的上下文）失效：即使落点还在，结果也基于已变的内容，不能落账。 */
const SOURCE_GONE = '填表上下文楼层已变化（请求期间被删除或重生成）：本组结果已作废，请重跑';

/** G4：复用首次组装的请求，只替换最后的「输出要求句」（buildFillRequest 恒把 instruction 追加为最后一个 user 段）。 */
function withFillInstruction(spec: FillRequestSpec, instruction: string): FillRequestSpec {
  const items = spec.items.slice();
  const last = items[items.length - 1];
  if (last && last.kind === 'segment') items[items.length - 1] = { ...last, content: instruction };
  else items.push({ kind: 'segment', role: 'user', content: instruction });
  return { ...spec, items };
}

/** 附加要求拼在输出要求句之后（首次由 buildFillRequest 拼；重试时由本函数补）。 */
function withExtraRequest(text: string, extra: string | undefined): string {
  const e = String(extra || '').trim();
  return e ? `${text}\n\n【本次附加要求】\n${e}` : text;
}

/**
 * 一次填表请求的完整尝试链（最多 resolveFillMaxAttempts(settings) 发；失败错误回注到输出要求句）。
 * 返回值额外带 `raw`＝最后一次拿到的原始 AI 输出（失败汇总时一并进日志，供展开研究）。
 *
 * G4：资料块/正文/示例只组装一次，重试只替换「输出要求句」——避免每次尝试都做一遍全表投影。
 * 代价：同一轮重试期间若用户并发改了账本，重试看到的是第一次尝试的投影（填表窗口内正常不会发生）。
 */
async function runFillAttempts(
  deps: FillerDeps,
  book: BookModel,
  group: UpdateGroup,
  ctx: FillPromptContext,
  settings: FillerSettings,
  signal: AbortSignal | undefined,
  label: string,
  onRequestError: (message: string) => void,
): Promise<ValidationOutcome & { raw: string; aborted?: boolean; requestFailed?: boolean }> {
  let outcome: ValidationOutcome = { ops: [], errors: [], partial: false };
  let lastRaw = '';
  /** AI 请求本身失败（网络/接口异常）：与「输出违规」一样算本组未成功——调度不得推进。 */
  let requestFailed = false;
  /** 首次尝试组装好的请求（G4）：后续重试只替换最后的输出要求句。 */
  let baseSpec: FillRequestSpec | null = null;
  const maxAttempts = resolveFillMaxAttempts(settings);
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (signal?.aborted) break;
      // 常驻进度通知：第几次尝试原位改文案（数据库「第 A/M 次调用AI」同形；同批多分组并发＝并排一条）
      deps.progress?.({ phase: 'attempt', label, key: group.key, attempt, maxAttempts });
      let raw = '';
      try {
        const spec: FillRequestSpec = baseSpec
          ? withFillInstruction(baseSpec, withExtraRequest(buildFillRetryInstruction(outcome.errors), ctx.extraRequest))
          : buildFillRequest(book, group, ctx, settings);
        if (!baseSpec) baseSpec = spec;
        raw = await deps.requestFill(spec, { signal });
      } catch (e) {
        // 用户点了进度通知终止（abort 会让请求报错）→ 不当失败报，交给调用方收「已终止」
        if (signal?.aborted) break;
        requestFailed = true;
        // 请求级失败单独进日志：旧实现只在最终汇总里留一行 message，异常对象的状态码/响应体/
        // 原因/堆栈全丢（比酒馆与供应商侧看到的错误少一截）。这里带完整原文 + 上次拿到的原始输出。
        deps.report?.({
          level: 'error',
          message: `${label} AI 请求失败（第 ${attempt}/${maxAttempts} 次）`,
          detail: describeErrorDetail(e),
          raw: lastRaw,
        });
        onRequestError(describeErrorSummary(e));
        break;
      }
      lastRaw = String(raw || '');
      outcome = parseFillOutput(book, raw);
      if (outcome.errors.length === 0) break;
      // 每次尝试的违规明细进运行日志（toast 只留最终汇总；这里的清单与原始输出才是排查证据）
      deps.report?.({
        level: 'warn',
        message: `${label} 第 ${attempt}/${maxAttempts} 次尝试：${outcome.errors.length} 项违规未落账`,
        detail: outcome.errors.join('\n'),
        raw: lastRaw,
      });
    }
  } finally {
    // 本请求收尾：并发形态下只摘自己那条（不带 key 的 end＝全清，由三个 runner 在收尾发）
    deps.progress?.({ phase: 'end', key: group.key, label });
  }
  // 用户终止：本次尝试链的任何半成品都不落账（B11）；调用方据 aborted 收「已终止」。
  if (signal?.aborted) return { ops: [], errors: [], partial: false, raw: lastRaw, aborted: true };
  return { ...outcome, raw: lastRaw, requestFailed };
}

/** 本次填表是否有失败需要常驻告警（AI 请求失败 / 重试耗尽仍有违规 / 落账失败）。 */
function reportFillFailure(deps: FillerDeps, errors: string[], raw = ''): void {
  if (errors.length === 0) return;
  deps.fail?.(fillFailureText(errors));
  deps.report?.({ level: 'error', message: fillFailureText(errors), detail: errors.join('\n'), raw });
}

/** 本组是否完整成功（调度推进的唯一条件）：AI 请求失败或重试耗尽仍有违规＝失败，下次重试本批；
 *  空输出（明确无变化）＝成功，照常推进（防空转重试）。 */
function fillGroupSucceeded(outcome: ValidationOutcome & { requestFailed?: boolean }): boolean {
  return outcome.requestFailed !== true && outcome.errors.length === 0;
}

/** 本轮立绘触发的唯一依据：在场角色表名（与状态栏 `ledgerPresenceFilled` 消费方同口径，改表名必须两侧同步）。 */
const PRESENCE_TABLE_NAME = '在场角色表';

/** 分组落账成功且该分组含「在场角色表」→ 通知状态栏本轮到齐。
 *  每轮只在**该分组成功**时发一次（失败/终止/作废不发）；其它任何表的落账都不会触发立绘。 */
function notifyPresenceTableFilled(
  deps: FillerDeps,
  tableNames: string[],
  aiFloor: number | null | undefined,
): void {
  if (!Array.isArray(tableNames) || !tableNames.includes(PRESENCE_TABLE_NAME)) return;
  try {
    deps.onPresenceTableFilled?.({
      aiFloor: Math.max(0, Math.trunc(Number(aiFloor) || 0)),
      tableNames: tableNames.slice(),
    });
  } catch (_e) { /* 监听方故障不得阻塞填表 */ }
}

/** 三入口统一的「跳过原因」上报（「为什么这轮没填表」的排查入口；新增跳过分支自动覆盖，不必逐处补）。 */
function reportSkip(deps: FillerDeps, prefix: string, summary: FillSummary): FillSummary {
  if (summary.skipped && summary.reason) deps.report?.({ level: 'info', message: `${prefix}：${summary.reason}` });
  return summary;
}

/** 执行一次自动填表（全部到期分组）。单写者：与用户写天然互斥。 */
export async function runScheduledFill(deps: FillerDeps, opts: { signal?: AbortSignal } = {}): Promise<FillSummary> {
  return reportSkip(deps, '跳过自动填表', await runScheduledFillCore(deps, opts));
}

async function runScheduledFillCore(deps: FillerDeps, opts: { signal?: AbortSignal } = {}): Promise<FillSummary> {
  const summary: FillSummary = { skipped: false, groups: 0, filledOps: 0, errors: [] };
  const chat = deps.getChat();
  if (!Array.isArray(chat) || chat.length < 2) {
    summary.skipped = true;
    summary.reason = '聊天太短';
    return summary;
  }
  const settings = deps.readSettings();
  const globals = resolveScheduleGlobals(settings);
  if (!globals.autoUpdateEnabled) {
    summary.skipped = true;
    summary.reason = '自动填表已关闭';
    return summary;
  }
  if (!deps.runtime.isReady()) {
    const ok = await deps.runtime.ensureSeeded();
    if (!ok) {
      summary.skipped = true;
      summary.reason = '台账未就绪';
      return summary;
    }
  }
  const book = deps.runtime.book()!;
  syncV2UpdateConfigs(book);
  let schedule = deps.runtime.getSchedule();
  /** 最后一次拿到的原始 AI 输出（失败汇总时一并进日志，供展开研究）。 */
  let lastRaw = '';
  const plan = computeUpdatePlan(book, chat, schedule, globals);
  if (plan.length === 0) {
    summary.skipped = true;
    summary.reason = '无到期分组';
    return summary;
  }
  deps.runtime.notifyFillStart();
  /** 排期改成「每桶落账后写一次」（同桶多组仍只写一次），投影整轮收一次——硬中断不丢已完成批次的进度。 */
  let scheduleDirty = false;
  let dataMayHaveChanged = false;
  try {
    // 同批（待填楼层窗口相同）的各分组**并发请求**，一批全部收齐再落账、再换下一批（对齐数据库插件的 bucket 语义）
    for (const bucketGroups of bucketPlanByWindow(plan)) {
      if (opts.signal?.aborted) break;
      const settled = await Promise.allSettled(bucketGroups.map(async (group): Promise<{ group: UpdateGroup; outcome: ValidationOutcome & { raw: string; aborted?: boolean }; target: PinnedFillTarget } | null> => {
        // 落点与来源楼层先钉住：请求期间的楼层增删/位移都不能改变本组结果该记到哪一层。
        const target = pinGroupTarget(chat, group.indices);
        if (!target) {
          summary.errors.push(`分组[${group.tableNames.join('、')}]：找不到可写目标楼层（AI 楼已不存在），本组跳过`);
          deps.report?.({ level: 'error', message: `跳过填表：${groupLabelOf(group)} 目标楼层不存在` });
          return null;
        }
        // 上下文只用 AI 回复（indices 恒为 AI 楼层）；过主项目「上下文标签剥离」（设置 → API）
        const storyText = stripWithContextConfig(storyTextOfIndices(chat, group.indices));
        if (!storyText.trim()) return null;
        const ctx: FillPromptContext = { storyText, keywordText: storyText };
        const label = groupLabelOf(group);
        deps.report?.({ level: 'info', message: `开始填表：${label}（${group.indices.length} 层，落点楼${target.target.aiFloor}）` });
        const outcome = await runFillAttempts(deps, book, group, ctx, settings, opts.signal, label, (message) => {
          summary.errors.push(`分组[${group.tableNames.join('、')}] AI 请求失败：${message}`);
        });
        return { group, outcome, target };
      }));
      settled.forEach((s, i) => {
        if (s.status === 'rejected') {
          const message = s.reason instanceof Error ? s.reason.message : String(s.reason);
          summary.errors.push(`分组[${bucketGroups[i].tableNames.join('、')}] AI 请求失败：${message}`);
        }
      });
      // 落账与调度推进按组序串行（写路径单写者；同一批各分组读的是同一份基线）
      for (const s of settled) {
        if (s.status !== 'fulfilled' || !s.value) continue;
        const { group, outcome, target } = s.value;
        if (outcome.raw) lastRaw = outcome.raw;
        // 用户终止：本次尝试链的半成品不落账（B11）
        if (outcome.aborted || opts.signal?.aborted) {
          summary.skipped = true;
          summary.reason = '已终止（用户点击进度通知终止）';
          break;
        }
        // 填表期间账本被整本替换 → 本批结果作废（结构已变，按陈旧结构落账会大面积被拒）
        if (deps.runtime.book() !== book) {
          summary.skipped = true;
          summary.reason = '账本在填表期间被替换（回滚/切模板/导入/切聊天），本批结果已作废，请重跑';
          break;
        }
        // 钉住的落点/来源楼层已失联（被删/重生成）：本组结果作废，不落账、不推进水位（下次会重试本批）。
        const { target: resolved, error: targetError } = resolvePinnedFillTarget(deps.getChat(), target);
        if (!resolved) {
          summary.errors.push(`分组[${group.tableNames.join('、')}]：${targetError}`);
          deps.report?.({ level: 'error', message: `填表结果作废：${groupLabelOf(group)} ${targetError}`, raw: outcome.raw || undefined });
          continue;
        }
        let commitFailed = false;
        let commitAt: LedgerWriteTarget | undefined;
        if (outcome.ops.length > 0) {
          const commit = deps.runtime.commitOps('ai', outcome.ops, { target: resolved });
          commitFailed = !commit.ok;
          commitAt = commit.at;
          if (commit.ok) summary.filledOps += outcome.ops.length;
          if (commitFailed) {
            const prefix = `分组[${group.tableNames.join('、')}]`;
            if (commit.errors.length) summary.errors.push(...commit.errors.map((e) => `${prefix}：${e}`));
            deps.report?.({
              level: 'error',
              message: `填表落账失败：${group.tableNames.join('、')}（${outcome.ops.length} 条操作未全部落账）`,
              detail: commit.errors.length ? commit.errors.join('\n') : '写入失败',
              raw: outcome.raw || undefined,
            });
          } else {
            deps.report?.({ level: 'info', message: `填表落账：${group.tableNames.join('、')} × ${outcome.ops.length} 条操作` });
          }
        }
        if (outcome.errors.length > 0) {
          // 重试耗尽：半成功（合法操作已落账）+ 告警（汇总进常驻失败通知）
          summary.errors.push(...outcome.errors.slice(0, 5).map((e) => `分组[${group.tableNames.join('、')}] 违规未落账：${e}`));
        }
        summary.groups++;
        if (commitFailed) {
          // 写账失败：不推进调度，下次会重试本批（B12）
          summary.errors.push(`分组[${group.tableNames.join('、')}]：落账失败，调度未推进（下次会重试本批）`);
        } else if (!fillGroupSucceeded(outcome)) {
          // AI 请求失败 / 重试耗尽仍有违规：本组停在上次填写的层，下次自动重试本批
          summary.errors.push(`分组[${group.tableNames.join('、')}]：本次填表未成功，调度未推进（下次会重试本批）`);
        } else {
          // 调度推进（空填也推进，防空转重试）；楼层号以钉住锚点解析出的**当前**序号为准。
          schedule = advanceScheduleToFloor(schedule, group, resolved.aiFloor);
          scheduleDirty = true;
          // 本组含在场角色表且本轮已完成 → 唯一一次立绘信号（空填/无变化也发：每轮一次）。
          notifyPresenceTableFilled(deps, group.tableNames, commitAt?.aiFloor ?? resolved.aiFloor);
        }
        if (outcome.ops.length > 0) dataMayHaveChanged = true;
      }
      // 水位每桶落账后立即持久化：刷新/关页/崩溃等硬中断时，已完成批次的进度不丢。
      // 先 flush 本批数据再写水位（flush 失败不推进）——避免「水位前进、数据没落盘」的倒挂；同桶多组仍只写一次。
      if (scheduleDirty) {
        try {
          if (await deps.runtime.flush() && await deps.runtime.patchSchedule(schedule)) scheduleDirty = false;
        } catch (_e) { /* 收尾 finally 重试 */ }
      }
      if (summary.skipped || opts.signal?.aborted) break;
    }
  } finally {
    // 兜底：本桶水位写失败（或收尾前被终止）时再试一次；先落数据再写水位。
    if (scheduleDirty) {
      try {
        if (await deps.runtime.flush()) await deps.runtime.patchSchedule(schedule);
      } catch (_e) { /* 落盘失败由 store 错误通道上报 */ }
    }
    // 投影整轮收一次：一组成功、另一组失败也要刷新（abort 也执行，保留已完成组的结果）。
    if (dataMayHaveChanged) void deps.refreshWorldbook?.();
    deps.progress?.({ phase: 'end' });
  }
  // 用户点进度通知终止：收「已终止」而不是失败（abort 触发的请求错误不当违规告警）
  if (opts.signal?.aborted) {
    summary.skipped = true;
    summary.reason = '已终止（用户点击进度通知终止）';
    return summary;
  }
  reportFillFailure(deps, summary.errors, lastRaw);
  return summary;
}

/** 手动填表范围（对齐数据库手动填表三模式）。**停用组（频率 0）的表任何 scope 都不选**（见 pickManualTables）。 */
export interface ManualFillOptions {
  /** all-updatable = 所在组频率>0 的全部表；group = 指定分组整体；pick = 勾选表格。
   *  **三模式一律排除停用组（频率 0）的表**：停用组＝不自动更新、不参与手动/定向填表、不注入世界书。 */
  scope?: 'all-updatable' | 'group' | 'pick';
  groupId?: number;
  tableRefs?: string[];
  /** 处理最近 N 层（默认 = 全局触达层数）。 */
  recentFloors?: number;
  /** 每 N 层合并为一次请求（默认 3）。 */
  mergeEvery?: number;
  /** 本次附加要求（一次性）。 */
  extraRequest?: string;
  /**
   * 手动填表前的「清空所选表在该批楼层的增量」确认（口径 A，用户定案）：
   * 先按「所选表 × 覆盖楼层」预演将清空的条目/操作数，由调用方弹确认。
   * **返回 false = 取消本次填表**（不清理、也不发请求）；返回 true = 清空后继续。
   * 未提供时 = 跳过清理（保持旧行为），便于自动链/测试无 UI 环境。
   */
  confirmPrune?: (info: { tables: string[]; floors: number; entries: number; ops: number }) => boolean | Promise<boolean>;
}

/** 手动填表：三模式范围 + 层数参数 + 附加要求；忽略调度直接跑一轮，跑完推进到当前楼层。 */
export async function runManualFill(deps: FillerDeps, opts: ManualFillOptions = {}, signal?: AbortSignal): Promise<FillSummary> {
  return reportSkip(deps, '跳过手动填表', await runManualFillCore(deps, opts, signal));
}

async function runManualFillCore(deps: FillerDeps, opts: ManualFillOptions = {}, signal?: AbortSignal): Promise<FillSummary> {
  const summary: FillSummary = { skipped: false, groups: 0, filledOps: 0, errors: [] };
  const options: ManualFillOptions = opts || {};
  const chat = deps.getChat();
  if (!deps.runtime.isReady()) {
    const ok = await deps.runtime.ensureSeeded();
    if (!ok) { summary.skipped = true; summary.reason = '台账未就绪'; return summary; }
  }
  let book = deps.runtime.book()!;
  syncV2UpdateConfigs(book);
  const settings = deps.readSettings();
  const globals = { ...resolveScheduleGlobals(settings), autoUpdateEnabled: true };
  let tables = pickManualTables(book, options);
  if (tables.length === 0) { summary.skipped = true; summary.reason = manualEmptyReason(book, options); return summary; }
  const recent = Math.max(1, Math.trunc(Number(options.recentFloors) || globals.autoUpdateThreshold));
  const mergeEvery = Math.max(1, Math.trunc(Number(options.mergeEvery) || globals.updateBatchSize));
  const aiIndices: number[] = [];
  for (let i = 0; i < chat.length; i++) if (isAnchorCandidate(chat[i])) aiIndices.push(i);
  const window = aiIndices.slice(-recent);
  const batches: number[][] = [];
  for (let i = 0; i < window.length; i += mergeEvery) batches.push(window.slice(i, i + mergeEvery));
  // 清空所选表在该批楼层的旧增量（口径 A）：手动填表＝这些表在这些层重来一遍；其他表/其他功能的写入不受影响。
  if (options.confirmPrune) {
    const anchors = new Set<string>();
    for (const i of window) {
      const anchor = ledgerAnchorFor(chat[i], i);
      if (anchor) anchors.add(anchor);
    }
    const tableIds = tables.map((t) => t.tableId);
    const preview = deps.runtime.countTableIncrements(anchors, tableIds);
    if (preview && (preview.entries > 0 || preview.ops > 0)) {
      const ok = await options.confirmPrune({ tables: tables.map((t) => t.name), floors: anchors.size, entries: preview.entries, ops: preview.ops });
      if (!ok) {
        // H4：点「取消」= 取消整个手动填表，不再"跳过清空继续填"。
        summary.skipped = true;
        summary.reason = '已取消（未清空增量，也未填表）';
        return summary;
      }
      const pruned = deps.runtime.pruneTableIncrements(anchors, tableIds);
      if (pruned) deps.report?.({ level: 'info', message: `手动填表前清空增量：${pruned.entries} 条目 / ${pruned.ops} 操作（${tables.length} 表 × ${anchors.size} 层）` });
      // 裁剪＝快照重放整本换新：先前持有的 book/表引用全部陈旧，必须重取（红线）
      book = deps.runtime.book()!;
      syncV2UpdateConfigs(book);
      tables = pickManualTables(book, options);
      if (tables.length === 0) { summary.skipped = true; summary.reason = manualEmptyReason(book, options); return summary; }
    }
  }
  deps.runtime.notifyFillStart();
  let schedule = deps.runtime.getSchedule();
  /** 最后一次拿到的原始 AI 输出（失败汇总时一并进日志，供展开研究）。 */
  let lastRaw = '';
  // 楼层批为屏障、同批各分组**并发请求**（different 组的表不混在同一次请求里；批间串行）
  const buckets = splitTablesByGroup(tables, groupsOf(book));
  const multiGroup = buckets.length > 1;
  const slotOf = (bucket: { groupId: number; groupName: string; tables: TableModel[] }, bi: number, batch: number[]): UpdateGroup => ({
    key: `manual|${bucket.groupId}|${bi}`,
    tableIds: bucket.tables.map((t) => t.tableId),
    tableNames: bucket.tables.map((t) => t.name),
    indices: batch,
    batchSize: mergeEvery,
    groupId: bucket.groupId,
    groupName: bucket.groupName,
  });
  /** G7：手动填表也整轮只写一次排期（同批多组不再每组写一次 book 文件）。 */
  let scheduleDirty = false;
  try {
    for (let bi = 0; bi < batches.length; bi++) {
      if (signal?.aborted) break;
      const batch = batches[bi];
      // 本批落点先钉住（批内最后一条 AI 楼）；请求期间楼层增删/位移不改落点。
      const target = pinGroupTarget(chat, batch);
      if (!target) {
        summary.errors.push(`手动填表第 ${bi + 1} 批：找不到可写目标楼层（AI 楼已不存在），本批跳过`);
        continue;
      }
      // 同批各分组同时发出（同一批读同一份基线）；全部收齐后按组序落账，最后才进下一批
      const storyText = stripWithContextConfig(storyTextOfIndices(chat, batch));
      const settled = await Promise.allSettled(buckets.map(async (bucket) => {
        const group = slotOf(bucket, bi, batch);
        const label = manualFillLabel('手动填表', bucket, multiGroup, bi, batches.length);
        const ctx: FillPromptContext = { storyText, keywordText: storyText, extraRequest: options.extraRequest };
        deps.report?.({ level: 'info', message: `开始填表：${label}（${batch.length} 层 × ${bucket.tables.length} 表，落点楼${target.target.aiFloor}）` });
        const outcome = await runFillAttempts(deps, book, group, ctx, settings, signal, label, (message) => {
          summary.errors.push(`AI 请求失败：${message}`);
        });
        return { bucket, group, outcome, target };
      }));
      settled.forEach((s, i) => {
        if (s.status === 'rejected') {
          const message = s.reason instanceof Error ? s.reason.message : String(s.reason);
          summary.errors.push(`分组[${buckets[i].tables.map((t) => t.name).join('、')}] AI 请求失败：${message}`);
        }
      });
      for (const s of settled) {
        if (s.status !== 'fulfilled') continue;
        const { bucket, group, outcome, target } = s.value;
        const names = bucket.tables.map((t) => t.name);
        if (outcome.raw) lastRaw = outcome.raw;
        // 用户终止：本次尝试链的半成品不落账（B11）
        if (outcome.aborted || signal?.aborted) {
          summary.skipped = true;
          summary.reason = '已终止（用户点击进度通知终止）';
          break;
        }
        // 填表期间账本被整本替换（时光机回滚/切模板/导入/切聊天）→ 本批结果作废（避免按陈旧结构落账）
        if (deps.runtime.book() !== book) {
          summary.skipped = true;
          summary.reason = '账本在填表期间被替换（回滚/切模板/导入/切聊天），本批结果已作废，请重跑';
          break;
        }
        // 钉住的落点/来源楼层已失联：本组结果作废，不落账、不推进水位。
        const { target: resolved, error: targetError } = resolvePinnedFillTarget(deps.getChat(), target);
        if (!resolved) {
          summary.errors.push(`分组[${names.join('、')}]：${targetError}`);
          deps.report?.({ level: 'error', message: `手动填表结果作废：${names.join('、')} ${targetError}`, raw: outcome.raw || undefined });
          continue;
        }
        let commitFailed = false;
        let commitAt: LedgerWriteTarget | undefined;
        if (outcome.ops.length > 0) {
          const commit = deps.runtime.commitOps('ai', outcome.ops, { target: resolved });
          commitFailed = !commit.ok;
          commitAt = commit.at;
          if (commit.ok) summary.filledOps += outcome.ops.length;
          if (commitFailed) {
            if (commit.errors.length) summary.errors.push(...commit.errors);
            deps.report?.({
              level: 'error',
              message: `手动填表落账失败：${names.join('、')}（${outcome.ops.length} 条操作未全部落账）`,
              detail: commit.errors.length ? commit.errors.join('\n') : '写入失败',
              raw: outcome.raw || undefined,
            });
          } else {
            deps.report?.({ level: 'info', message: `填表落账：${names.join('、')} × ${outcome.ops.length} 条操作` });
          }
        }
        if (outcome.errors.length > 0) {
          summary.errors.push(...outcome.errors.slice(0, 5).map((e) => `违规未落账：${e}`));
        }
        summary.groups++;
        if (commitFailed) {
          // 写账失败：不推进调度，下次重试本批（B12）
          summary.errors.push(`分组[${names.join('、')}]：落账失败，调度未推进（下次会重试本批）`);
        } else if (!fillGroupSucceeded(outcome)) {
          // AI 请求失败 / 重试耗尽仍有违规：本组停在上次填写的层，下次重试本批
          summary.errors.push(`分组[${names.join('、')}]：本次填表未成功，调度未推进（下次会重试本批）`);
        } else {
          schedule = advanceScheduleToFloor(schedule, group, resolved.aiFloor);
          scheduleDirty = true;
          // 手动填表同样只在「含在场角色表的分组成功」时发一次信号（与自动链同口径）。
          notifyPresenceTableFilled(deps, names, commitAt?.aiFloor ?? resolved.aiFloor);
        }
      }
      // 水位每批落账后立即持久化：刷新/关页/崩溃等硬中断时，已完成批次的进度不丢。
      // 先 flush 本批数据再写水位（flush 失败不推进）——避免「水位前进、数据没落盘」的倒挂；同批多组仍只写一次。
      if (scheduleDirty) {
        try {
          if (await deps.runtime.flush() && await deps.runtime.patchSchedule(schedule)) scheduleDirty = false;
        } catch (_e) { /* 收尾 finally 重试 */ }
      }
      if (summary.skipped || signal?.aborted) break;
    }
  } finally {
    // 兜底：本批水位写失败（或收尾前被终止）时再试一次；先落数据再写水位。
    if (scheduleDirty) {
      try {
        if (await deps.runtime.flush()) await deps.runtime.patchSchedule(schedule);
      } catch (_e) { /* 落盘失败由 store 错误通道上报 */ }
    }
    deps.progress?.({ phase: 'end' });
  }
  void deps.refreshWorldbook?.();
  // 用户点进度通知终止：收「已终止」而不是失败（abort 触发的请求错误不当违规告警）
  if (signal?.aborted) {
    summary.skipped = true;
    summary.reason = '已终止（用户点击进度通知终止）';
    return summary;
  }
  reportFillFailure(deps, summary.errors, lastRaw);
  return summary;
}

/** 手动/定向填表三模式选表（**停用组一律排除**：频率 0 的表不自动更新，也不参与任何手动填表）。 */
export function pickManualTables(book: BookModel, opts: ManualFillOptions): TableModel[] {
  return manualCandidates(book, opts).filter((t) => !isStoppedTable(t));
}

/** 范围内的候选表（**未**过滤停用组）——只给跳过原因文案用；与 pickManualTables 同源，不会漂移。 */
function manualCandidates(book: BookModel, opts: ManualFillOptions): TableModel[] {
  const sorted = [...book.tables.values()].sort((a, b) => a.orderNo - b.orderNo);
  const scope = opts.scope || 'all-updatable';
  if (scope === 'group') {
    const gid = Number(opts.groupId);
    return sorted.filter((t) => t.v2def ? Number(t.v2def.groupId) === gid : false);
  }
  if (scope === 'pick') {
    const refs = opts.tableRefs || [];
    if (refs.length === 0) return sorted;
    return sorted.filter((t) => refs.some((r) => r === t.name || r === t.tableId));
  }
  return sorted; // all-updatable：范围＝全部表（停用组由 pickManualTables 统一排除）
}

/** 空结果的跳过原因：候选非空但全被停用组过滤 → 点名，否则「无匹配表」。 */
function manualEmptyReason(book: BookModel, opts: ManualFillOptions): string {
  return manualCandidates(book, opts).length > 0 ? '所选表都在频率 0 分组（不参与填表）' : '无匹配表';
}

/** 定向重填（时光机「回滚并重新填表」）：给定表 + 指定楼层正文跑一次填表。 */
export async function runRefillForStory(
  deps: FillerDeps,
  tableRefs: string[],
  storyText: string,
  signal?: AbortSignal,
  target?: LedgerWriteTarget,
): Promise<FillSummary> {
  return reportSkip(deps, '跳过定向重填', await runRefillForStoryCore(deps, tableRefs, storyText, signal, target));
}

async function runRefillForStoryCore(
  deps: FillerDeps,
  tableRefs: string[],
  storyText: string,
  signal?: AbortSignal,
  target?: LedgerWriteTarget,
): Promise<FillSummary> {
  const summary: FillSummary = { skipped: false, groups: 0, filledOps: 0, errors: [] };
  if (!deps.runtime.isReady()) { summary.skipped = true; summary.reason = '台账未就绪'; return summary; }
  // 回滚重填必须钉住被回滚的那一层：楼层已不存在时直接跳过（绝不改记到尾楼）。
  if (target && aiFloorOfAnchor(deps.getChat(), target.anchor) === null) {
    summary.skipped = true;
    summary.reason = '目标楼层已失效（可能已删除或重生成），本次重填已作废';
    return summary;
  }
  const book = deps.runtime.book()!;
  const settings = deps.readSettings();
  const tables = pickManualTables(book, { scope: 'pick', tableRefs });
  if (tables.length === 0 || !storyText.trim()) {
    summary.skipped = true;
    summary.reason = manualEmptyReason(book, { scope: 'pick', tableRefs }) === '无匹配表'
      ? '无匹配表或正文为空'
      : '所选表都在频率 0 分组（不参与填表）';
    return summary;
  }
  deps.runtime.notifyFillStart();
  const filtered = stripWithContextConfig(storyText);
  const ctx: FillPromptContext = { storyText: filtered, keywordText: filtered };
  // 同一次定向重填＝一批：各分组**并发请求**（不同组的表不混在同一次请求里，同手动填表口径）
  const buckets = splitTablesByGroup(tables, groupsOf(book));
  const multiGroup = buckets.length > 1;
  let terminated = false;
  /** 最后一次拿到的原始 AI 输出（失败汇总时一并进日志，供展开研究）。 */
  let lastRaw = '';
  try {
    const settled = signal?.aborted
      ? []
      : await Promise.allSettled(buckets.map(async (bucket) => {
        const group: UpdateGroup = {
          key: `refill|${bucket.groupId}`,
          tableIds: bucket.tables.map((t) => t.tableId),
          tableNames: bucket.tables.map((t) => t.name),
          indices: [],
          batchSize: 1,
          groupId: bucket.groupId,
          groupName: bucket.groupName,
        };
        const label = manualFillLabel('定向重填', bucket, multiGroup, 0, 1);
        const outcome = await runFillAttempts(deps, book, group, ctx, settings, signal, label, (message) => {
          summary.errors.push(`AI 请求失败：${message}`);
        });
        return { bucket, group, outcome };
      }));
    if (signal?.aborted) terminated = true;
    settled.forEach((s, i) => {
      if (s.status === 'rejected') {
        const message = s.reason instanceof Error ? s.reason.message : String(s.reason);
        summary.errors.push(`分组[${buckets[i].tables.map((t) => t.name).join('、')}] AI 请求失败：${message}`);
      }
    });
    // 请求期间目标楼可能被删/重生成：落账前重解析；失联则整批作废（不落账、不改记到尾楼）。
    const resolvedTarget = target ? resolvePinnedTarget(deps.getChat(), target) : null;
    const targetGone = !!target && !resolvedTarget;
    if (targetGone) {
      summary.skipped = true;
      summary.reason = TARGET_GONE;
      summary.errors.push(TARGET_GONE);
    }
    for (const s of settled) {
      if (targetGone) break;
      if (s.status !== 'fulfilled') continue;
      const { bucket, outcome } = s.value;
      const names = bucket.tables.map((t) => t.name);
      if (outcome.raw) lastRaw = outcome.raw;
      // 用户终止：本次尝试链的半成品不落账（B11）
      if (outcome.aborted || signal?.aborted) {
        terminated = true;
        break;
      }
      if (deps.runtime.book() !== book) {
        summary.skipped = true;
        summary.reason = '账本在填表期间被替换（回滚/切模板/导入/切聊天），本批结果已作废，请重跑';
        break;
      }
      if (outcome.ops.length > 0) {
        const commit = deps.runtime.commitOps('ai', outcome.ops, resolvedTarget ? { target: resolvedTarget } : undefined);
        if (commit.ok) summary.filledOps += outcome.ops.length;
        else {
          if (commit.errors.length) summary.errors.push(...commit.errors);
          deps.report?.({
            level: 'error',
            message: `定向重填落账失败：${names.join('、')}（${outcome.ops.length} 条操作未全部落账）`,
            detail: commit.errors.length ? commit.errors.join('\n') : '写入失败',
            raw: outcome.raw || undefined,
          });
        }
        if (commit.ok) {
          deps.report?.({ level: 'info', message: `定向重填落账：${names.join('、')} × ${outcome.ops.length} 条操作` });
          // 定向重填含在场角色表且已落账 → 同样是一次「本轮更新完成」信号。
          notifyPresenceTableFilled(deps, names, commit.at?.aiFloor ?? resolvedTarget?.aiFloor);
        }
      }
      if (outcome.errors.length > 0) {
        summary.errors.push(...outcome.errors.slice(0, 5).map((e) => `违规未落账：${e}`));
      }
      if (outcome.ops.length > 0) summary.groups += 1;
    }
  } finally {
    deps.progress?.({ phase: 'end' });
  }
  void deps.refreshWorldbook?.();
  if (terminated || signal?.aborted) {
    summary.skipped = true;
    summary.reason = '已终止（用户点击进度通知终止）';
    return summary;
  }
  // 定向重填成功后把水位推进到被重填的那一层：否则下一轮自动填表会把同一层再填一遍。
  // 只在「目标楼仍有效 + 没被跳过 + 没有违规」时推进；失败/半成功保留水位让下一轮重试。
  const resolved = target ? resolvePinnedTarget(deps.getChat(), target) : null;
  if (resolved && !summary.skipped && summary.errors.length === 0) {
    const schedule = advanceScheduleToFloor(
      deps.runtime.getSchedule(),
      { tableIds: tables.map((table) => table.tableId) },
      resolved.aiFloor,
    );
    try {
      // 先落数据再写水位（与三入口同口径）；写失败保留低水位，下一轮重试本层。
      if (await deps.runtime.flush()) await deps.runtime.patchSchedule(schedule);
    } catch (_e) { /* 落盘失败由 store 错误通道上报 */ }
  }
  reportFillFailure(deps, summary.errors, lastRaw);
  return summary;
}
