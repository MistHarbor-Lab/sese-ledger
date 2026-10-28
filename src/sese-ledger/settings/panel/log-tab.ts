// ===== 日志标签页：本次会话的警告 / 错误（实时刷新）+ 引擎诊断摘要（设置页那道卡已并入） =====
//
// 数据源＝core/ledger-log.ts 的内存环形缓冲（刷新 / 重载即空，不落盘）。
// 页面只做三件事：渲染 + 筛选（列表 / 复制 / 导出共用 filterLogEntries 一份口径）+ 动作（复制 / 导出 JSON / 清空）。
// 渲染一律 esc / textContent（沿用「禁向宿主注入 HTML」的既有教训）。
import { esc, el, downloadJsonFile, workbenchDoc, LEDGER_VERSION_LABEL, type WorkbenchDeps } from './shared';
import {
  filterLogEntries, formatLogTime, ledgerLogExport, ledgerLogText, LEDGER_LOG_LIMIT, LEDGER_LOG_RAW_LIMIT, LEDGER_LOG_SOURCES,
  type LedgerLogEntry, type LedgerLogFilterLevel,
} from '../../core/ledger-log';
import type { TabCtx } from './shell';

/** 日志实时重渲节流（G9）：80ms 在填表高峰接近 12 次/秒整表重建；250ms 仍算实时，手机不卡。 */
const LOG_RENDER_THROTTLE_MS = 250;

const LEVEL_LABEL: Record<string, string> = { error: '错误', warn: '警告', info: '信息' };
const LEVEL_TAG: Record<string, string> = { error: 'danger', warn: 'warn', info: 'info' };

/** 复制纯文本：剪贴板 API 优先，宿主不给权限时回退宿主文档的 execCommand('copy')。 */
async function copyPlainText(deps: WorkbenchDeps, text: string): Promise<boolean> {
  try {
    const clipboard = (deps.window as any)?.navigator?.clipboard;
    if (clipboard?.writeText) { await clipboard.writeText(text); return true; }
  } catch (_e) { /* 回退 execCommand */ }
  try {
    const doc = workbenchDoc(deps);
    const area = doc.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.left = '-9999px';
    doc.body.appendChild(area);
    area.focus();
    area.setSelectionRange(0, text.length);
    area.select();
    const ok = (doc as any).execCommand?.('copy') === true;
    area.remove();
    return ok;
  } catch (_e) {
    return false;
  }
}

/** 一行日志（含可选详情 / 原始 AI 输出展开；原始输出带一键复制）。 */
function logRowHtml(entry: LedgerLogEntry, open: boolean): string {
  const detail = String(entry.detail || '');
  const raw = String(entry.raw || '');
  const expandable = !!(detail || raw);
  const merged = entry.count > 1 ? `<span class="slw-log-count">×${entry.count}（最近 ${esc(formatLogTime(entry.lastAt))}）</span>` : '';
  // 模块层按 LEDGER_LOG_RAW_LIMIT 截断（截断后长度＝上限+1），这里据此提示
  const rawNote = raw.length > LEDGER_LOG_RAW_LIMIT ? `（超长已截断至 ${LEDGER_LOG_RAW_LIMIT} 字）` : '';
  // 未读错误：rail 徽章计数的行内反馈；已读后整行降噪 + 标记（警告 / 信息不参与）
  const unread = entry.level === 'error' && entry.unread === true;
  const isRead = entry.level === 'error' && entry.unread === false;
  const rowClass = `slw-logrow slw-lv-${entry.level}${expandable ? ' slw-logrow-expandable' : ''}${isRead ? ' is-read' : ''}`;
  const tip = entry.level === 'error' ? (isRead ? '已读' : '点击标记已读') : '';
  return `
    <div class="${rowClass}" data-id="${entry.id}"${tip ? ` title="${tip}"` : ''}>
      <span class="slw-dot-slot">${unread ? '<i class="slw-unread-dot"></i>' : ''}</span>
      <span class="slw-log-time">${esc(formatLogTime(entry.at))}</span>
      <span class="slw-tag ${LEVEL_TAG[entry.level]} slw-log-src">${esc(LEVEL_LABEL[entry.level])}</span>
      <span class="slw-tag dim slw-log-src">${esc(entry.source)}</span>
      <span class="slw-log-msg">${esc(entry.message)}${merged}${raw ? '<span class="slw-log-count">· 含原始 AI 输出</span>' : ''}</span>
      ${isRead ? '<span class="slw-readmark">已读</span>' : ''}
      ${expandable ? `<button class="slw-log-x" type="button">${open ? '详情 ▾' : '详情 ▸'}</button>` : ''}
    </div>
    ${open && detail ? `<div class="slw-log-detail">${esc(detail)}</div>` : ''}
    ${open && raw ? `
      <div class="slw-log-rawwrap">
        <div class="slw-log-rawhead">
          <span class="slw-muted">原始 AI 输出${esc(rawNote)}</span>
          <button class="slw-btn sm" type="button" data-copyraw="${entry.id}">复制原始输出</button>
        </div>
        <div class="slw-log-raw">${esc(raw)}</div>
      </div>` : ''}`;
}

export function renderLogTab(ctx: TabCtx, pane: HTMLElement): void {
  const { deps, doc } = ctx;
  pane.innerHTML = '';
  let levelFilter: LedgerLogFilterLevel = 'all';
  let sourceFilter = '全部';
  const expanded = new Set<number>();

  const card = el(doc, 'div', { class: 'slw-card' }, `
    <h3>运行日志 <span class="desc">填表与使用过程中的警告 / 错误 · 只保留在当前页面会话里（刷新或重载即自动清空）</span></h3>
    <div class="slw-row" style="margin-top:0">
      <span class="slw-muted" data-stats></span>
      <span style="flex:1"></span>
      <button class="slw-btn sm" type="button" data-copy>复制全部</button>
      <button class="slw-btn sm" type="button" data-export>导出 JSON</button>
      <button class="slw-btn sm danger" type="button" data-clear>清空日志</button>
    </div>
    <div class="slw-row" style="margin:8px 0 10px">
      <span class="slw-seg" data-levels>
        <button type="button" data-lv="all" class="on">全部</button>
        <button type="button" data-lv="nw">警告 + 错误</button>
        <button type="button" data-lv="error">仅错误</button>
      </span>
      <span class="slw-muted">来源</span>
      <span data-sources style="display:flex;gap:6px;flex-wrap:wrap"></span>
    </div>
    <div class="slw-loglist" data-list></div>
    <div class="slw-annot">日志上限 ${LEDGER_LOG_LIMIT} 条，超出丢最旧；填表 / 推进的警告与错误会带上<b>完整原始 AI 输出</b>：点「详情 ▸」展开查看，条内「复制原始输出」可单独取走——出问题时先看这里。<b>错误条目点整行即标记已读</b>（左栏徽章随之减少）；读过后同类错误再次出现会重新点亮。</div>`);
  pane.appendChild(card);

  const statsEl = card.querySelector('[data-stats]') as HTMLElement;
  const listEl = card.querySelector('[data-list]') as HTMLElement;
  const sourcesEl = card.querySelector('[data-sources]') as HTMLElement;

  /** 当前筛选下的条目（列表 / 复制 / 导出共用）。 */
  function shown(): LedgerLogEntry[] {
    return filterLogEntries(deps.log.list(), { level: levelFilter, source: sourceFilter });
  }

  function renderStats(): void {
    const c = deps.log.counts();
    statsEl.textContent = `共 ${c.total} 条 · 错误 ${c.error}（未读 ${deps.log.unreadErrors()}） · 警告 ${c.warn} · 信息 ${c.info} · 上限 ${LEDGER_LOG_LIMIT} 条（超出丢最旧 · 连续相同自动折叠计数）`;
  }

  function renderList(): void {
    const rows = shown();
    if (rows.length === 0) {
      listEl.innerHTML = deps.log.counts().total === 0
        ? '<div class="slw-logempty">本次会话暂无日志。<br><span class="slw-muted">出现警告或错误时会实时记录在这里（含完整错误原文）；刷新或重载页面会自动清空。</span></div>'
        : '<div class="slw-logempty">当前筛选下没有日志。<br><span class="slw-muted">换个级别或来源看看，或点「全部」。</span></div>';
      return;
    }
    listEl.innerHTML = rows.map((e) => logRowHtml(e, expanded.has(e.id))).join('');
    // 整行可点：错误条目标记已读（徽章随之减一）；有详情 / 原始输出的条目同时展开或收起。
    listEl.querySelectorAll('.slw-logrow').forEach((row) => (row as HTMLElement).addEventListener('click', () => {
      const id = Number((row as HTMLElement).dataset.id);
      const entry = rows.find((e) => e.id === id);
      if (!entry) return;
      let changed = false;
      if (entry.level === 'error' && deps.log.markErrorRead(id)) changed = true;
      if (entry.detail || entry.raw) {
        if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
        changed = true;
      }
      if (changed) renderList();
    }));
    // 单条「复制原始输出」：直接复制该条目的完整 AI 输出（研究原因用，不必连整份日志一起带走）
    listEl.querySelectorAll('[data-copyraw]').forEach((btn) => (btn as HTMLElement).addEventListener('click', async () => {
      const id = Number((btn as HTMLElement).dataset.copyraw);
      const entry = rows.find((e) => e.id === id);
      if (!entry?.raw) return;
      const ok = await copyPlainText(deps, entry.raw);
      (btn as HTMLButtonElement).textContent = ok ? '已复制 ✓' : '复制失败';
      if (!ok) deps.warn('复制失败（宿主未开放剪贴板），可改用「导出 JSON」');
      setTimeout(() => { (btn as HTMLButtonElement).textContent = '复制原始输出'; }, 1600);
    }));
  }

  function renderSources(): void {
    sourcesEl.innerHTML = ['全部', ...LEDGER_LOG_SOURCES]
      .map((s) => `<button class="slw-chip${s === sourceFilter ? ' on' : ''}" type="button" data-src="${esc(s)}">${esc(s)}</button>`)
      .join('');
    sourcesEl.querySelectorAll('[data-src]').forEach((btn) => (btn as HTMLElement).addEventListener('click', () => {
      sourceFilter = (btn as HTMLElement).dataset.src || '全部';
      renderSources();
      renderList();
    }));
  }

  card.querySelectorAll('[data-levels] button').forEach((btn) => (btn as HTMLElement).addEventListener('click', () => {
    levelFilter = ((btn as HTMLElement).dataset.lv || 'all') as LedgerLogFilterLevel;
    card.querySelectorAll('[data-levels] button').forEach((b) => b.classList.toggle('on', b === btn));
    renderList();
  }));

  (card.querySelector('[data-copy]') as HTMLElement).addEventListener('click', async (e) => {
    const btn = e.target as HTMLButtonElement;
    const rows = shown();
    if (rows.length === 0) { deps.warn('当前筛选下没有日志可复制'); return; }
    const ok = await copyPlainText(deps, ledgerLogText(rows));
    btn.textContent = ok ? '已复制 ✓' : '复制失败';
    if (!ok) deps.warn('复制失败（宿主未开放剪贴板），可改用「导出 JSON」');
    setTimeout(() => { btn.textContent = '复制全部'; }, 1600);
  });

  (card.querySelector('[data-export]') as HTMLElement).addEventListener('click', () => {
    const rows = shown();
    if (rows.length === 0) { deps.warn('当前筛选下没有日志可导出'); return; }
    downloadJsonFile(deps, '瑟瑟台账-运行日志.json', ledgerLogExport(rows, LEDGER_VERSION_LABEL));
  });

  (card.querySelector('[data-clear]') as HTMLElement).addEventListener('click', () => {
    deps.log.clear();
    expanded.clear();
    renderStats();
    renderList();
  });

  // 常驻重渲订阅：填表跑着时日志页开着也能实时看到新条目。
  // 切页签只清 pane.innerHTML、pane 本身仍连接 ⇒ 必须同时检查内部节点是否还在；
  // 并在 shell 清空页签前通过 __slwCleanup 真注销，避免每进一次日志页就多一个订阅。
  let logTimer = 0;
  const logWin = pane.ownerDocument.defaultView || deps.window;
  const unsubscribe = deps.log.subscribe(() => {
    if (!pane.isConnected || !statsEl.isConnected) { unsubscribe(); return; }
    if (logTimer) return;
    logTimer = logWin.setTimeout(() => {
      logTimer = 0;
      if (!pane.isConnected || !statsEl.isConnected) { unsubscribe(); return; }
      renderStats();
      renderList();
    }, LOG_RENDER_THROTTLE_MS);
  });
  (pane as any).__slwCleanup = () => {
    unsubscribe();
    if (logTimer) {
      logWin.clearTimeout(logTimer);
      logTimer = 0;
    }
  };

  renderStats();
  renderSources();
  renderList();

  // ── 诊断摘要（原设置页「引擎诊断」搬来此处：排查只看一页；设置页那道卡已删） ──
  const diagCard = el(doc, 'div', { class: 'slw-card' }, `
    <h3>诊断摘要 <span class="desc">引擎现状与投影状态 · 版本信息</span></h3>
    <div class="slw-muted" data-diag></div>`);
  pane.appendChild(diagCard);
  const diagEl = diagCard.querySelector('[data-diag]') as HTMLElement;
  const store = deps.runtime.__store();
  const entryCount = store?.peekEntries().length ?? 0;
  const fold = store?.peekFoldInfo?.();
  const wb = deps.diagWorldbook();
  diagEl.innerHTML =
    `storageId：${esc(String(deps.runtime.storageId() || '未建账').slice(0, 18))}… · 记账条目：${entryCount} · 就绪：${deps.runtime.isReady() ? '是' : '否'} · 待落盘：${deps.runtime.pending() ? '有' : '无'}` +
    `${fold ? ` · 时间轴：楼${fold.aiFloor}` : ''} · 世界书投影：${wb.count} 条目${wb.at ? `（上次刷新 ${new Date(wb.at).toLocaleTimeString()}）` : ''} · 日志：${deps.log.counts().total} / ${LEDGER_LOG_LIMIT}<br>` +
    `版本：${LEDGER_VERSION_LABEL} · 填表校验器：SQL · v2（text + 唯一 + 必填）`;
}
