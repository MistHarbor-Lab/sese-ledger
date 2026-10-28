// ===== 设置标签页：开关 · API 来源卡（跟随主项目）· 高级调度参数（引擎诊断已并入「日志」页） =====
import { esc, el, downloadJsonFile, pickJsonFile, confirmDialog } from './shared';
import { isDriverEnabled, isProgressPersistEnabled } from '../../core/settings-store';
import { groupsOf, isStoppedGroup } from '../../core/book';
import { DEFAULT_FILL_MAX_ATTEMPTS, FILL_MAX_ATTEMPTS_LIMIT, resolveFillMaxAttempts } from '../../core/scribe';
import { summaryWarning, summaryWarnThresholdOf } from '../../core/summary-warning';
import type { TabCtx } from './shell';

export function renderSettingsTab(ctx: TabCtx, pane: HTMLElement): void {
  const { deps, doc } = ctx;
  const s = deps.settings.get();
  pane.innerHTML = '';

  // ── 开关 ──
  const switchCard = el(doc, 'div', { class: 'slw-card' }, `
    <h3>开关</h3>
    <div class="slw-row"><label>自动填表</label><span class="slw-switch ${s.autoFillEnabled !== false ? 'on' : ''}" id="slw-s-auto"></span><span class="slw-muted">AI 回复落楼后按分组频率自动填表</span></div>
    <div class="slw-row"><label>剧情推进</label><span class="slw-switch ${isDriverEnabled(s) ? 'on' : ''}" id="slw-s-driver"></span><span class="slw-muted">默认开；关闭后不再拦截用户发送做规划改写（三入口 + 防回环），并撤除聊天显示正则</span></div>
    <div class="slw-row"><label>填表/推进持久化</label><span class="slw-switch ${isProgressPersistEnabled(s) ? 'on' : ''}" id="slw-s-progress-persist"></span><span class="slw-muted">默认关；关闭后填表/推进进度通知显示 3 秒即自动隐去（错误告警仍常驻；工作台顶部「填表进行中」横幅不受影响）</span></div>
    <div class="slw-row"><label>悬浮按钮</label><span class="slw-switch ${s.showLauncher !== false ? 'on' : ''}" id="slw-s-launcher"></span><span class="slw-muted">关闭后仍可从酒馆扩展菜单（魔杖图标）打开工作台</span></div>`);
  pane.appendChild(switchCard);
  switchCard.querySelector('#slw-s-auto')!.addEventListener('click', async (e) => {
    const next = !(e.target as HTMLElement).classList.contains('on');
    (e.target as HTMLElement).classList.toggle('on', next);
    await deps.settings.update({ autoFillEnabled: next });
  });
  switchCard.querySelector('#slw-s-driver')!.addEventListener('click', async (e) => {
    const next = !(e.target as HTMLElement).classList.contains('on');
    (e.target as HTMLElement).classList.toggle('on', next);
    await deps.settings.update({ driverEnabled: next });
    try { await (deps.canonical as any).syncPlotRegex?.(); } catch (_e) { /* ignore */ }
  });
  switchCard.querySelector('#slw-s-launcher')!.addEventListener('click', async (e) => {
    const next = !(e.target as HTMLElement).classList.contains('on');
    (e.target as HTMLElement).classList.toggle('on', next);
    await deps.settings.update({ showLauncher: next });
    try { deps.window.dispatchEvent(new CustomEvent('slw-render-launcher')); } catch (_e) { /* ignore */ }
  });
  switchCard.querySelector('#slw-s-progress-persist')!.addEventListener('click', async (e) => {
    const next = !(e.target as HTMLElement).classList.contains('on');
    (e.target as HTMLElement).classList.toggle('on', next);
    await deps.settings.update({ progressPersist: next });
  });

  // ── 纪要维护（数量提醒；合并使用填表 API） ──
  const warnInfo = summaryWarning(deps.runtime.book(), s);
  const warnLimit = summaryWarnThresholdOf(s);
  const warnTag = warnLimit === 0 ? '提醒已关闭' : warnInfo.over ? `超过 ${warnInfo.diff} 条` : '正常';
  const warnTagCls = warnLimit === 0 ? 'dim' : warnInfo.over ? 'danger' : 'ok';
  const summaryCard = el(doc, 'div', { class: 'slw-card' }, `
    <h3>纪要维护 <span class="desc">数量提醒；合并使用填表 API</span></h3>
    <div class="slw-row">
      <label>数量警告阈值</label>
      <input type="number" id="slw-s-summary-warn" value="${warnLimit}" min="0" max="9999" style="width:88px"> 条
      <span class="slw-muted">超过该值时：工作台顶部横幅 + 填表完成后提示一次；<b>0 = 关闭提醒</b></span>
    </div>
    <div class="slw-row">
      <label>当前聊天纪要</label>
      <b id="slw-s-summary-count">${warnInfo.count}</b> 条
      <span class="slw-tag ${warnTagCls}" id="slw-s-summary-state">${warnTag}</span>
      <span class="slw-muted">合并请到「纪要合并」标签</span>
    </div>
    <div class="slw-annot">阈值是全局设置；纪要按聊天独立存储。提醒不会阻止填表。合并使用「填表 API」，不单独占一个预设位。</div>`);
  pane.appendChild(summaryCard);
  summaryCard.querySelector('#slw-s-summary-warn')!.addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const v = Math.max(0, Math.min(9999, Math.trunc(Number(input.value)) || 0));
    input.value = String(v);
    await deps.settings.update({ summaryWarnThreshold: v });
    const info = summaryWarning(deps.runtime.book(), deps.settings.get());
    const countEl = summaryCard.querySelector('#slw-s-summary-count') as HTMLElement | null;
    const stateEl = summaryCard.querySelector('#slw-s-summary-state') as HTMLElement | null;
    if (countEl) countEl.textContent = String(info.count);
    if (stateEl) {
      stateEl.textContent = v === 0 ? '提醒已关闭' : info.over ? `超过 ${info.diff} 条` : '正常';
      stateEl.className = 'slw-tag ' + (v === 0 ? 'dim' : info.over ? 'danger' : 'ok');
    }
    try { deps.window.dispatchEvent(new CustomEvent('slw-summary-warn-refresh')); } catch (_e) { /* ignore */ }
  });

  // ── API 来源（填表 / 推进各自独立；填表可按分组独立） ──
  const presets = deps.hostConfig.listPresets();
  const globalMode = deps.hostConfig.describeGlobalMode();
  const book = deps.runtime.book();
  const activeGroups = (book ? groupsOf(book) : [])
    .filter((g) => !isStoppedGroup(g))
    .sort((a, b) => Number(a.id) - Number(b.id));
  const groupNameOf = (g: { id: number; name?: string }): string => {
    const name = String(g.name || '').trim();
    return name && name !== `分组${g.id}` ? name : '';
  };
  /** 用途的基准选择（忽略「按分组独立」开关；供基准回退与分组默认值使用）。 */
  const baseSelectionOf = (purpose: 'fill' | 'driver'): string => {
    const idRaw = (s as Record<string, unknown>)[`${purpose}ApiPresetId`];
    const modeRaw = (s as Record<string, unknown>)[`${purpose}ApiMode`];
    const id = typeof idRaw === 'string' ? idRaw : String(s.apiPresetId || '');
    const mode = typeof modeRaw === 'string' ? modeRaw : String(s.apiMode || 'follow');
    if (mode === 'tavern') return 'tavern|';
    return id ? `pin|${id}` : 'follow|';
  };
  /** 顶栏当前选择：填表按分组独立时固定显示 group|。 */
  const selectionOf = (purpose: 'fill' | 'driver'): string =>
    purpose === 'fill' && s.fillApiPerGroup === true ? 'group|' : baseSelectionOf(purpose);
  const selectionLabel = (value: string): string => {
    const [kind, id] = value.split('|');
    if (kind === 'tavern') return '酒馆主 API（不覆盖）';
    if (kind === 'pin' && id) {
      const preset = presets.find((p) => p.id === id);
      return preset ? (preset.name || preset.model || preset.id) : `${id}（预设已删除）`;
    }
    return `跟随主项目全局（当前：${globalMode}）`;
  };
  const optionsOf = (selected: string, opts: { inherit?: string; group?: boolean } = {}): string => [
    ...(opts.inherit !== undefined
      ? [`<option value="inherit|" ${selected === 'inherit|' ? 'selected' : ''}>沿用基准 · ${esc(opts.inherit)}</option>`]
      : []),
    `<option value="follow|" ${selected === 'follow|' ? 'selected' : ''}>跟随主项目全局选择（当前：${esc(globalMode)}）</option>`,
    `<option value="tavern|" ${selected === 'tavern|' ? 'selected' : ''}>酒馆主 API（不覆盖）</option>`,
    '<option value="__presets__" disabled>── 主项目预设 ──</option>',
    ...presets.map((p) => `<option value="pin|${esc(p.id)}" ${selected === `pin|${p.id}` ? 'selected' : ''}>　${esc(p.name || p.model || p.id)}</option>`),
    ...(opts.group ? [`<option value="group|" ${selected === 'group|' ? 'selected' : ''}>按分组独立（每个分组单独指定）</option>`] : []),
  ].join('');
  /** 分组绑定 → 下拉值；预设已被删除时按「沿用基准」显示（与实际解析的回退一致）。 */
  const groupBindingOf = (groupId: number): string => {
    const binding = s.fillGroupApis?.[String(groupId)];
    if (!binding) return 'inherit|';
    if (binding.mode === 'tavern') return 'tavern|';
    const presetId = typeof binding.presetId === 'string' ? binding.presetId.trim() : '';
    if (!presetId) return 'follow|';
    return presets.some((p) => p.id === presetId) ? `pin|${presetId}` : 'inherit|';
  };
  const groupStateOf = (value: string): string =>
    value === 'inherit|' ? '沿用' : value === 'tavern|' ? '酒馆' : value === 'follow|' ? '跟随' : '独立';
  /** 分组 API 区块：只列频率 > 0 的分组；空台账/全停用有明确空态。 */
  const groupApiBlock = (): string => {
    const baseLabel = selectionLabel(baseSelectionOf('fill'));
    const head = `<div class="slw-groupapi-head">
      <span class="t">分组 API</span>
      <span class="slw-muted">仅显示更新频率 &gt; 0 的分组；未改动的分组沿用基准</span>
      <span class="slw-tag info slw-groupapi-base">基准：${esc(baseLabel)}</span>
    </div>`;
    if (!book) {
      return `<div class="slw-groupapi">${head}<div class="slw-groupapi-empty">当前聊天尚未建账，暂无分组；先推进剧情建账，或直接执行手动填表。</div></div>`;
    }
    if (activeGroups.length === 0) {
      return `<div class="slw-groupapi">${head}<div class="slw-groupapi-empty">当前台账没有更新频率 &gt; 0 的分组；请到「表格」页把分组频率改为 &gt; 0。</div></div>`;
    }
    return `<div class="slw-groupapi">${head}
      ${activeGroups.map((g) => {
        const selected = groupBindingOf(Number(g.id));
        const name = groupNameOf(g);
        return `<div class="slw-groupapi-row" data-gid="${g.id}">
          <div class="g-name"><span class="slw-tag">分组${g.id}</span>${name ? `<b>${esc(name)}</b>` : ''}<span class="slw-muted">每 ${Math.max(0, Math.trunc(Number(g.frequency) || 0))} 层</span></div>
          <select data-group-api="${g.id}">${optionsOf(selected, { inherit: baseLabel })}</select>
          <span class="g-state">${groupStateOf(selected)}</span>
        </div>`;
      }).join('')}
      <div class="slw-groupapi-foot">
        <span class="slw-muted">频率 0 的分组不显示；配置保留，频率改回 &gt; 0 后自动恢复。</span>
        <button class="slw-btn sm" id="slw-s-group-reset">全部恢复沿用基准</button>
      </div>
    </div>`;
  };
  const apiCard = el(doc, 'div', { class: 'slw-card' }, `
    <h3>API 来源 <span class="desc">预设仓库 = 统一状态栏「设置 → API → 预设管理」；台账不再单独配置 API</span></h3>
    <div class="slw-row">
      <label>填表 API</label>
      <select id="slw-s-api-fill" style="min-width:280px">${optionsOf(selectionOf('fill'), { group: true })}</select>
      <span class="slw-muted">自动/手动填表、定向重填、建表向导</span>
    </div>
    ${s.fillApiPerGroup === true ? groupApiBlock() : ''}
    <div class="slw-row">
      <label>推进 API</label>
      <select id="slw-s-api-driver" style="min-width:280px">${optionsOf(selectionOf('driver'))}</select>
      <span class="slw-muted">剧情推进规划请求</span>
    </div>
    <div class="slw-row"><span class="slw-muted">主项目切换预设/删除预设，台账即时跟随（监听配置变更事件）；预设被删时回退酒馆主 API 并告警。</span></div>
    <div class="slw-annot">填表与推进分别选择 API 来源；两条管线都只引用主项目预设仓库（不在此填接口地址/密钥/模型）。按分组独立只作用于填表：自动/手动/时光机重填按所属分组取 API，建表向导跟随分组1；推进不受影响。</div>
    <div class="slw-row">
      <button class="slw-btn" id="slw-s-export">导出全量备份</button>
      <button class="slw-btn" id="slw-s-import">导入全量备份</button>
      <button class="slw-btn" id="slw-s-wb-refresh">刷新世界书投影</button>
    </div>
    <div class="slw-annot">全量备份＝当前聊天的整本台账（表结构、分组、读取/注入设置与全部数据行）；不含记账历史、时光机快照，也不含填表/推进/模板预设（这些是全局设置，各自单独导入导出）。<b>导入会整本覆盖当前聊天台账</b>，导入前自动下载一份当前台账备份。</div>`);
  pane.appendChild(apiCard);
  const bindApiSelect = (purpose: 'fill' | 'driver'): void => {
    const select = apiCard.querySelector(`#slw-s-api-${purpose}`) as HTMLSelectElement | null;
    if (!select) return;
    select.addEventListener('change', async () => {
      // 填表专用：按分组独立（保留 fillApiPresetId/fillApiMode 作为基准）。
      if (purpose === 'fill' && select.value === 'group|') {
        await deps.settings.update({ fillApiPerGroup: true });
        deps.notify('填表 API 已切换为按分组独立（即时生效）');
        ctx.refresh('settings');
        return;
      }
      const [kind, id] = select.value.split('|');
      const idKey = purpose === 'fill' ? 'fillApiPresetId' : 'driverApiPresetId';
      const modeKey = purpose === 'fill' ? 'fillApiMode' : 'driverApiMode';
      const patch: Record<string, string | boolean> = {};
      if (kind === 'follow') { patch[idKey] = ''; patch[modeKey] = 'follow'; }
      else if (kind === 'tavern') { patch[idKey] = ''; patch[modeKey] = 'tavern'; }
      else if (kind === 'pin' && id) { patch[idKey] = id; patch[modeKey] = 'follow'; }
      if (!Object.keys(patch).length) return;
      if (purpose === 'fill') patch.fillApiPerGroup = false;
      await deps.settings.update(patch as any);
      deps.notify(purpose === 'fill' ? '填表 API 已更新（即时生效）' : '推进 API 已更新（即时生效）');
      ctx.refresh('settings');
    });
  };
  bindApiSelect('fill');
  bindApiSelect('driver');
  // 分组行改动只落对应 groupId 的绑定，局部更新状态文字（不整页重绘，避免下拉失焦）。
  apiCard.querySelectorAll('[data-group-api]').forEach((node) => {
    node.addEventListener('change', async (e) => {
      const select = e.target as HTMLSelectElement;
      const groupId = String(select.dataset.groupApi || '');
      if (!groupId) return;
      const map = { ...(deps.settings.get().fillGroupApis || {}) };
      const value = select.value;
      if (value === 'inherit|') delete map[groupId];
      else if (value === 'tavern|') map[groupId] = { mode: 'tavern' };
      else if (value === 'follow|') map[groupId] = { mode: 'follow' };
      else if (value.startsWith('pin|')) {
        const presetId = value.slice(4).trim();
        if (!presetId) return;
        map[groupId] = { mode: 'follow', presetId };
      } else return;
      await deps.settings.update({ fillGroupApis: map });
      const row = select.closest('.slw-groupapi-row') as HTMLElement | null;
      if (!row) return;
      row.classList.toggle('changed', value !== 'inherit|' && value !== 'tavern|');
      row.classList.toggle('tavern', value === 'tavern|');
      const state = row.querySelector('.g-state');
      if (state) state.textContent = groupStateOf(value);
    });
  });
  apiCard.querySelector('#slw-s-group-reset')?.addEventListener('click', async () => {
    await deps.settings.update({ fillGroupApis: {} });
    apiCard.querySelectorAll('[data-group-api]').forEach((node) => {
      const select = node as HTMLSelectElement;
      select.value = 'inherit|';
      const row = select.closest('.slw-groupapi-row') as HTMLElement | null;
      if (!row) return;
      row.classList.remove('changed', 'tavern');
      const state = row.querySelector('.g-state');
      if (state) state.textContent = '沿用';
    });
    deps.notify('分组 API 已全部恢复为沿用基准');
  });
  apiCard.querySelector('#slw-s-export')!.addEventListener('click', () => {
    // 复用统一下载出口（锚点挂宿主 body，Firefox 也能触发）。
    downloadJsonFile(deps, '瑟瑟台账-全量备份.json', deps.canonical.exportBook());
  });
  apiCard.querySelector('#slw-s-import')!.addEventListener('click', async () => {
    const parsed = await pickJsonFile(deps, '.json');
    if (parsed === null) { deps.warn('JSON 读取失败或已取消'); return; }
    const sheetKeys = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? Object.keys(parsed).filter((k) => k.startsWith('sheet_') && parsed[k] && typeof parsed[k] === 'object' && Array.isArray(parsed[k].content))
      : [];
    if (sheetKeys.length === 0) {
      deps.warn('不是台账全量备份文件（没有 sheet_* 表数据）；模板请用「表格 → 导入数据库模板 JSON」');
      return;
    }
    const rowCount = sheetKeys.reduce((n, k) => n + Math.max(0, Array.isArray(parsed[k].content) ? parsed[k].content.length - 1 : 0), 0);
    const names = sheetKeys.map((k) => String(parsed[k].name || k));
    const preview = names.slice(0, 8).join('、') + (names.length > 8 ? ` 等 ${names.length} 张表` : '');
    if (!await confirmDialog(deps,
      `导入全量备份？\n\n备份包含 ${sheetKeys.length} 张表 / ${rowCount} 行数据：\n${preview}\n\n将整本覆盖当前聊天的台账（表结构、分组、读取/注入设置一并覆盖），不合并。\n备份不含记账历史、时光机快照与填表/推进/模板预设（全局设置）。\n导入前会自动下载当前台账备份。`,
      { okText: '导入并覆盖', danger: true })) return;
    // 覆盖前留底：先序列化确认真能导出（失败则二次确认），再触发下载。
    try {
      const current = deps.canonical.exportBook();
      JSON.stringify(current);
      downloadJsonFile(deps, `瑟瑟台账-导入前备份-${Date.now()}.json`, current);
    } catch (e) {
      if (!await confirmDialog(deps, `导入前自动备份当前台账失败：${e instanceof Error ? e.message : String(e)}\n仍要继续导入吗？`, { okText: '仍要导入', danger: true })) return;
    }
    const ok = await deps.canonical.importBook(parsed);
    if (ok) {
      deps.notify('全量备份已导入（世界书投影已刷新）');
      ctx.structureChanged();
    } else {
      deps.warn('导入失败：文件结构无效、台账未就绪，或当前聊天没有可写入的 AI 楼层');
    }
  });
  apiCard.querySelector('#slw-s-wb-refresh')!.addEventListener('click', async (e) => {
    const btn = e.target as HTMLButtonElement;
    btn.disabled = true;
    const ok = await deps.refreshWorldbook({ force: true });
    btn.disabled = false;
    ok ? deps.notify('世界书投影已刷新') : deps.warn('世界书刷新失败（无可用世界书或助手 API 不可用）');
  });

  // ── 请求结构（只读说明） ──
  const reqCard = el(doc, 'div', { class: 'slw-card' }, `
    <h3>请求结构 <span class="desc">填表 / 剧情推进均走统一状态栏的 1A 同构管线（破限/黑名单/标签剥离共享；API 来源各自设置）</span></h3>
    <table class="slw-tbl slw-stack">
      <tbody>
        <tr><th style="width:186px">破限头 / 尾部破限</th><td>共享主项目「设置 → API → 破限提示词」（台账不另开入口）；填表不挂反八股（输出 SQL），推进挂</td></tr>
        <tr><th>上下文标签剥离</th><td>共享主项目「设置 → API → 上下文标签剥离」（默认剥 <code>image</code>）；作用【当前正文】与【上轮正文】</td></tr>
        <tr><th>世界书条目黑名单</th><td>共享主项目两份名单（全局正则 ＋ 角色卡勾选）；两条请求同样受管</td></tr>
        <tr><th>台账投影族</th><td>填表恒剔除（内置：数据库/台账条目不进填表提示词）；推进保留（角色现行数据靠关键词命中）</td></tr>
        <tr><th>参考资料块</th><td>世界书 before/after ＋ 用户人设 / 角色卡描述 / 角色性格 / 场景 / 示例对话（1A 原生槽位，随角色卡自动带入；隐藏该块＝整组不发）</td></tr>
        <tr><th>扫描素材</th><td>填表＝本组待填楼层正文；推进＝上轮正文＋本轮输入（素材本身不进提示词）</td></tr>
      </tbody>
    </table>
    <div class="slw-row"><span class="slw-muted">破限 / 黑名单 / 标签剥离都在主项目设置里改，改完台账两条请求即时跟随。</span></div>`);
  pane.appendChild(reqCard);

  // ── 高级调度参数 ──
  const advCard = el(doc, 'div', { class: 'slw-card' }, `
    <h3>高级调度参数</h3>
    <div class="slw-row"><label>触达层数</label><input type="number" id="slw-s-threshold" value="${Number(s.autoUpdateThreshold) > 0 ? s.autoUpdateThreshold : 5}" min="1" style="width:64px"><span class="slw-muted">待记录楼须与最近 N 层 AI 回复相交才触发（全局，分组频率之外仅存的调度参数）</span></div>
    <div class="slw-row"><label>跳过楼层</label><input type="number" id="slw-s-skip" value="${Number(s.skipUpdateFloors) >= 0 ? s.skipUpdateFloors : 0}" min="0" style="width:64px"><span class="slw-muted">最近 N 层 AI 回复不参与自动填表</span></div>
    <div class="slw-row"><label>重试次数</label><input type="number" id="slw-s-retry" value="${resolveFillMaxAttempts(s)}" min="1" max="${FILL_MAX_ATTEMPTS_LIMIT}" style="width:64px"><span class="slw-muted">AI 输出未通过校验时最多尝试 N 次（含首次，默认 ${DEFAULT_FILL_MAX_ATTEMPTS}）；填表与建表向导共用，剧情推进的重试在各推进预设内单独设置</span></div>`);
  pane.appendChild(advCard);
  advCard.querySelector('#slw-s-threshold')!.addEventListener('change', async (e) => {
    const v = Math.max(1, Math.trunc(Number((e.target as HTMLInputElement).value) || 5));
    await deps.settings.update({ autoUpdateThreshold: v });
  });
  advCard.querySelector('#slw-s-skip')!.addEventListener('change', async (e) => {
    const v = Math.max(0, Math.trunc(Number((e.target as HTMLInputElement).value) || 0));
    await deps.settings.update({ skipUpdateFloors: v });
  });
  advCard.querySelector('#slw-s-retry')!.addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const v = resolveFillMaxAttempts({ fillMaxAttempts: Number(input.value) });
    input.value = String(v);
    await deps.settings.update({ fillMaxAttempts: v });
  });
  // 引擎诊断卡已并入「日志」页（诊断摘要）：同一信息不摆两处。
}
