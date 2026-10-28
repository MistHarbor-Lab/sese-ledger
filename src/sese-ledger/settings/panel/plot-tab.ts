// ===== 推进标签页：预设管理 · 预设编辑（单任务：匹配替换参数置顶 + 段/块混排 + 最终指令） =====
// 1A 化：提示词段支持固定块混排（参考资料块/资料块/上下文块/上轮推进结果块/表数据块，只调顺序与显隐、内容只读）；
// 内置预设＝魔改召回 / 极速纯召回（单任务，不可覆盖不可删）；原多任务列表/阶段号编辑已整体删除。
import { esc, el, downloadJsonFile, pickJsonFile, mountPromptEditor, confirmDialog, promptDialog, openEditorDialog } from './shared';
import type { TabCtx } from './shell';
import {
  BUILTIN_PRESET_NAMES,
  builtinDriverPreset,
  defaultDriverPreset,
  isValidDriverPreset,
  normalizeDriverPreset,
  normalizeRates,
  pickPrevTagContent,
  PLOT_PRESET_FORMAT,
  PLOT_PRESET_SCHEMA,
  readPlotFromMessage,
  readPlotRawFromMessage,
  splitTags,
  type DriverPreset,
} from '../../core/director';
import {
  DIRECTOR_BLOCK_CATALOG,
  type LedgerBlockId,
  type LedgerTableBlockConfig,
} from '../../core/ai-request';
import { readTableBlockValue } from '../../core/book';

function clonePreset(p: DriverPreset): DriverPreset {
  return JSON.parse(JSON.stringify(p));
}

const BLOCK_HINTS: Partial<Record<LedgerBlockId, string>> = {
  scan: '两轮黑名单过滤后关键词命中的世界书条目＋当前角色卡设定（用户人设 / 角色卡描述 / 角色性格 / 场景 / 示例对话）；扫描素材＝上轮正文＋本轮输入。',
  dossier: '【已有纪要】：纪要表「编码索引 + 概览」全量（召回任务的唯一真值来源）。',
  context: '【上轮正文】（最近 N 层 AI 回复，过主项目标签剥离）＋【当前输入】（本轮用户输入）。',
  prevDirective: '【上轮推进结果】：从上一轮推演的原始输出里只提取你勾选的标签（取不到回落最终指令；点「选择标签」多选）；缺标签或无内容时整块不出条。',
  tableData: '取账本里某张表的指定行/列；点「配置」选表与取值列。',
};

const PLACEHOLDER_HINT = '段内可用：{{意外倾向}} {{意外频率}} {{主动频率}} {{氛围频率}} {{召回数量}} {{本轮输入}} {{roll_bg}} {{roll_char1}}~{{roll_char5}} {{roll_fate}}（骰点每轮前端投真骰）';

export function renderPlotTab(ctx: TabCtx, pane: HTMLElement): void {
  const { deps, doc } = ctx;
  const s = deps.settings.get();
  const storedPresets: Record<string, unknown> = { ...(s.plotPresets || {}) };
  const validNames = Object.keys(storedPresets).filter((n) => deps.canonical.driver.isValidPreset(storedPresets[n])).sort();
  const invalidNames = Object.keys(storedPresets).filter((n) => !deps.canonical.driver.isValidPreset(storedPresets[n])).sort();
  const presetNames = [...BUILTIN_PRESET_NAMES, ...validNames];
  const currentName = s.driverPresetName && presetNames.includes(s.driverPresetName) ? s.driverPresetName : BUILTIN_PRESET_NAMES[0];
  // 载入预设：内置目录优先；用户预设一律先归一化（编辑器只认单任务字段，旧格式在下拉里标不可用）
  const basePreset: DriverPreset = builtinDriverPreset(currentName)
    || (validNames.includes(currentName) ? (normalizeDriverPreset(storedPresets[currentName]) || defaultDriverPreset()) : defaultDriverPreset());
  const working = clonePreset(basePreset);
  const isBuiltin = BUILTIN_PRESET_NAMES.includes(currentName);
  pane.innerHTML = '';

  // ── 预设摘要卡（平时只显示当前预设 + 编辑入口；长表单进大弹窗） ──
  const segCount = working.promptGroup.filter((m) => !m.block).length;
  const blockCount = working.promptGroup.filter((m) => m.block).length;
  const tagCount = splitTags(working.tags).length;
  const recallCount = normalizeRates(working.rates).recallCount;
  const presetCard = el(doc, 'div', { class: 'slw-card slw-preset-card' }, `
    <h3>推进预设 <span class="desc">内置两份（魔改召回 / 极速纯召回，不可覆盖）+ 自建预设；只支持台账自己的新格式</span></h3>
    <div class="slw-row" style="margin:0">
      <select id="slw-p-select" style="min-width:260px">
        ${presetNames.map((n) => `<option value="${esc(n)}" ${n === currentName ? 'selected' : ''}>${esc(n)}${BUILTIN_PRESET_NAMES.includes(n) ? '（内置）' : ''}</option>`).join('')}
        ${invalidNames.map((n) => `<option disabled>${esc(n)}（旧格式·不可用）</option>`).join('')}
      </select>
      <span class="slw-tag ${isBuiltin ? 'dim' : 'info'}">${isBuiltin ? '内置' : '自定义'}</span>
      <span class="slw-preset-summary">${segCount} 段 · ${blockCount} 个固定块 · 标签 ${tagCount} 个 · 召回数量 ${recallCount}</span>
      <button class="slw-btn primary" id="slw-p-edit">编辑预设…</button>
    </div>
    <div class="slw-preset-actions">
      <button class="slw-btn sm" id="slw-p-import">导入台账预设 JSON…</button>
      <button class="slw-btn sm" id="slw-p-export">导出当前</button>
      ${invalidNames.length > 0 ? `<span class="slw-tag warn">旧格式 ${invalidNames.length} 个</span><span class="slw-muted">已不可用也不会被加载；删除入口在「编辑预设…」里</span>` : ''}
    </div>`);
  pane.appendChild(presetCard);
  presetCard.querySelector('#slw-p-select')!.addEventListener('change', async (e) => {
    await deps.settings.update({ driverPresetName: (e.target as HTMLSelectElement).value });
    ctx.refresh('plot');
  });
  presetCard.querySelector('#slw-p-edit')!.addEventListener('click', () => openPlotPresetEditor(ctx, currentName));
  presetCard.querySelector('#slw-p-import')!.addEventListener('click', async () => {
    const parsed = await pickJsonFile(deps, '.json');
    if (!parsed || typeof parsed !== 'object') { deps.warn('JSON 读取失败'); return; }
    if ((parsed as any).format !== PLOT_PRESET_FORMAT) { deps.warn('不是台账推进预设文件（缺少 format 标记）——旧格式 JSON 不再支持导入'); return; }
    const preset = (parsed as any).preset;
    if (!isValidDriverPreset(preset)) { deps.warn('预设内容不完整（缺少任务/模板字段）'); return; }
    const name = String(preset.name || '导入的推进预设');
    if (BUILTIN_PRESET_NAMES.includes(name)) { deps.warn(`「${name}」是内置预设名，改为「导入的推进预设」保存`); preset.name = '导入的推进预设'; }
    const finalName = String(preset.name || '导入的推进预设');
    await deps.canonical.driver.setPreset(preset, finalName);
    deps.notify(`推进预设「${finalName}」已导入`);
    ctx.refresh('plot');
  });
  presetCard.querySelector('#slw-p-export')!.addEventListener('click', () => {
    downloadJsonFile(deps, `瑟瑟台账-推进预设-${working.name || '导出'}.json`, {
      format: PLOT_PRESET_FORMAT,
      schemaVersion: PLOT_PRESET_SCHEMA,
      preset: working,
    });
  });

  // ── 推进说明（短文案，留在页面；长表单进弹窗） ──
  pane.appendChild(el(doc, 'div', { class: 'slw-annot', style: 'margin-top:12px' },
    '推进只保留用户发送时的自动拦截链路（三入口等价 + 防回环 + 纪要 AM 码召回）；编辑页只做配置，无手动触发入口。结构头（破限＋反八股）与结构尾（尾部破限）共享主项目设置，不在此编辑。'));
}

/** 推进预设编辑弹窗：参数 + 段/块混排 + 最终指令；所有修改先落草稿，保存时一次性写入。 */
function openPlotPresetEditor(ctx: TabCtx, currentName: string): void {
  const { deps, doc } = ctx;
  const s = deps.settings.get();
  const storedPresets: Record<string, unknown> = { ...(s.plotPresets || {}) };
  const validNames = Object.keys(storedPresets).filter((n) => deps.canonical.driver.isValidPreset(storedPresets[n])).sort();
  const invalidNames = Object.keys(storedPresets).filter((n) => !deps.canonical.driver.isValidPreset(storedPresets[n])).sort();
  const isBuiltin = BUILTIN_PRESET_NAMES.includes(currentName);
  const basePreset: DriverPreset = builtinDriverPreset(currentName)
    || (validNames.includes(currentName) ? (normalizeDriverPreset(storedPresets[currentName]) || defaultDriverPreset()) : defaultDriverPreset());

  let draft = clonePreset(basePreset);
  let draftName = currentName;
  let draftReplaced = false;
  const originalJson = JSON.stringify(draft);

  const content = el(doc, 'div');
  const rates = normalizeRates(draft.rates);
  content.innerHTML = `
    <fieldset class="fs" style="margin-top:0;border-top:0;padding-top:0"><legend>匹配替换参数（随预设保存）</legend>
      <div class="slw-rategrid">
        <label title="全局意外走向倾向">意外倾向<input type="number" step="0.05" data-rate="rateMain" value="${rates.rateMain}"></label>
        <label title="全局意外触发频率">意外频率<input type="number" step="0.05" data-rate="ratePersonal" value="${rates.ratePersonal}"></label>
        <label title="角色主动触发频率">主动频率<input type="number" step="0.05" data-rate="rateErotic" value="${rates.rateErotic}"></label>
        <label title="环境氛围触发频率">氛围频率<input type="number" step="0.05" data-rate="rateCuckold" value="${rates.rateCuckold}"></label>
        <label title="召回记忆条数">召回数量<input type="number" data-rate="recallCount" value="${rates.recallCount}"></label>
      </div>
      <div class="slw-editor-note">这些值替换提示词段里的同名占位符：{{意外倾向}} {{意外频率}} {{主动频率}} {{氛围频率}} {{召回数量}}。</div>
    </fieldset>

    <div class="slw-row" style="margin-top:10px">
      <label>最大重试</label><input type="number" data-f="maxRetries" value="${draft.maxRetries}" style="width:60px">
      <span class="slw-muted">AI 空回复、请求异常或输出总长度不足时重试几次（0＝不重试）</span></div>
    <div class="slw-row"><label>标签</label><input type="text" data-f="tags" value="${esc(draft.tags)}" placeholder="逗号分隔，如 recall,spot" style="width:220px">
      <label style="min-width:auto">最小回复长度</label><input type="number" data-f="minLength" value="${draft.minLength}" style="width:70px">
      <span class="slw-muted">最小回复长度按 AI 原始输出整段长度判定（0＝不校验）。最终指令模板里写 {{标签}} 才会输出对应标签内容（输出为 &lt;标签&gt;内容&lt;/标签&gt;）；「上轮推进结果块」的可选标签也来自这里。</span></div>

    <fieldset class="fs"><legend>提示词段 与 固定块（顺序可调；固定块内容引擎生成、只能调顺序或隐藏）</legend>
      <div id="slw-p-segments"></div>
      <div class="slw-row" id="slw-p-segments-actions"></div>
    </fieldset>

    <fieldset class="fs"><legend>全局与最终指令</legend>
      <div class="slw-row"><label>上下文层数</label><input type="number" data-g="contextTurnCount" value="${draft.contextTurnCount}" style="width:64px">
        <span class="slw-muted">＝【上轮正文】取最近几层 AI 回复</span></div>
      <div class="slw-row" style="align-items:flex-start"><label style="padding-top:6px">最终指令模板</label>
        <span style="flex:1;min-width:0">
        <textarea rows="12" data-g="finalDirectiveTemplate">${esc(draft.finalDirectiveTemplate)}</textarea>
        <span class="slw-muted">模板可用：{{本轮输入}}（把本轮用户输入注入最终指令）＋ 标签占位符（如 {{recall}} → 替换为 &lt;recall&gt;内容&lt;/recall&gt;）；标签在模板里没写占位符则不输出。</span>
        </span></div>
    </fieldset>`;

  const actions = el(doc, 'div');
  actions.innerHTML = `
    <span class="slw-editor-dirty" data-slw-dirty style="display:none">● 有未保存修改</span>
    <span class="slw-editor-spacer"></span>
    <button class="slw-btn" data-act="cancel">取消</button>
    <button class="slw-btn primary" data-act="save">保存预设</button>`;
  const dirtyEl = actions.querySelector('[data-slw-dirty]') as HTMLElement;
  const saveBtn = actions.querySelector('[data-act="save"]') as HTMLButtonElement;

  let handle: ReturnType<typeof openEditorDialog> | null = null;
  let segEditor: { render: () => void } | null = null;

  const isDirty = (): boolean => draftReplaced || JSON.stringify(draft) !== originalJson;
  const syncDirty = (): void => {
    dirtyEl.style.display = isDirty() ? '' : 'none';
    if (!handle) return;
    const tag = handle.root.querySelector('[data-slw-toolbar-tag]') as HTMLElement | null;
    const del = handle.root.querySelector('[data-act="delete"]') as HTMLButtonElement | null;
    const custom = !isBuiltin || draftReplaced;
    if (tag) {
      tag.textContent = custom ? '自定义' : '内置';
      tag.className = `slw-tag ${custom ? 'info' : 'dim'}`;
    }
    if (del) del.disabled = isBuiltin || draftReplaced;
  };

  const syncFields = (): void => {
    content.querySelectorAll('[data-f]').forEach((n) => {
      const key = (n as HTMLElement).dataset.f as 'maxRetries' | 'minLength' | 'tags';
      (n as HTMLInputElement).value = String((draft as any)[key] ?? '');
    });
    const r = normalizeRates(draft.rates);
    content.querySelectorAll('[data-rate]').forEach((n) => {
      const key = (n as HTMLElement).dataset.rate!;
      (n as HTMLInputElement).value = String((r as any)[key] ?? '');
    });
    content.querySelectorAll('[data-g]').forEach((n) => {
      const key = (n as HTMLElement).dataset.g!;
      if (key === 'contextTurnCount') (n as HTMLInputElement).value = String(draft.contextTurnCount ?? 3);
      else (n as HTMLTextAreaElement).value = String((draft as any)[key] ?? '');
    });
  };

  const mountSegments = (): void => {
    segEditor = mountPromptEditor({
      box: content.querySelector('#slw-p-segments') as HTMLElement,
      actions: content.querySelector('#slw-p-segments-actions') as HTMLElement,
      items: draft.promptGroup,
      blockIds: DIRECTOR_BLOCK_CATALOG,
      hints: BLOCK_HINTS,
      allowTableBlock: true,
      placeholderHint: PLACEHOLDER_HINT,
      onChange: syncDirty,
      onConfigTableBlock: (index) => openTableBlockDialog(ctx, draft.promptGroup[index], () => { segEditor?.render(); syncDirty(); }),
      onConfigPrevDirective: (index) => openPrevDirectiveDialog(ctx, () => draft.tags, draft.promptGroup[index], () => { segEditor?.render(); syncDirty(); }),
    });
  };

  const replaceDraft = (next: DriverPreset, name: string): void => {
    draft = clonePreset(next);
    draft.name = name;
    draftName = name;
    draftReplaced = true;
    syncFields();
    mountSegments();
    syncDirty();
    handle?.setTitle(`推进预设 · ${name}`, '草稿尚未保存；点「保存预设」后生效。');
  };

  content.querySelectorAll('[data-f]').forEach((n) => {
    const key = (n as HTMLElement).dataset.f! as 'maxRetries' | 'minLength' | 'tags';
    const apply = (): void => {
      const value = (n as HTMLInputElement).value;
      if (key === 'maxRetries' || key === 'minLength') draft[key] = Number(value) || 0;
      else draft[key] = value;
      syncDirty();
    };
    n.addEventListener('input', apply);
    n.addEventListener('change', apply);
  });
  content.querySelectorAll('[data-rate]').forEach((n) => {
    const key = (n as HTMLElement).dataset.rate!;
    const apply = (): void => {
      const v = Number((n as HTMLInputElement).value);
      draft.rates = { ...(draft.rates || {}), [key]: Number.isFinite(v) && v >= 0 ? v : undefined };
      syncDirty();
    };
    n.addEventListener('input', apply);
    n.addEventListener('change', apply);
  });
  content.querySelectorAll('[data-g]').forEach((n) => {
    const key = (n as HTMLElement).dataset.g!;
    const apply = (): void => {
      if (key === 'contextTurnCount') draft.contextTurnCount = Number((n as HTMLInputElement).value) || 3;
      else (draft as any)[key] = (n as HTMLTextAreaElement).value;
      syncDirty();
    };
    n.addEventListener('input', apply);
    n.addEventListener('change', apply);
  });

  mountSegments();

  handle = openEditorDialog(deps, {
    title: `推进预设 · ${draftName}`,
    subtitle: isBuiltin ? '内置预设不可覆盖：保存时会提示另存为新预设。结构头/尾共享主项目破限设置。' : '结构头/尾共享主项目破限设置。',
    toolbar: `
      <button class="slw-btn sm" data-act="new">从默认新建</button>
      <button class="slw-btn sm danger" data-act="delete"${isBuiltin ? ' disabled' : ''}>删除所选</button>
      ${invalidNames.length > 0 ? `<button class="slw-btn sm danger" data-act="drop-legacy">删除全部旧格式预设</button>` : ''}
      <span class="slw-tag ${isBuiltin ? 'dim' : 'info'}" data-slw-toolbar-tag style="margin-left:auto">${isBuiltin ? '内置' : '自定义'}</span>`,
    content,
    actions,
    beforeClose: async () => {
      if (!isDirty()) return true;
      return await confirmDialog(deps, '有未保存的修改，关闭后丢弃？', { okText: '放弃修改', cancelText: '继续编辑', danger: true });
    },
  });

  actions.querySelector('[data-act="cancel"]')!.addEventListener('click', () => handle?.requestClose());
  handle.root.querySelector('[data-act="new"]')!.addEventListener('click', async () => {
    const name = await promptDialog(deps, '新预设名：', '自定义推进预设', { okText: '创建' });
    if (!name) return;
    if (BUILTIN_PRESET_NAMES.includes(name)) { deps.warn('该名字与内置预设重名，请换一个'); return; }
    const fresh = defaultDriverPreset();
    fresh.name = name;
    replaceDraft(fresh, name);
    deps.notify('新预设已放入草稿，点「保存预设」生效');
  });
  handle.root.querySelector('[data-act="delete"]')!.addEventListener('click', async () => {
    if (isBuiltin || draftReplaced) { deps.warn('该预设不可删除'); return; }
    if (!await confirmDialog(deps, `删除预设「${draftName}」？`, { okText: '删除预设', danger: true })) return;
    await deps.canonical.driver.deletePreset(draftName);
    deps.notify(`预设「${draftName}」已删除`);
    handle?.close(true);
    ctx.refresh('plot');
  });
  const dropLegacyBtn = handle.root.querySelector('[data-act="drop-legacy"]');
  if (dropLegacyBtn) {
    dropLegacyBtn.addEventListener('click', async () => {
      if (!await confirmDialog(deps, `删除全部 ${invalidNames.length} 个旧格式预设？此操作不可撤销。`, { okText: '全部删除', danger: true })) return;
      for (const n of invalidNames) await deps.canonical.driver.deletePreset(n);
      deps.notify('旧格式预设已清除');
      handle?.close(true);
      ctx.refresh('plot');
    });
  }

  saveBtn.addEventListener('click', async () => {
    let saveName = draft.name || '自定义预设';
    if (isBuiltin && !draftReplaced) {
      const prompted = await promptDialog(deps, '内置预设不可覆盖，保存为：', `${currentName} 改`, { okText: '另存为新预设' });
      if (!prompted) return;
      saveName = prompted;
    }
    if (BUILTIN_PRESET_NAMES.includes(saveName)) { deps.warn('该名字与内置预设重名，请换一个'); return; }
    draft.name = saveName;
    if (!isValidDriverPreset(draft)) { deps.warn('预设内容不完整（提示词段缺失或模板字段不对）'); return; }
    saveBtn.disabled = true;
    saveBtn.textContent = '保存中…';
    try {
      await deps.canonical.driver.setPreset(draft, saveName);
      deps.notify(`推进预设「${saveName}」已保存`);
      handle?.close(true);
      ctx.refresh('plot');
    } catch (err) {
      deps.warn('保存推进预设失败：' + (err instanceof Error ? err.message : String(err)));
      saveBtn.disabled = false;
      saveBtn.textContent = '保存预设';
    }
  });

  syncDirty();
}

/** 表数据块配置弹窗（取指定表里指定行的某列；＝数据库 {[db.表.where(…).get(…)]}）。 */
function openTableBlockDialog(ctx: TabCtx, item: { table?: LedgerTableBlockConfig }, onSaved: () => void): void {
  const { deps, doc } = ctx;
  const book = deps.runtime.book();
  if (!book) { deps.warn('台账未就绪（当前聊天尚未建账）'); return; }
  const bookRef = book;
  const tables = [...bookRef.tables.values()].sort((a, b) => a.orderNo - b.orderNo);
  if (tables.length === 0) { deps.warn('当前模板没有可用表'); return; }
  const cfg: LedgerTableBlockConfig = { table: '', ...(item.table || {}) };
  // 只清理上一次「表数据块」子弹窗；不能 remove 掉外层的预设编辑弹窗遮罩。
  doc.querySelector('.slw-dialog-mask[data-slw-table-block]')?.remove();
  const mask = el(doc, 'div', { class: 'slw-dialog-mask', 'data-slw-table-block': '1' });
  const dialog = el(doc, 'div', { class: 'slw-dialog' });
  const columnsOf = (tableName: string): string[] => {
    const t = tables.find((x) => x.name === tableName || x.tableId === tableName);
    return t ? t.headers.filter((h) => h && h !== 'row_id') : [];
  };
  function draw(): void {
    const cols = columnsOf(cfg.table);
    dialog.innerHTML = `
      <h3>表数据块配置 <button class="x" style="float:right;background:none;border:0;color:#8b8676;font-size:16px;cursor:pointer">✕</button></h3>
      <div class="slw-muted" style="margin-bottom:8px">每轮请求实时读账本（无缓存）；取不到（表/行/列不存在或值为空）时该块整块不出条。</div>
      <div class="slw-row"><label>表</label>
        <select id="slw-tb-table" style="width:190px">
          <option value="">（选择一张表）</option>
          ${tables.map((t) => `<option value="${esc(t.name)}" ${cfg.table === t.name ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
        </select></div>
      <div class="slw-row"><label>行定位列</label>
        <select id="slw-tb-key" style="width:150px"${cols.length === 0 ? ' disabled' : ''}>
          <option value="">（留空＝整表投影）</option>
          ${cols.map((c) => `<option value="${esc(c)}" ${cfg.matchColumn === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}
        </select>
        <label style="min-width:auto">等于</label><input type="text" id="slw-tb-val" value="${esc(cfg.matchValue || '')}" placeholder="如：已探索地点概览" style="width:200px"></div>
      <div class="slw-row"><label>取值列</label>
        <select id="slw-tb-column" style="width:150px"${cols.length === 0 ? ' disabled' : ''}>
          <option value="">（留空＝整行以 | 拼接）</option>
          ${cols.map((c) => `<option value="${esc(c)}" ${cfg.valueColumn === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}
        </select>
        <label style="min-width:auto">块抬头</label><input type="text" id="slw-tb-label" value="${esc(cfg.label || '')}" placeholder="留空＝取值列名 > 表名" style="width:150px"></div>
      <div class="slw-report" id="slw-tb-preview" style="margin-top:8px"></div>
      <div class="slw-row" style="justify-content:flex-end;margin-top:10px">
        <button class="slw-btn" data-close>取消</button><button class="slw-btn primary" data-save>保存配置</button></div>`;
    const preview = dialog.querySelector('#slw-tb-preview') as HTMLElement;
    const text = cfg.table ? readTableBlockValue(bookRef, cfg) : '';
    preview.textContent = cfg.table ? (text || '（当前读不到内容：该块会整块不出条）') : '（选表后可预览）';
    dialog.querySelector('#slw-tb-table')!.addEventListener('change', (e) => {
      cfg.table = (e.target as HTMLSelectElement).value;
      cfg.matchColumn = ''; cfg.valueColumn = '';
      draw();
    });
    dialog.querySelector('#slw-tb-key')!.addEventListener('change', (e) => { cfg.matchColumn = (e.target as HTMLSelectElement).value; draw(); });
    dialog.querySelector('#slw-tb-val')!.addEventListener('input', (e) => { cfg.matchValue = (e.target as HTMLInputElement).value; });
    dialog.querySelector('#slw-tb-column')!.addEventListener('change', (e) => { cfg.valueColumn = (e.target as HTMLSelectElement).value; draw(); });
    dialog.querySelector('#slw-tb-label')!.addEventListener('input', (e) => { cfg.label = (e.target as HTMLInputElement).value; });
    dialog.querySelector('.x')!.addEventListener('click', close);
    dialog.querySelectorAll('[data-close]').forEach((b) => { (b as HTMLElement).onclick = close; });
    dialog.querySelector('[data-save]')!.addEventListener('click', () => {
      if (!cfg.table) { deps.warn('请先选择表'); return; }
      item.table = {
        table: cfg.table,
        ...(cfg.matchColumn ? { matchColumn: cfg.matchColumn } : {}),
        ...(String(cfg.matchValue || '').trim() ? { matchValue: String(cfg.matchValue).trim() } : {}),
        ...(cfg.valueColumn ? { valueColumn: cfg.valueColumn } : {}),
        ...(String(cfg.label || '').trim() ? { label: String(cfg.label).trim() } : {}),
      };
      close();
      onSaved();
      deps.notify('表数据块已配置');
    });
  }
  mask.appendChild(dialog);
  doc.body.appendChild(mask);
  function close(): void { mask.remove(); }
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  draw();
}

/** 上一轮推进的两份来源（读 chat 里最近一个带 sl_plot / sl_plot_tasks 的用户楼）：
 * raw＝原始输出（标签真源）、assembled＝最终指令（回落）；都没有＝空。 */
function lastPlotSources(deps: TabCtx['deps']): { raw: string; assembled: string } {
  try {
    const chat = deps.getChat() || [];
    for (let i = chat.length - 1; i >= 0; i--) {
      if (chat[i]?.is_user !== true) continue;
      const raw = readPlotRawFromMessage(chat[i]);
      const assembled = readPlotFromMessage(chat[i]);
      if (raw || assembled) return { raw, assembled };
    }
  } catch (_e) { /* 宿主 chat 不可用＝没有预览 */ }
  return { raw: '', assembled: '' };
}

/** 上轮推进结果块配置弹窗：多选要注入的标签（选项＝本预设标签清单；含上一轮命中预览）。 */
function openPrevDirectiveDialog(ctx: TabCtx, presetTags: () => string, item: { tags?: string[] }, onSaved: () => void): void {
  const { deps, doc } = ctx;
  const options = splitTags(presetTags());
  const picked = new Set((item.tags || []).map((t) => String(t).trim()).filter(Boolean));
  const src = lastPlotSources(deps);
  // 只清理上一次「上轮推进结果」子弹窗；不能 remove 掉外层的预设编辑弹窗遮罩。
  doc.querySelector('.slw-dialog-mask[data-slw-prev-directive]')?.remove();
  const mask = el(doc, 'div', { class: 'slw-dialog-mask', 'data-slw-prev-directive': '1' });
  const dialog = el(doc, 'div', { class: 'slw-dialog' });
  const previewOf = (tag: string): string => {
    if (!src.raw && !src.assembled) return '（还没有上一轮推进输出）';
    const content = pickPrevTagContent(tag, src.raw, src.assembled);
    return content ? `有内容：${content.length > 40 ? content.slice(0, 40) + '…' : content}` : '上一轮没有这个标签';
  };
  dialog.innerHTML = `
    <h3>上轮推进结果块 · 选择注入标签 <button class="x" style="float:right;background:none;border:0;color:#8b8676;font-size:16px;cursor:pointer">✕</button></h3>
    <div class="slw-muted" style="margin-bottom:8px">每轮从上一轮最终指令里只提取勾选的标签（&lt;标签&gt;内容&lt;/标签&gt;）注入本轮请求；一个都不勾＝该块整块不出条。选项＝本预设「标签」清单。</div>
    ${options.length === 0
      ? '<div class="slw-report slw-muted">本预设还没有标签：先在上方「标签」里填写标签名，再回来勾选。</div>'
      : `<div style="display:flex;flex-direction:column;gap:6px;margin:6px 0">${options.map((t) => `
          <label style="display:flex;gap:8px;align-items:baseline">
            <input type="checkbox" class="check" data-tag="${esc(t)}" ${picked.has(t) ? 'checked' : ''}>
            <b>${esc(t)}</b><span class="slw-muted">${esc(previewOf(t))}</span>
          </label>`).join('')}</div>`}
    <div class="slw-row" style="margin-top:10px">
      <button class="slw-btn sm" data-all${options.length === 0 ? ' disabled' : ''}>全选</button>
      <button class="slw-btn sm" data-none${options.length === 0 ? ' disabled' : ''}>全不选</button>
      <span style="flex:1"></span>
      <button class="slw-btn" data-close>取消</button><button class="slw-btn primary" data-save>保存</button></div>`;
  dialog.querySelectorAll('[data-tag]').forEach((n) => n.addEventListener('change', (e) => {
    const tag = (n as HTMLElement).dataset.tag!;
    if ((e.target as HTMLInputElement).checked) picked.add(tag);
    else picked.delete(tag);
  }));
  dialog.querySelector('[data-all]')?.addEventListener('click', () => {
    options.forEach((t) => picked.add(t));
    dialog.querySelectorAll('[data-tag]').forEach((n) => { (n as HTMLInputElement).checked = true; });
  });
  dialog.querySelector('[data-none]')?.addEventListener('click', () => {
    picked.clear();
    dialog.querySelectorAll('[data-tag]').forEach((n) => { (n as HTMLInputElement).checked = false; });
  });
  dialog.querySelector('.x')!.addEventListener('click', close);
  dialog.querySelectorAll('[data-close]').forEach((b) => { (b as HTMLElement).onclick = close; });
  dialog.querySelector('[data-save]')!.addEventListener('click', () => {
    // 按预设标签清单顺序落盘（去掉已不在清单里的旧选择）
    item.tags = options.filter((t) => picked.has(t));
    close();
    onSaved();
    deps.notify('上轮推进结果块已配置');
  });
  mask.appendChild(dialog);
  doc.body.appendChild(mask);
  function close(): void { mask.remove(); }
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
}

/** 供参考：可用的固定块清单（顺序 = 默认顺序）。 */
export const DIRECTOR_BLOCKS = DIRECTOR_BLOCK_CATALOG;
