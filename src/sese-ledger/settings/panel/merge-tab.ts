// ===== 纪要合并标签（台账独占） =====
//
// 四种模式：平均合并 / 前略后详 / 按段大小 / 时间智能。
// - 平均合并：目标 N 合 1；连续累加首次 >= N 即收段；末段不足 N 单独保留。
// - 前略后详：合并成 M 条；前 50% 每条压更多、后 25% 每条压更少；只改几合一，不改字数上限。
// - 所有段统一使用「纪要最大字数」；不设置分区字数。
// - 合并标记由台账 core/summary-merge-markers 维护（UI 不展示归属）。
//
// 本文件只负责界面；算法/服务在 core/summary-merge.ts，后台进度由服务订阅驱动。

import { esc, type WorkbenchDeps } from './shared';
import type { TabCtx } from './shell';
import {
  defaultSummaryMergeConfig,
  type SummaryMergeConfig,
  type SummaryMergePlan,
  type SummaryMergeSegment,
  type SummaryMergeState,
} from '../../core/summary-merge';
import { summaryWarning } from '../../core/summary-warning';

interface MergeTabUi {
  config: SummaryMergeConfig;
  ack: boolean;
  openSeg: number;
}

let ui: MergeTabUi | null = null;

const MODE_LABEL: Record<string, string> = {
  average: '平均合并',
  frontback: '前略后详',
  fixed: '按段大小',
  time: '时间智能',
};

function ensureUi(service: any): MergeTabUi {
  if (!ui) {
    const last = typeof service.getLastConfig === 'function' ? service.getLastConfig() : null;
    ui = { config: last || defaultSummaryMergeConfig(), ack: false, openSeg: -1 };
  }
  return ui;
}

function locked(state: SummaryMergeState): boolean {
  return state.phase !== 'idle';
}

function activeConfig(service: any, current: MergeTabUi): SummaryMergeConfig {
  const state: SummaryMergeState = service.getState();
  return state.phase !== 'idle' && state.config ? state.config : current.config;
}

function clamp(n: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, n));
}

function segRange(s: SummaryMergeSegment): string {
  return s.amRange || (s.rows[0]?.code || '') + '~' + (s.rows[s.rows.length - 1]?.code || '');
}

function zoneTag(s: SummaryMergeSegment): string {
  if (!s.zone) return '';
  const label = s.zone === 'front' ? '前' : s.zone === 'mid' ? '中' : '后';
  const cls = s.zone === 'front' ? 'info' : s.zone === 'back' ? 'warn' : '';
  return `<span class="slw-tag ${cls}">${label}段</span>`;
}

function statusIcon(s: SummaryMergeSegment): string {
  switch (s.status) {
    case 'success': return '✓';
    case 'failed': return '✕';
    case 'running': return '⟳';
    case 'skipped': return '→';
    case 'omitted': return '—';
    default: return '○';
  }
}

function statusText(s: SummaryMergeSegment): string {
  switch (s.status) {
    case 'success': return '成功';
    case 'failed': return '失败 · 重试 ' + s.retries + '/' + s.maxRetries;
    case 'running': return '进行中';
    case 'skipped': return '未执行';
    case 'omitted': return '单条·无需合并';
    default: return '待处理';
  }
}

function requestCount(plan: SummaryMergePlan): number {
  return plan.segments.filter((s) => s.status !== 'omitted').length;
}

function statsHtml(info: any, warn: ReturnType<typeof summaryWarning>): string {
  const status = warn.limit === 0 ? '提醒已关闭' : warn.over ? '超过 ' + warn.diff + ' 条' : '正常';
  const statusCls = warn.limit === 0 ? '' : warn.over ? 'hot' : 'ok';
  return ''
    + `<div class="slw-merge-stat"><span>当前纪要</span><b>${info.count}</b><em>条</em></div>`
    + `<div class="slw-merge-stat"><span>已合并</span><b>${info.merged}</b><em>条</em></div>`
    + `<div class="slw-merge-stat"><span>未合并</span><b>${info.unmerged}</b><em>条</em></div>`
    + `<div class="slw-merge-stat"><span>建议上限</span><b>${warn.limit === 0 ? '关闭' : warn.limit}</b><em>条</em></div>`
    + `<div class="slw-merge-stat"><span>状态</span><b class="${statusCls}">${status}</b></div>`;
}

function modeCardsHtml(cfg: SummaryMergeConfig, disabled: boolean): string {
  const d = disabled ? ' disabled' : '';
  const card = (mode: string, icon: string, title: string, desc: string, hint: string): string =>
    `<button class="slw-merge-mode${cfg.mode === mode ? ' on' : ''}" data-merge-mode="${mode}" type="button"${d}>`
    + `<div class="mt"><span class="mi">${icon}</span>${title}</div>`
    + `<div class="md">${desc}</div><div class="mh">${hint}</div></button>`;
  return ''
    + card('average', '≋', '平均合并',
      '选一个「合并程度 N」：按原顺序连续累加合并数，首次达到 N 就收一段。让每条最终纪要尽量接近 N 合 1。',
      '适合：整表均匀压缩，目标是控制总量。')
    + card('frontback', '⇥', '前略后详',
      '选最终条数 M：前 50% 每条压更多原始纪要；中 25% 过渡；后 25% 每条压更少。只改变几合一，不改变每条字数上限。',
      '适合：保留最近剧情的细节，压缩早期历史。')
    + card('fixed', '▤', '按段大小',
      '每 N 条原始纪要合并成一条；沿用旧版规则，按行数分段。',
      '适合：固定长度、可预测的批量压缩。')
    + card('time', '⏱', '时间智能',
      '每 N 小时内的纪要合并成一条；按时间跨度分段，时间不可解析的条目并入当前段。',
      '适合：按剧情时间压缩，而不是按条数。');
}

function rangeOptions(rows: { rowId: number; code: string }[], selected: number): string {
  return rows.map((r) => `<option value="${r.rowId}"${r.rowId === selected ? ' selected' : ''}>${esc(r.code)}</option>`).join('');
}

function configHtml(cfg: SummaryMergeConfig, state: SummaryMergeState, rows: { rowId: number; code: string }[]): string {
  const lock = locked(state);
  const dis = lock ? ' disabled' : '';
  const first = rows[0]?.rowId ?? 0;
  const last = rows[rows.length - 1]?.rowId ?? 0;
  const start = cfg.startRow ?? first;
  const end = cfg.endRow ?? last;
  const startCode = rows.find((r) => r.rowId === start)?.code || rows[0]?.code || '—';
  const endCode = rows.find((r) => r.rowId === end)?.code || rows[rows.length - 1]?.code || '—';
  const selectedCount = rows.filter((r) => r.rowId >= start && r.rowId <= end).length;
  const words = cfg.maxWords ?? 600;
  const retry = cfg.maxRetries ?? 3;
  let fields = '';
  if (cfg.mode === 'average') {
    fields = '<div class="slw-merge-grid">'
      + `<div class="slw-row"><label>合并程度</label><input type="number" data-merge-field="targetAverage" value="${cfg.targetAverage ?? 6}" min="2" max="50"${dis}> 合 1</div>`
      + `<div class="slw-row"><label>纪要最大字数</label><input type="number" data-merge-field="maxWords" value="${words}" min="100" max="750"${dis}> 字</div>`
      + '</div>'
      + `<div class="slw-merge-preview">范围：<b>全部 ${rows.length} 条</b>；按原顺序连续累加每条纪要的合并数，<b>首次达到目标 N 即收一段</b>（超过也行）；末段不足 N 时<b>单独保留</b>，不并入上一段。</div>`;
  } else if (cfg.mode === 'frontback') {
    const maxTarget = Math.max(2, rows.length - 1);
    const targetValue = Math.min(cfg.targetRows ?? Math.max(2, Math.floor(rows.length / 2)), maxTarget);
    fields = '<div class="slw-merge-grid">'
      + `<div class="slw-row"><label>合并成</label><input type="number" data-merge-field="targetRows" value="${targetValue}" min="2" max="${maxTarget}"${dis}> 条</div>`
      + `<div class="slw-row"><label>纪要最大字数</label><input type="number" data-merge-field="maxWords" value="${words}" min="100" max="750"${dis}> 字</div>`
      + `<div class="slw-row" style="grid-column:1 / -1"><label>密度权重</label>前 <input type="number" data-merge-field="weightFront" value="${cfg.weights?.front ?? 3}" min="0.1" max="9" step="0.1" style="width:62px"${dis}>`
      + ` 中 <input type="number" data-merge-field="weightMid" value="${cfg.weights?.mid ?? 2}" min="0.1" max="9" step="0.1" style="width:62px"${dis}>`
      + ` 后 <input type="number" data-merge-field="weightBack" value="${cfg.weights?.back ?? 1}" min="0.1" max="9" step="0.1" style="width:62px"${dis}>`
      + '<span class="slw-muted">（越大＝每条压更多原始纪要、合并数更大；只影响几合一，不改单条字数上限；会自动缩放以保证正好合并成 M 条）</span></div>'
      + '</div>'
      + `<div class="slw-merge-preview">范围：<b>全部 ${rows.length} 条</b>；前 / 中 / 后按<b>合并后的条数</b>分区（50% / 25% / 25%）；所有段统一使用「纪要最大字数」<b>${words}</b> 字，本模式只改变几合一。</div>`;
  } else if (cfg.mode === 'fixed') {
    fields = '<div class="slw-merge-grid">'
      + `<div class="slw-row"><label>每段条数</label><input type="number" data-merge-field="fixedSize" value="${cfg.fixedSize ?? 5}" min="2" max="20"${dis}> 条</div>`
      + `<div class="slw-row"><label>纪要最大字数</label><input type="number" data-merge-field="maxWords" value="${words}" min="100" max="750"${dis}> 字</div>`
      + `<div class="slw-row"><label>起始</label><select data-merge-field="startRow"${dis}>${rangeOptions(rows, start)}</select></div>`
      + `<div class="slw-row"><label>结束</label><select data-merge-field="endRow"${dis}>${rangeOptions(rows, end)}</select></div>`
      + '</div>'
      + `<div class="slw-merge-preview">范围：<b>${esc(startCode)} ~ ${esc(endCode)}</b>（共 ${selectedCount} 条）→ 每段 ${cfg.fixedSize ?? 5} 条。</div>`;
  } else {
    fields = '<div class="slw-merge-grid">'
      + `<div class="slw-row"><label>时间跨度</label><input type="number" data-merge-field="thresholdHours" value="${cfg.thresholdHours ?? 24}" min="1" max="168"${dis}> 小时/段</div>`
      + `<div class="slw-row"><label>纪要最大字数</label><input type="number" data-merge-field="maxWords" value="${words}" min="100" max="750"${dis}> 字</div>`
      + `<div class="slw-row"><label>起始</label><select data-merge-field="startRow"${dis}>${rangeOptions(rows, start)}</select></div>`
      + `<div class="slw-row"><label>结束</label><select data-merge-field="endRow"${dis}>${rangeOptions(rows, end)}</select></div>`
      + '</div>'
      + `<div class="slw-merge-preview">范围：<b>${esc(startCode)} ~ ${esc(endCode)}</b>（共 ${selectedCount} 条）→ ${cfg.thresholdHours ?? 24} 小时/段。</div>`;
  }
  fields += `<div class="slw-row" style="margin-top:8px"><label>最大重试</label><input type="number" data-merge-field="maxRetries" value="${retry}" min="0" max="10" style="width:64px"${dis}> 次`
    + '<span class="slw-muted">每段独立重试；失败段保留原条目</span></div>';
  return fields;
}

function chartHtml(segments: SummaryMergeSegment[]): string {
  const max = Math.max(1, ...segments.map((s) => s.mass));
  return '<div class="slw-merge-chart">'
    + segments.map((s) => {
      const h = Math.max(3, Math.round((s.mass / max) * 100));
      const z = s.zone === 'front' ? ' z-front' : s.zone === 'mid' ? ' z-mid' : s.zone === 'back' ? ' z-back' : '';
      return `<i class="${z}" style="height:${h}%" title="${esc(segRange(s))} · ${s.mass} 合 1"></i>`;
    }).join('')
    + '</div>';
}

function segDetailHtml(s: SummaryMergeSegment): string {
  const items = s.rows.slice(0, 4).map((r) =>
    '<div class="slw-merge-orig"><span class="code">' + esc(r.code) + '</span>'
    + '<span class="span">' + esc(r.timeSpan) + '</span>'
    + '<span class="cnt">' + r.mergeCount + ' 合 1</span>'
    + '<p>' + esc(r.summary) + '</p></div>').join('');
  const more = s.rows.length > 4 ? '<div class="slw-muted" style="padding:4px 0">… 其余 ' + (s.rows.length - 4) + ' 条</div>' : '';
  const err = s.status === 'failed' && s.error ? '<div class="slw-merge-orig"><span class="err">✕ ' + esc(s.error) + '</span></div>' : '';
  const merged = s.status === 'success' && s.merged ? '<div class="slw-merge-orig"><span class="code">合并产物</span><p>' + esc(s.merged.summary) + '</p></div>' : '';
  return '<div class="slw-merge-seg-detail">' + items + more + err + merged + '</div>';
}

function segHtml(s: SummaryMergeSegment, state: SummaryMergeState, openSeg: number): string {
  const done = state.phase === 'done';
  const check = done && (s.status === 'failed' || s.status === 'skipped' || s.status === 'pending')
    ? `<input class="slw-merge-check" type="checkbox" data-seg-check="${s.index}"${s.status === 'failed' ? ' checked' : ''}>`
    : (done ? '<span style="width:13px;flex:0 0 13px"></span>' : '');
  const open = openSeg === s.index;
  return '<div class="slw-merge-seg is-' + s.status + (s.tail ? ' is-tail' : '') + (open ? ' open' : '') + '" data-merge-seg="' + s.index + '">'
    + '<span class="st">' + statusIcon(s) + '</span>' + check
    + '<span class="am">' + esc(segRange(s)) + '</span>'
    + '<span class="meta">' + s.rows.length + ' 条</span>'
    + '<span class="mass">' + s.mass + ' 合 1</span>' + zoneTag(s)
    + '<span class="tail">' + statusText(s) + '</span></div>'
    + (open ? segDetailHtml(s) : '');
}

function previewHtml(plan: { ok: true; plan: SummaryMergePlan } | { ok: false; error: string }, state: SummaryMergeState, openSeg: number): string {
  if (!plan.ok) return `<div class="slw-merge-warn">${esc(plan.error)}</div>`;
  const p = plan.plan;
  const segments = state.phase === 'idle' ? p.segments : state.segments;
  const stat = p.mode === 'average'
    ? `原始 <b>${p.scopeRows}</b> 条 / 合并数 <b>${p.totalMass}</b> → 目标 <b>${p.targetAverage}</b> 合 1 → <b>${segments.length}</b> 段 / ${segments.length} 条`
      + (p.segments.length && p.segments[p.segments.length - 1].tail ? ` <span class="bad">（末段 ${p.tailMass} < ${p.targetAverage}，单独保留）</span>` : '')
    : p.mode === 'frontback'
      ? `原始 <b>${p.scopeRows}</b> 条 / 合并数 <b>${p.totalMass}</b> → 合并成 <b>${p.targetRows}</b> 条；前段每条压更多、后段每条压更少（字数上限统一）`
      : p.mode === 'fixed'
        ? `范围 <b>${p.scopeRows}</b> 条 → 每段 <b>${p.config.fixedSize}</b> 条 → <b>${segments.length}</b> 段`
        : `范围 <b>${p.scopeRows}</b> 条 → 每段 <b>${p.config.thresholdHours}</b> 小时 → <b>${segments.length}</b> 段`;
  const zoneLabels = p.mode === 'frontback' && p.zones
    ? '<div class="slw-merge-zonelabels">'
      + p.zones.map((z) => `<span style="flex:${Math.max(1, z.finalCount)}">${z.label} ${z.finalCount} 条</span>`).join('')
      + '</div>'
    : '<div class="slw-merge-chart-cap"><span>每根柱 = 一段</span><span>越高 = 该段压缩的原始纪要越多</span></div>';
  const zoneTable = p.mode === 'frontback' && p.zones
    ? '<table class="slw-tbl slw-tbl-fixed" style="margin-top:10px"><colgroup><col style="width:92px"><col style="width:88px"><col style="width:118px"><col></colgroup>'
      + '<thead><tr><th>区段</th><th>最终条数</th><th>目标合并数/条</th><th>实际平均</th></tr></thead><tbody>'
      + p.zones.map((z) => `<tr><td>${z.label}段</td><td>${z.finalCount} 条</td><td>${z.targetMass.toFixed(2)} 合 1</td><td>${z.actualAvg.toFixed(2)} 合 1</td></tr>`).join('')
      + '</tbody></table>'
    : '';
  const tail = p.mode === 'average' && p.segments.length && p.segments[p.segments.length - 1].tail
    ? `<div class="slw-merge-warn">末段合并数不足目标（${p.tailMass} < ${p.targetAverage}）：按“首次达标即收段”的规则<b>单独保留为末段</b>，不并入上一段。</div>`
    : '';
  return `<div class="slw-merge-statrow"><span>${stat}</span><span style="margin-left:auto">预计 <b>${requestCount(p)}</b> 次 AI 请求（串行）</span></div>`
    + chartHtml(segments) + zoneLabels + zoneTable + tail
    + `<div class="slw-merge-seglist" id="slwMergeSegList">${segments.map((s) => segHtml(s, state, openSeg)).join('')}</div>`;
}

function actionsHtml(plan: { ok: true; plan: SummaryMergePlan } | { ok: false; error: string }, state: SummaryMergeState, ack: boolean): string {
  if (state.phase === 'success') {
    const r = state.result;
    return `<div class="slw-merge-success"><div class="big">✓</div><h4>合并完成</h4>`
      + `<p><span class="num">${r?.before ?? 0} → ${r?.after ?? 0}</span> 条</p>`
      + `<p>成功 ${r?.success ?? 0} 段；失败 ${r?.failed ?? 0} 段、未执行 ${r?.skipped ?? 0} 段保留原条目。</p>`
      + `<p>AM 编号已重排为连续；合并标记已更新。</p>`
      + `<p style="color:#e0c07a">继续推进对话即可，无需重填纪要表。</p></div>`
      + `<div class="slw-merge-actions"><span class="spacer"></span><button class="slw-btn primary" type="button" data-merge-action="reset">开始新的合并</button></div>`;
  }
  if (state.phase === 'running') {
    const segments = state.segments;
    const done = segments.filter((s) => s.status === 'success' || s.status === 'failed' || s.status === 'skipped' || s.status === 'omitted').length;
    const success = segments.filter((s) => s.status === 'success').length;
    const failed = segments.filter((s) => s.status === 'failed').length;
    return `<div class="slw-merge-bar"><i style="width:${Math.round((done / Math.max(1, segments.length)) * 100)}%"></i></div>`
      + `<div class="slw-merge-statrow"><span><span class="dot" style="background:#8fce8f"></span>成功 <b>${success}</b></span>`
      + `<span><span class="dot" style="background:#e07a7a"></span>失败 <b>${failed}</b></span>`
      + `<span>共 <b>${segments.length}</b> 段 · 已完成 ${done}</span><span style="margin-left:auto">串行请求中；切走标签不会中断</span></div>`
      + `<div class="slw-merge-actions"><button class="slw-btn danger" type="button" data-merge-action="abort">中断合并</button><span class="spacer"></span><span class="slw-merge-note">完成后还需要点「结束并替换已完成」才写回。</span></div>`;
  }
  if (state.phase === 'done') {
    const segments = state.segments;
    const success = segments.filter((s) => s.status === 'success').length;
    const failed = segments.filter((s) => s.status === 'failed').length;
    const skipped = segments.filter((s) => s.status === 'skipped' || s.status === 'pending').length;
    const err = state.error ? `<div class="slw-merge-warn">${esc(state.error)}</div>` : '';
    return err + `<div class="slw-merge-statrow"><span><span class="dot" style="background:#8fce8f"></span>成功 <b>${success}</b></span>`
      + `<span><span class="dot" style="background:#e07a7a"></span>失败 <b>${failed}</b></span><span>未执行 <b>${skipped}</b></span>`
      + `<span style="margin-left:auto">失败的段默认勾选，可重新生成</span></div>`
      + `<div class="slw-merge-actions">`
      + (skipped ? '<button class="slw-btn" type="button" data-merge-action="continue">继续未完成</button>' : '')
      + '<button class="slw-btn" type="button" data-merge-action="regen">重新生成选中</button>'
      + '<button class="slw-btn danger" type="button" data-merge-action="discard">结束并放弃全部</button>'
      + '<span class="spacer"></span>'
      + `<button class="slw-btn primary" type="button" data-merge-action="commit"${success ? '' : ' disabled'}>结束并替换已完成</button>`
      + '</div><div class="slw-merge-note" style="margin-top:5px">替换后：成功的段各变 1 条；失败/未执行段保留原条目；整表 AM 编号重排为连续。</div>';
  }
  if (!plan.ok) return `<div class="slw-merge-note">${esc(plan.error)}</div>`;
  const req = requestCount(plan.plan);
  const canStart = req > 0 && ack;
  return `<div class="slw-merge-statrow"><span>将发出 <b>${req}</b> 次 AI 请求（串行）</span><span style="margin-left:auto">单条段自动跳过，不耗请求</span></div>`
    + `<label class="slw-merge-ack"><input type="checkbox" data-merge-ack${ack ? ' checked' : ''}> 我已知晓：合并期间不要手动编辑/删除参与合并的旧纪要；完成后继续推进对话即可。</label>`
    + `<div class="slw-merge-actions"><span class="spacer"></span><button class="slw-btn primary" type="button" data-merge-action="start"${canStart ? '' : ' disabled'}>开始合并</button></div>`;
}

function noticeHtml(text: string): string {
  return `<div class="slw-card"><div class="slw-annot">${esc(text)}</div></div>`;
}

export function renderMergeTab(ctx: TabCtx, pane: HTMLElement): void {
  const { deps } = ctx;
  const service = deps.canonical?.summaryMerge;
  const oldCleanup = (pane as any).__slwCleanup;
  if (typeof oldCleanup === 'function') {
    try { oldCleanup(); } catch (_e) { /* ignore */ }
  }
  (pane as any).__slwCleanup = undefined;

  if (!service) {
    pane.innerHTML = noticeHtml('纪要合并服务未就绪（台账版本过旧或装载未完成）。');
    return;
  }
  if (deps.realDbPresent) {
    pane.innerHTML = noticeHtml('当前为真数据库模式：请使用状态栏数据库纪要页的合并功能。台账合并仅在台账接管时可用。');
    return;
  }
  const current = ensureUi(service);
  const state: SummaryMergeState = service.getState();
  if (state.phase !== 'idle' && state.config) current.config = state.config;
  const info = service.getInfo();
  if (!info.ok) {
    pane.innerHTML = noticeHtml(info.error || '纪要表不可用');
    return;
  }
  const warn = summaryWarning(deps.runtime.book(), deps.settings.get());
  const rows = typeof service.getRowList === 'function' ? service.getRowList() : [];
  const cfg = activeConfig(service, current);
  const plan = service.preview(cfg);

  pane.innerHTML = `
    <div class="slw-card">
      <h3>纪要合并 <span class="desc">独立标签；四种模式；合并标记自动维护</span></h3>
      <div class="slw-merge-stats" id="slwMergeStats">${statsHtml(info, warn)}</div>
      <div class="slw-annot">合并标记 = 这一条纪要进一步代表多少条原始纪要（几合一）。旧数据/未标记按 <b>1 合 1</b> 计；合并成功后自动更新并按当前表修剪。</div>
    </div>
    <div class="slw-card">
      <h3>合并方式 <span class="desc">点一张卡切换；预览与执行都按当前方式</span></h3>
      <div class="slw-merge-modes" id="slwMergeModes">${modeCardsHtml(cfg, locked(state))}</div>
    </div>
    <div class="slw-card">
      <h3>配置 <span class="desc">${MODE_LABEL[cfg.mode] || ''}</span></h3>
      <div id="slwMergeConfig">${configHtml(cfg, state, rows)}</div>
    </div>
    <div class="slw-card">
      <h3>预览 <span class="desc">分段与合并数分布；点任意段展开原始纪要</span></h3>
      <div id="slwMergePreview">${previewHtml(plan, state, current.openSeg)}</div>
    </div>
    <div class="slw-card">
      <h3>执行 <span class="desc">串行 AI 请求；失败段保留原条目；最终确认才写回</span></h3>
      <div id="slwMergeActions">${actionsHtml(plan, state, current.ack)}</div>
    </div>`;

  // 事件委托：页签元素只换 innerHTML，监听挂在 pane 上（每次渲染覆盖，不叠加）。
  pane.onclick = (e: MouseEvent) => {
    const t = e.target as HTMLElement;
    const modeBtn = t.closest('[data-merge-mode]') as HTMLElement | null;
    if (modeBtn) {
      const st = service.getState();
      if (locked(st)) return;
      current.config = { ...current.config, mode: modeBtn.getAttribute('data-merge-mode') as SummaryMergeConfig['mode'] };
      current.ack = false;
      current.openSeg = -1;
      // 走外壳重渲，保证紧凑模式的说明/卡片装饰重新施加（直接 renderMergeTab 会跳过 decorate）。
      ctx.refresh('merge');
      return;
    }
    if (t.closest('input[type="checkbox"]')) return;
    const seg = t.closest('[data-merge-seg]') as HTMLElement | null;
    if (seg) {
      const idx = Number(seg.getAttribute('data-merge-seg'));
      current.openSeg = current.openSeg === idx ? -1 : idx;
      refreshDynamic(pane, ctx, service);
      return;
    }
    const action = t.closest('[data-merge-action]') as HTMLElement | null;
    if (!action) return;
    const kind = action.getAttribute('data-merge-action');
    if (kind === 'start') {
      if (!current.ack) return;
      const r = service.start(current.config);
      if (!r.ok) deps.warn(r.error || '开始合并失败');
      return;
    }
    if (kind === 'abort') { service.abort(); return; }
    if (kind === 'continue') {
      const r = service.resume();
      if (!r.ok) deps.warn(r.error || '没有可继续的段');
      return;
    }
    if (kind === 'regen') {
      const checked = [...pane.querySelectorAll('[data-seg-check]:checked')].map((n) => Number((n as HTMLElement).getAttribute('data-seg-check')));
      if (!checked.length) { deps.warn('请先勾选要重新生成的失败/未执行段'); return; }
      const r = service.resume(checked);
      if (!r.ok) deps.warn(r.error || '重新生成失败');
      return;
    }
    if (kind === 'discard' || kind === 'reset') {
      service.reset();
      current.ack = false;
      current.openSeg = -1;
      ctx.refresh('merge');
      return;
    }
    if (kind === 'commit') {
      void service.commit().then((r: any) => {
        if (!r?.ok) deps.warn(r?.error || '合并提交失败');
      });
      return;
    }
  };

  pane.onchange = (e: Event) => {
    const t = e.target as HTMLElement;
    if (t.matches('[data-merge-ack]')) {
      current.ack = (t as HTMLInputElement).checked;
      refreshDynamic(pane, ctx, service);
      return;
    }
    const field = t.closest('[data-merge-field]') as HTMLInputElement | HTMLSelectElement | null;
    if (!field) return;
    const name = field.getAttribute('data-merge-field');
    if (!name) return;
    const raw = Number((field as HTMLInputElement).value);
    const cfg = { ...current.config, weights: { ...(current.config.weights || { front: 3, mid: 2, back: 1 }) } };
    if (name === 'targetAverage') cfg.targetAverage = clamp(Number.isFinite(raw) ? raw : 6, 2, 50);
    else if (name === 'targetRows') cfg.targetRows = clamp(Number.isFinite(raw) ? raw : Math.floor(rows.length / 2), 2, Math.max(2, rows.length - 1));
    else if (name === 'weightFront') cfg.weights!.front = Math.max(0.1, Number.isFinite(raw) ? raw : 3);
    else if (name === 'weightMid') cfg.weights!.mid = Math.max(0.1, Number.isFinite(raw) ? raw : 2);
    else if (name === 'weightBack') cfg.weights!.back = Math.max(0.1, Number.isFinite(raw) ? raw : 1);
    else if (name === 'fixedSize') cfg.fixedSize = clamp(Number.isFinite(raw) ? raw : 5, 2, 20);
    else if (name === 'thresholdHours') cfg.thresholdHours = clamp(Number.isFinite(raw) ? raw : 24, 1, 168);
    else if (name === 'maxWords') cfg.maxWords = clamp(Number.isFinite(raw) ? raw : 600, 100, 750);
    else if (name === 'maxRetries') cfg.maxRetries = clamp(Number.isFinite(raw) ? raw : 3, 0, 10);
    else if (name === 'startRow') cfg.startRow = Number.isFinite(raw) ? raw : undefined;
    else if (name === 'endRow') cfg.endRow = Number.isFinite(raw) ? raw : undefined;
    current.config = cfg;
    const next = (cfg as any)[name];
    if (next !== undefined && field.tagName === 'INPUT') (field as HTMLInputElement).value = String(next);
    refreshDynamic(pane, ctx, service);
  };

  const unsub = service.subscribe((_s: SummaryMergeState) => {
    if (!pane.isConnected) { try { unsub(); } catch (_e) { /* ignore */ } return; }
    refreshDynamic(pane, ctx, service);
  });
  (pane as any).__slwCleanup = () => {
    try { unsub(); } catch (_e) { /* ignore */ }
  };
}

/** 进度/提交事件只刷新动态区域；配置输入保留焦点与值。 */
function refreshDynamic(pane: HTMLElement, ctx: TabCtx, service: any): void {
  const deps: WorkbenchDeps = ctx.deps;
  const current = ensureUi(service);
  const state: SummaryMergeState = service.getState();
  if (state.phase !== 'idle' && state.config) current.config = state.config;
  const cfg = activeConfig(service, current);
  const info = service.getInfo();
  if (!info.ok) return;
  const warn = summaryWarning(deps.runtime.book(), deps.settings.get());
  const plan = service.preview(cfg);

  const stats = pane.querySelector('#slwMergeStats');
  if (stats) stats.innerHTML = statsHtml(info, warn);
  const modes = pane.querySelector('#slwMergeModes');
  if (modes) modes.innerHTML = modeCardsHtml(cfg, locked(state));
  pane.querySelectorAll('[data-merge-field]').forEach((n) => {
    (n as HTMLInputElement).disabled = locked(state);
  });

  const content = pane.closest('.slw-content') as HTMLElement | null;
  const contentTop = content ? content.scrollTop : 0;
  const oldList = pane.querySelector('#slwMergeSegList') as HTMLElement | null;
  const listTop = oldList ? oldList.scrollTop : 0;
  const preview = pane.querySelector('#slwMergePreview');
  if (preview) preview.innerHTML = previewHtml(plan, state, current.openSeg);
  const newList = pane.querySelector('#slwMergeSegList') as HTMLElement | null;
  if (newList && listTop) newList.scrollTop = listTop;
  const actions = pane.querySelector('#slwMergeActions');
  if (actions) actions.innerHTML = actionsHtml(plan, state, current.ack);
  if (content) content.scrollTop = contentTop;
  // 配置区的模式说明可能随模式变（这里只更新 desc，不重建输入）。
  const card = pane.querySelector('#slwMergeConfig')?.closest('.slw-card') as HTMLElement | null;
  const desc = card?.querySelector('h3 .desc') as HTMLElement | null;
  if (desc) desc.textContent = MODE_LABEL[cfg.mode] || '';
}
