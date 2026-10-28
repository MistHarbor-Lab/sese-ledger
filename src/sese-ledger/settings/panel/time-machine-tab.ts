// ===== 时光机标签页：楼层时间轴 · 逐格 diff 审核（勾选否决）· 该层快照 · 回滚/导出 =====
import { esc, el, downloadJsonFile, confirmDialog } from './shared';
import type { TabCtx } from './shell';
import { createBook } from '../../core/book';
import { groupDiffsByTable, type CellDiff, type TimelineFloor } from '../../core/time-machine';

function timeLabel(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function renderTimeMachineTab(ctx: TabCtx, pane: HTMLElement): void {
  const { deps, doc } = ctx;
  pane.innerHTML = '';
  const tm = deps.canonical.timemachine;

  const headCard = el(doc, 'div', { class: 'slw-card', style: 'margin-bottom:10px' }, `
    <h3>数据时光机 <span class="desc">回看任意楼层当时的完整数据、逐格审核 AI 填表是否合理，可否决/回滚</span></h3>
    <div class="slw-row"><button class="slw-btn sm" id="slw-tm-rescan">重新扫描</button><button class="slw-btn sm" id="slw-tm-fold-all">全部折叠进快照</button><span class="slw-muted" id="slw-tm-meta"></span></div>`);
  pane.appendChild(headCard);

  const wrap = el(doc, 'div', { class: 'slw-tm' });
  const left = el(doc, 'div', { class: 'slw-tm-left' }, '<h4>楼层时间轴</h4>');
  const right = el(doc, 'div', { class: 'slw-tm-right' });
  wrap.appendChild(left);
  wrap.appendChild(right);
  pane.appendChild(wrap);

  let timeline: TimelineFloor[] = [];
  let selected: TimelineFloor | null = null;
  let diffs: CellDiff[] = [];
  const selectedChecks = new Set<number>();
  /** 同一 revision 内按楼层缓存快照（选楼层不再反复 bake 整本）。 */
  const snapCache = new Map<number, any>();

  function renderMeta(): void {
    const meta = headCard.querySelector('#slw-tm-meta') as HTMLElement;
    meta.textContent = `数据源：台账记账条目（带楼层锚点）· 共 ${timeline.length} 个有数据的楼层${tm.foldBoundary() !== null ? ` · 结转点：楼${tm.foldBoundary()}（更早楼层仅可查看快照）` : ''}`;
  }

  function renderTimeline(): void {
    const fold = tm.foldBoundary();
    timeline = tm.timeline();
    // 左栏只报「改了多少处」——表名清单（sheet_* 一串）移出此列，改在右侧按表折叠看
    const items = timeline.map((f) => `
      <div class="slw-tm-floor ${selected?.aiFloor === f.aiFloor ? 'on' : ''}" data-floor="${f.aiFloor}" style="${f.folded ? 'opacity:.55' : ''}">
        <b>楼 ${f.aiFloor}</b> ${timeLabel(f.time)}<span class="slw-muted">${f.opCount} 处改动</span>
      </div>`).join('');
    // 全量折叠后时间轴为空但结转点仍在：分隔线照常显示（否则用户只看得到「暂无记账条目」）
    const foldDivider = fold !== null ? `<div class="slw-tm-floor" style="opacity:.5;cursor:default"><b>══ 已折叠（结转点：楼${fold}）══</b><span class="slw-muted">更早楼层仅可查看快照</span></div>` : '';
    left.innerHTML = '<h4>楼层时间轴</h4>' + (items + foldDivider || '<div class="slw-muted" style="padding:10px 12px">暂无记账条目</div>');
    left.querySelectorAll('[data-floor]').forEach((n) => {
      (n as HTMLElement).onclick = () => selectFloor(Number((n as HTMLElement).dataset.floor));
    });
    renderMeta();
  }

  /** 只切选中态，不重建整条时间轴（手机端每次点楼层都全量重绘会明显卡）。 */
  function syncSelectedClass(): void {
    left.querySelectorAll('[data-floor]').forEach((n) => {
      (n as HTMLElement).classList.toggle('on', selected?.aiFloor === Number((n as HTMLElement).dataset.floor));
    });
  }

  function selectFloor(floor: number): void {
    const f = timeline.find((x) => x.aiFloor === floor) || null;
    selected = f;
    selectedChecks.clear();
    diffs = f && !f.folded ? (tm.diffAtFloor(floor) || []) : [];
    syncSelectedClass();
    renderRight();
  }

  function renderRight(): void {
    right.innerHTML = '';
    if (!selected) {
      right.appendChild(el(doc, 'div', { class: 'slw-card' }, '<h3>填表审核</h3><div class="slw-muted">在左侧选择一个楼层查看该层改动。</div>'));
      return;
    }
    const groups = selected.folded ? [] : groupDiffsByTable(diffs);
    const auditCard = el(doc, 'div', { class: 'slw-card' }, `
      <h3 style="display:flex;align-items:center;flex-wrap:wrap">楼 ${selected.aiFloor} · 填表审核 <span class="desc">按表折叠；勾选后点「否决选中项」——否决以补偿记录实现，不改写历史</span>${groups.length > 0 ? '<button type="button" class="slw-btn sm" id="slw-tm-collapse-all" style="margin-left:auto">折叠全部</button>' : ''}</h3>
      ${selected.folded
        ? '<div class="slw-annot">该层已折叠进快照（结转点之前），仅可查看快照，不可逐格否决。</div>'
        : groups.map((g) => (
        `<details class="slw-tm-group" open>
          <summary>${esc(g.table)}<span class="slw-muted">（${g.items.length} 处改动）</span></summary>
          <table class="slw-tbl slw-tbl-fixed slw-responsive">
            <colgroup><col style="width:32px"><col style="width:170px"><col style="width:150px"><col></colgroup>
            <thead><tr><th></th><th>行</th><th>列</th><th>变化</th></tr></thead>
            <tbody>
              ${g.items.map(({ index: i, diff: d }) => `<tr>
                <td data-label="选择"><input type="checkbox" class="check" data-idx="${i}" ${selectedChecks.has(i) ? 'checked' : ''}></td>
                <td data-label="行">${d.kind === 'row_insert' ? '＋新行 ' : ''}row ${d.rowId}${d.rowLabel ? ' · ' + esc(d.rowLabel) : ''}</td>
                <td data-label="列">${esc(d.column)}</td>
                <td data-label="变化">${d.kind === 'row_insert'
                  ? `<span class="slw-diff-new">初始行</span>`
                  : d.kind === 'row_delete'
                    ? `<span class="slw-diff-old">删除整行</span>`
                    : `<span class="slw-diff-old">${esc(String(d.oldValue).slice(0, 40))}</span> → <span class="slw-diff-new">${esc(String(d.newValue).slice(0, 40))}</span>`}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </details>`)).join('') || '<div class="slw-muted">该层无逐格变化（结构变更或纯增删已折叠）。</div>'}
      <div class="slw-row" style="margin-top:10px">
        <button class="slw-btn" id="slw-tm-all">全选本层改动</button><button class="slw-btn" id="slw-tm-none">取消选择</button>
        <button class="slw-btn primary" id="slw-tm-veto-sel">否决选中项（${selectedChecks.size}）</button><button class="slw-btn danger" id="slw-tm-veto-all">否决本层全部改动</button>
      </div>
      <div class="slw-row">
        <button class="slw-btn danger" id="slw-tm-rollback-refill">回滚本层并重新填表</button><button class="slw-btn" id="slw-tm-rollback">仅回滚本层</button><button class="slw-btn" id="slw-tm-export">导出这一层数据</button>
        <span class="slw-muted">回滚 = 物理裁剪该层条目 + 调度回退；重填 = 用该层原文再跑一次填表</span>
      </div>`);
    right.appendChild(auditCard);

    // 一键折叠：默认全部展开；全部收起后按钮翻为「展开全部」，同一按钮可还原
    const groupEls = (): HTMLDetailsElement[] => Array.from(auditCard.querySelectorAll<HTMLDetailsElement>('details.slw-tm-group'));
    const collapseBtn = auditCard.querySelector('#slw-tm-collapse-all') as HTMLButtonElement | null;
    if (collapseBtn) {
      const syncCollapseLabel = (): void => {
        collapseBtn.textContent = groupEls().some((g) => g.open) ? '折叠全部' : '展开全部';
      };
      // 手点单个分组时也同步文案（toggle 不冒泡，走捕获阶段）
      auditCard.addEventListener('toggle', syncCollapseLabel, true);
      collapseBtn.addEventListener('click', () => {
        const anyOpen = groupEls().some((g) => g.open);
        groupEls().forEach((g) => { g.open = !anyOpen; });
        syncCollapseLabel();
      });
    }

    auditCard.querySelectorAll('[data-idx]').forEach((n) => {
      n.addEventListener('change', (e) => {
        const i = Number((e.target as HTMLElement).dataset.idx);
        if ((e.target as HTMLInputElement).checked) selectedChecks.add(i); else selectedChecks.delete(i);
        const btn = auditCard.querySelector('#slw-tm-veto-sel') as HTMLElement;
        if (btn) btn.textContent = `否决选中项（${selectedChecks.size}）`;
      });
    });
    // 全选/取消：只改勾选态与按钮计数（原先调 renderRight 会触发整页重建 + 全本 bake 重跑）
    const syncChecks = (): void => {
      auditCard.querySelectorAll('[data-idx]').forEach((n) => {
        (n as HTMLInputElement).checked = selectedChecks.has(Number((n as HTMLElement).dataset.idx));
      });
      const btn = auditCard.querySelector('#slw-tm-veto-sel') as HTMLElement;
      if (btn) btn.textContent = `否决选中项（${selectedChecks.size}）`;
    };
    auditCard.querySelector('#slw-tm-all')?.addEventListener('click', () => {
      diffs.forEach((_, i) => selectedChecks.add(i));
      syncChecks();
    });
    auditCard.querySelector('#slw-tm-none')?.addEventListener('click', () => {
      selectedChecks.clear();
      syncChecks();
    });
    auditCard.querySelector('#slw-tm-veto-sel')?.addEventListener('click', async () => {
      const picks = diffs.filter((_, i) => selectedChecks.has(i));
      if (picks.length === 0) { deps.warn('请先勾选要否决的改动'); return; }
      if (!await confirmDialog(deps, `否决 ${picks.length} 项改动？（以补偿记录实现，不改写历史）`, { okText: '否决选中项', danger: true })) return;
      const ok = tm.veto(selected!.aiFloor, picks);
      if (ok) { snapCache.clear(); deps.notify('已否决：补偿记录已落最新楼'); renderTimeline(); selectFloor(selected!.aiFloor); }
      else deps.warn('否决失败（详见控制台）');
    });
    auditCard.querySelector('#slw-tm-veto-all')?.addEventListener('click', async () => {
      if (diffs.length === 0) { deps.warn('该层无改动可否决'); return; }
      if (!await confirmDialog(deps, `否决本层全部 ${diffs.length} 处改动？`, { okText: '否决全部', danger: true })) return;
      const ok = tm.veto(selected!.aiFloor, diffs);
      if (ok) { snapCache.clear(); deps.notify('已否决本层全部改动'); renderTimeline(); selectFloor(selected!.aiFloor); }
      else deps.warn('否决失败');
    });
    auditCard.querySelector('#slw-tm-rollback')?.addEventListener('click', async (e) => {
      if (!await confirmDialog(deps, `回滚楼 ${selected!.aiFloor}？该层全部记账条目将被物理裁剪，数据回到上一层状态。`, { okText: '回滚本层', danger: true })) return;
      const btn = e.target as HTMLButtonElement;
      btn.disabled = true; btn.textContent = '回滚中…';
      const r = await tm.rollbackFloor(selected!.aiFloor, { refill: false });
      btn.disabled = false; btn.textContent = '仅回滚本层';
      if (r.ok) { snapCache.clear(); deps.notify(`已回滚（裁剪 ${r.pruned} 条记账条目）`); selected = null; renderTimeline(); renderRight(); }
      else deps.warn('回滚失败');
    });
    auditCard.querySelector('#slw-tm-rollback-refill')?.addEventListener('click', async (e) => {
      if (!await confirmDialog(deps, `回滚楼 ${selected!.aiFloor} 并用该层原文重新填表？`, { okText: '回滚并重填', danger: true })) return;
      const btn = e.target as HTMLButtonElement;
      btn.disabled = true; btn.textContent = '回滚并重填中…';
      const r = await tm.rollbackFloor(selected!.aiFloor, { refill: true });
      btn.disabled = false; btn.textContent = '回滚本层并重新填表';
      if (r.ok) { snapCache.clear(); deps.notify(`已回滚并重填（裁剪 ${r.pruned} 条 · 重填 ${r.refilled ?? 0} 条操作）`); selected = null; renderTimeline(); renderRight(); }
      else deps.warn('回滚失败');
    });
    auditCard.querySelector('#slw-tm-export')?.addEventListener('click', () => {
      const data = tm.exportFloor(selected!.aiFloor);
      if (!data) { deps.warn('导出失败'); return; }
      downloadJsonFile(deps, `瑟瑟台账-楼${selected!.aiFloor}-快照.json`, data);
    });

    // 该层数据快照（只读预览：默认显示第一张有数据的表，可切换）
    let snapWorkbook = snapCache.get(selected.aiFloor) || null;
    if (!snapWorkbook) {
      snapWorkbook = tm.exportFloor(selected.aiFloor);
      if (snapWorkbook) snapCache.set(selected.aiFloor, snapWorkbook);
    }
    if (snapWorkbook) {
      const snapBook = createBook(snapWorkbook);
      const tables = [...snapBook.tables.values()].filter((t) => t.rows.size > 0);
      const snapCard = el(doc, 'div', { class: 'slw-card' }, `
        <h3>该层数据快照 <span class="desc">只读预览 · 楼${selected.aiFloor} 结束时的完整表格内容</span></h3>
        ${tables.length > 1 ? `<div class="slw-row"><select id="slw-tm-snap-table" style="min-width:220px">${tables.map((t) => `<option>${esc(t.name)}</option>`).join('')}</select></div>` : ''}
        <div id="slw-tm-snap-body"></div>`);
      right.appendChild(snapCard);
      const renderSnap = (name: string) => {
        const table = tables.find((t) => t.name === name) || tables[0];
        const body = snapCard.querySelector('#slw-tm-snap-body') as HTMLElement;
        if (!table) { body.innerHTML = '<div class="slw-muted">（该层无数据）</div>'; return; }
        // 预建键集：原先每格都 diffs.some 全扫 = O(行×列×diff)；键集后每格 O(1)
        const cellKeys = new Set<string>();
        const rowLevelRows = new Set<number>();
        for (const d of diffs) {
          if (d.tableId !== table.tableId) continue;
          if (d.kind === 'cell') cellKeys.add(`${d.rowId}|${d.column}`);
          else rowLevelRows.add(d.rowId);
        }
        const rowIds = [...table.rows.keys()].sort((a, b) => a - b);
        body.innerHTML = `<div class="slw-tbl-wrap"><table class="slw-tbl">
          <thead><tr>${table.headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
          <tbody>${rowIds.map((id) => `<tr>${table.rows.get(id)!.map((c, ci) => {
            const changed = cellKeys.has(`${id}|${table.headers[ci]}`) || (rowLevelRows.has(id) && ci === 1);
            return `<td${changed ? ' class="slw-diff-new" style="border-radius:4px"' : ''}>${esc(String(c).slice(0, 60))}</td>`;
          }).join('')}</tr>`).join('')}</tbody>
        </table></div>`;
      };
      if (tables.length > 0) {
        renderSnap(tables[0].name);
        snapCard.querySelector('#slw-tm-snap-table')?.addEventListener('change', (e) => renderSnap((e.target as HTMLSelectElement).value));
      }
    }
  }

  headCard.querySelector('#slw-tm-rescan')!.addEventListener('click', () => {
    selected = null;
    snapCache.clear();
    renderTimeline();
    renderRight();
    deps.notify('时光机已重新扫描');
  });

  // 手动全部折叠：把增量流水一次折进快照（保留窗口＝0）。不可逆——折完这层逐格记录只剩快照视图。
  headCard.querySelector('#slw-tm-fold-all')!.addEventListener('click', async (e) => {
    const btn = e.target as HTMLButtonElement;
    const count = deps.runtime.__store()?.peekEntries().length ?? 0;
    if (count === 0) { deps.warn('当前没有可折叠的增量记录（流水已空）'); return; }
    if (!await confirmDialog(deps, `把全部 ${count} 条增量记录折叠进账本快照？\n\n· 快照更新为当前完整账本，增量流水清空\n· 时光机的逐层改动记录全部不可再审核 / 否决（只保留「已折叠」边界）\n· 表格数据不变，之后的新改动照常记录\n\n此操作不可撤销。`, { okText: '全部折叠', danger: true })) return;
    btn.disabled = true;
    try {
      const r = await deps.runtime.foldAll();
      if (!r.ok) { deps.warn('折叠失败：快照写入失败（外部存储可能暂时不可用），增量记录未清空'); return; }
      selected = null;
      selectedChecks.clear();
      diffs = [];
      snapCache.clear();
      renderTimeline();
      renderRight();
      deps.notify(r.folded > 0 ? `已折叠 ${r.folded} 条增量记录（快照已更新）` : '增量流水已清空');
    } finally {
      btn.disabled = false;
    }
  });

  renderTimeline();
  renderRight();
}
