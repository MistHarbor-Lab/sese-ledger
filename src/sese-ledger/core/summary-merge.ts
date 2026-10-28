// ===== 纪要合并：台账独立标签的算法与服务 =====
//
// 四种模式：
//   · fixed     按段大小（每 N 条原始纪要一段）
//   · time      时间智能（每 N 小时一段）
//   · average   平均合并（目标 N 合 1；连续累加，首次达到 N 即收段；末段不足 N 单独保留）
//   · frontback 前略后详（合并成 M 条；前 50% 每条压更多、后 25% 每条压更少；
//               只影响几合一，不改变每条纪要的字数上限）
//
// 合并数（几合一）由台账独占的 summary-merge-markers 维护；本模块只读计数、提交后写回。
// 写库走 runtime.commitOps（一次记账条目，时光机可回退）；不做 DELETE+INSERT 整表重插。
// 纯算法函数全部导出，便于 node --test 直接覆盖。

import { applyOp, resolveColumn, specialFormOf, type BookModel, type TableModel } from './book';
import { cloneBookForDryRun } from './fill-sql';
import type { LedgerOp } from './types';
import type { SummaryMergeMarkerStore } from './summary-merge-markers';

export interface SummaryMergeRow {
  rowId: number;
  code: string;
  timeSpan: string;
  summary: string;
  chronicleText: string;
  keyDialogue: string;
  mergeCount: number;
}

export type SummaryMergeMode = 'fixed' | 'time' | 'average' | 'frontback';

export interface SummaryMergeConfig {
  mode: SummaryMergeMode;
  /** fixed/time 的范围（row_id，含两端）；缺省＝整表。 */
  startRow?: number;
  endRow?: number;
  fixedSize?: number;
  thresholdHours?: number;
  targetAverage?: number;
  targetRows?: number;
  weights?: { front: number; mid: number; back: number };
  maxRetries?: number;
  maxWords?: number;
}

export type SummarySegmentStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped' | 'omitted';

export interface SummaryMergedContent {
  summary: string;
  chronicleText: string;
  keyDialogue: string;
  timeSpan: string;
}

export interface SummaryMergeSegment {
  index: number;
  startRow: number;
  endRow: number;
  amRange: string;
  rows: SummaryMergeRow[];
  mass: number;
  zone?: 'front' | 'mid' | 'back';
  targetMass?: number;
  status: SummarySegmentStatus;
  retries: number;
  maxRetries: number;
  merged?: SummaryMergedContent;
  error?: string;
  tail?: boolean;
}

export interface SummaryMergeAiResult {
  ok: boolean;
  data?: { summary: string; chronicleText: string; keyDialogue: string };
  error?: string;
}

export interface SummaryMergeZoneStat {
  key: 'front' | 'mid' | 'back';
  label: string;
  finalCount: number;
  targetMass: number;
  actualAvg: number;
}

export interface SummaryMergePlan {
  ok: true;
  mode: SummaryMergeMode;
  config: SummaryMergeConfig;
  segments: SummaryMergeSegment[];
  scopeRows: number;
  totalMass: number;
  targetAverage?: number;
  targetRows?: number;
  zones?: SummaryMergeZoneStat[];
  tailMass?: number;
}

export interface SummaryMergeInfo {
  ok: boolean;
  error?: string;
  tableName?: string;
  count: number;
  merged: number;
  unmerged: number;
}

export interface SummaryMergeState {
  phase: 'idle' | 'running' | 'done' | 'success';
  config: SummaryMergeConfig | null;
  segments: SummaryMergeSegment[];
  startedAt: number;
  error?: string;
  result?: { before: number; after: number; success: number; failed: number; skipped: number };
}

export interface SummaryMergeDeps {
  book(): BookModel | null;
  markers: SummaryMergeMarkerStore;
  requestAi(entries: SummaryMergeRow[], maxWords: number, signal?: AbortSignal): Promise<SummaryMergeAiResult>;
  commitOps(source: 'merge', ops: LedgerOp[]): { ok: boolean; errors: string[] };
  flush(): Promise<void> | void;
  refreshWorldbook(): Promise<boolean> | void;
  isFillRunning?(): boolean;
  warn?(message: string, source?: string): void;
  notify?(message: string, title?: string): void;
  log?(level: 'info' | 'warn' | 'error', source: string, message: string): void;
}

export interface SummaryMergeService {
  getState(): SummaryMergeState;
  getInfo(): SummaryMergeInfo;
  /** 当前纪要表的行清单（fixed/time 的起止下拉用）。 */
  getRowList(): { rowId: number; code: string }[];
  /** 上一次开始/预览使用的配置（切标签/刷新后恢复输入用）。 */
  getLastConfig(): SummaryMergeConfig;
  preview(config: SummaryMergeConfig): { ok: true; plan: SummaryMergePlan } | { ok: false; error: string };
  start(config: SummaryMergeConfig): { ok: boolean; error?: string };
  abort(): void;
  resume(indices?: number[]): { ok: boolean; error?: string };
  commit(): Promise<{ ok: boolean; error?: string; before?: number; after?: number }>;
  reset(): void;
  subscribe(fn: (state: SummaryMergeState) => void): () => void;
  isRunning(): boolean;
  hasPendingResult(): boolean;
  dispose(): void;
}

// ═══════════════════════════════════════════════════════════════
// 时间跨度（纯函数，短年份安全）
// ═══════════════════════════════════════════════════════════════

export function splitTimeSpan(ts: string): { start: string; end: string } | null {
  const text = String(ts || '').trim();
  if (!text) return null;
  const idx = text.indexOf('~');
  if (idx < 0) return { start: '', end: text };
  const start = text.slice(0, idx).trim();
  const end = text.slice(idx + 1).trim();
  if (!end) return null;
  return { start, end };
}

export function parseChronicleTime(ts: string, side: 'start' | 'end'): Date | null {
  const parts = splitTimeSpan(ts);
  if (!parts) return null;
  const raw = side === 'start' ? parts.start : parts.end;
  const m = /(-?\d{1,6})-(\d{1,2})-(\d{1,2})/.exec(String(raw || ''));
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);
  if (!Number.isFinite(year) || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const tm = String(raw).match(/(\d{1,2}):(\d{2})/);
  const hh = tm ? parseInt(tm[1], 10) : 0;
  const mm = tm ? parseInt(tm[2], 10) : 0;
  if (hh > 23 || mm > 59) return null;
  const d = new Date(2000, 0, 1, 0, 0, 0);
  d.setFullYear(year, month - 1, day);
  d.setHours(hh, mm, 0, 0);
  return d;
}

/** 段内首条起始 ~ 末条结束；首条无开始（`~ 结束`）时输出 `~ 末条结束`。 */
export function jsMergeTimeSpan(entries: SummaryMergeRow[]): string {
  if (entries.length === 0) return '';
  if (entries.length === 1) return entries[0].timeSpan;
  const first = entries[0].timeSpan;
  const last = entries[entries.length - 1].timeSpan;
  const firstParts = splitTimeSpan(first);
  const lastParts = splitTimeSpan(last);
  if (lastParts) {
    return (firstParts?.start ? firstParts.start + ' ~ ' : '~ ') + lastParts.end;
  }
  return first;
}

// ═══════════════════════════════════════════════════════════════
// AI 提示词与解析（合并请求）
// ═══════════════════════════════════════════════════════════════

function mergeRules(maxWords: number): string {
  return `
[合并规则]
1. 概览(summary)：一句话概括这N条合并后的整体内容，必须体现涉及的互动角色名、地点、重要事件或变化伏笔。≤80字。
2. 纪要正文(chronicle_text)：以无损压缩体重述这N条纪要的全部信息。必须保留：
   - 所有延续到后文的约定、计划、伏笔
   - 状态变化（人物关系变化、身份/态度变化、关系里程碑）
   - 重大转折与因果关系
   - 重要数字（金额、次数、时间点、数量等）
   - 每一个重要角色的出场与互动
   - 推动剧情的关键行为
   移除所有修辞与对话原文。不加评论，不抒情，不升华。行文生活化，用词直白，文字基调积极向上。避免「达成协议」「确立计划」等正式措辞。
   结尾必须保持开放，不得归纳状态、给出结论性评价或封闭式收束，在事件自然流动中结束。
   禁止内容：极端情绪、夸张、比喻、升华、情绪总结、支配欲、掌控欲、总结性收尾。
   ≤${maxWords}字。
3. 重要对话(key_dialogue)：每行使用“说话人：原文台词”格式，最多5条。仅从所有原重要对话中挑选直接推动剧情转折、揭示关键信息、改变人物关系/决策、构成承诺/誓约/约定的最重要1-3句原文台词。排除寒暄、重复、情绪感叹。宁少勿滥——无足够信息量则留空。

[NSFW规范]
涉及性行为的场景，纪要仅记录「行为事实」，严禁记录「感官过程」：
必须记录：谁主动发起/引导、发生了什么行为、体位、高潮次数及强度、身体里程碑（破处/初次后庭/中出等）、过程中的关键对话、事后反应和态度变化。
严禁记录：体液细节、声音/呻吟、节奏力度变化、肌肤触感温度、生殖器交合的文学描写。
本质：把 NSFW 当「性行为事实清单」而非「情色小说摘抄」。

[核心原则]
合并目标=「提供给后续 AI 扮演时不出现记忆错乱或缺失的、保留最大信息量的压缩」。压缩后前因后果与剧情依旧连贯。重要信息=有助于后续剧情推进时给 AI 做参考的内容（人物关系变化、重大转折、重要约定等）。宁可略微啰嗦也不要丢失重要信息。
`;
}

/** N 条纪要 → 完整 user 指令。 */
export function buildMergeInstruction(entries: SummaryMergeRow[], maxWords: number): string {
  const entryXml = entries
    .map((e, i) => '<entry n="' + (i + 1) + '"><summary>' + e.summary + '</summary><text>' + e.chronicleText + '</text><dialogue>' + e.keyDialogue + '</dialogue></entry>')
    .join('\n');
  const n = entries.length;
  return (
    '[System]\n' +
    '你是一个严谨的「客观记忆记录枢纽」与「无损信息压缩器」。任务：把同一故事中按时间顺序排列的 ' +
    n +
    ' 条纪要合并成 1 条，在最大限度保留对后续剧情推进有帮助的信息的前提下进行压缩。合并后必须保证前因后果连贯、剧情不断裂。\n\n' +
    '[Input] 待合并的 ' + n + ' 条纪要（按时间顺序）：\n<entries>\n' + entryXml + '\n</entries>\n\n' +
    '[Output] 严格遵守以下标签格式，标签外不得有任何文字：\n' +
    '<chronicle>\n' +
    '<summary>合并后概览（≤80字，一句话，体现关键角色名/地点/重要事件或变化伏笔）</summary>\n' +
    '<text>合并后纪要正文（≤' + maxWords + '字，宁可少写不要超出）</text>\n' +
    '<dialogue>从所有原重要对话中挑选最重要、信息量最大的1-3句原文台词；每行使用“说话人：原文台词”格式，最多5条；如原重要对话均无推动剧情价值，留空输出 <dialogue></dialogue></dialogue>\n' +
    '</chronicle>\n\n' + mergeRules(maxWords)
  );
}

/** 从 AI 返回文本提取 <chronicle> 三子标签并校验字数。 */
export function extractChronicle(text: string): SummaryMergeAiResult {
  const chron = String(text || '').match(/<chronicle>([\s\S]*?)<\/chronicle>/i);
  if (!chron) return { ok: false, error: '未找到 <chronicle> 标签' };
  const inner = chron[1];
  const sumM = inner.match(/<summary>([\s\S]*?)<\/summary>/i);
  const textM = inner.match(/<text>([\s\S]*?)<\/text>/i);
  const dlgM = inner.match(/<dialogue>([\s\S]*?)<\/dialogue>/i);
  if (!sumM || !textM || !dlgM) return { ok: false, error: '缺少 summary/text/dialogue 子标签' };
  const summary = sumM[1].trim();
  const chronicleText = textM[1].trim();
  const keyDialogue = dlgM[1].trim();
  if (summary.length > 80) return { ok: false, error: '概览超长（' + summary.length + ' > 80）' };
  if (chronicleText.length > 750) return { ok: false, error: '纪要超长（' + chronicleText.length + ' > 750）' };
  return { ok: true, data: { summary, chronicleText, keyDialogue } };
}

// ═══════════════════════════════════════════════════════════════
// 分段算法（纯函数）
// ═══════════════════════════════════════════════════════════════

function reindex(segs: SummaryMergeSegment[]): SummaryMergeSegment[] {
  segs.forEach((s, i) => { s.index = i; });
  return segs;
}

function segmentOf(rows: SummaryMergeRow[], zone: SummaryMergeSegment['zone'], maxRetries: number, targetMass?: number): SummaryMergeSegment {
  const mass = rows.reduce((n, r) => n + r.mergeCount, 0);
  return {
    index: 0,
    startRow: rows[0].rowId,
    endRow: rows[rows.length - 1].rowId,
    amRange: rows[0].code + '~' + rows[rows.length - 1].code,
    rows,
    mass,
    zone,
    targetMass,
    status: rows.length === 1 ? 'omitted' : 'pending',
    retries: 0,
    maxRetries,
  };
}

export function computeFixedSegments(rows: SummaryMergeRow[], size: number, maxRetries: number): SummaryMergeSegment[] {
  const step = Math.max(2, Math.min(20, Math.trunc(size) || 5));
  const out: SummaryMergeSegment[] = [];
  for (let i = 0; i < rows.length; i += step) out.push(segmentOf(rows.slice(i, i + step), undefined, maxRetries));
  return reindex(out);
}

export function computeTimeSegments(rows: SummaryMergeRow[], hours: number, maxRetries: number): SummaryMergeSegment[] {
  const threshold = Math.max(1, Math.min(168, Math.trunc(hours) || 24)) * 3600000;
  const out: SummaryMergeSegment[] = [];
  let i = 0;
  while (i < rows.length) {
    let segStart: Date | null = null;
    for (let k = i; k < rows.length; k++) {
      segStart = parseChronicleTime(rows[k].timeSpan, 'start');
      if (segStart) break;
    }
    let j = i;
    let closed = false;
    while (j < rows.length) {
      if (j - i + 1 >= 20) {
        out.push(segmentOf(rows.slice(i, j + 1), undefined, maxRetries));
        i = j + 1;
        closed = true;
        break;
      }
      const curEnd = parseChronicleTime(rows[j].timeSpan, 'end');
      if (curEnd && segStart && j > i && (curEnd.getTime() - segStart.getTime()) >= threshold) {
        out.push(segmentOf(rows.slice(i, j + 1), undefined, maxRetries));
        i = j + 1;
        closed = true;
        break;
      }
      j++;
    }
    if (!closed) {
      out.push(segmentOf(rows.slice(i), undefined, maxRetries));
      i = rows.length;
    }
  }
  return reindex(out);
}

/**
 * 平均合并：按原顺序连续累加每条纪要的合并数；首次 >= 目标 N 即收一段。
 * 末段不足 N 单独保留（不并入上一段）。单条段 = 无需合并。
 */
export function computeAverageSegments(rows: SummaryMergeRow[], target: number, maxRetries: number): SummaryMergeSegment[] {
  const n = Math.max(2, Math.min(50, Math.trunc(target) || 6));
  const out: SummaryMergeSegment[] = [];
  let cur: SummaryMergeRow[] = [];
  let sum = 0;
  for (const row of rows) {
    cur.push(row);
    sum += row.mergeCount;
    if (sum >= n) {
      out.push(segmentOf(cur, undefined, maxRetries));
      cur = [];
      sum = 0;
    }
  }
  if (cur.length) {
    const tail = segmentOf(cur, undefined, maxRetries);
    tail.tail = sum < n;
    out.push(tail);
  }
  return reindex(out);
}

/**
 * 前略后详：合并成 M 条。前/中/后按最终条数 50%/25%/25% 分区；
 * 权重只决定目标几合一，不决定字数。
 */
export function computeFrontBackSegments(
  rows: SummaryMergeRow[],
  targetRows: number,
  weights: { front: number; mid: number; back: number },
  maxRetries: number,
): { ok: true; segments: SummaryMergeSegment[]; zones: SummaryMergeZoneStat[]; targetRows: number; totalMass: number } | { ok: false; error: string } {
  if (rows.length < 3) return { ok: false, error: '至少需要 3 条纪要' };
  const M = Math.trunc(targetRows);
  if (!Number.isFinite(M) || M < 2 || M >= rows.length) return { ok: false, error: '目标条数必须小于当前纪要条数' };
  const F = Math.floor(M * 0.5);
  const D = Math.floor(M * 0.25);
  const B = M - F - D;
  const X = Math.max(0.1, Number(weights.front) || 3);
  const Y = Math.max(0.1, Number(weights.mid) || 2);
  const Z = Math.max(0.1, Number(weights.back) || 1);
  const totalMass = rows.reduce((n, r) => n + r.mergeCount, 0);
  const W = F * X + D * Y + B * Z;
  if (W <= 0) return { ok: false, error: '密度权重无效' };
  const k = totalMass / W;
  const targetF = k * X;
  const targetD = k * Y;
  const targetB = k * Z;
  const targets: number[] = [];
  for (let g = 0; g < M; g++) targets.push(g < F ? targetF : (g < F + D ? targetD : targetB));
  const cum: number[] = [0];
  for (let i = 0; i < rows.length; i++) cum.push(cum[i] + rows[i].mergeCount);
  const segs: SummaryMergeSegment[] = [];
  let next = 0;
  for (let g = 0; g < M; g++) {
    const minEnd = next;
    const maxEnd = g === M - 1 ? rows.length - 1 : rows.length - (M - g - 1) - 1;
    let end = minEnd;
    if (g !== M - 1) {
      const desired = targets[g];
      let best = Infinity;
      for (let j = minEnd; j <= maxEnd; j++) {
        const mass = cum[j + 1] - cum[next];
        const diff = Math.abs(mass - desired);
        if (diff < best - 1e-9) { best = diff; end = j; }
      }
    } else {
      end = rows.length - 1;
    }
    const zone: SummaryMergeSegment['zone'] = g < F ? 'front' : (g < F + D ? 'mid' : 'back');
    segs.push(segmentOf(rows.slice(next, end + 1), zone, maxRetries, targets[g]));
    next = end + 1;
  }
  const zones: SummaryMergeZoneStat[] = [
    { key: 'front', label: '前', finalCount: 0, targetMass: targetF, actualAvg: 0 },
    { key: 'mid', label: '中', finalCount: 0, targetMass: targetD, actualAvg: 0 },
    { key: 'back', label: '后', finalCount: 0, targetMass: targetB, actualAvg: 0 },
  ];
  for (const z of zones) {
    const list = segs.filter((s) => s.zone === z.key);
    z.finalCount = list.length;
    z.actualAvg = list.length ? list.reduce((n, s) => n + s.mass, 0) / list.length : 0;
  }
  return { ok: true, segments: reindex(segs), zones, targetRows: M, totalMass };
}

// ═══════════════════════════════════════════════════════════════
// 读表 / 规划 / 提交
// ═══════════════════════════════════════════════════════════════

export function findSummaryTable(book: BookModel | null): TableModel | null {
  if (!book) return null;
  for (const table of book.tables.values()) {
    if (specialFormOf(table.name, table.v2def) === 'summary') return table;
  }
  return null;
}

interface SummaryColumns { code: number; span: number; summary: number; text: number; dialogue: number }

function summaryColumns(table: TableModel): SummaryColumns | null {
  const code = resolveColumn(table, '编码索引');
  const span = resolveColumn(table, '时间跨度');
  const summary = resolveColumn(table, '概览');
  const text = resolveColumn(table, '纪要');
  const dialogue = resolveColumn(table, '重要对话');
  if (code < 0 || span < 0 || summary < 0 || text < 0 || dialogue < 0) return null;
  return { code, span, summary, text, dialogue };
}

function readRows(table: TableModel, markers: SummaryMergeMarkerStore): SummaryMergeRow[] {
  const cols = summaryColumns(table);
  if (!cols) return [];
  const bySpan = markers.read();
  const ids = [...table.rows.keys()].sort((a, b) => a - b);
  return ids.map((rowId) => {
    const cells = table.rows.get(rowId)!;
    const timeSpan = String(cells[cols.span] ?? '');
    return {
      rowId,
      code: String(cells[cols.code] ?? ''),
      timeSpan,
      summary: String(cells[cols.summary] ?? ''),
      chronicleText: String(cells[cols.text] ?? ''),
      keyDialogue: String(cells[cols.dialogue] ?? ''),
      mergeCount: markers.countOf(bySpan, timeSpan),
    };
  });
}

function rowSignature(row: SummaryMergeRow): string {
  return [row.rowId, row.code, row.timeSpan, row.summary, row.chronicleText, row.keyDialogue].join('\u0000');
}

function normalizeConfig(config: SummaryMergeConfig): SummaryMergeConfig {
  return {
    mode: config.mode,
    startRow: config.startRow !== undefined ? Math.trunc(Number(config.startRow)) : undefined,
    endRow: config.endRow !== undefined ? Math.trunc(Number(config.endRow)) : undefined,
    fixedSize: Math.max(2, Math.min(20, Math.trunc(Number(config.fixedSize)) || 5)),
    thresholdHours: Math.max(1, Math.min(168, Math.trunc(Number(config.thresholdHours)) || 24)),
    targetAverage: Math.max(2, Math.min(50, Math.trunc(Number(config.targetAverage)) || 6)),
    targetRows: Math.trunc(Number(config.targetRows)) || 100,
    weights: {
      front: Math.max(0.1, Number(config.weights?.front) || 3),
      mid: Math.max(0.1, Number(config.weights?.mid) || 2),
      back: Math.max(0.1, Number(config.weights?.back) || 1),
    },
    maxRetries: Number.isFinite(Number(config.maxRetries))
      ? Math.max(0, Math.min(10, Math.trunc(Number(config.maxRetries))))
      : 3,
    maxWords: Math.max(100, Math.min(750, Math.trunc(Number(config.maxWords)) || 600)),
  };
}

function planForRows(allRows: SummaryMergeRow[], config: SummaryMergeConfig): { ok: true; plan: SummaryMergePlan } | { ok: false; error: string } {
  const cfg = normalizeConfig(config);
  let scope = allRows;
  if (cfg.mode === 'fixed' || cfg.mode === 'time') {
    const start = cfg.startRow ?? (allRows.length ? allRows[0].rowId : 0);
    const end = cfg.endRow ?? (allRows.length ? allRows[allRows.length - 1].rowId : 0);
    if (!allRows.length) return { ok: false, error: '纪要表为空' };
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return { ok: false, error: '起止行号无效' };
    scope = allRows.filter((r) => r.rowId >= start && r.rowId <= end);
    if (scope.length < 2) return { ok: false, error: '范围内至少需要 2 条纪要' };
  } else if (allRows.length < 2) {
    return { ok: false, error: '至少需要 2 条纪要' };
  }
  const totalMass = scope.reduce((n, r) => n + r.mergeCount, 0);
  if (cfg.mode === 'fixed') {
    const segments = computeFixedSegments(scope, cfg.fixedSize!, cfg.maxRetries!);
    return { ok: true, plan: { ok: true, mode: cfg.mode, config: cfg, segments, scopeRows: scope.length, totalMass } };
  }
  if (cfg.mode === 'time') {
    const segments = computeTimeSegments(scope, cfg.thresholdHours!, cfg.maxRetries!);
    return { ok: true, plan: { ok: true, mode: cfg.mode, config: cfg, segments, scopeRows: scope.length, totalMass } };
  }
  if (cfg.mode === 'average') {
    const segments = computeAverageSegments(scope, cfg.targetAverage!, cfg.maxRetries!);
    const tail = segments.length ? segments[segments.length - 1] : undefined;
    return {
      ok: true,
      plan: {
        ok: true, mode: cfg.mode, config: cfg, segments, scopeRows: scope.length, totalMass,
        targetAverage: cfg.targetAverage,
        tailMass: tail ? tail.mass : 0,
      },
    };
  }
  const fb = computeFrontBackSegments(scope, cfg.targetRows!, cfg.weights!, cfg.maxRetries!);
  if (!fb.ok) return { ok: false, error: fb.error };
  return {
    ok: true,
    plan: {
      ok: true, mode: cfg.mode, config: cfg, segments: fb.segments, scopeRows: scope.length,
      totalMass: fb.totalMass, targetRows: fb.targetRows, zones: fb.zones,
    },
  };
}

function validateFinalRows(
  rows: { rowId: number; code: string; timeSpan: string; summary: string; chronicleText: string }[],
  touched: ReadonlySet<number>,
): string | null {
  const seen = new Set<string>();
  for (const r of rows) {
    // 只校验本次合并产物的字数；原样保留的旧行不改写，不因历史数据过长阻断合并。
    if (touched.has(r.rowId)) {
      if (r.summary.length > 80) return '概览超长（' + r.summary.length + ' > 80）';
      if (r.chronicleText.length > 750) return '纪要超长（' + r.chronicleText.length + ' > 750）';
    }
    if (r.timeSpan.indexOf('~') < 0) return '时间跨度格式错误';
    if (!r.code) return '编码索引为空';
    if (seen.has(r.code)) return '编码索引重复：' + r.code;
    seen.add(r.code);
  }
  return null;
}

interface FinalRow {
  rowId: number;
  oldCode: string;
  code: string;
  timeSpan: string;
  summary: string;
  chronicleText: string;
  keyDialogue: string;
  mergeCount: number;
}

function buildFinalRows(
  table: TableModel,
  currentRows: SummaryMergeRow[],
  segments: SummaryMergeSegment[],
  cols: SummaryColumns,
): { ok: true; finalRows: FinalRow[]; ops: LedgerOp[] } | { ok: false; error: string } {
  const deleted = new Set<number>();
  const replacements = new Map<number, SummaryMergedContent>();
  const upserts = new Map<number, string[]>();
  for (const seg of segments) {
    if (seg.status !== 'success' || !seg.merged) continue;
    const anchor = seg.rows[0].rowId;
    replacements.set(anchor, seg.merged);
    for (let i = 1; i < seg.rows.length; i++) deleted.add(seg.rows[i].rowId);
    const anchorCells = table.rows.get(anchor);
    if (!anchorCells) return { ok: false, error: '合并锚点行已不存在（row_id=' + anchor + '）' };
    const cells = anchorCells.slice();
    cells[cols.span] = seg.merged.timeSpan;
    cells[cols.summary] = seg.merged.summary;
    cells[cols.text] = seg.merged.chronicleText;
    cells[cols.dialogue] = seg.merged.keyDialogue;
    upserts.set(anchor, cells);
  }
  const finalRows: FinalRow[] = [];
  for (const row of currentRows) {
    if (deleted.has(row.rowId)) continue;
    const rep = replacements.get(row.rowId);
    if (rep) {
      finalRows.push({
        rowId: row.rowId, oldCode: row.code, code: '',
        timeSpan: rep.timeSpan, summary: rep.summary, chronicleText: rep.chronicleText,
        keyDialogue: rep.keyDialogue, mergeCount: row.mergeCount,
      });
    } else {
      finalRows.push({
        rowId: row.rowId, oldCode: row.code, code: '',
        timeSpan: row.timeSpan, summary: row.summary, chronicleText: row.chronicleText,
        keyDialogue: row.keyDialogue, mergeCount: row.mergeCount,
      });
    }
  }
  finalRows.forEach((r, i) => { r.code = 'AM' + String(i + 1).padStart(4, '0'); });
  const err = validateFinalRows(finalRows, new Set(replacements.keys()));
  if (err) return { ok: false, error: err };
  const ops: LedgerOp[] = [];
  for (const rowId of deleted) ops.push({ kind: 'row_delete', table: table.tableId, rowId });
  for (const [rowId, cells] of upserts) ops.push({ kind: 'row_upsert', table: table.tableId, rowId, cells });
  for (const r of finalRows) {
    if (r.oldCode !== r.code) ops.push({ kind: 'cell', table: table.tableId, rowId: r.rowId, column: table.headers[cols.code], value: r.code });
  }
  return { ok: true, finalRows, ops };
}

function cloneBook(book: BookModel): BookModel {
  return cloneBookForDryRun(book);
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); resolve(); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// ═══════════════════════════════════════════════════════════════
// 服务
// ═══════════════════════════════════════════════════════════════

const DEFAULT_CONFIG: SummaryMergeConfig = {
  mode: 'average',
  fixedSize: 5,
  thresholdHours: 24,
  targetAverage: 6,
  targetRows: 100,
  weights: { front: 3, mid: 2, back: 1 },
  maxRetries: 3,
  maxWords: 600,
};

export function createSummaryMergeService(deps: SummaryMergeDeps): SummaryMergeService {
  let state: SummaryMergeState = {
    phase: 'idle',
    config: null,
    segments: [],
    startedAt: 0,
  };
  let lastConfig: SummaryMergeConfig = { ...DEFAULT_CONFIG, weights: { ...DEFAULT_CONFIG.weights! } };
  let snapshotSignatures = new Map<number, string>();
  let abortCtrl: AbortController | null = null;
  const listeners = new Set<(s: SummaryMergeState) => void>();

  function emit(): void {
    const snap = state;
    listeners.forEach((fn) => {
      try { fn(snap); } catch (_e) { /* 单个订阅失败不影响其它 */ }
    });
  }

  function summaryTable(): TableModel | null {
    return findSummaryTable(deps.book());
  }

  function getInfo(): SummaryMergeInfo {
    const table = summaryTable();
    if (!table) return { ok: false, error: '当前模板没有纪要表', count: 0, merged: 0, unmerged: 0 };
    const cols = summaryColumns(table);
    if (!cols) return { ok: false, error: '纪要表缺少 编码索引/时间跨度/概览/纪要/重要对话 列', count: 0, merged: 0, unmerged: 0 };
    const rows = readRows(table, deps.markers);
    const merged = rows.filter((r) => r.mergeCount > 1).length;
    return { ok: true, tableName: table.name, count: rows.length, merged, unmerged: rows.length - merged };
  }

  function preview(config: SummaryMergeConfig):
    | { ok: true; plan: SummaryMergePlan }
    | { ok: false; error: string } {
    const table = summaryTable();
    if (!table) return { ok: false, error: '当前模板没有纪要表' };
    const cols = summaryColumns(table);
    if (!cols) return { ok: false, error: '纪要表缺少 编码索引/时间跨度/概览/纪要/重要对话 列' };
    if (table.rows.size === 0) return { ok: false, error: '纪要表为空' };
    const rows = readRows(table, deps.markers);
    return planForRows(rows, config);
  }

  function start(config: SummaryMergeConfig): { ok: boolean; error?: string } {
    if (state.phase === 'running') return { ok: false, error: '已有合并在执行' };
    if (deps.isFillRunning?.()) return { ok: false, error: '已有填表在执行，请等待完成后再合并' };
    const cfg = normalizeConfig(config);
    const table = summaryTable();
    if (!table) return { ok: false, error: '当前模板没有纪要表' };
    const cols = summaryColumns(table);
    if (!cols) return { ok: false, error: '纪要表缺少 编码索引/时间跨度/概览/纪要/重要对话 列' };
    const rows = readRows(table, deps.markers);
    const planned = planForRows(rows, cfg);
    if (!planned.ok) return { ok: false, error: planned.error };
    const segments = planned.plan.segments;
    const requestCount = segments.filter((s) => s.status !== 'omitted').length;
    if (requestCount === 0) return { ok: false, error: '没有需要合并的段（单条段会自动跳过）' };
    // 标记修剪：只保留当前纪要表仍存在的时间跨度（旧标记不迁移）。
    const liveSpans = rows.map((r) => r.timeSpan);
    const pruned = deps.markers.prune(liveSpans);
    void deps.markers.write(pruned);
    snapshotSignatures = new Map(rows.map((r) => [r.rowId, rowSignature(r)]));
    lastConfig = { ...cfg, weights: { ...cfg.weights! } };
    state = { phase: 'running', config: cfg, segments, startedAt: Date.now() };
    abortCtrl = new AbortController();
    emit();
    deps.log?.('info', '纪要合并', '开始合并：' + segments.length + ' 段 / 预计 ' + requestCount + ' 次请求');
    void run(abortCtrl.signal);
    return { ok: true };
  }

  async function run(signal: AbortSignal): Promise<void> {
    const cfg = state.config!;
    const maxWords = cfg.maxWords!;
    const failedSegs: number[] = [];
    for (const seg of state.segments) {
      if (seg.status === 'success' || seg.status === 'omitted' || seg.status === 'skipped') continue;
      if (signal.aborted) {
        if (seg.status === 'pending') seg.status = 'skipped';
        emit();
        continue;
      }
      seg.status = 'running';
      seg.error = undefined;
      emit();
      let ok = false;
      const attempts = seg.maxRetries;
      for (let attempt = 0; attempt <= attempts; attempt++) {
        if (signal.aborted) break;
        let result: SummaryMergeAiResult;
        try {
          result = await deps.requestAi(seg.rows, maxWords, signal);
        } catch (e: any) {
          result = { ok: false, error: String(e?.message || e) };
        }
        if (result.ok && result.data) {
          seg.merged = { ...result.data, timeSpan: jsMergeTimeSpan(seg.rows) };
          seg.status = 'success';
          seg.error = undefined;
          ok = true;
          break;
        }
        seg.retries = attempt + 1;
        seg.error = result.error || '未知错误';
        if (attempt < attempts) await wait(800 * (attempt + 1), signal);
      }
      if (!ok) {
        seg.status = signal.aborted ? 'skipped' : 'failed';
        if (seg.status === 'failed') failedSegs.push(seg.index);
      }
      emit();
      if (signal.aborted) {
        for (const s of state.segments) {
          if (s.status === 'pending') s.status = 'skipped';
        }
        emit();
        break;
      }
    }
    state.phase = 'done';
    emit();
    const success = state.segments.filter((s) => s.status === 'success').length;
    const failed = state.segments.filter((s) => s.status === 'failed').length;
    deps.log?.('info', '纪要合并', '合并循环结束：成功 ' + success + ' 段 / 失败 ' + failed + ' 段');
  }

  function abort(): void {
    if (!abortCtrl) return;
    abortCtrl.abort();
    for (const s of state.segments) {
      if (s.status === 'pending') s.status = 'skipped';
    }
    if (state.phase === 'running') state.phase = 'done';
    emit();
    deps.log?.('warn', '纪要合并', '用户中断合并（已完成的段保留，待确认）');
  }

  function resume(indices?: number[]): { ok: boolean; error?: string } {
    if (state.phase !== 'done') return { ok: false, error: '当前没有待继续的合并' };
    const picked = indices && indices.length ? new Set(indices) : null;
    let changed = false;
    for (const s of state.segments) {
      if (picked && !picked.has(s.index)) continue;
      if (s.status === 'pending' || s.status === 'skipped' || s.status === 'failed') {
        s.status = 'pending';
        s.retries = 0;
        s.error = undefined;
        changed = true;
      }
    }
    if (!changed) return { ok: false, error: '没有可重跑的段' };
    state.phase = 'running';
    state.error = undefined;
    abortCtrl = new AbortController();
    emit();
    void run(abortCtrl.signal);
    return { ok: true };
  }

  async function commit(): Promise<{ ok: boolean; error?: string; before?: number; after?: number }> {
    if (state.phase !== 'done') return { ok: false, error: '当前没有待提交的合并结果' };
    const table = summaryTable();
    if (!table) return { ok: false, error: '当前模板没有纪要表' };
    const cols = summaryColumns(table);
    if (!cols) return { ok: false, error: '纪要表缺少 编码索引/时间跨度/概览/纪要/重要对话 列' };
    const currentRows = readRows(table, deps.markers);
    const currentById = new Map(currentRows.map((r) => [r.rowId, r]));
    for (const [rowId, sig] of snapshotSignatures) {
      const cur = currentById.get(rowId);
      if (!cur) return { ok: false, error: '纪要表在合并期间被修改（row_id=' + rowId + ' 已不存在），本次结果未写入' };
      if (rowSignature(cur) !== sig) return { ok: false, error: '纪要表在合并期间被修改（row_id=' + rowId + ' 内容已变化），本次结果未写入' };
    }
    const built = buildFinalRows(table, currentRows, state.segments, cols);
    if (!built.ok) return { ok: false, error: '提交预校失败：' + built.error };
    // 副本试跑：确保所有操作可应用，再提交。
    const sim = cloneBook(deps.book()!);
    for (const op of built.ops) {
      const applied = applyOp(sim, op);
      if (!applied.ok) return { ok: false, error: '提交预校失败：' + (applied.error || '操作无法应用') };
    }
    const simTable = sim.tables.get(table.tableId);
    if (!simTable) return { ok: false, error: '提交预校失败：试跑后找不到纪要表' };
    const simCodes = [...simTable.rows.entries()]
      .sort((a, b) => a[0] - b[0])
      .map((entry) => String(entry[1][cols.code] ?? ''));
    if (simCodes.length !== built.finalRows.length) {
      return { ok: false, error: '提交预校失败：试跑行数不一致' };
    }
    const expectCodes = built.finalRows.map((r) => r.code);
    for (let i = 0; i < expectCodes.length; i++) {
      if (simCodes[i] !== expectCodes[i]) return { ok: false, error: '提交预校失败：试跑编号不一致' };
    }
    state.phase = 'running';
    state.error = undefined;
    emit();
    const before = currentRows.length;
    const r = deps.commitOps('merge', built.ops);
    if (!r.ok) {
      state.phase = 'done';
      state.error = r.errors.join('；') || '写入失败';
      emit();
      return { ok: false, error: state.error };
    }
    await deps.flush();
    await deps.refreshWorldbook();
    const newMerged = state.segments
      .filter((s) => s.status === 'success' && s.merged)
      .map((s) => ({
        timeSpan: s.merged!.timeSpan,
        count: s.rows.reduce((n, row) => n + row.mergeCount, 0),
      }));
    const okMarkers = await deps.markers.applyMerge(newMerged, built.finalRows.map((row) => row.timeSpan));
    if (!okMarkers) deps.warn?.('合并标记写入失败：纪要数据已合并，但平均合并会按 1 合 1 计算', '纪要合并');
    const success = state.segments.filter((s) => s.status === 'success').length;
    const failed = state.segments.filter((s) => s.status === 'failed').length;
    const skipped = state.segments.filter((s) => s.status === 'skipped' || s.status === 'pending').length;
    const after = built.finalRows.length;
    state.phase = 'success';
    state.result = { before, after, success, failed, skipped };
    emit();
    deps.log?.('info', '纪要合并', '合并提交：' + before + ' → ' + after + ' 条');
    deps.notify?.('纪要合并完成：' + before + ' → ' + after + ' 条', '纪要合并');
    return { ok: true, before, after };
  }

  function reset(): void {
    if (abortCtrl) abortCtrl.abort();
    abortCtrl = null;
    snapshotSignatures = new Map();
    state = { phase: 'idle', config: null, segments: [], startedAt: 0 };
    emit();
  }

  function dispose(): void {
    if (abortCtrl) abortCtrl.abort();
    abortCtrl = null;
    listeners.clear();
    snapshotSignatures = new Map();
    state = { phase: 'idle', config: null, segments: [], startedAt: 0 };
  }

  return {
    getState: () => state,
    getInfo,
    getRowList: () => {
      const table = summaryTable();
      if (!table) return [];
      return readRows(table, deps.markers).map((r) => ({ rowId: r.rowId, code: r.code }));
    },
    getLastConfig: () => ({ ...lastConfig, weights: { ...lastConfig.weights! } }),
    preview,
    start,
    abort,
    resume,
    commit,
    reset,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    isRunning: () => state.phase === 'running',
    hasPendingResult: () => state.phase === 'done',
    dispose,
  };
}

export function defaultSummaryMergeConfig(): SummaryMergeConfig {
  return { ...DEFAULT_CONFIG, weights: { ...DEFAULT_CONFIG.weights! } };
}
