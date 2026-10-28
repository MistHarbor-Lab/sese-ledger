// ===== 填表标签页：手动填表卡（范围勾选网格 + 层数参数 + 附加要求）· 各表填表状态 · 填表提示词卡（结构头任务段 + 段/块混排） =====
import { esc, el, downloadJsonFile, pickJsonFile, mountPromptEditor, confirmDialog, openEditorDialog } from './shared';
import type { TabCtx } from './shell';
import { groupsOf, isStoppedGroup, isStoppedTable } from '../../core/book';
import { FILL_SYSTEM_PROMPT, FILL_OUTPUT_INSTRUCTION, fillPromptSpecsOf, computeFillStatus, resolveScheduleGlobals } from '../../core/scribe';
import { FILL_BLOCK_IDS, LEDGER_BLOCK_LABELS, LEDGER_SCAN_HEADING, type LedgerPromptItemSpec } from '../../core/ai-request';
import { isAnchorCandidate } from '../../core/floor-scope';
import { describeErrorDetail, describeErrorSummary } from '../../core/error-detail';

/** 固定块说明（弹窗编辑器与摘要共用）。 */
const FILL_BLOCK_HINTS: Partial<Record<(typeof FILL_BLOCK_IDS)[number], string>> = {
  scan: '【参考资料】：两轮黑名单过滤后关键词命中的世界书条目＋当前角色卡设定（用户人设 / 角色卡描述 / 角色性格 / 场景 / 示例对话；填表额外剔除全部台账/数据库投影条目，内置无需配置），供理解人物与既有设定，不属于本轮正文。扫描素材＝本组待填楼层的正文。',
  dossier: '【当前台账】：本轮需要填的表及已有内容——每张表由一行「表 N/M：表名」分隔线框出（表名 + 表说明 + 操作规则 + 已有数据），同时声明填表范围；已有数据受每张表「读取设置 × 世界书注入」四档决策控制，未提供时显式写「【已有数据】空」。',
  context: '【当前正文】：本组待填楼层的 AI 回复（不含用户楼），填表的唯一事实依据，已过主项目「上下文标签剥离」。',
};

/** 正整数参数读设置（缺省回落）。 */
function savedNumberOf(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

export function renderFillTab(ctx: TabCtx, pane: HTMLElement): void {
  const { deps, doc } = ctx;
  const s = deps.settings.get();
  const book = deps.runtime.book();
  const groups = book ? groupsOf(book) : [];
  const tables = book ? [...book.tables.values()].sort((a, b) => a.orderNo - b.orderNo) : [];
  const threshold = Number(s.autoUpdateThreshold) > 0 ? Number(s.autoUpdateThreshold) : 5;
  const recentValue = savedNumberOf(s.fillRecentFloors, threshold);
  const mergeValue = savedNumberOf(s.fillMergeEvery, 3);
  /** 停用组（频率 0）的判定走 core/book 单出口：与自动调度、世界书注入同一口径。 */
  const fillable = tables.filter((t) => !isStoppedTable(t));
  /** 速选分组按钮：**停用组不出现**（组内表既不填表也不注入世界书），空组也不出现。 */
  const pickGroups = groups.filter((g) => !isStoppedGroup(g) && tables.some((t) => Number(t.v2def?.groupId) === Number(g.id)));
  /** 勾选即最终范围（打开面板默认＝全选可填表；没有可填表时留空，避免空跑）。 */
  const picked = new Set<string>(fillable.map((t) => t.tableId));
  pane.innerHTML = '';

  // ── 手动填表卡 ──
  const fillCard = el(doc, 'div', { class: 'slw-card' }, `
    <h3>手动填表 <span class="desc">范围＝下方勾选结果（速选：全选 / 分组）；层数参数 + 本次附加要求</span></h3>
    <div class="slw-row slw-row--stack" style="align-items:flex-start">
      <label style="padding-top:6px">填表范围</label>
      <div style="flex:1;min-width:0">
        <div class="slw-row" style="margin:0 0 6px">
          <button class="slw-chip" id="slw-f-all">全选</button>
          <button class="slw-chip" id="slw-f-none">全不选</button>
          <span style="width:1px;height:16px;background:var(--line2)"></span>
          ${pickGroups.map((g) => `<button class="slw-chip" data-g="${g.id}">分组${g.id}${g.name && g.name !== `分组${g.id}` ? `（${esc(g.name)}）` : ''}</button>`).join('')}
          <span class="slw-count" id="slw-f-count"></span>
        </div>
        <div class="slw-pickgrid" id="slw-f-grid"></div>
      </div>
    </div>
    <div class="slw-row">
      <label>处理最近</label><input type="number" id="slw-f-recent" value="${recentValue}" min="1" style="width:64px"> 层
      <label style="min-width:auto">每</label><input type="number" id="slw-f-merge" value="${mergeValue}" min="1" style="width:64px"> 层合并为一次请求
      <span class="slw-muted">（改动即保存；处理最近缺省＝全局触达层数 ${threshold} 层）</span>
    </div>
    <div class="slw-row" style="align-items:flex-start">
      <label style="padding-top:6px">附加要求</label>
      <textarea rows="2" id="slw-f-extra" placeholder="留空时不追加。例如：本次重点关注NPC对主角态度的变化"></textarea>
    </div>
    <div class="slw-row"><button class="slw-btn primary" id="slw-f-run">执行填表</button><span class="slw-muted" id="slw-f-status">执行中显示进度与结果摘要（X 批 / Y 条操作 / 违规告警）</span><span class="slw-count" id="slw-f-plan" style="margin-left:auto"></span></div>
    <div class="slw-annot">「全选」＝除<b>停用组（频率 0）</b>以外的全部表；点分组按钮＝只勾该组的表（<b>停用组没有按钮</b>）；<b>下方勾选即最终执行范围</b>。停用组的表<b>不参与任何填表</b>（勾选框置灰）、<b>不注入世界书</b>——要填它就把该组频率改成 >0（表清单 / 分组配置）。执行时<b>按分组分别请求</b>（不同组的表不混在同一次请求里）且<b>同一批的各分组并发</b>：同一批读同一份基线，这一批全部回来才用下一批楼层继续；自动更新与定向重填同一口径。<b>执行期间弹常驻进度通知</b>（在跑的每个分组并排显示 + 第几次尝试，点通知本体＝终止本次填表，点关闭按钮＝只关通知），<b>工作台顶部同时显示「填表进行中」横幅</b>（通知自动隐去后也能从这里终止）；失败弹常驻通知（点关闭才消失）。手动填表忽略调度直接跑一轮，跑完把调度推进到当前楼层（防空转重试）。</div>`);
  pane.appendChild(fillCard);

  const gridEl = fillCard.querySelector('#slw-f-grid') as HTMLElement;
  const countEl = fillCard.querySelector('#slw-f-count') as HTMLElement;
  const planEl = fillCard.querySelector('#slw-f-plan') as HTMLElement;
  /** 本次将发出的请求数预览：分组数 × 楼层批数（与 scribe 的分组/分批口径同构）。 */
  function updateRunPlan(): void {
    const selected = tables.filter((t) => picked.has(t.tableId));
    const groupCount = new Set(selected.map((t) => Number(t.v2def ? t.v2def.groupId : 1) || 1)).size;
    const aiCount = (deps.getChat() as any[]).filter((m) => isAnchorCandidate(m)).length;
    const recent = savedNumberOf((fillCard.querySelector('#slw-f-recent') as HTMLInputElement)?.value, recentValue);
    const merge = savedNumberOf((fillCard.querySelector('#slw-f-merge') as HTMLInputElement)?.value, mergeValue);
    const floors = Math.min(recent, aiCount);
    const batches = floors <= 0 ? 0 : Math.ceil(floors / merge);
    planEl.textContent = groupCount === 0 || batches === 0
      ? '本次：无请求（未勾选表或没有可填的 AI 楼层）'
      : `本次：${groupCount} 组 × ${batches} 批 = ${groupCount * batches} 次请求（同批 ${groupCount} 组并发）`;
  }
  function renderGrid(): void {
    gridEl.innerHTML = tables.map((t) => {
      const stopped = isStoppedTable(t);
      const on = picked.has(t.tableId);
      return `<label class="${stopped ? 'dim' : ''}"${stopped ? ' title="频率 0 分组（停用组）：不参与填表、不注入世界书——要填它先把该组频率改成 >0"' : ''}><input type="checkbox" class="check" data-pick="${esc(t.tableId)}" ${on ? 'checked' : ''}${stopped ? ' disabled' : ''}><span>${esc(t.name)}</span>${stopped ? '<span class="slw-tag dim">不参与填表</span>' : ''}</label>`;
    }).join('') || '<div class="slw-muted">（当前模板无表）</div>';
    countEl.textContent = `已选 ${picked.size} / ${tables.length}`;
    gridEl.querySelectorAll('[data-pick]').forEach((n) => n.addEventListener('change', (e) => {
      const id = (e.target as HTMLElement).dataset.pick!;
      if ((e.target as HTMLInputElement).checked) picked.add(id); else picked.delete(id);
      countEl.textContent = `已选 ${picked.size} / ${tables.length}`;
      updateRunPlan();
    }));
    updateRunPlan();
  }
  const setPicked = (ids: string[]): void => {
    picked.clear();
    for (const id of ids) picked.add(id);
    renderGrid();
  };
  renderGrid();
  fillCard.querySelector('#slw-f-all')!.addEventListener('click', () => setPicked(fillable.map((t) => t.tableId)));
  fillCard.querySelector('#slw-f-none')!.addEventListener('click', () => setPicked([]));
  fillCard.querySelectorAll('[data-g]').forEach((btn) => (btn as HTMLElement).addEventListener('click', () => {
    const gid = Number((btn as HTMLElement).dataset.g);
    setPicked(tables.filter((t) => (Number(t.v2def ? t.v2def.groupId : 1) || 1) === gid && !isStoppedTable(t)).map((t) => t.tableId));
  }));
  // 层数参数主动保存（下次打开仍是上次的值）
  (fillCard.querySelector('#slw-f-recent') as HTMLInputElement).addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const v = savedNumberOf(input.value, recentValue);
    input.value = String(v);
    await deps.settings.update({ fillRecentFloors: v });
    updateRunPlan();
  });
  (fillCard.querySelector('#slw-f-merge') as HTMLInputElement).addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const v = savedNumberOf(input.value, mergeValue);
    input.value = String(v);
    await deps.settings.update({ fillMergeEvery: v });
    updateRunPlan();
  });
  fillCard.querySelector('#slw-f-run')!.addEventListener('click', async (e) => {
    const btn = e.target as HTMLButtonElement;
    // 全局互斥：自动填表/另一次手动正在跑时直接拒绝（跨页签重画也不怕按钮恢复可点）——B13/H3。
    if (deps.canonical.fill.isRunning?.()) {
      deps.warn('已有填表在执行（请等待完成，或点击进度通知终止）');
      btn.disabled = true;
      btn.textContent = '填表中…';
      return;
    }
    const pickedRefs = tables.filter((t) => picked.has(t.tableId)).map((t) => t.name);
    if (pickedRefs.length === 0) { deps.warn('请至少勾选一张表'); return; }
    btn.disabled = true; btn.textContent = '填表中…';
    (fillCard.querySelector('#slw-f-status') as HTMLElement).textContent = '填表执行中…（按分组分别请求 + 严格校验；点进度通知＝终止）';
    try {
      const summary = await deps.canonical.fill.runNow({
        scope: 'pick',
        tableRefs: pickedRefs,
        recentFloors: Number((fillCard.querySelector('#slw-f-recent') as HTMLInputElement).value) || threshold,
        mergeEvery: Number((fillCard.querySelector('#slw-f-merge') as HTMLInputElement).value) || 3,
        extraRequest: (fillCard.querySelector('#slw-f-extra') as HTMLTextAreaElement).value.trim() || undefined,
        // 口径 A：手动填表＝这些表在这些层重来一遍——先清空它们的旧增量再填（物理裁剪，不可恢复，故点名确认）
        confirmPrune: (info: { tables: string[]; floors: number; entries: number; ops: number }) => confirmDialog(deps,
          `手动填表将先清空所选表在被覆盖楼层的既有增量（不可恢复）：\n`
          + `· 表 ${info.tables.length} 张：${info.tables.slice(0, 8).join('、')}${info.tables.length > 8 ? ' 等' : ''}\n`
          + `· 楼层 ${info.floors} 层 · 条目 ${info.entries} 条 / 操作 ${info.ops} 处\n\n`
          + `这些表在这些层的旧改动（含前端手改）会被丢弃，随后由本次填表重算。其他表不受影响。`,
          { okText: '清空并重填', danger: true },
        ),
      });
      if (summary.skipped) deps.warn(`填表跳过：${summary.reason}`);
      else deps.notify(`填表完成：${summary.groups} 批 / ${summary.filledOps} 条操作${summary.errors.length ? `（${summary.errors.length} 项违规告警）` : ''}`);
      (fillCard.querySelector('#slw-f-status') as HTMLElement).textContent =
        summary.skipped ? `跳过：${summary.reason}` : `完成：${summary.groups} 批 / ${summary.filledOps} 条操作${summary.errors.length ? ` / ${summary.errors.length} 项违规` : ''}`;
    } catch (err) {
      // 意外异常（正常失败已由 scribe 逐项上报）：完整原文进日志，toast 只留摘要
      deps.log.push('error', '填表', '手动填表执行异常', describeErrorDetail(err));
      deps.warn('填表失败：' + describeErrorSummary(err));
    } finally {
      // 按钮跟随全局状态：自动填表仍在跑时保持禁用，不因本次手动结束而恢复可点。
      const running = deps.canonical.fill.isRunning?.() === true;
      btn.disabled = running;
      btn.textContent = running ? '填表中…' : '执行填表';
      renderStatus();
    }
  });
  // 首屏：如果打开面板时已经有填表在跑，按钮直接显示运行态。
  if (deps.canonical.fill.isRunning?.() === true) {
    const runBtn = fillCard.querySelector('#slw-f-run') as HTMLButtonElement | null;
    if (runBtn) { runBtn.disabled = true; runBtn.textContent = '填表中…'; }
  }

  // ── 各表填表状态卡（口径对齐数据库「上次更新 / 下次触发」） ──
  const statusCard = el(doc, 'div', { class: 'slw-card' }, `
    <h3>各表填表状态 <span class="desc">上次填写 = 最后一次填到的 AI 楼层；下次更新 = 上次填写 + 分组频率 + 跳过楼层</span></h3>
    <div class="slw-row"><span class="slw-muted" id="slw-f-st-head"></span><button class="slw-btn sm" id="slw-f-st-refresh" style="margin-left:auto">刷新</button></div>
    <table class="slw-tbl slw-tbl-fixed slw-responsive">
      <colgroup><col><col style="width:130px"><col style="width:104px"><col style="width:92px"><col style="width:132px"></colgroup>
      <thead><tr><th>表名</th><th>分组</th><th>频率</th><th>上次填写</th><th>下次更新</th></tr></thead>
      <tbody id="slw-f-st-body"></tbody>
    </table>
    <div class="slw-annot">自动填表 / 手动填表 / 定向重填都会推进「上次填写」（失败组除外：请求失败或仍有违规时停在原层，下次自动重试本批）。标「已到期」＝上下文总层数已达触发层，下次收到 AI 回复就会跑这一组；频率 0 的分组＝<b>停用组</b>：不参与自动更新，也不参与手动填表与定向重填（显示「—」），且不注入世界书。</div>`);
  pane.appendChild(statusCard);
  function renderStatus(): void {
    const bodyEl = statusCard.querySelector('#slw-f-st-body') as HTMLElement;
    const headEl = statusCard.querySelector('#slw-f-st-head') as HTMLElement;
    const current = deps.runtime.book();
    if (!current) {
      headEl.textContent = '';
      bodyEl.innerHTML = '<tr><td colspan="5" class="slw-muted">台账未就绪：先推进剧情（发送一条消息）触发自动更新；也可直接执行手动填表建账</td></tr>';
      return;
    }
    const now = deps.settings.get();
    const report = computeFillStatus(current, deps.getChat(), deps.runtime.getSchedule(), resolveScheduleGlobals({ autoUpdateThreshold: now.autoUpdateThreshold, skipUpdateFloors: now.skipUpdateFloors }));
    headEl.textContent = `上下文总层数：${report.aiCount}（仅 AI 回复楼层）· 跳过楼层：${report.skipFloors}`;
    bodyEl.innerHTML = report.rows.map((r) => {
      const due = r.frequency > 0 && report.aiCount >= r.nextUpdateFloor;
      const last = r.lastFilled > 0 ? `第 ${r.lastFilled} 层` : '<span class="slw-muted">未填</span>';
      const next = r.frequency > 0
        ? `第 ${r.nextUpdateFloor} 层${due ? ' <span class="slw-tag warn">已到期</span>' : ''}`
        : '<span class="slw-muted">—</span>';
      return `<tr>
        <td data-label="表名">${esc(r.name)}</td>
        <td data-label="分组"><span class="slw-tag slw-ell${r.frequency === 0 ? ' dim' : ''}">${esc(r.groupName || `分组${r.groupId}`)}</span></td>
        <td data-label="频率">${r.frequency > 0 ? `每 ${r.frequency} 层` : '<span class="slw-muted">0（不参与填表）</span>'}</td>
        <td data-label="上次填写">${last}</td>
        <td data-label="下次更新">${next}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="5" class="slw-muted">（当前模板无表）</td></tr>';
  }
  renderStatus();
  statusCard.querySelector('#slw-f-st-refresh')!.addEventListener('click', () => renderStatus());

  // ── 填表预设摘要卡（平时只显示状态 + 编辑入口；长表单进大弹窗） ──
  const customSystem = storedFillPrompt(String(s.fillSystemPrompt || ''));
  const promptItems = fillPromptSpecsOf(s);
  const defaultItemsJson = JSON.stringify(fillPromptSpecsOf({}));
  const presetCustom = customSystem !== '' || JSON.stringify(promptItems) !== defaultItemsJson;
  const effectiveSystem = customSystem || FILL_SYSTEM_PROMPT;
  const segCount = promptItems.filter((m) => !m.block).length;
  const blockCount = promptItems.filter((m) => m.block).length;
  const hiddenCount = promptItems.filter((m) => m.hidden === true).length;
  const presetCard = el(doc, 'div', { class: 'slw-card slw-preset-card' }, `
    <h3>填表预设 <span class="desc">任务段 + 内容项顺序；原「填表提示词」</span></h3>
    <div class="slw-row" style="margin:0">
      <span class="slw-tag ${presetCustom ? 'info' : 'dim'}">${presetCustom ? '自定义' : '内置默认'}</span>
      <span class="slw-preset-summary">任务段 <b>${effectiveSystem.length.toLocaleString()}</b> 字 · 内容项 <b>${promptItems.length}</b> 项（固定块 ${blockCount} / 段 ${segCount}${hiddenCount ? `，${hiddenCount} 个隐藏` : ''}）</span>
      <button class="slw-btn primary" id="slw-f-preset-edit">编辑填表预设…</button>
    </div>
    <div class="slw-muted" style="margin-top:6px">破限头 / 尾部破限与条目黑名单不随预设走，属主项目设置；留空任务段＝使用内置 SQL 版。</div>`);
  pane.appendChild(presetCard);
  presetCard.querySelector('#slw-f-preset-edit')!.addEventListener('click', () => openFillPresetEditor(ctx));
}

/** 填表预设编辑弹窗：任务段 + 内容项混排；所有修改先落草稿，保存时一次性写入。 */
function openFillPresetEditor(ctx: TabCtx): void {
  const { deps, doc } = ctx;
  const s = deps.settings.get();
  const initialSystem = String(s.fillSystemPrompt || '').trim() || FILL_SYSTEM_PROMPT;
  const originalSystem = storedFillPrompt(String(s.fillSystemPrompt || ''));
  const originalItems = fillPromptSpecsOf(s);
  const originalItemsJson = JSON.stringify(originalItems);
  const defaultItemsJson = JSON.stringify(fillPromptSpecsOf({}));
  const draftItems = clonePromptItems(originalItems);

  const content = el(doc, 'div');
  content.innerHTML = `
    <div class="slw-structline"><span class="slw-tag dim">结构头 · 破限槽位</span><span>只读，共享主项目「设置 → API → 破限头」；填表不挂反八股（输出是 SQL）。</span></div>
    <label class="slw-fieldlabel">任务段 <span class="slw-muted">（留空 = 内置默认；示例里的 {{表}} {{列}} 是引擎标记）</span></label>
    <textarea rows="14" id="slw-f-sysprompt" class="slw-tall" placeholder="（留空 = 使用内置默认提示词）">${esc(initialSystem)}</textarea>
    <div class="slw-editor-note">上面这段是「任务段」（＝原填表提示词；默认已预填内置内容，留空则使用内置默认）。示例里的 <b>{{表}} {{列}} {{列2}} {{长表}} {{长列}} {{数表}} {{数列}}</b> 是引擎标记：填表时按本轮台账里的真实表名、列名替换（长列＝长文本列、数列＝数字列），改示例时保留这些标记即可。</div>
    <fieldset class="fs">
      <legend>内容项（段 与 固定块 混排 · 顺序可调；固定块内容由引擎生成、只能调顺序或隐藏）</legend>
      <div id="slw-f-blocks"></div>
      <div class="slw-row" id="slw-f-blocks-actions"></div>
      <div class="slw-muted" style="margin-top:6px">块的位置＝内容在请求里的落点：<b>${esc(LEDGER_BLOCK_LABELS.scan)}</b> 的落点即 1A 原生中段槽位组（世界书激活条目 + 角色卡/人设/场景等设定按序插入，带「${esc(LEDGER_SCAN_HEADING)}」抬头）。输出要求句恒在内容项之后、尾部破限之前。</div>
    </fieldset>
    <div class="slw-structline" style="margin-top:12px"><span class="slw-tag dim">结构尾 · 尾部破限槽位</span><span>只读，共享主项目「设置 → API → 尾部破限」；输出完成后追加，文本出口统一剥 &lt;safe&gt; 段。</span></div>
    <div class="slw-annot" style="margin-bottom:0">内容项后恒跟输出要求句：<span class="slw-muted">${esc(FILL_OUTPUT_INSTRUCTION)}</span></div>`;
  const textarea = content.querySelector('#slw-f-sysprompt') as HTMLTextAreaElement;

  const actions = el(doc, 'div');
  actions.innerHTML = `
    <span class="slw-editor-dirty" data-slw-dirty style="display:none">● 有未保存修改</span>
    <span class="slw-editor-spacer"></span>
    <button class="slw-btn" data-act="cancel">取消</button>
    <button class="slw-btn primary" data-act="save">保存填表预设</button>`;
  const dirtyEl = actions.querySelector('[data-slw-dirty]') as HTMLElement;
  const saveBtn = actions.querySelector('[data-act="save"]') as HTMLButtonElement;

  let handle: ReturnType<typeof openEditorDialog> | null = null;

  const isDefaultDraft = (): boolean => JSON.stringify(draftItems) === defaultItemsJson;
  const isDirty = (): boolean =>
    storedFillPrompt(textarea.value) !== originalSystem
    || JSON.stringify(draftItems) !== originalItemsJson;

  const syncTag = (): void => {
    const tag = handle?.root.querySelector('[data-slw-toolbar-tag]') as HTMLElement | null;
    if (!tag) return;
    const custom = storedFillPrompt(textarea.value) !== '' || !isDefaultDraft();
    tag.textContent = custom ? '自定义' : '内置默认';
    tag.className = `slw-tag ${custom ? 'info' : 'dim'}`;
  };
  const syncDirty = (): void => {
    dirtyEl.style.display = isDirty() ? '' : 'none';
    syncTag();
  };

  const editor = mountPromptEditor({
    box: content.querySelector('#slw-f-blocks') as HTMLElement,
    actions: content.querySelector('#slw-f-blocks-actions') as HTMLElement,
    items: draftItems,
    blockIds: FILL_BLOCK_IDS,
    hints: FILL_BLOCK_HINTS,
    onChange: syncDirty,
  });

  handle = openEditorDialog(deps, {
    title: '填表预设',
    subtitle: '任务段 + 内容项顺序；原「填表提示词」。破限与黑名单不随预设走。',
    toolbar: `
      <button class="slw-btn sm" data-act="reset">恢复默认</button>
      <button class="slw-btn sm" data-act="import">导入填表预设 JSON</button>
      <button class="slw-btn sm" data-act="export">导出填表预设 JSON</button>
      <span class="slw-tag dim" data-slw-toolbar-tag style="margin-left:auto">内置默认</span>`,
    content,
    actions,
    beforeClose: async () => {
      if (!isDirty()) return true;
      return await confirmDialog(deps, '有未保存的修改，关闭后丢弃？', { okText: '放弃修改', cancelText: '继续编辑', danger: true });
    },
  });

  textarea.addEventListener('input', syncDirty);
  actions.querySelector('[data-act="cancel"]')!.addEventListener('click', () => handle?.requestClose());

  handle.root.querySelector('[data-act="reset"]')!.addEventListener('click', async () => {
    if (!await confirmDialog(deps, '恢复内置填表提示词与内容项顺序？（当前弹窗里的修改将被清空，保存后才生效）', { okText: '恢复默认', danger: true })) return;
    textarea.value = FILL_SYSTEM_PROMPT;
    draftItems.splice(0, draftItems.length, ...clonePromptItems(fillPromptSpecsOf({})));
    editor.render();
    syncDirty();
  });

  handle.root.querySelector('[data-act="import"]')!.addEventListener('click', async () => {
    const parsed = await pickJsonFile(deps, '.json');
    if (!parsed || typeof parsed !== 'object') { deps.warn('JSON 读取失败'); return; }
    if ((parsed as any).format !== 'sese-ledger-fill-prompt') { deps.warn('不是台账填表预设文件（缺少 format 标记）'); return; }
    const text = String((parsed as any).fillSystemPrompt || '').trim() || FILL_SYSTEM_PROMPT;
    textarea.value = text;
    if (Array.isArray((parsed as any).fillPrompt)) {
      draftItems.splice(0, draftItems.length, ...clonePromptItems(fillPromptSpecsOf({ fillPrompt: (parsed as any).fillPrompt })));
      editor.render();
    }
    syncDirty();
    deps.notify('填表预设已导入到草稿，点「保存填表预设」生效');
  });

  handle.root.querySelector('[data-act="export"]')!.addEventListener('click', () => {
    downloadJsonFile(deps, '瑟瑟台账-填表预设.json', {
      format: 'sese-ledger-fill-prompt',
      schemaVersion: 2,
      fillSystemPrompt: textarea.value.trim() || FILL_SYSTEM_PROMPT,
      fillPrompt: draftItems,
    });
  });

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    saveBtn.textContent = '保存中…';
    try {
      const system = storedFillPrompt(textarea.value);
      // 与任务段「留空=内置」同口径：内容项与内置默认完全一致时回存 null，继续跟随内置升级。
      await deps.canonical.prompts.setFillSystem(system);
      await deps.canonical.prompts.setFillPrompt(isDefaultDraft() ? null : draftItems);
      deps.notify('填表提示词已保存');
      handle?.close(true);
      ctx.refresh('fill');
    } catch (err) {
      deps.warn('保存填表预设失败：' + (err instanceof Error ? err.message : String(err)));
      saveBtn.disabled = false;
      saveBtn.textContent = '保存填表预设';
    }
  });

  syncDirty();
}

/** 空 / 等于内置文本 = 使用内置默认（与保存口径一致）。 */
function storedFillPrompt(text: string): string {
  const trimmed = String(text || '').trim();
  return trimmed === FILL_SYSTEM_PROMPT.trim() ? '' : trimmed;
}

function clonePromptItems(items: LedgerPromptItemSpec[]): LedgerPromptItemSpec[] {
  return JSON.parse(JSON.stringify(items)) as LedgerPromptItemSpec[];
}
