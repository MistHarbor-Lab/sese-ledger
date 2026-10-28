// ===== 迁移标签页：向导四步（选模板→扫描→差异报告→应用）· 清理工具 =====
import { esc, el, confirmDialog, downloadJsonFile, type WorkbenchDeps } from './shared';
import type { TabCtx } from './shell';
import { groupsOf } from '../../core/book';
import { v2TemplateToWorkbook } from '../../core/blueprint';
import { collectExtraTables, mergeExtraTablesIntoV2Template } from '../../core/migrator';

/** C7：先确认再备份；备份失败要明确提示并二次确认（不再出现「已自动备份」的假提示）。 */
async function backupOrConfirm(deps: WorkbenchDeps, label: string): Promise<boolean> {
  try {
    const data = deps.canonical.exportBook();
    JSON.stringify(data); // 提前暴露序列化失败（循环引用/内存），不要静默当备份成功
    downloadJsonFile(deps, `${label}-${Date.now()}.json`, data);
    return true;
  } catch (e) {
    deps.warn(`自动备份失败：${e instanceof Error ? e.message : String(e)}`);
    return await confirmDialog(deps, '自动备份失败。仍要继续吗？建议先手动导出备份。', { okText: '仍要继续', danger: true });
  }
}

interface MigrateUiState { step: number; report: any; aligned: any; alignReport: any }

export function renderMigrateTab(ctx: TabCtx, pane: HTMLElement): void {
  const { deps, doc } = ctx;
  const s = deps.settings.get();
  const state: MigrateUiState = { step: 1, report: null, aligned: null, alignReport: null };
  const presetNames = deps.settings.listTemplatePresetNames().filter((n) => n !== deps.standardPresetName);
  const currentLabel = String(deps.canonical?.templateBinding?.name?.() || '') || s.defaultTemplatePreset || deps.standardPresetName;
  const stdInfo = `${esc(deps.standardPresetName)} · ${deps.standardTemplateV2.tables.length} 表 / ${deps.standardTemplateV2.groups.length} 分组`;
  pane.innerHTML = '';

  const card = el(doc, 'div', { class: 'slw-card' }, `
    <h3>存量迁移（原数据库 → 台账） <span class="desc">按当前选择的模板迁移；先看模板与差异，再应用</span></h3>
    <div class="slw-steps" id="slw-m-steps">
      <div class="slw-step" data-step="1"><b>①</b>选择模板</div>
      <div class="slw-step" data-step="2"><b>②</b>扫描数据库</div>
      <div class="slw-step" data-step="3"><b>③</b>差异报告</div>
      <div class="slw-step" data-step="4"><b>④</b>应用迁移</div>
    </div>
    <div class="slw-row"><label>迁移模板</label>
      <select id="slw-m-tpl" style="min-width:300px">
        <option value="${esc(deps.standardPresetName)}" ${currentLabel === deps.standardPresetName ? 'selected' : ''}>内置 · ${stdInfo}</option>
        ${presetNames.map((n) => `<option value="${esc(n)}" ${n === currentLabel ? 'selected' : ''}>${esc(n)}（自定义）</option>`).join('')}
      </select>
      <span class="slw-muted">扫描结果显示的就是这份模板与数据库数据的差异</span></div>
    <div class="slw-row"><button class="slw-btn" id="slw-m-scan">重新扫描</button><span class="slw-muted" id="slw-m-scan-info">尚未扫描</span></div>
    <h3 style="margin-top:14px">差异报告</h3>
    <div class="slw-report" id="slw-m-report" style="display:none"></div>
    <div class="slw-row" style="margin-top:10px">
      <button class="slw-btn primary" id="slw-m-apply" disabled>应用迁移（③ → ④）</button>
      <span class="slw-muted">应用前自动全量备份导出；迁移建立台账外部存储，保留楼层回退语义；并<b>自动清理本卡世界书里的数据库系残留条目</b>（已清过则不重复动）</span>
    </div>`);
  pane.appendChild(card);

  // ── 清理工具 ──
  const cleanCard = el(doc, 'div', { class: 'slw-card' }, `
    <h3>清理工具</h3>
    <div class="slw-row">
      <button class="slw-btn danger" id="slw-m-del-db-wb">删除本卡世界书的数据库条目</button>
      <span class="slw-muted">只扫<b>当前角色卡对应世界书</b>（不碰其他角色卡的世界书），删其中的数据库系条目：TavernDB-ACU-* 全族（真数据库注入条目 + 台账换词根前的旧投影/包裹）＋整表导出裸名族（entryName 及 -表头 / -包裹-上 / -包裹-下，插件不带前缀）＋总结条目/小总结条目/重要人物条目；不碰消息与其他条目</span>
    </div>
    <div class="slw-row">
      <button class="slw-btn danger" id="slw-m-clean-msg">清理数据库消息残留</button>
      <span class="slw-muted">清消息上的 TavernDB_ACU_* 帧字段；世界书条目用上一行</span>
    </div>
    <div class="slw-row">
      <button class="slw-btn danger" id="slw-m-clear-chat">清除当前聊天数据</button>
      <span class="slw-muted">清空本聊天的台账数据：删两个外部存储文件（sl_&lt;id&gt;_book / sl_&lt;id&gt;_entries）＋删台账世界书投影＋按当前模板重建空账本；账本历史与时光机一并清空（执行前自动导出备份），不动消息正文、其他世界书条目与推进历史</span>
    </div>
    <div class="slw-row">
      <button class="slw-btn danger" id="slw-m-del-proj">删除台账的全部世界书投影</button>
      <span class="slw-muted">只删台账受管条目（SeseLedger-* 及包裹条目），不碰其他条目；删除后可随时点「刷新当前投影」重建</span>
    </div>
    <div class="slw-row"><button class="slw-btn" id="slw-m-wb-refresh">刷新当前投影</button><span class="slw-muted">按当前账本重建全部受管世界书条目</span></div>`);
  pane.appendChild(cleanCard);

  // ── 台账恢复（A9 身份丢失 / 文件缺失 / 锚点漂移）──
  const recoveryCard = el(doc, 'div', { class: 'slw-card' }, `
    <h3>台账恢复 <span class="desc">聊天里找不到旧台账时，从链接文件/全局索引找回；也可处理锚点漂移</span></h3>
    <div class="slw-annot" id="slw-r-status">读取状态中…</div>
    <div class="slw-row">
      <button class="slw-btn" id="slw-r-scan">扫描可恢复台账</button>
      <button class="slw-btn" id="slw-r-refresh">刷新状态</button>
      <button class="slw-btn danger" id="slw-r-fresh">新建空账本（保留旧文件）</button>
    </div>
    <div class="slw-row"><label>手动 storageId</label>
      <input type="text" id="slw-r-sid" placeholder="从 sl_index.json 或日志页复制完整 id" style="min-width:300px">
      <button class="slw-btn" id="slw-r-sid-rebind">按 id 重绑</button>
      <span class="slw-muted">索引/链接都找不到时的最后手段；重绑前会自动备份当前台账</span></div>
    <div class="slw-report" id="slw-r-list" style="display:none"></div>
    <h3 style="margin-top:14px">锚点漂移自救</h3>
    <div class="slw-row">
      <button class="slw-btn" id="slw-r-orphan-check">检查不可见流水</button>
      <button class="slw-btn danger" id="slw-r-orphan-apply">按楼层序号重绑</button>
      <span class="slw-muted">仅当流水因消息标识变化而全部失配时使用；重绑前会先导出备份，可能把已删楼层的旧内容绑到同序号楼层</span>
    </div>`);
  pane.appendChild(recoveryCard);

  const recoveryStatusEl = recoveryCard.querySelector('#slw-r-status') as HTMLElement;
  const recoveryListEl = recoveryCard.querySelector('#slw-r-list') as HTMLElement;

  function refreshRecoveryCard(): void {
    const api = deps.canonical?.recovery;
    if (!api?.status) { recoveryStatusEl.textContent = '恢复接口不可用（请更新台账脚本）'; return; }
    const st = api.status();
    const sid = st?.storageId ? `${String(st.storageId).slice(0, 12)}…` : '未建账';
    const parts = [`当前 storageId：${sid}`];
    if (st?.needed) parts.push(`待恢复：${st.reason || '需要选择旧账本'}`);
    else parts.push('状态：正常');
    if (st?.anchorOrphan) parts.push(`锚点异常：${st.orphanEntries}/${st.totalEntries} 条全部不可见`);
    else if (st?.orphanEntries > 0) parts.push(`有 ${st.orphanEntries} 条失配流水（多数是已删楼层，正常待折叠）`);
    recoveryStatusEl.textContent = parts.join(' · ');
  }

  function fmtTime(ts: unknown): string {
    const n = Number(ts || 0);
    if (!n) return '—';
    try { return new Date(n).toLocaleString(); } catch (_e) { return '—'; }
  }

  function renderRecoveryList(candidates: any[]): void {
    recoveryListEl.innerHTML = '';
    if (!Array.isArray(candidates) || candidates.length === 0) {
      recoveryListEl.style.display = 'block';
      recoveryListEl.textContent = '没有发现可恢复的旧账本候选。若确认数据曾经存在，请先导出 sl_index.json 并反馈给开发者。';
      return;
    }
    recoveryListEl.style.display = 'block';
    const rows = candidates.map((c) => {
      const sid = String(c.storageId || '');
      const fileState = c.hasBook === undefined && c.hasEntries === undefined
        ? ''
        : ` · book:${c.hasBook ? '有' : '无'} entries:${c.hasEntries ? '有' : '无'}`;
      return `
        <div class="slw-row" data-sid="${esc(sid)}" style="align-items:flex-start;gap:6px;flex-wrap:wrap">
          <b>${esc(sid.slice(0, 12))}…</b>
          <span class="slw-muted">${esc(c.source || '')}${c.chatKey ? ` · ${esc(c.chatKey)}` : ''}${fileState}</span>
          <span class="slw-muted">创建 ${esc(fmtTime(c.createdAt))} · 最后 ${esc(fmtTime(c.lastSeenAt))}</span>
          <button class="slw-btn" data-act="inspect">查看</button>
          <button class="slw-btn primary" data-act="rebind">重绑</button>
          <button class="slw-btn" data-act="download">下载</button>
          <span class="slw-muted" data-info></span>
        </div>`;
    });
    recoveryListEl.innerHTML = rows.join('');
  }

  async function scanRecovery(): Promise<void> {
    const api = deps.canonical?.recovery;
    if (!api?.candidates) { deps.warn('恢复接口不可用（请更新台账脚本）'); return; }
    recoveryListEl.style.display = 'block';
    recoveryListEl.textContent = '扫描中…';
    try {
      const candidates = await api.candidates();
      refreshRecoveryCard();
      renderRecoveryList(candidates);
    } catch (e) {
      recoveryListEl.textContent = `扫描失败：${e instanceof Error ? e.message : String(e)}`;
    }
  }

  recoveryCard.querySelector('#slw-r-refresh')!.addEventListener('click', () => refreshRecoveryCard());
  recoveryCard.querySelector('#slw-r-scan')!.addEventListener('click', async (e) => {
    const btn = e.target as HTMLButtonElement;
    btn.disabled = true;
    try { await scanRecovery(); } finally { btn.disabled = false; }
  });
  recoveryCard.querySelector('#slw-r-sid-rebind')!.addEventListener('click', async (e) => {
    const api = deps.canonical?.recovery;
    if (!api?.rebind) { deps.warn('恢复接口不可用（请更新台账脚本）'); return; }
    const input = recoveryCard.querySelector('#slw-r-sid') as HTMLInputElement;
    const sid = String(input.value || '').trim();
    if (!sid) { deps.warn('请先填写完整 storageId'); return; }
    if (!await confirmDialog(deps, `把当前聊天重绑到 storageId ${sid.slice(0, 16)}…？\n\n· 会载入该 id 的账本并写入当前聊天身份\n· 旧文件不会删除\n· 若不确定该 id 是否属于本聊天，建议先用「查看」核对行列数`, { okText: '重绑并载入' })) return;
    if (!await backupOrConfirm(deps, '瑟瑟台账-重绑前备份')) return;
    const btn = e.target as HTMLButtonElement;
    btn.disabled = true;
    try {
      const r = await api.rebind(sid);
      if (!r?.ok) { deps.warn(`重绑失败：${r?.error || '未知原因'}`); return; }
      deps.notify(r.metaWritten ? '已重绑并载入指定账本' : '已载入指定账本，但身份写入未确认（链接/索引仍可找回）');
      const st = api.status();
      if (st?.anchorOrphan) deps.warn('已载入指定账本，但流水与当前楼层锚点不匹配；可在本页用「按楼层序号重绑」尝试恢复');
      await deps.refreshWorldbook({ force: true });
      ctx.refresh('tables');
      refreshRecoveryCard();
    } catch (err) {
      deps.warn(`重绑失败：${err instanceof Error ? err.message : String(err)}`);
    } finally { btn.disabled = false; }
  });
  recoveryCard.querySelector('#slw-r-fresh')!.addEventListener('click', async (e) => {
    const api = deps.canonical?.recovery;
    if (!api?.startFresh) { deps.warn('恢复接口不可用（请更新台账脚本）'); return; }
    if (!await confirmDialog(deps, '新建空账本？\n· 会给当前聊天生成一个全新的 storageId 并写入空模板\n· 当前聊天原来的账本身份会被替换（旧文件不删，之后仍可在本页扫描找回）\n· 请仅在旧账本无法恢复、或你确定要从头开始时使用\n\n确认继续？', { okText: '新建空账本', danger: true })) return;
    const btn = e.target as HTMLButtonElement;
    btn.disabled = true;
    try {
      const r = await api.startFresh();
      if (!r?.ok) { deps.warn(`新建空账本失败：${r?.error || '未知原因'}`); return; }
      deps.notify('已新建空账本（旧文件保留）');
      await deps.refreshWorldbook({ force: true });
      ctx.refresh('tables');
      refreshRecoveryCard();
      await scanRecovery();
    } finally { btn.disabled = false; }
  });

  recoveryListEl.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement;
    const act = target.getAttribute('data-act');
    if (!act) return;
    const row = target.closest('[data-sid]') as HTMLElement | null;
    const sid = row?.getAttribute('data-sid') || '';
    const api = deps.canonical?.recovery;
    const info = row?.querySelector('[data-info]') as HTMLElement | null;
    if (!sid || !api) return;
    if (act === 'inspect') {
      if (info) info.textContent = '读取中…';
      try {
        const r = await api.inspect(sid);
        if (!r) { if (info) info.textContent = '读取失败'; return; }
        if (!r.ok) { if (info) info.textContent = `损坏：${r.error || '未知'}`; return; }
        if (info) info.textContent = `${r.tableCount} 表 / ${r.rowCount} 行 / ${r.entryCount} 条流水 / seq ${r.seq}`;
      } catch (err) {
        if (info) info.textContent = `读取失败：${err instanceof Error ? err.message : String(err)}`;
      }
      return;
    }
    if (act === 'download') {
      try {
        const data = await api.export(sid);
        if (!data) { deps.warn('该候选没有可导出的账本内容'); return; }
        downloadJsonFile(deps, `瑟瑟台账-恢复-${sid.slice(0, 8)}.json`, data);
        deps.notify('已导出候选账本（可用于「设置 → 导入全量备份」）');
      } catch (err) {
        deps.warn(`导出失败：${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
    if (act === 'rebind') {
      if (!await confirmDialog(deps, `把当前聊天重绑到旧账本 ${sid.slice(0, 12)}…？\n\n· 会写入当前聊天的身份指针并立即载入该账本\n· 旧文件不会删除\n· 建议先「下载」一份备份；重绑后请核对数据是否为目标聊天`, { okText: '重绑并载入' })) return;
      if (!await backupOrConfirm(deps, '瑟瑟台账-重绑前备份')) return;
      target.setAttribute('disabled', '');
      try {
        const r = await api.rebind(sid);
        if (!r?.ok) { deps.warn(`重绑失败：${r?.error || '未知原因'}`); return; }
        deps.notify(r.metaWritten ? '已重绑并载入旧账本' : '已载入旧账本，但身份写入未确认（链接/索引仍可找回，建议稍后重试）');
        const st = api.status();
        if (st?.anchorOrphan) deps.warn('已载入候选账本，但流水与当前楼层锚点不匹配（可能绑到了另一聊天的账本）；可在本页用「按楼层序号重绑」尝试恢复');
        await deps.refreshWorldbook({ force: true });
        ctx.refresh('tables');
        refreshRecoveryCard();
        await scanRecovery();
      } catch (err) {
        deps.warn(`重绑失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        target.removeAttribute('disabled');
      }
    }
  });

  recoveryCard.querySelector('#slw-r-orphan-check')!.addEventListener('click', async (e) => {
    const api = deps.canonical?.recovery;
    if (!api?.replayInvisible) { deps.warn('恢复接口不可用（请更新台账脚本）'); return; }
    const btn = e.target as HTMLButtonElement;
    btn.disabled = true;
    try {
      const r = await api.replayInvisible({ dryRun: true });
      if (!r?.ok) { deps.warn(`检查失败：${r?.error || '未知原因'}`); return; }
      deps.notify(r.entries > 0 ? `可重绑 ${r.entries} 条失配流水（共 ${r.total} 条）` : '没有可重绑的失配流水');
    } finally { btn.disabled = false; }
  });
  recoveryCard.querySelector('#slw-r-orphan-apply')!.addEventListener('click', async (e) => {
    const api = deps.canonical?.recovery;
    if (!api?.replayInvisible) { deps.warn('恢复接口不可用（请更新台账脚本）'); return; }
    if (!await confirmDialog(deps, '按 aiFloor 序号重绑全部失配流水？\n\n· 只处理锚点失配、且序号仍落在当前楼层内的条目\n· 会先下载当前台账备份\n· 若楼层曾被删除/重排，可能把旧内容绑到同序号的另一层——请先确认备份可回滚', { okText: '备份并重绑', danger: true })) return;
    if (!await backupOrConfirm(deps, '瑟瑟台账-锚点重绑前备份')) return;
    const btn = e.target as HTMLButtonElement;
    btn.disabled = true;
    try {
      const r = await api.replayInvisible({});
      if (!r?.ok) { deps.warn(`重绑失败：${r?.error || '未知原因'}`); return; }
      deps.notify(`已重绑 ${r.entries} 条流水（共 ${r.total} 条）`);
      await deps.refreshWorldbook({ force: true });
      ctx.refresh('tables');
      refreshRecoveryCard();
    } finally { btn.disabled = false; }
  });
  refreshRecoveryCard();

  cleanCard.querySelector('#slw-m-wb-refresh')!.addEventListener('click', async (e) => {
    const btn = e.target as HTMLButtonElement;
    btn.disabled = true;
    const ok = await deps.refreshWorldbook({ force: true });
    btn.disabled = false;
    ok ? deps.notify('世界书投影已刷新') : deps.warn('世界书刷新失败（无可用世界书或助手 API 不可用）');
  });
  cleanCard.querySelector('#slw-m-del-db-wb')!.addEventListener('click', async (e) => {
    const btn = e.target as HTMLButtonElement;
    const extra = deps.realDbPresent ? '（真数据库在场：这些条目就是真数据库的注入内容）' : '';
    // 裸名族预览：把「会按名删除」的例外名点给用户看（模板 entryName 派生，非前缀匹配）
    let bareLine = '';
    try {
      const names: string[] = deps.canonical.databaseBareNames?.() || [];
      if (names.length) bareLine = `\n含整表导出裸名族 ${names.length} 个名（${names.slice(0, 8).join('、')}${names.length > 8 ? ' 等' : ''}，及各自的 -表头 / -包裹-上 / -包裹-下）`;
    } catch (_e) { /* 预览失败按纯前缀口径提示 */ }
    if (!await confirmDialog(deps, `删除当前角色卡对应世界书里的数据库系条目？${extra}\n（只扫本卡的这一本世界书，其他角色卡的世界书不动）\n· TavernDB-ACU-* 全族（含 ACU-[code]- 隔离前缀形态）\n· 总结条目 / 小总结条目 / 重要人物条目${bareLine}\n不碰消息与其他条目。`, { okText: '删除这些条目', danger: true })) return;
    btn.disabled = true;
    try {
      const n = await deps.canonical.deleteDatabaseWorldbooks();
      if (n === null) deps.warn('解析不到当前角色卡对应的世界书（无卡上下文或助手 API 不可用），未执行删除');
      else deps.notify(n > 0 ? `已删除本卡世界书里 ${n} 条数据库系条目（点「刷新当前投影」可按当前账本重建台账投影）` : '本卡世界书里未发现数据库系条目');
    } finally {
      btn.disabled = false;
    }
  });
  cleanCard.querySelector('#slw-m-clear-chat')!.addEventListener('click', async (e) => {
    const btn = e.target as HTMLButtonElement;
    // 先确认、再备份：点取消不再白下载备份文件；备份失败会二次确认（C7）。
    if (!await confirmDialog(deps, '清除当前聊天数据？\n· 删本聊天两个台账外部存储文件——账本历史、时光机与调度一并清空（不可恢复）\n· 删台账世界书投影（SeseLedger-*，可重建）\n· 按当前模板重建空账本（表格结构保留、数据行为空）\n不动消息正文、其他世界书条目与推进历史。\n\n确认后会先自动下载全量备份，再执行清除。', { okText: '清除', danger: true })) return;
    if (!await backupOrConfirm(deps, '瑟瑟台账-清除前备份')) return;
    btn.disabled = true;
    try {
      const r = await deps.canonical.clearCurrentChatData();
      if (!r.reset) deps.notify(`本聊天尚未建账：无台账存储文件可删${r.projections ? `（已清 ${r.projections} 条台账投影）` : ''}`);
      else deps.notify(`当前聊天数据已清除：删 ${r.files} 个存储文件 · ${r.projections} 条台账投影 · ${r.seeded ? '已按当前模板重建空账本' : '空账本重建失败（写不入账，稍后重试）'}`);
    } finally {
      btn.disabled = false;
    }
  });
  cleanCard.querySelector('#slw-m-clean-msg')!.addEventListener('click', async (e) => {
    const btn = e.target as HTMLButtonElement;
    if (!await confirmDialog(deps, '清除消息上的全部 TavernDB_ACU_* 数据库帧字段（建议先在设置页导出全量备份）？', { okText: '清除帧字段', danger: true })) return;
    btn.disabled = true;
    try {
      const n = await deps.canonical.cleanupDbMessageFields();
      deps.notify(`清理完成：${n} 楼消息的数据库帧字段已移除`);
    } finally {
      btn.disabled = false;
    }
  });
  cleanCard.querySelector('#slw-m-del-proj')!.addEventListener('click', async () => {
    if (!await confirmDialog(deps, '删除台账的全部世界书投影（SeseLedger-* 及包裹条目）？不碰其他条目，可随时重建。', { okText: '删除投影', danger: true })) return;
    const n = await deps.canonical.deleteAllProjections();
    deps.notify(`已删除 ${n} 条受管世界书条目（点「刷新当前投影」可重建）`);
  });

  function setStep(step: number): void {
    state.step = step;
    card.querySelectorAll('.slw-step').forEach((n) => {
      const v = Number((n as HTMLElement).dataset.step);
      n.classList.toggle('done', v < step);
      n.classList.toggle('cur', v === step);
    });
  }
  setStep(1);

  async function selectedTemplateWorkbook(): Promise<{ workbook: any; name: string } | null> {
    const name = (card.querySelector('#slw-m-tpl') as HTMLSelectElement).value;
    if (name === deps.standardPresetName) return { workbook: deps.canonical.standardTemplateWorkbook, name };
    // 记忆化解析（G3）：与表格页/收敛共用同一份结果。
    const normalized = deps.settings.loadTemplatePresetNormalized(name);
    if (!normalized?.ok || !normalized.workbook) return null;
    return { workbook: normalized.workbook, name };
  }

  card.querySelector('#slw-m-scan')!.addEventListener('click', async (e) => {
    const btn = e.target as HTMLButtonElement;
    btn.disabled = true; btn.textContent = '扫描中…';
    try {
      const tpl = await selectedTemplateWorkbook();
      if (!tpl) { deps.warn('模板读取失败'); return; }
      state.report = await deps.canonical.migrate.fromDb();
      setStep(3);
      const info = card.querySelector('#slw-m-scan-info') as HTMLElement;
      // 先给进度：后续若弹出「模板外表」确认框，用户也能看出扫描已完成、不是卡死。
      info.textContent = `发现数据库帧 ${state.report?.frameCount ?? 0} 楼（含 checkpoint ${state.report?.checkpointCount ?? 0} 次）· 正在生成差异报告…`;
      if (!state.report?.ok && (state.report?.frameCount ?? 0) === 0) {
        info.textContent = state.report?.warnings?.[0] || '扫描未发现可迁移内容';
        (card.querySelector('#slw-m-report') as HTMLElement).style.display = 'none';
        (card.querySelector('#slw-m-report') as HTMLElement).textContent = '';
        (card.querySelector('#slw-m-apply') as HTMLButtonElement).disabled = true;
        return;
      }
      info.textContent = `发现数据库帧 ${state.report.frameCount} 楼（含 checkpoint ${state.report.checkpointCount} 次）· 推进历史楼 ${(state.report.plotFloors || []).length}（应用时平移 qrf_plot → sl_plot）`;
      // 模板外数据表：由用户在扫描后选「并入一份新模板（该卡专用，数据保留）」或「丢弃」
      let tplWorkbook = tpl.workbook;
      let tplName = tpl.name;
      const extras = collectExtraTables((state.report as any).snapshot || {}, tplWorkbook);
      if (extras.length > 0) {
        const names = extras.map((e) => e.name);
        const keep = await confirmDialog(
          deps,
          `发现 ${extras.length} 张模板外的数据表：${names.join('、')}。\n\n`
          + `「并入新模板」= 另存一份**新模板**并改绑本角色卡（其他角色卡不受影响；这些表的数据保留）\n`
          + `「丢弃这些表」= 这些表的数据不导入。`,
          { okText: '并入新模板（保留数据）', cancelText: '丢弃这些表' },
        );
        if (keep) {
          const boundName = String(deps.canonical?.templateBinding?.name?.() || '') || deps.standardPresetName;
          const normalizedBase = deps.settings.loadTemplatePresetNormalized(boundName);
          const baseTemplateV2 = normalizedBase?.ok && normalizedBase.v2
            ? normalizedBase.v2
            : (deps.settings.loadTemplatePresetNormalized(tplName)?.v2 ?? null) || deps.canonical.standardTemplateV2;
          const mergedName = `${tplName}·并入 ${new Date().toISOString().slice(0, 10)}`;
          const mergedResult = mergeExtraTablesIntoV2Template(baseTemplateV2 as any, (state.report as any).snapshot || {}, extras, mergedName);
          if (!mergedResult) {
            deps.warn('并入失败（迁移产物结构无法转换），已按「丢弃」继续');
          } else {
            await deps.settings.saveTemplatePreset(mergedName, JSON.stringify(mergedResult.template));
            const bindResult = deps.canonical.templateBinding?.set?.(mergedName);
            if (bindResult && bindResult.ok === false) deps.warn(bindResult.message);
            tplWorkbook = v2TemplateToWorkbook(mergedResult.template);
            tplName = mergedName;
            deps.notify(`已并入新模板「${mergedName}」（${mergedResult.merged.join('、')}）并改绑本角色卡`);
          }
        }
      }
      // 按（可能已并入的）模板对齐 → 差异报告
      const alignment = deps.canonical.migrate.alignToTemplate(state.report, tplWorkbook, tplName);
      state.aligned = alignment?.aligned || null;
      state.alignReport = alignment?.report || null;
      const reportBox = card.querySelector('#slw-m-report') as HTMLElement;
      reportBox.style.display = 'block';
      const lines: string[] = [];
      if (state.alignReport) lines.push(state.alignReport.text);
      lines.push('');
      lines.push(`转译条目：${(state.report.entries || []).length} · 数据行：${state.report.rowCount ?? 0}`);
      lines.push(state.report.verified === null || state.report.verified === undefined ? '比对：原数据库不在场，跳过' : `比对：${state.report.verified ? '逐格一致 ✅' : '不一致 ❌'}`);
      for (const m of (state.report.mismatches || []).slice(0, 5)) lines.push(`· ${m}`);
      for (const w of (state.report.warnings || [])) lines.push(`⚠ ${w}`);
      if (!state.report.ok) lines.push('', '❌ 迁移仍有硬失败，「应用迁移」已禁用（请把上面的报错反馈给开发者）');
      reportBox.textContent = lines.join('\n');
      (card.querySelector('#slw-m-apply') as HTMLButtonElement).disabled = !state.report.ok;
    } catch (err) {
      // 扫描链路任何异常都要落到界面上（无 catch 时只会停在 ③、控制台报错，用户看到的就是「无反应」）
      const msg = err instanceof Error ? err.message : String(err);
      deps.warn(`迁移扫描失败：${msg}`);
      const info = card.querySelector('#slw-m-scan-info') as HTMLElement | null;
      if (info) info.textContent = `扫描失败：${msg}`;
      const reportBox = card.querySelector('#slw-m-report') as HTMLElement | null;
      if (reportBox) {
        reportBox.style.display = 'block';
        reportBox.textContent = `扫描失败：${msg}\n（详细堆栈见控制台；可重试或反馈此文案）`;
      }
      const apply = card.querySelector('#slw-m-apply') as HTMLButtonElement | null;
      if (apply) apply.disabled = true;
    } finally {
      btn.disabled = false; btn.textContent = '重新扫描';
    }
  });

  card.querySelector('#slw-m-apply')!.addEventListener('click', async (e) => {
    const btn = e.target as HTMLButtonElement;
    if (!state.report?.ok) return;
    // 先确认、再备份（C7）：取消不再白下载；备份失败二次确认。
    if (!await confirmDialog(deps, '应用迁移？台账外部存储将建立（保留楼层回退语义），推进历史平移 qrf_plot → sl_plot；并自动清理本卡世界书里的数据库系残留条目。\n\n确认后会先自动下载全量备份，再应用迁移。', { okText: '应用迁移' })) return;
    if (!await backupOrConfirm(deps, '瑟瑟台账-迁移前备份')) return;
    btn.disabled = true; btn.textContent = '应用中…';
    try {
      const ok = await deps.canonical.migrate.apply(state.report, state.aligned);
      setStep(4);
      if (ok) {
        // 清理结果由后端 apply() 汇总（含「已清过＝空转」与「世界书解析不到」两种口径），此处只报迁移本体
        deps.notify('迁移完成：台账外部存储已建立');
        // 迁移后显示分组数
        const book = deps.runtime.book();
        if (book) (card.querySelector('#slw-m-scan-info') as HTMLElement).textContent += ` · 已按模板建立（${groupsOf(book).length} 分组）`;
      } else deps.warn('迁移落盘失败（详见控制台）');
    } finally {
      btn.disabled = false; btn.textContent = '应用迁移（③ → ④）';
    }
  });
}
