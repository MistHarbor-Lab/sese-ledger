// ===== 表格标签页：模板卡 · 表清单 · 分组配置 · 建表向导 · 表编辑抽屉 =====
import { esc, el, pickJsonFile, downloadJsonFile, commitTemplateEdit, confirmDialog, promptDialog, alertDialog, summaryGroupAssignmentsOfBook, summaryGroupAssignmentsOfV2, confirmSummaryGroupSplit } from './shared';
import type { TabCtx } from './shell';
import { groupsOf, isStoppedGroup, isStoppedTable, setGroupsOf, syncV2UpdateConfigs, projectWorkbook, specialFormOf, type TableModel } from '../../core/book';
import { clampSingleUnique, convergeBookToTemplate, normalizeTemplateAny, workbookToV2Template } from '../../core/blueprint';
import { buildBookStructureSummary, buildWizardMessages, newTableId, parseWizardOutput, wizardDefToSheet } from '../../core/table-wizard';
import { resolveFillMaxAttempts } from '../../core/scribe';
import { describeErrorDetail, describeErrorSummary } from '../../core/error-detail';
import { summaryWarning } from '../../core/summary-warning';
import type { LedgerGroupDef, LedgerSheetDef } from '../../core/types';

/** 纪要表判定（硬约束：纪要表不允许进入频率 0 的停用组）——名称/特殊形态单出口。 */
function isSummaryTable(t: TableModel): boolean {
  return specialFormOf(t.name, t.v2def) === 'summary';
}

/** 停用组拦截提示：纪要表不许进频率 0 分组（返回 null = 放行）。 */
function summaryStoppedReason(summaryName: string, group: LedgerGroupDef | undefined): string | null {
  return isStoppedGroup(group)
    ? `「${summaryName}」是纪要表：不允许进入频率 0 的分组（停用组不填表、不注入世界书）——换个分组，或先把该组频率改成 >0`
    : null;
}

function readModeTag(mode: string): string {
  if (mode === 'trigger') return '<span class="slw-tag info">按触发</span>';
  if (mode === 'none') return '<span class="slw-tag dim">不读取</span>';
  return '<span class="slw-tag">全量</span>';
}

/** 本聊天生效的模板名（角色卡绑定优先 → 全局默认预设 → 内置）。 */
function templateLabelOf(ctx: TabCtx): string {
  const binding = ctx.deps.canonical?.templateBinding;
  const bound = String(binding?.name?.() || '');
  if (bound) return bound;
  return ctx.deps.settings.get().defaultTemplatePreset || ctx.deps.standardPresetName;
}

/** 绑定说明（跟随角色卡 / 群聊回落全局默认）。 */
function bindingNoteOf(ctx: TabCtx): string {
  const binding = ctx.deps.canonical?.templateBinding;
  if (!binding || binding.writable?.() !== true) {
    return '当前为群聊/无角色卡上下文：模板绑定回落「全局默认预设」（模板库全局保存）';
  }
  const bound = String(binding.boundToCard?.() || '');
  return bound
    ? `本模板跟随<b>当前角色卡</b>（该卡所有聊天共用；改结构自动写回该预设）`
    : '尚未给该角色卡绑定模板：当前用「全局默认预设」，选一次模板即绑定到本卡';
}

export function renderTablesTab(ctx: TabCtx, pane: HTMLElement): void {
  const { deps, doc } = ctx;
  const book = deps.runtime.book();
  pane.innerHTML = '';

  // ── 模板卡 ──
  // 预设可用性预扫：读不出来的一律**保留在列表里**（标「读取失败 · 可删除」），否则用户永远选不中它、也就删不掉。
  const presetEntries = deps.settings.listTemplatePresetNames()
    .filter((n) => n !== deps.standardPresetName)
    .map((name) => {
      // 与收敛/建账共用同一份记忆化解析（G3）：表格页每次重渲不再全量 JSON.parse + 校验。
      const normalized = deps.settings.loadTemplatePresetNormalized(name);
      return { name, ok: !!normalized?.ok, legacy: !!normalized?.ok && !normalized?.v2 };
    });
  const goodPresets = presetEntries.filter((p) => p.ok);
  const badPresets = presetEntries.filter((p) => !p.ok);
  const currentLabel = templateLabelOf(ctx);
  const groups = book ? groupsOf(book) : [];
  const tplCard = el(doc, 'div', { class: 'slw-card' }, `
    <h3>当前模板 <span class="desc">模板决定表结构、分组与世界书注入；模板库全局保存，<b>绑定跟随角色卡</b>（一处改，该卡所有聊天跟着变）</span></h3>
    <div class="slw-row">
      <select id="slw-tpl-select" style="min-width:320px">
        <option value="${esc(deps.standardPresetName)}" ${currentLabel === deps.standardPresetName ? 'selected' : ''}>内置 · ${esc(deps.standardPresetName)} · ${esc(deps.standardTemplateV2.tables.length)} 表 / ${esc(deps.standardTemplateV2.groups.length)} 分组</option>
        ${goodPresets.map((p) => `<option value="${esc(p.name)}" ${p.name === currentLabel ? 'selected' : ''}>${esc(p.name)}（自定义${p.legacy ? ' · 旧格式套用时自动转换' : ''}）</option>`).join('')}
        ${badPresets.map((p) => `<option value="${esc(p.name)}" ${p.name === currentLabel ? 'selected' : ''}>${esc(p.name)}（读取失败 · 可删除）</option>`).join('')}
        <option value="__import__">＋ 导入数据库模板 JSON…</option>
        <option value="__blank__">＋ 新建空白模板…</option>
      </select>
      <button class="slw-btn" id="slw-tpl-save-as">另存为预设</button>
      <button class="slw-btn" id="slw-tpl-export">导出 JSON</button>
      <button class="slw-btn danger" id="slw-tpl-delete">删除所选预设</button>
    </div>
    ${badPresets.length > 0 ? `<div class="slw-row"><span class="slw-muted" style="flex:1">检测到 ${badPresets.length} 个读不出来的模板预设（内容不是模板 JSON / 结构校验不过）：${badPresets.map((p) => esc(p.name)).join('、')}——选中后可直接「删除所选预设」。</span></div>` : ''}
    <div class="slw-annot">导入数据库（v1）模板 JSON 时自动转换为台账 v2：DDL→列定义（枚举/长度/数字限制丢弃）、角色过滤→按触发读取、updateConfig 调度参数→分组注册表。转换报告会先展示再落库。表名/列名一律中文（引擎只认中文名）：填表与查询都用中文名。<br>当前模板<b>「${esc(currentLabel)}」</b>＝结构真源与写回目标：改分组 / 改表结构 / 增删表 / 套用建表向导后自动写回该模板；${bindingNoteOf(ctx)}。绑定内置标准模板时改结构会自动另存派生预设并改绑（内置不可改）。要留档另一份用「另存为预设」（存进模板库）；<b>「导出 JSON」</b>把当前模板存成一个模板文件（分组 / 读取设置 / 世界书注入 / 表说明与触发提示全带走），用「＋ 导入数据库模板 JSON…」即可原样读回。</div>`);
  pane.appendChild(tplCard);
  tplCard.querySelector('#slw-tpl-select')!.addEventListener('change', async (e) => {
    const value = (e.target as HTMLSelectElement).value;
    if (value === '__import__') { await importTemplateJson(ctx); return; }
    if (value === '__blank__') { await applyBlankTemplate(ctx); return; }
    // 读预设：loadTemplatePreset 返回**已解析**的模板对象（v1 workbook / v2 模板）——直接用，别再取 .templateStr
    const isStandard = value === deps.standardPresetName;
    const loaded = isStandard ? null : deps.settings.loadTemplatePreset(value);
    if (!isStandard && !loaded) {
      // 读不出来：**不重渲**（否则下拉弹回默认项 ⇒ 这个预设既选不中也删不掉——历史 bug），选中项留在原地待删
      deps.warn(`预设「${value}」读取失败（内容不是模板 JSON）。可直接点「删除所选预设」清掉它。`);
      return;
    }
    // 分组告警：目标模板把全局数据表与纪要表分到不同组时先确认（取消则下拉回位、不套用）
    const targetV2 = isStandard ? deps.standardTemplateV2 : deps.settings.loadTemplatePresetNormalized(value)?.v2;
    if (targetV2) {
      const ok = await confirmSummaryGroupSplit(
        ctx,
        summaryGroupAssignmentsOfV2(targetV2),
        Array.isArray(targetV2.groups) ? targetV2.groups : [],
      );
      if (!ok) { (e.target as HTMLSelectElement).value = currentLabel; return; }
    }
    // 交由既有链路统一归一化：v2 直通 / 纯 v1 自动转换 / 带 ledgerV2 的 workbook 走直通分支
    const r = await deps.canonical.applyBlueprint(isStandard ? deps.canonical.standardTemplateWorkbook : loaded, { scope: 'chat' });
    if (r?.success === false) { deps.warn(r?.message || '模板套用失败'); return; }
    // 绑定跟随角色卡（同卡各聊天共用）；无卡上下文（群聊）由 canonical 回落全局默认预设
    const bindResult = deps.canonical.templateBinding?.set?.(value);
    if (bindResult && bindResult.ok === false) deps.warn(bindResult.message);
    else deps.notify(bindResult?.message || `已套用模板「${value}」（当前聊天）`);
    ctx.structureChanged();
  });
  tplCard.querySelector('#slw-tpl-save-as')!.addEventListener('click', async () => {
    if (!book) return;
    const name = await promptDialog(deps, '预设名：', `我的模板 ${new Date().toISOString().slice(0, 10)}`, { okText: '另存为预设' });
    if (!name) return;
    const v2 = workbookToV2Template(projectWorkbook(book), name);
    if (!v2) { deps.warn('当前账本无 v2 表定义，无法另存'); return; }
    await deps.settings.saveTemplatePreset(name, JSON.stringify(v2));
    deps.notify(`预设「${name}」已保存`);
    ctx.refresh('tables');
  });
  tplCard.querySelector('#slw-tpl-export')!.addEventListener('click', () => {
    if (!book) { deps.warn('台账未就绪（当前聊天尚未建账）'); return; }
    // 导出**裸 v2 模板**（无包裹壳）：与「＋ 导入数据库模板 JSON…」同一条链路可直接读回（v2 直通，无需转换）
    const v2 = workbookToV2Template(projectWorkbook(book), currentLabel);
    if (!v2) { deps.warn('当前账本无 v2 表定义，无法导出'); return; }
    downloadJsonFile(deps, `瑟瑟台账-模板预设-${currentLabel}.json`, v2);
  });
  tplCard.querySelector('#slw-tpl-delete')!.addEventListener('click', async () => {
    const select = tplCard.querySelector('#slw-tpl-select') as HTMLSelectElement;
    const name = select.value;
    if (name.startsWith('__') || name === deps.standardPresetName) { deps.warn('内置/虚拟项不可删除'); return; }
    const isWriteTarget = name === currentLabel;
    if (!await confirmDialog(deps, `删除预设「${name}」？${isWriteTarget ? '（它正是当前写回目标，删除后写回目标切回内置模板）' : ''}不影响当前聊天结构。`, { okText: '删除预设', danger: true })) return;
    await deps.settings.deleteTemplatePreset(name);
    deps.notify(`预设「${name}」已删除`);
    ctx.refresh('tables');
  });

  if (!book) {
    pane.appendChild(el(doc, 'div', { class: 'slw-annot' }, '台账未就绪（当前聊天尚未建账）。发送一轮对话或执行手动填表后自动建账。'));
    return;
  }

  // ── 表清单 ──
  const tables = [...book.tables.values()].sort((a, b) => a.orderNo - b.orderNo);
  const groupMap = new Map(groups.map((g) => [g.id, g]));
  const summaryWarnInfo = summaryWarning(book, deps.settings.get());
  const listCard = el(doc, 'div', { class: 'slw-card' }, `
    <h3>表清单 <span class="desc">「编辑」打开表编辑抽屉；「＋ 新增表」手动建一张空表</span></h3>
    <div class="slw-row" style="margin-bottom:10px">
      <button class="slw-btn sm" id="slw-table-add">＋ 新增表</button>
      <span class="slw-muted">当前 ${tables.length} 张表 · 新增/删除都即时写回当前所选预设（内置模板或未选预设时不写回）</span>
    </div>
    <table class="slw-tbl slw-tbl-fixed slw-responsive">
      <colgroup><col><col style="width:56px"><col style="width:56px"><col style="width:118px"><col style="width:96px"><col style="width:230px"><col style="width:124px"></colgroup>
      <thead><tr><th>表名</th><th>列</th><th>行</th><th>分组</th><th>读取模式</th><th>世界书注入</th><th>操作</th></tr></thead>
      <tbody>
        ${tables.map((t) => {
          const def = t.v2def;
          const g = def ? groupMap.get(def.groupId) : undefined;
          const stopped = !!def && isStoppedTable(t);
          const gLabel = g ? (isStoppedGroup(g) ? `${esc(g.name)}（频率0）` : esc(g.name)) : '—';
          const wb = def?.worldbook;
          const wbKeyDesc = ((): string => {
            const c1 = String(wb?.keywordsColumn || '—');
            const logic = wb?.keywordsLogic === 'and' ? ' 与 ' : wb?.keywordsLogic === 'or' ? ' 或 ' : '';
            const c2 = logic && wb?.keywordsColumn2 ? String(wb.keywordsColumn2) : '';
            return `${c1}${logic}${c2}`;
          })();
          const special = specialFormOf(t.name, def);
          const specialMark = special
            ? ` <span class="slw-tag warn" title="特殊表（${special === 'relation' ? '人物关系：条目名/包裹标签恒为「人物关系表：A与B的关系」' : '纪要：每行一条目＝时间跨度|纪要|重要对话 + AM 码 keys，整组由 <过往记忆> 标签条目（顺序 9985/9995）包住'}）——形态由引擎特判，禁止删除">✦ ${special === 'relation' ? '人物关系' : '纪要'}</span>`
            : '';
          const wbTag = def?.lensForm === 'summary'
            ? '<span class="slw-tag ok">纪要表：AM 码</span>'
            : stopped
              ? `<span class="slw-tag dim" title="${esc(t.name)}：所在分组频率 0（停用组）→ 不注入世界书｜原设置保留：${wb?.enabled ? esc(wbKeyDesc) : '注入关'}——挪回频率 >0 的分组即恢复">关（频率0）</span>`
              : wb?.enabled
                ? `<span class="slw-tag ok slw-ell" title="${esc(t.name)}：${esc(wbKeyDesc)}">${wb.mode === 'constant' ? '常量' : '关键词触发'} · ${esc(t.name)}：${esc(wbKeyDesc)}</span>`
                : '<span class="slw-tag dim">关</span>';
          return `<tr>
            <td data-label="表名">${esc(t.name)}${specialMark}</td><td data-label="列">${t.headers.length - 1}</td><td data-label="行">${t.rows.size}${special === 'summary' && summaryWarnInfo.over ? ` <span class="slw-tag danger" title="超过建议上限 ${summaryWarnInfo.limit} 条；到「纪要合并」标签压缩">超过建议上限</span>` : ''}</td>
            <td data-label="分组"><span class="slw-tag slw-ell${g && isStoppedGroup(g) ? ' dim' : ''}">${gLabel}</span></td>
            <td data-label="读取模式">${readModeTag(def?.readMode || 'all')}</td>
            <td data-label="世界书注入">${wbTag}</td>
            <td data-label="操作"><button class="slw-btn sm" data-edit="${esc(t.tableId)}">编辑</button> <button class="slw-btn sm danger" data-del="${esc(t.tableId)}"${special ? ' disabled title="特殊表（引擎特判形态）：禁止删除"' : ''}>删除</button></td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
    <div class="slw-annot">表名/列名一律中文（引擎只认中文名）：填表、查询、世界书条目都用中文名。「读取模式」= 填表时该表数据进【当前台账】的方式：<b>全量</b>＝恒进入；<b>按触发</b>＝看世界书注入（关＝不进入 / 常量＝恒进入 / 关键词触发＝命中关键词才进入，关键词取「世界书注入 → 关键词列」（选了「与/或」逻辑时按两列同口径判定），用处理后的正文段匹配）；<b>不读取</b>＝只给表说明与操作规则。频率 0 的分组＝<b>停用组</b>：组内表不自动更新、<b>不参与任何填表</b>（填表页分组按钮里不出现该组、勾选框置灰）、<b>不注入世界书</b>（无视该表注入开关，设置保留——挪回频率 >0 的分组即恢复）；<b>纪要表不允许进入停用组</b>。<b>删除</b>＝表与数据行一并删除（不可恢复），当前所选预设同步更新；表名带 <b>✦</b> 标记的是<b>特殊表</b>（人物关系 / 纪要，世界书条目形态由引擎特判），<b>禁止删除</b>。</div>`);
  pane.appendChild(listCard);
  listCard.querySelectorAll('[data-edit]').forEach((btn) => {
    (btn as HTMLElement).onclick = () => openTableDrawer(ctx, (btn as HTMLElement).dataset.edit!);
  });
  listCard.querySelector('#slw-table-add')!.addEventListener('click', () => openTableDrawer(ctx, null));
  listCard.querySelectorAll('[data-del]').forEach((btn) => {
    (btn as HTMLElement).onclick = async () => {
      const id = (btn as HTMLElement).dataset.del!;
      const target = book.tables.get(id);
      if (!target) return;
      // 特殊表（人物关系表 / 纪要表）禁删：形态由引擎特判，删了流水线直接缺口（按钮已 disabled，此处兜底）
      if (specialFormOf(target.name, target.v2def)) { deps.warn(`「${target.name}」是特殊表（引擎特判形态），禁止删除`); return; }
      if (!await confirmDialog(deps, `删除表「${target.name}」（${target.rows.size} 行数据一并删除，不可恢复）？\n当前所选预设（如有）同步更新。`, { okText: '删除表', danger: true })) return;
      book.tables.delete(id);
      commitTemplateEdit(ctx, `表「${target.name}」已删除`);
    };
  });

  // ── 分组配置 ──
  const membersOf = (gid: number) => tables.filter((t) => t.v2def && Number(t.v2def.groupId) === gid);
  const groupCard = el(doc, 'div', { class: 'slw-card' }, `
    <h3>分组配置 <span class="desc">分组 = 调度单位；组内表共用一次填表请求（同一批剧情上下文）；频率只在此设置</span></h3>
    <div class="slw-row" style="margin-bottom:10px">
      <button class="slw-btn sm" id="slw-group-add">＋ 增加分组</button>
      <span class="slw-muted">当前 ${groups.length} 组 · 组内表共用一次填表请求（同一批剧情上下文）</span>
    </div>
    <table class="slw-tbl slw-tbl-fixed slw-responsive">
      <colgroup><col style="width:52px"><col style="width:170px"><col style="width:250px"><col><col style="width:186px"></colgroup>
      <thead><tr><th>编号</th><th>组名</th><th>更新频率</th><th>成员表</th><th>操作</th></tr></thead>
      <tbody>
        ${groups.map((g) => `<tr>
          <td data-label="编号">${g.id}</td>
          <td data-label="组名"><input type="text" value="${esc(g.name)}" style="width:130px" data-gname="${g.id}"></td>
          <td data-label="更新频率">每 <input type="number" value="${g.frequency}" min="0" style="width:56px" data-gfreq="${g.id}"> 层${isStoppedGroup(g) ? ' <span class="slw-tag dim" title="停用组：组内表不自动更新、不参与任何填表、不注入世界书（注入设置保留）">= 不填表 · 不注入世界书</span>' : ''}</td>
          <td data-label="成员表">${membersOf(g.id).map((t) => `<span class="slw-tag">${esc(t.name)}</span>`).join(' ') || '<span class="slw-muted">（空）</span>'}</td>
          <td data-label="操作"><button class="slw-btn sm" data-gmembers="${g.id}">调整成员</button> <button class="slw-btn sm danger" data-gdel="${g.id}" ${Number(g.id) === 1 ? 'disabled title="分组1 是兜底分组，不能删除（可改名/改频率）"' : ''}>删除组</button></td>
        </tr>`).join('')}
      </tbody>
    </table>
    <div class="slw-annot">「调整成员」弹出表多选清单（把表在组间移动）；删除组时成员自动并入分组1。频率只在此设置——表编辑抽屉里不再有任何调度参数（这是与数据库的最大差异之一）。<b>频率 0 ＝停用组</b>：组内表不自动更新、不参与手动/定向填表、不注入世界书；<b>纪要表不允许放进停用组</b>（调整成员、改频率、删除组三处都会拦下并提示）。</div>`);
  pane.appendChild(groupCard);
  const commitGroups = async (next: typeof groups, reassign?: (t: TableModel) => void): Promise<void> => {
    // change 事件常伴「失焦空提交」：分组结构实际未变时早退——否则整本投影 + 快照记账 +
    // 预设回写 + 世界书刷新 + 整页重渲（O(book)）白跑一轮。
    if (!reassign && JSON.stringify(next) === JSON.stringify(groupsOf(book))) return;
    setGroupsOf(book, next);
    if (reassign) for (const t of book.tables.values()) reassign(t);
    syncV2UpdateConfigs(book);
    commitTemplateEdit(ctx);
  };
  groupCard.querySelectorAll('[data-gname]').forEach((input) => {
    (input as HTMLInputElement).addEventListener('change', async (e) => {
      const gid = Number((e.target as HTMLElement).dataset.gname);
      const next = groupsOf(book).map((g) => g.id === gid ? { ...g, name: (e.target as HTMLInputElement).value.trim() || g.name } : g);
      await commitGroups(next);
    });
  });
  groupCard.querySelectorAll('[data-gfreq]').forEach((input) => {
    (input as HTMLInputElement).addEventListener('change', async (e) => {
      const target = e.target as HTMLInputElement;
      const gid = Number(target.dataset.gfreq);
      const freq = Math.max(0, Math.trunc(Number(target.value) || 0));
      const current = groupsOf(book).find((g) => Number(g.id) === gid);
      const currentFreq = Math.max(0, Math.trunc(Number(current?.frequency) || 0));
      if (freq === currentFreq) { target.value = String(currentFreq); return; } // 失焦空提交：值回位、不提交
      // 纪要表不许进停用组：把含纪要表的组改成频率 0 会让整组变停用 → 拦下并回滚输入框
      if (freq === 0) {
        const summary = membersOf(gid).find(isSummaryTable);
        if (summary) { target.value = String(currentFreq); deps.warn(summaryStoppedReason(summary.name, { id: gid, name: current?.name || `分组${gid}`, frequency: 0 })!); return; }
      }
      const next = groupsOf(book).map((g) => g.id === gid ? { ...g, frequency: freq } : g);
      await commitGroups(next);
    });
  });
  groupCard.querySelector('#slw-group-add')!.addEventListener('click', async () => {
    const name = await promptDialog(deps, '新分组名称：', `分组${groups.length + 1}`, { okText: '创建分组' });
    if (name === null) return;
    const next = [...groupsOf(book), { id: Math.max(0, ...groupsOf(book).map((g) => g.id)) + 1, name: name || `分组${groups.length + 1}`, frequency: 1 }];
    await commitGroups(next);
  });
  groupCard.querySelectorAll('[data-gdel]').forEach((btn) => {
    (btn as HTMLElement).onclick = async () => {
      const gid = Number((btn as HTMLElement).dataset.gdel);
      // 分组1 是兜底分组（删组时成员默认并入这里）：禁止删除，避免成员挂到不存在的组（E2）。
      if (gid === 1) { deps.warn('分组1 是兜底分组，不能删除（可改名/改频率）'); return; }
      if (groupsOf(book).length <= 1) { deps.warn('至少保留一个分组'); return; }
      // 成员自动并入分组1：若被删组含纪要表、而分组1是停用组 → 等于把纪要表塞进停用组，拦下
      const dest = groupsOf(book).find((g) => Number(g.id) === 1 && Number(g.id) !== gid);
      const summary = membersOf(gid).find(isSummaryTable);
      if (summary && dest && isStoppedGroup(dest)) {
        deps.warn(`分组1（${dest.name}）是频率 0 的停用组：删除本组会把「${summary.name}」并进去——先把分组1 的频率改成 >0，或先把纪要表挪到别的分组`);
        return;
      }
      if (!await confirmDialog(deps, '删除该分组？成员表自动并入分组1。', { okText: '删除分组', danger: true })) return;
      const next = groupsOf(book).filter((g) => g.id !== gid);
      // 成员并入分组1 后若把全局数据表/纪要表拆到不同组 → 先确认（取消则整个删除中止）
      const assignments = summaryGroupAssignmentsOfBook(book)
        .map((a) => (Number(a.groupId) === gid ? { ...a, groupId: 1 } : a));
      if (!await confirmSummaryGroupSplit(ctx, assignments, next)) return;
      await commitGroups(next, (t) => { if (t.v2def && Number(t.v2def.groupId) === gid) t.v2def.groupId = 1; });
    };
  });
  groupCard.querySelectorAll('[data-gmembers]').forEach((btn) => {
    (btn as HTMLElement).onclick = () => openGroupMembersDialog(ctx, Number((btn as HTMLElement).dataset.gmembers));
  });

  // ── 建表向导 ──
  const wizardCard = el(doc, 'div', { class: 'slw-card' }, `
    <h3>建表向导 <span class="desc">一句话描述 → AI 生成整张表；或选现有表描述修改要求</span></h3>
    <div class="slw-row"><button class="slw-btn primary" id="slw-wizard-open">打开建表向导</button>
      <span class="slw-muted">生成结果先预览、通过严格校验后才套用（校验失败自动带错误回注重试）</span></div>`);
  pane.appendChild(wizardCard);
  wizardCard.querySelector('#slw-wizard-open')!.addEventListener('click', () => openWizardDialog(ctx));
}

// ===== 模板导入（v1 数据库模板 JSON → v2；转换报告先展示） =====
async function importTemplateJson(ctx: TabCtx): Promise<void> {
  const { deps } = ctx;
  const parsed = await pickJsonFile(ctx.deps, '.json');
  if (!parsed) { deps.warn('JSON 读取失败'); return; }
  const normalized = normalizeTemplateAny(parsed);
  if (!normalized.ok || !normalized.workbook || !normalized.v2) {
    deps.warn('模板校验失败：' + normalized.errors.join('；'));
    return;
  }
  const reportText = ['转换报告：', ...normalized.report].join('\n');
  if (!await confirmDialog(deps, reportText + '\n\n确认导入并套用到当前聊天？', { okText: '导入并套用' })) return;
  if (!await confirmSummaryGroupSplit(ctx, summaryGroupAssignmentsOfV2(normalized.v2), normalized.v2.groups || [])) return;
  const name = await promptDialog(deps, '保存为预设名：', '导入模板 ' + new Date().toISOString().slice(5, 10), { okText: '导入' });
  if (name === null) return; // 点取消 = 中止整个导入，不能继续套用（E6）
  await deps.settings.saveTemplatePreset(name || '导入模板', JSON.stringify(normalized.v2));
  const bindResult = deps.canonical.templateBinding?.set?.(name || '导入模板');
  if (bindResult && bindResult.ok === false) deps.warn(bindResult.message);
  const r = await deps.canonical.applyBlueprint(normalized.workbook, { scope: 'chat' });
  if (r?.success !== false) deps.notify('模板已导入并套用');
  else deps.warn(r?.message || '套用失败');
  ctx.structureChanged();
}

async function applyBlankTemplate(ctx: TabCtx): Promise<void> {
  const { deps } = ctx;
  if (!await confirmDialog(deps, '新建空白模板：丢弃当前聊天的全部表结构与数据行（模板外内容一律丢弃，不可恢复）？建议先「另存为预设」或「导出 JSON」备份。', { okText: '新建空白模板', danger: true })) return;
  const blank = { schemaVersion: 2, name: '空白模板', groups: [{ id: 1, name: '分组1', frequency: 1 }], tables: [] };
  const r = await deps.canonical.applyBlueprint(blank, { scope: 'chat' });
  if (r?.success !== false) deps.notify('已套用空白模板（原表与数据已丢弃）');
  else deps.warn(r?.message || '套用失败');
  ctx.structureChanged();
}

// ===== 表编辑抽屉（tableId=null 时是「新增表」：同一套字段，保存即建表） =====
function openTableDrawer(ctx: TabCtx, tableId: string | null): void {
  const { deps, doc } = ctx;
  const book = deps.runtime.book();
  if (!book) { deps.warn('台账未就绪（当前聊天尚未建账）'); return; }
  const table = tableId ? book.tables.get(tableId) : null;
  if (tableId && (!table || !table.v2def)) { deps.warn('该表不是 v2 结构（刷新后重试）'); return; }
  const isCreate = !table;
  const groups = groupsOf(book);
  const visible = [...book.tables.values()];
  const def: LedgerSheetDef = isCreate
    ? {
        tableId: '',
        name: '',
        orderNo: Math.max(0, ...visible.map((t) => t.orderNo)) + 1,
        groupId: groups[0]?.id ?? 1,
        note: '',
        triggerNotes: {},
        columns: [{ header: '名称', type: 'text', unique: true, notNull: true }],
        readMode: 'all',
        worldbook: { enabled: false },
      }
    : JSON.parse(JSON.stringify(table!.v2def));
  const columnsHeader = def.lensForm === 'summary';
  // 特殊表（人物关系 / 纪要）：表名由引擎特判（主项目也按名认人物关系表），改名会静默失效 → 输入框只读
  const specialForm = isCreate ? '' : specialFormOf(def.name, def);
  // 总览条目只对「启用注入 + 关键词触发 + 非纪要」有意义（常量注入本身已是整表一条）
  const wbKeywordVisible = def.worldbook.enabled === true && def.lensForm !== 'summary' && def.worldbook.mode !== 'constant';

  const app = doc.querySelector('.slw-app') as HTMLElement | null;
  if (!app) return;
  app.querySelector('.slw-drawer-mask')?.remove();
  app.querySelector('.slw-drawer')?.remove();
  const mask = el(doc, 'div', { class: 'slw-drawer-mask open' });
  const drawer = el(doc, 'div', { class: 'slw-drawer open' });
  drawer.innerHTML = `
    <div class="slw-drawer-head"><b>${isCreate ? '新增表' : `编辑表 · ${esc(def.name)}`}</b><button class="x">✕</button></div>
    <div class="slw-drawer-body">
      <fieldset class="fs" style="margin-top:0;border-top:0;padding-top:0">
        <legend>基本信息</legend>
        <div class="slw-row"><label>表名</label><input type="text" id="slw-td-name" value="${esc(def.name)}" placeholder="中文表名（建议以「表」字结尾）" style="width:200px"${specialForm ? ' readonly title="特殊表（人物关系 / 纪要）：形态由引擎与主项目按名特判，表名不可改"' : ''}>${specialForm ? ` <span class="slw-muted">特殊表：表名锁定（${specialForm === 'relation' ? '人物关系' : '纪要'}）</span>` : ''}
          <label style="min-width:auto">所属分组</label>
          <select id="slw-td-group" style="width:150px">
            ${groups.map((g) => `<option value="${g.id}" ${g.id === def.groupId ? 'selected' : ''}${specialForm === 'summary' && isStoppedGroup(g) ? ' disabled' : ''}>分组${g.id} · ${esc(g.name)}（每${g.frequency}层${isStoppedGroup(g) ? ' · 停用' : ''}）</option>`).join('')}
            <option value="__new__">＋ 新建分组…</option>
          </select></div>
        <div class="slw-row" style="align-items:flex-start"><label style="padding-top:6px">表说明</label><textarea rows="6" class="slw-note-area" id="slw-td-note" placeholder="这张表记什么、每列怎么写、判据是什么（原样进填表提示词）">${esc(def.note || '')}</textarea></div>
        <div class="slw-row" style="align-items:flex-start"><label style="padding-top:6px">触发提示</label>
          <span style="flex:1;display:flex;flex-direction:column;gap:6px;min-width:0">
            <div class="slw-row" style="margin:0;flex-wrap:nowrap"><span class="slw-muted" style="width:44px;flex:0 0 auto">增行</span><textarea rows="2" class="slw-trig" id="slw-td-ins" placeholder="什么情况下新增行">${esc(def.triggerNotes?.insert || '')}</textarea></div>
            <div class="slw-row" style="margin:0;flex-wrap:nowrap"><span class="slw-muted" style="width:44px;flex:0 0 auto">改格</span><textarea rows="2" class="slw-trig" id="slw-td-upd" placeholder="什么情况下更新已有行">${esc(def.triggerNotes?.update || '')}</textarea></div>
            <div class="slw-row" style="margin:0;flex-wrap:nowrap"><span class="slw-muted" style="width:44px;flex:0 0 auto">删行</span><textarea rows="2" class="slw-trig" id="slw-td-del" placeholder="什么情况下删除行（一般填「禁止」）">${esc(def.triggerNotes?.delete || '')}</textarea></div>
          </span></div>
      </fieldset>

      <fieldset class="fs" ${columnsHeader ? 'disabled' : ''}>
        <legend>列定义 ${columnsHeader ? '<span class="slw-muted" style="font-weight:400">（纪要表列结构为兼容特殊形态，禁改）</span>' : ''}</legend>
        <table class="slw-tbl slw-tbl-fixed slw-cols-edit slw-responsive">
          <colgroup><col><col style="width:70px"><col style="width:56px"><col style="width:56px"><col style="width:116px"></colgroup>
          <thead><tr><th>列名（中文）</th><th>类型</th><th>唯一</th><th>必填</th><th>操作</th></tr></thead>
          <tbody id="slw-td-cols"></tbody>
        </table>
        <div class="slw-row"><button class="slw-btn sm" id="slw-td-col-add">＋ 添加列</button></div>
      </fieldset>

      <fieldset class="fs">
        <legend>读取设置 <span class="slw-muted" style="font-weight:400">（填表时该表数据如何进提示词）</span></legend>
        <div class="slw-row">
          <label><input type="radio" name="slw-td-rm" class="check" value="all" ${def.readMode === 'all' ? 'checked' : ''}> 全量读取</label>
          <label><input type="radio" name="slw-td-rm" class="check" value="trigger" ${def.readMode === 'trigger' ? 'checked' : ''}> 按触发读取</label>
          <label><input type="radio" name="slw-td-rm" class="check" value="none" ${def.readMode === 'none' ? 'checked' : ''}> 不读取</label>
        </div>
        <div class="slw-muted">不读取 = 只给表说明与触发提示、不给数据行（AI 仍可增改，适合大归档表）。<br>
          「按触发」的判定关键词取自下方「世界书注入 → 关键词列」（选了「与 / 或」逻辑时按两列同口径判定）——与绿灯注入共用同一套规则，不再单独选触发列。</div>
      </fieldset>

      <fieldset class="fs">
        <legend>世界书注入</legend>
        <div class="slw-muted" id="slw-td-wb-stopped" style="display:none;margin-bottom:6px">当前分组频率 0（停用组）：<b>本表不填表、不注入世界书</b>——下列设置保留、暂不生效；挪回频率 >0 的分组即恢复。</div>
        <div class="slw-row"><label>启用注入</label><span class="slw-switch ${def.worldbook.enabled ? 'on' : ''}" id="slw-td-wb-on" ${def.lensForm === 'summary' ? 'title="纪要表特殊形态由引擎自动处理"' : ''}></span></div>
        <div class="slw-row" id="slw-td-wb-mode-row" style="${def.worldbook.enabled ? '' : 'display:none'}"><label>注入方式</label>
          <div class="slw-seg" id="slw-td-wb-mode">
            <button data-m="constant" class="${def.worldbook.mode === 'constant' ? 'on' : ''}">常量（蓝灯）</button>
            <button data-m="keyword" class="${def.worldbook.mode === 'constant' ? '' : 'on'}">关键词触发（绿灯）</button>
          </div></div>
        <div class="slw-row" id="slw-td-wb-body" style="${def.worldbook.enabled ? '' : 'display:none'}"><label>关键词列</label>
          <select id="slw-td-wb-key" style="width:150px"></select>
          <span class="slw-muted">条目名自动 = <b>${esc(def.name)}：关键词值</b>（不可改）；该列同时是「按触发」判定用的关键词</span></div>
        <div class="slw-row" id="slw-td-wb-logic-row" style="${def.worldbook.enabled && def.lensForm !== 'summary' && def.worldbook.mode !== 'constant' ? '' : 'display:none'}"><label>逻辑</label>
          <div class="slw-seg" id="slw-td-wb-logic">
            <button data-l="none" class="${def.worldbook.keywordsLogic === 'and' || def.worldbook.keywordsLogic === 'or' ? '' : 'on'}">无</button>
            <button data-l="and" class="${def.worldbook.keywordsLogic === 'and' ? 'on' : ''}">与</button>
            <button data-l="or" class="${def.worldbook.keywordsLogic === 'or' ? 'on' : ''}">或</button>
          </div>
          <span class="slw-muted">与＝两列都要出现；或＝任一列出现即可（写入世界书关键词逻辑，「按触发读取」同口径筛行）</span></div>
        <div class="slw-row" id="slw-td-wb-key2-row" style="${def.worldbook.enabled && def.lensForm !== 'summary' && def.worldbook.mode !== 'constant' && def.worldbook.keywordsLogic ? '' : 'display:none'}"><label>第二关键词列</label>
          <select id="slw-td-wb-key2" style="width:150px"></select></div>
        <div class="slw-row" id="slw-td-wb-wrap-row" style="${def.worldbook.enabled && def.lensForm !== 'summary' ? '' : 'display:none'}"><label>包裹标签</label><input type="text" id="slw-td-wb-tag" value="${esc(def.worldbook.wrapTag || '')}" style="width:150px" placeholder="${esc(def.name || '表名')}">
          <span class="slw-muted">默认＝表名；关键词触发时逐行标签 = <b>包裹标签-主关键词值</b>（如 &lt;${esc(def.worldbook.wrapTag || def.name || '表名')}-王二&gt;）</span></div>
        <div class="slw-row" id="slw-td-wb-place-row" style="${def.worldbook.enabled && def.lensForm !== 'summary' ? '' : 'display:none'}"><label>插入位置</label>
          <select id="slw-td-wb-pos" style="width:210px">
            <option value="before_character_definition">before_character_definition</option>
            <option value="after_character_definition">after_character_definition</option>
            <option value="at_depth_as_system">at_depth_as_system</option>
            <option value="at_depth_as_user">at_depth_as_user</option>
            <option value="at_depth_as_assistant">at_depth_as_assistant</option>
          </select>
          <label style="min-width:auto">depth</label><input type="number" id="slw-td-wb-depth" value="${Number(def.worldbook.placement?.depth ?? 2)}" style="width:64px">
          <label style="min-width:auto">order</label><input type="number" id="slw-td-wb-order" value="${Number(def.worldbook.placement?.order ?? 10000)}" style="width:80px"></div>
        <div class="slw-row" id="slw-td-wb-ov-row" style="display:${wbKeywordVisible ? 'flex' : 'none'};align-items:flex-start">
          <label style="padding-top:4px;min-width:110px">注入总览世界书</label>
          <span class="slw-switch ${def.worldbook.overview?.enabled === true ? 'on' : ''}" id="slw-td-wb-ov-on"></span>
          <span class="slw-muted" style="flex:1">额外注入一条<b>常量总览</b>，汇总所选列的全部行；位置沿用上方插入位置，<b>order 往前提 1 位</b>（排在逐行条目之前）。</span>
        </div>
        <div class="slw-row" id="slw-td-wb-ov-body" style="display:${wbKeywordVisible && def.worldbook.overview?.enabled === true ? 'flex' : 'none'};align-items:flex-start">
          <label style="padding-top:4px;min-width:110px">总览列</label>
          <span style="flex:1;display:flex;flex-direction:column;gap:4px;min-width:0">
            <span id="slw-td-wb-ov-cols" class="slw-pickgrid" style="grid-template-columns:repeat(auto-fill,minmax(110px,1fr))"></span>
            <span class="slw-muted">条目名：<b>SeseLedger-表名-总览</b> · 常量条目 · 不写关键词 · 不显示 row_id</span>
          </span>
        </div>
        ${def.lensForm === 'summary' ? '<div class="slw-muted" style="margin-top:4px">纪要表为引擎特判形态（每行一条目＝<b>时间跨度|纪要|重要对话</b> + AM 码 keys，顺序 9990；整组由顺序 9985/9995 的 <b>&lt;过往记忆&gt;</b> / <b>&lt;/过往记忆&gt;</b> 两条标签条目包住），由引擎自动处理，不在此配置；<b>纪要概览（索引）条目不再创建</b>。</div>' : ''}
      </fieldset>
    </div>
    <div class="slw-drawer-foot">
      <button class="slw-btn" data-close>取消</button>
      <button class="slw-btn primary" id="slw-td-save">${isCreate ? '创建' : '保存'}</button>
    </div>`;
  app.appendChild(mask);
  app.appendChild(drawer);
  // 插入位置下拉必须回显当前设置：否则不改它直接保存会把位置静默重置成第一项（E4）。
  const posSelect = drawer.querySelector('#slw-td-wb-pos') as HTMLSelectElement | null;
  if (posSelect) posSelect.value = String(def.worldbook.placement?.position || 'before_character_definition');
  const closeDrawer = () => { mask.remove(); drawer.remove(); };
  mask.addEventListener('click', closeDrawer);
  drawer.querySelector('.x')!.addEventListener('click', closeDrawer);
  drawer.querySelectorAll('[data-close]').forEach((b) => { (b as HTMLElement).onclick = closeDrawer; });

  // 列编辑器
  const colsBody = drawer.querySelector('#slw-td-cols') as HTMLElement;
  function renderCols(): void {
    colsBody.innerHTML = def.columns.map((c, i) => `<tr>
      <td data-label="列名（中文）"><input type="text" value="${esc(c.header)}" data-col-h="${i}"></td>
      <td data-label="类型"><span class="slw-tag dim">text</span></td>
      <td data-label="唯一"><input type="radio" name="slw-td-unique" class="check" ${c.unique ? 'checked' : ''} data-col-u="${i}" title="一表至多一列唯一；再点一次可取消"></td>
      <td data-label="必填"><input type="checkbox" class="check" ${c.notNull ? 'checked' : ''} data-col-n="${i}"></td>
      <td data-label="操作"><button class="slw-btn sm" data-col-up="${i}">↑</button> <button class="slw-btn sm" data-col-down="${i}">↓</button> <button class="slw-btn sm danger" data-col-del="${i}">删</button></td>
    </tr>`).join('');
    colsBody.querySelectorAll('[data-col-h]').forEach((n) => n.addEventListener('change', (e) => { def.columns[Number((e.target as HTMLElement).dataset.colH)].header = (e.target as HTMLInputElement).value.trim(); renderSeedOptions(); }));
    // 唯一列＝单选（一表至多一列）：点未选中的列＝改到该列；点已选中的列＝取消（全部置 false）
    colsBody.querySelectorAll('[data-col-u]').forEach((n) => n.addEventListener('click', (e) => {
      const i = Number((e.target as HTMLElement).dataset.colU);
      const wasUnique = def.columns[i]?.unique === true;
      def.columns.forEach((c, j) => { c.unique = wasUnique ? false : j === i; });
      renderCols();
    }));
    colsBody.querySelectorAll('[data-col-n]').forEach((n) => n.addEventListener('change', (e) => { def.columns[Number((e.target as HTMLElement).dataset.colN)].notNull = (e.target as HTMLInputElement).checked; }));
    colsBody.querySelectorAll('[data-col-up]').forEach((n) => (n as HTMLElement).onclick = () => { const i = Number((n as HTMLElement).dataset.colUp); if (i > 0) { [def.columns[i - 1], def.columns[i]] = [def.columns[i], def.columns[i - 1]]; renderCols(); } });
    colsBody.querySelectorAll('[data-col-down]').forEach((n) => (n as HTMLElement).onclick = () => { const i = Number((n as HTMLElement).dataset.colDown); if (i < def.columns.length - 1) { [def.columns[i + 1], def.columns[i]] = [def.columns[i], def.columns[i + 1]]; renderCols(); } });
    colsBody.querySelectorAll('[data-col-del]').forEach((n) => (n as HTMLElement).onclick = () => { const i = Number((n as HTMLElement).dataset.colDel); def.columns.splice(i, 1); renderCols(); renderSeedOptions(); });
  }
  renderCols();
  drawer.querySelector('#slw-td-col-add')!.addEventListener('click', () => {
    // 物理名是引擎内部别名：不需用户填，先分配（保存时统一补齐去重）
    def.columns.push({ header: `新列${def.columns.length + 1}`, type: 'text', unique: false, notNull: false });
    renderCols(); renderSeedOptions();
  });

  // 总览条目（仅关键词触发）：开关 + 列勾选。列被增删/改名后随 renderSeedOptions 重填。
  const ovSwitch = drawer.querySelector('#slw-td-wb-ov-on') as HTMLElement | null;
  const ovRow = drawer.querySelector('#slw-td-wb-ov-row') as HTMLElement | null;
  const ovBody = drawer.querySelector('#slw-td-wb-ov-body') as HTMLElement | null;
  function syncOverviewUi(): void {
    if (!ovSwitch || !ovBody) return;
    const on = def.worldbook.overview?.enabled === true;
    ovSwitch.classList.toggle('on', on);
    // 正文区只在「启用注入 + 关键词触发 + 非纪要」时出现（列增删触发的重渲也要守住这条）
    const visible = on && def.worldbook.enabled === true && def.worldbook.mode !== 'constant' && def.lensForm !== 'summary';
    ovBody.style.display = visible ? 'flex' : 'none';
  }
  function renderOverviewCols(): void {
    const wrap = drawer.querySelector('#slw-td-wb-ov-cols') as HTMLElement | null;
    if (!wrap) return;
    const picked = new Set((def.worldbook.overview?.columns || []).map(String));
    wrap.innerHTML = def.columns
      .filter((c) => String(c.header || '').trim())
      .map((c) => `<label><input type="checkbox" class="check" data-ov-col="${esc(c.header)}" ${picked.has(c.header) ? 'checked' : ''}> <span>${esc(c.header)}</span></label>`)
      .join('');
    wrap.querySelectorAll('[data-ov-col]').forEach((n) => {
      n.addEventListener('change', () => {
        const header = String((n as HTMLElement).dataset.ovCol || '');
        const cur = new Set((def.worldbook.overview?.columns || []).map(String));
        if ((n as HTMLInputElement).checked) cur.add(header); else cur.delete(header);
        def.worldbook.overview = {
          enabled: def.worldbook.overview?.enabled === true,
          columns: def.columns.map((c) => c.header).filter((h) => cur.has(h)),
        };
        syncOverviewUi();
      });
    });
    syncOverviewUi();
  }

  // 世界书关键词列下拉（列增删/改名后重填；「按触发」判定与绿灯注入共用这些列）
  function renderSeedOptions(): void {
    const columnOptions = (current: string, withEmpty: boolean): string =>
      `${withEmpty ? `<option value="" ${current ? '' : 'selected'}>（不设置）</option>` : ''}`
      + def.columns.map((c) => `<option value="${esc(c.header)}" ${c.header === current ? 'selected' : ''}>${esc(c.header)}</option>`).join('');
    const keySelect = drawer.querySelector('#slw-td-wb-key') as HTMLSelectElement | null;
    if (keySelect) {
      const current = def.worldbook.keywordsColumn || '';
      keySelect.innerHTML = columnOptions(current, false);
    }
    const key2Select = drawer.querySelector('#slw-td-wb-key2') as HTMLSelectElement | null;
    if (key2Select) {
      const current2 = def.worldbook.keywordsColumn2 || '';
      key2Select.innerHTML = columnOptions(current2, true);
    }
    renderOverviewCols();
  }
  renderSeedOptions();
  drawer.querySelectorAll('input[name=slw-td-rm]').forEach((r) => {
    (r as HTMLInputElement).addEventListener('change', (e) => {
      def.readMode = (e.target as HTMLInputElement).value as LedgerSheetDef['readMode'];
    });
  });
  // 注入方式（常量 / 关键词触发）
  drawer.querySelectorAll('#slw-td-wb-mode button').forEach((b) => {
    (b as HTMLElement).addEventListener('click', () => {
      const mode = ((b as HTMLElement).dataset.m === 'constant' ? 'constant' : 'keyword') as 'constant' | 'keyword';
      def.worldbook.mode = mode;
      drawer.querySelectorAll('#slw-td-wb-mode button').forEach((x) => x.classList.toggle('on', (x as HTMLElement).dataset.m === mode));
      showWbRows(def.worldbook.enabled); // 常量注入不看关键词 → 逻辑行随方式隐藏
    });
  });
  // 关键词逻辑（无 / 与 / 或）：与/或 才出现第二关键词列
  drawer.querySelectorAll('#slw-td-wb-logic button').forEach((b) => {
    (b as HTMLElement).addEventListener('click', () => {
      const raw = String((b as HTMLElement).dataset.l || 'none');
      def.worldbook.keywordsLogic = raw === 'and' || raw === 'or' ? raw : undefined;
      drawer.querySelectorAll('#slw-td-wb-logic button').forEach((x) => x.classList.toggle('on', x === b));
      showWbRows(def.worldbook.enabled);
    });
  });

  // 世界书开关
  const wbSwitch = drawer.querySelector('#slw-td-wb-on') as HTMLElement;
  const showWbRows = (on: boolean): void => {
    for (const id of ['#slw-td-wb-body', '#slw-td-wb-mode-row']) {
      (drawer.querySelector(id) as HTMLElement).style.display = on ? 'flex' : 'none';
    }
    const extra = on && def.lensForm !== 'summary' ? 'flex' : 'none';
    for (const id of ['#slw-td-wb-wrap-row', '#slw-td-wb-place-row']) {
      (drawer.querySelector(id) as HTMLElement).style.display = extra;
    }
    // 关键词逻辑只在「关键词触发」下有意义（常量注入与纪要特殊形态不看关键词列）
    const keywordMode = extra === 'flex' && def.worldbook.mode !== 'constant';
    (drawer.querySelector('#slw-td-wb-logic-row') as HTMLElement).style.display = keywordMode ? 'flex' : 'none';
    (drawer.querySelector('#slw-td-wb-key2-row') as HTMLElement).style.display = keywordMode && def.worldbook.keywordsLogic ? 'flex' : 'none';
    // 总览条目同样只在关键词触发下有意义（常量注入本身已是整表一条）
    if (ovRow) ovRow.style.display = keywordMode ? 'flex' : 'none';
    if (keywordMode) syncOverviewUi();
    else if (ovBody) ovBody.style.display = 'none';
  };
  if (def.lensForm !== 'summary') {
    wbSwitch.addEventListener('click', () => {
      def.worldbook.enabled = !def.worldbook.enabled;
      wbSwitch.classList.toggle('on', def.worldbook.enabled);
      showWbRows(def.worldbook.enabled);
    });
  }
  if (ovSwitch && def.lensForm !== 'summary') {
    ovSwitch.addEventListener('click', () => {
      const on = def.worldbook.overview?.enabled !== true;
      if (on) {
        const known = new Set(def.columns.map((c) => c.header));
        const cur = (def.worldbook.overview?.columns || []).filter((h) => known.has(h));
        const kw = String((drawer.querySelector('#slw-td-wb-key') as HTMLSelectElement | null)?.value || def.columns[0]?.header || '');
        def.worldbook.overview = { enabled: true, columns: cur.length ? cur : [kw].filter(Boolean) };
      } else {
        def.worldbook.overview = { enabled: false, columns: def.worldbook.overview?.columns || [] };
      }
      renderOverviewCols();
      syncOverviewUi();
    });
  }
  // 「停用组」提示随所属分组下拉实时联动（新建分组恒为频率 1 → 不算停用）
  const groupSelectEl = drawer.querySelector('#slw-td-group') as HTMLSelectElement;
  const stoppedHintEl = drawer.querySelector('#slw-td-wb-stopped') as HTMLElement;
  const syncStoppedHint = (): void => {
    const raw = groupSelectEl.value;
    const g = raw === '__new__' ? undefined : groups.find((x) => Number(x.id) === Number(raw));
    stoppedHintEl.style.display = raw !== '__new__' && isStoppedGroup(g) ? '' : 'none';
  };
  groupSelectEl.addEventListener('change', syncStoppedHint);
  syncStoppedHint();

  // 保存
  drawer.querySelector('#slw-td-save')!.addEventListener('click', async () => {
    const nameInput = drawer.querySelector('#slw-td-name') as HTMLInputElement;
    const noteInput = drawer.querySelector('#slw-td-note') as HTMLTextAreaElement;
    const groupSelect = drawer.querySelector('#slw-td-group') as HTMLSelectElement;
    // 特殊表（人物关系 / 纪要）表名锁定：形态由引擎与主项目按名特判，改名会静默失效（输入框已只读，此处兜底）
    if (specialForm) {
      if (nameInput.value.trim() && nameInput.value.trim() !== def.name) { deps.warn(`「${def.name}」是特殊表：表名不可改（改名会让特殊形态与主项目寻址失效）`); nameInput.value = def.name; }
    } else {
      def.name = nameInput.value.trim() || def.name;
    }
    def.note = noteInput.value;
    def.triggerNotes = {
      insert: (drawer.querySelector('#slw-td-ins') as HTMLInputElement).value || undefined,
      update: (drawer.querySelector('#slw-td-upd') as HTMLInputElement).value || undefined,
      delete: (drawer.querySelector('#slw-td-del') as HTMLInputElement).value || undefined,
    };
    if (def.lensForm !== 'summary') {
      def.worldbook.keywordsColumn = (drawer.querySelector('#slw-td-wb-key') as HTMLSelectElement)?.value || undefined;
      // 关键词逻辑与第二关键词列（无 = 两字段一并清掉，保持旧形状逐字节不变）
      const logic = def.worldbook.keywordsLogic;
      const col2 = (drawer.querySelector('#slw-td-wb-key2') as HTMLSelectElement)?.value || '';
      def.worldbook.keywordsColumn2 = logic && col2 ? col2 : undefined;
      def.worldbook.wrapTag = (drawer.querySelector('#slw-td-wb-tag') as HTMLInputElement)?.value.trim() || undefined;
      if (!def.worldbook.mode) def.worldbook.mode = 'keyword';
      const pos = (drawer.querySelector('#slw-td-wb-pos') as HTMLSelectElement)?.value || 'before_character_definition';
      const depth = Number((drawer.querySelector('#slw-td-wb-depth') as HTMLInputElement)?.value);
      const order = Number((drawer.querySelector('#slw-td-wb-order') as HTMLInputElement)?.value);
      const placement: { position: string; depth?: number; order?: number } = { position: pos };
      if (pos.startsWith('at_depth') && Number.isFinite(depth)) placement.depth = Math.max(0, Math.trunc(depth));
      if (Number.isFinite(order)) placement.order = Math.trunc(order);
      def.worldbook.placement = placement;
      // 总览条目：只在「启用注入 + 关键词触发」时读取 DOM（其余情形保留已存配置，切回关键词触发即恢复）
      if (def.worldbook.enabled === true && def.worldbook.mode !== 'constant' && ovSwitch) {
        const known = new Set(def.columns.map((c) => c.header));
        const picked = Array.from(drawer.querySelectorAll('#slw-td-wb-ov-cols input[data-ov-col]:checked'))
          .map((n) => String((n as HTMLElement).dataset.ovCol || ''))
          .filter((h) => known.has(h));
        const ovOn = ovSwitch.classList.contains('on');
        if (ovOn && picked.length === 0) {
          deps.warn('已开启「注入总览世界书」但未勾选任何列：本次按关闭保存');
          def.worldbook.overview = { enabled: false, columns: [] };
        } else if (ovOn) {
          def.worldbook.overview = { enabled: true, columns: picked };
        } else if (picked.length > 0) {
          def.worldbook.overview = { enabled: false, columns: picked };
        } else {
          delete def.worldbook.overview;
        }
      }
    }
    // 校验（对齐 validateV2Template 单表口径）
    const errors: string[] = [];
    if (!def.name) errors.push('表名不能为空');
    // 新建与改名统一查重（排除自身）：中文表名是引擎/世界书/向导的寻址键（E3）。
    if (visible.some((t) => t.tableId !== def.tableId && t.name === def.name)) errors.push(`已存在同名表「${def.name}」`);
    if (def.columns.length === 0) errors.push('至少需要一列');
    const seenH = new Set<string>();
    for (const c of def.columns) {
      c.header = String(c.header || '').trim();
      if (!c.header) errors.push('存在空列名');
      if (seenH.has(c.header)) errors.push(`列名「${c.header}」重复`);
      seenH.add(c.header);
    }
    // 唯一列单选兜底（UI 已是单选；此处防外部改动/旧数据带进多列唯一）
    const droppedUnique = clampSingleUnique(def);
    if (droppedUnique.length > 0) deps.warn(`一表至多一列唯一：已保留首列，清除 ${droppedUnique.join('、')}`);
    if (def.readMode === 'trigger' && def.worldbook.enabled === true && def.worldbook.mode !== 'constant') {
      // 关键词触发/按触发判定共用关键词列：缺失回落首列（引擎自愈）
      const known = new Set(def.columns.map((c) => c.header));
      if (!def.worldbook.keywordsColumn || !known.has(def.worldbook.keywordsColumn)) {
        def.worldbook.keywordsColumn = def.columns[0]?.header;
      }
    }
    // 第二关键词列自愈：失效/与首列相同/未选 → 清掉列与逻辑（退回只看第一列）
    if (def.worldbook.keywordsColumn2) {
      const known = new Set(def.columns.map((c) => c.header));
      const c2 = String(def.worldbook.keywordsColumn2);
      if (!known.has(c2) || c2 === String(def.worldbook.keywordsColumn || '')) {
        def.worldbook.keywordsColumn2 = undefined;
        def.worldbook.keywordsLogic = undefined;
      }
    }
    if (def.worldbook.keywordsLogic && !def.worldbook.keywordsColumn2 && def.worldbook.enabled === true && def.worldbook.mode !== 'constant') {
      deps.warn('已选「与/或」但未选第二关键词列：本表将只按第一列判定（可随时补选）');
    }
    if (errors.length) { deps.warn(errors[0]); return; }
    // 分组处理（含新建分组）
    let groups = groupsOf(book);
    if (groupSelect.value === '__new__') {
      const gname = await promptDialog(deps, '新分组名称：', `分组${groups.length + 1}`, { okText: '创建分组' });
      if (gname === null) return;
      const nid = Math.max(0, ...groups.map((g) => g.id)) + 1;
      groups = [...groups, { id: nid, name: gname || `分组${nid}`, frequency: 1 }];
      def.groupId = nid;
    } else {
      def.groupId = Number(groupSelect.value) || 1;
    }
    // 纪要表不许进停用组（下拉里已禁用停用组选项，此处兜底；含「新建表直接取名纪要表」的情形）
    if (specialFormOf(def.name, def) === 'summary') {
      const blocked = summaryStoppedReason(def.name, groups.find((g) => Number(g.id) === Number(def.groupId)));
      if (blocked) { deps.warn(blocked); return; }
    }
    // 全局数据表 / 纪要表被分到不同组 → 先确认（取消则不落盘、抽屉保持原样）。
    // 只有本次改动涉及这两张表（编辑/改名成特殊表/新建特殊表）才检查。
    const targetIsGlobal = def.name === '全局数据表';
    const targetIsSummary = specialFormOf(def.name, def) === 'summary';
    const wasSpecial = !isCreate && (table!.name === '全局数据表' || specialFormOf(table!.name, table!.v2def) === 'summary');
    if (wasSpecial || targetIsGlobal || targetIsSummary) {
      const assignments = summaryGroupAssignmentsOfBook(book)
        .filter((a) => isCreate || a.tableId !== table!.tableId);
      if (targetIsGlobal || targetIsSummary) {
        assignments.push({
          name: def.name,
          tableId: isCreate ? '' : table!.tableId,
          groupId: Number(def.groupId),
          isSummary: targetIsSummary,
        });
      }
      if (!await confirmSummaryGroupSplit(ctx, assignments, groups)) return;
    }
    if (isCreate) {
      // 新增表：与建表向导同一套套用路径（def → 单表模板 → 协调器引入空结构）
      def.tableId = newTableId();
      const workbook = projectWorkbook(book);
      workbook[def.tableId] = wizardDefToSheet(def) as any;
      (workbook.mate as any).ledgerGroups = groups;
      convergeBookToTemplate(book, workbook);
      syncV2UpdateConfigs(book);
      closeDrawer();
      commitTemplateEdit(ctx, `表「${def.name}」已新增`);
      return;
    }
    // 套用：整本模板重建 + 收敛器（列改名认领/新增列补空/模板外列丢弃）
    const originalColumns = table!.v2def!.columns.map((c) => c.header);
    const removedColumns = originalColumns.filter((h) => !def.columns.some((c) => c.header === h));
    if (def.lensForm !== 'summary' && removedColumns.length > 0) {
      if (!await confirmDialog(deps, `以下列将被删除（数据一并丢弃，结转后不可恢复）：${removedColumns.join('、')}。`, { okText: '删除这些列', danger: true })) return;
    }
    const workbook = projectWorkbook(book);
    // 从投影抽出本表的单表模板（headers 重排为 def 顺序；其余表照旧）
    const sheet: any = workbook[tableId!];
    sheet.name = def.name;
    sheet.content = [['row_id', ...def.columns.map((c) => c.header)]];
    sheet.ledgerV2 = def;
    (workbook.mate as any).ledgerGroups = groups;
    convergeBookToTemplate(book, workbook);
    syncV2UpdateConfigs(book);
    closeDrawer();
    commitTemplateEdit(ctx, `表「${def.name}」已保存`);
  });
}

// ===== 调整成员弹窗 =====
function openGroupMembersDialog(ctx: TabCtx, groupId: number): void {
  const { deps, doc } = ctx;
  const book = deps.runtime.book();
  if (!book) return;
  const groups = groupsOf(book);
  const tables = [...book.tables.values()].filter((t) => t.v2def).sort((a, b) => a.orderNo - b.orderNo);
  doc.querySelector('.slw-dialog-mask')?.remove();
  const mask = el(doc, 'div', { class: 'slw-dialog-mask' });
  const dialog = el(doc, 'div', { class: 'slw-dialog' });
  dialog.innerHTML = `
    <h3>调整分组成员 <button class="x" style="float:right;background:none;border:0;color:#8b8676;font-size:16px;cursor:pointer">✕</button></h3>
    <table class="slw-tbl slw-tbl-fixed slw-responsive">
      <colgroup><col><col style="width:240px"></colgroup>
      <thead><tr><th>表</th><th>所属分组</th></tr></thead>
      <tbody>
        ${tables.map((t) => `<tr><td data-label="表">${esc(t.name)}</td>
          <td data-label="所属分组"><select data-table="${esc(t.tableId)}" style="width:220px">
            ${groups.map((g) => `<option value="${g.id}" ${Number(t.v2def!.groupId) === g.id ? 'selected' : ''}${isSummaryTable(t) && isStoppedGroup(g) ? ' disabled' : ''}>分组${g.id} · ${esc(g.name)}（每${g.frequency}层${isStoppedGroup(g) ? ' · 停用' : ''}）</option>`).join('')}
          </select></td></tr>`).join('')}
      </tbody>
    </table>
    <div class="slw-row" style="justify-content:flex-end;margin-top:12px">
      <button class="slw-btn" data-close>取消</button>
      <button class="slw-btn primary" data-save>保存成员分配</button>
    </div>
    <div class="slw-muted" style="margin-top:8px">频率 0 的组＝停用组：组内表不自动更新、不参与填表、不注入世界书（选它会被拦下）；纪要表不能放进停用组（选项已置灰）。</div>`;
  mask.appendChild(dialog);
  doc.body.appendChild(mask);
  const close = () => mask.remove();
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  dialog.querySelector('.x')!.addEventListener('click', close);
  dialog.querySelectorAll('[data-close]').forEach((b) => { (b as HTMLElement).onclick = close; });
  dialog.querySelector('[data-save]')!.addEventListener('click', async () => {
    // 先全校验再落：纪要表不许进停用组（下拉已禁用，此处兜底）——拦下时不落盘、不关弹窗
    const pending: { t: TableModel; gid: number }[] = [];
    let blocked = '';
    dialog.querySelectorAll('[data-table]').forEach((sel) => {
      const t = book.tables.get((sel as HTMLElement).dataset.table!);
      if (!t?.v2def) return;
      const gid = Number((sel as HTMLSelectElement).value);
      pending.push({ t, gid });
      if (!blocked && isSummaryTable(t)) {
        blocked = summaryStoppedReason(t.name, groups.find((g) => Number(g.id) === gid)) || '';
      }
    });
    if (blocked) { deps.warn(blocked); return; }
    // 全局数据表 / 纪要表被分到不同组 → 先确认（取消则不落盘、弹窗保持原样）
    const assignments = summaryGroupAssignmentsOfBook(
      book,
      pending.map(({ t, gid }) => ({ tableId: t.tableId, groupId: gid })),
    );
    if (!await confirmSummaryGroupSplit(ctx, assignments, groups)) return;
    for (const { t, gid } of pending) t.v2def!.groupId = gid;
    syncV2UpdateConfigs(book);
    close();
    commitTemplateEdit(ctx, '分组成员已更新');
  });
  void groupId;
}

// ===== 建表向导弹窗 =====
function openWizardDialog(ctx: TabCtx): void {
  const { deps, doc } = ctx;
  const book = deps.runtime.book();
  if (!book) { deps.warn('台账未就绪'); return; }
  const tables = [...book.tables.values()].sort((a, b) => a.orderNo - b.orderNo);
  doc.querySelector('.slw-dialog-mask')?.remove();
  const mask = el(doc, 'div', { class: 'slw-dialog-mask' });
  const dialog = el(doc, 'div', { class: 'slw-dialog' });
  dialog.innerHTML = `
    <h3>建表向导 <button class="x" style="float:right;background:none;border:0;color:#8b8676;font-size:16px;cursor:pointer">✕</button></h3>
    <div class="slw-row">
      <div class="slw-seg" id="slw-wz-mode"><button class="on" data-m="create">新建表</button><button data-m="modify">修改现有表</button></div>
    </div>
    <div class="slw-row" id="slw-wz-create-row"><label>一句话描述</label><input type="text" id="slw-wz-desc" style="flex:1" placeholder="例如：一个商店系统，记录每个镇子商店卖什么、价格、库存"></div>
    <div class="slw-row" id="slw-wz-modify-row" style="display:none"><label>要修改的表</label><select id="slw-wz-target" style="width:180px">${tables.map((t) => `<option>${esc(t.name)}</option>`).join('')}</select>
      <label style="min-width:auto">修改要求</label><input type="text" id="slw-wz-req" style="flex:1" placeholder="写清要改哪些字段；没提到的不动"></div>
    <div class="slw-row"><label>参考注入</label>
      <select id="slw-wz-ref" style="width:220px"><option value="1">现有表结构摘要（推荐）</option><option value="0">不参考任何现有表</option></select>
      <button class="slw-btn sm" id="slw-wz-preview-inject">预览注入内容</button></div>
    <div class="slw-row"><label>使用的 API</label><span class="slw-muted" id="slw-wz-api"></span></div>
    <details style="margin:10px 0"><summary class="slw-muted" style="cursor:pointer">查看 AI 原始输出</summary>
      <div class="slw-report" id="slw-wz-raw" style="margin-top:6px">（尚未生成）</div>
    </details>
    <details id="slw-wz-preview-details"><summary class="slw-muted" style="cursor:pointer">生成结果预览（严格校验通过后出现）</summary>
      <table class="slw-tbl slw-tbl-fixed slw-responsive" style="margin-top:6px"><colgroup><col><col style="width:56px"><col style="width:56px"></colgroup><thead><tr><th>列名</th><th>唯一</th><th>必填</th></tr></thead>
      <tbody id="slw-wz-preview"></tbody></table>
      <div class="slw-muted" id="slw-wz-preview-meta" style="margin-top:6px"></div>
    </details>
    <div class="slw-row" style="justify-content:flex-end;margin-top:12px">
      <button class="slw-btn" data-close>取消</button>
      <button class="slw-btn primary" id="slw-wz-run">生成并套用到当前模板</button>
    </div>
    <div class="slw-annot">输出必须通过 v2 表结构强校验（列名不重复且非 row_id、触发列有效等），失败自动带错误回注重试（最多3次）；套用走模板协调器（新列补空、改名认领），并询问是否存回模板预设。</div>`;
  mask.appendChild(dialog);
  doc.body.appendChild(mask);
  const close = () => mask.remove();
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  dialog.querySelector('.x')!.addEventListener('click', close);
  dialog.querySelectorAll('[data-close]').forEach((b) => { (b as HTMLElement).onclick = close; });

  let generated: LedgerSheetDef | null = null;
  /** 生成代次：输入变化即 +1，用于丢弃「请求在途时用户改了模式/目标/描述」的旧结果。 */
  let generationToken = 0;
  const runBtn = dialog.querySelector('#slw-wz-run') as HTMLButtonElement;
  /** 生成结果只对「生成时的模式/目标/描述」有效：任何输入变化都作废，防旧结果套到别的表（E5）。 */
  const resetGenerated = (): void => {
    generationToken += 1;
    generated = null;
    runBtn.textContent = '生成并套用到当前模板';
    const preview = dialog.querySelector('#slw-wz-preview') as HTMLElement | null;
    if (preview) preview.innerHTML = '';
    const meta = dialog.querySelector('#slw-wz-preview-meta') as HTMLElement | null;
    if (meta) meta.textContent = '';
    const details = dialog.querySelector('#slw-wz-preview-details') as HTMLDetailsElement | null;
    if (details) details.open = false;
  };

  let mode: 'create' | 'modify' = 'create';
  dialog.querySelectorAll('#slw-wz-mode button').forEach((b) => {
    (b as HTMLElement).onclick = () => {
      mode = (b as HTMLElement).dataset.m as 'create' | 'modify';
      dialog.querySelectorAll('#slw-wz-mode button').forEach((x) => x.classList.toggle('on', x === b));
      (dialog.querySelector('#slw-wz-create-row') as HTMLElement).style.display = mode === 'create' ? 'flex' : 'none';
      (dialog.querySelector('#slw-wz-modify-row') as HTMLElement).style.display = mode === 'modify' ? 'flex' : 'none';
      resetGenerated();
    };
  });
  // 模式/目标表/描述/参考注入任一变化 → 作废旧生成结果，必须重新生成再套用。
  (dialog.querySelector('#slw-wz-target') as HTMLSelectElement | null)?.addEventListener('change', resetGenerated);
  (dialog.querySelector('#slw-wz-desc') as HTMLInputElement | null)?.addEventListener('input', resetGenerated);
  (dialog.querySelector('#slw-wz-req') as HTMLInputElement | null)?.addEventListener('input', resetGenerated);
  (dialog.querySelector('#slw-wz-ref') as HTMLSelectElement | null)?.addEventListener('change', resetGenerated);
  const apiResolved = deps.hostConfig.resolve(deps.settings.get(), 'fill', 1);
  const apiLabel = apiResolved.mode === 'tavern'
    ? '酒馆主 API（不覆盖）'
    : apiResolved.mode === 'pinned' || apiResolved.mode === 'custom'
      ? apiResolved.label
      : '跟随全局 · ' + deps.hostConfig.describeGlobalMode();
  (dialog.querySelector('#slw-wz-api') as HTMLElement).textContent = `填表 API（${apiLabel}）——建表向导跟随分组1`;
  dialog.querySelector('#slw-wz-preview-inject')!.addEventListener('click', () => {
    const text = buildBookStructureSummary(book);
    void alertDialog(deps, text.slice(0, 4000), { title: '参考注入内容预览' });
  });

  runBtn.addEventListener('click', async () => {
    if (generated) { await applyGenerated(); return; }
    const token = generationToken;
    const desc = mode === 'create'
      ? (dialog.querySelector('#slw-wz-desc') as HTMLInputElement).value.trim()
      : (dialog.querySelector('#slw-wz-req') as HTMLInputElement).value.trim();
    if (!desc) { deps.warn(mode === 'create' ? '请填写一句话描述' : '请填写修改要求'); return; }
    const target = mode === 'modify' ? (dialog.querySelector('#slw-wz-target') as HTMLSelectElement).value : undefined;
    const input = { mode, description: desc, targetTable: target, includeStructure: (dialog.querySelector('#slw-wz-ref') as HTMLSelectElement).value === '1' };
    runBtn.disabled = true; runBtn.textContent = '生成中…';
    let raw = '';
    const maxAttempts = resolveFillMaxAttempts(deps.settings.get());
    try {
      let parsed: ReturnType<typeof parseWizardOutput> | null = null;
      const baseMessages = buildWizardMessages(book, input);
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        raw = await deps.requestAiMessages(baseMessages);
        (dialog.querySelector('#slw-wz-raw') as HTMLElement).textContent = raw.slice(0, 6000);
        parsed = parseWizardOutput(raw, target ? tables.find((t) => t.name === target)?.tableId : undefined);
        if (parsed.ok) break;
        if (attempt < maxAttempts) {
          baseMessages.push({ role: 'assistant', content: raw.slice(0, 4000) });
          baseMessages.push({ role: 'user', content: '上次输出未通过校验：\n' + parsed.errors.map((e) => '- ' + e).join('\n') + '\n请修正后重新输出完整 JSON（不要解释）。' });
        }
      }
      if (token !== generationToken) return; // 输入已变化：本次结果作废（E5）
      if (!parsed || !parsed.ok || !parsed.def) {
        const errors = parsed?.errors?.length ? parsed.errors : ['未知错误'];
        // 完整校验清单 + 原始输出进日志（toast 只放第一条——旧实现只提示第一条，日志也只剩这一条）
        deps.log.push('error', '填表', '建表向导：AI 输出未通过校验', errors.join('\n'), raw);
        deps.warn('生成失败：' + errors[0]);
        return;
      }
      generated = parsed.def;
      const previewBody = dialog.querySelector('#slw-wz-preview') as HTMLElement;
      previewBody.innerHTML = generated.columns.map((c) => `<tr><td data-label="列名">${esc(c.header)}</td><td data-label="唯一">${c.unique ? '✓' : ''}</td><td data-label="必填">${c.notNull ? '✓' : ''}</td></tr>`).join('');
      // 落地分组＝修改模式沿用目标表的组、新建模式落第一个分组：是停用组就如实说明（表将不填表、不注入世界书）
      const targetName = mode === 'modify' ? (dialog.querySelector('#slw-wz-target') as HTMLSelectElement).value : '';
      const targetGroupId = mode === 'modify'
        ? Number(tables.find((t) => t.name === targetName)?.v2def?.groupId ?? groupsOf(book)[0]?.id ?? 1)
        : Number(groupsOf(book)[0]?.id ?? 1);
      const stoppedNote = isStoppedGroup(groupsOf(book).find((g) => Number(g.id) === targetGroupId))
        ? '（所在分组频率 0：不填表、不注入世界书）' : '';
      (dialog.querySelector('#slw-wz-preview-meta') as HTMLElement).textContent =
        `读取模式：${generated.readMode === 'trigger' ? '按触发' : generated.readMode === 'none' ? '不读取' : '全量'} · 世界书注入：${generated.worldbook.enabled ? (generated.worldbook.mode === 'constant' ? '常量' : '关键词触发') + '（关键词列 ' + (generated.worldbook.keywordsColumn || '—') + '）' : '关'}${stoppedNote}`;
      (dialog.querySelector('#slw-wz-preview-details') as HTMLDetailsElement).open = true;
      runBtn.textContent = '套用到当前模板';
      deps.notify('生成通过校验，请确认预览后套用');
    } catch (e) {
      if (token === generationToken) {
        // 请求异常：完整原文进日志（状态码/响应体/cause/堆栈），toast 只留单行摘要
        deps.log.push('error', '填表', '建表向导 AI 请求失败', describeErrorDetail(e), raw);
        deps.warn('AI 请求失败：' + describeErrorSummary(e));
      }
    } finally {
      if (token === generationToken) {
        runBtn.disabled = false;
        if (!generated) runBtn.textContent = '生成并套用到当前模板';
      }
    }
  });

  const applyGenerated = async (): Promise<void> => {
    if (!generated) return;
    if (mode === 'modify') {
      const target = (dialog.querySelector('#slw-wz-target') as HTMLSelectElement).value;
      const t = tables.find((x) => x.name === target);
      if (t) {
        // tableId 恒复用目标表（v1 表亦然——否则协调器会当新表引入造成重复）
        generated.tableId = t.tableId;
        generated.orderNo = t.v2def?.orderNo ?? t.orderNo;
        generated.groupId = t.v2def?.groupId ?? 1;
      }
    } else {
      generated.groupId = groupsOf(book)[0]?.id || 1;
    }
    // 全局数据表 / 纪要表分组一致性：套用前确认（取消则不落盘）
    const targetId = String(generated.tableId || '');
    const targetIsGlobal = generated.name === '全局数据表';
    const targetIsSummary = specialFormOf(generated.name, generated) === 'summary';
    const wasSpecial = mode === 'modify' && !!targetId
      && (() => {
        const t = book.tables.get(targetId);
        return !!t && (t.name === '全局数据表' || specialFormOf(t.name, t.v2def) === 'summary');
      })();
    if (wasSpecial || targetIsGlobal || targetIsSummary) {
      const assignments = summaryGroupAssignmentsOfBook(book)
        .filter((a) => !targetId || a.tableId !== targetId);
      if (targetIsGlobal || targetIsSummary) {
        assignments.push({
          name: generated.name,
          tableId: targetId,
          groupId: Number(generated.groupId),
          isSummary: targetIsSummary,
        });
      }
      if (!await confirmSummaryGroupSplit(ctx, assignments, groupsOf(book))) return;
    }
    const sheet = wizardDefToSheet(generated);
    const workbook = projectWorkbook(book);
    workbook[sheet.uid as string] = sheet;
    convergeBookToTemplate(book, workbook);
    syncV2UpdateConfigs(book);
    close();
    commitTemplateEdit(ctx, `表「${generated.name}」已套用`);
    if (await confirmDialog(deps, `是否把含「${generated.name}」的当前模板存为另一份预设？`, { okText: '存为新预设', cancelText: '不用' })) {
      const name = await promptDialog(deps, '预设名：', `我的模板 ${new Date().toISOString().slice(0, 10)}`, { okText: '保存' });
      if (name) {
        const v2 = workbookToV2Template(projectWorkbook(book), name);
        if (v2) await deps.settings.saveTemplatePreset(name, JSON.stringify(v2));
      }
    }
  };
}
