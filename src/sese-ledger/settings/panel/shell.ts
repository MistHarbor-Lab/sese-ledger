// ===== 工作台外壳：悬浮按钮 → 全屏遮罩 → 大面板（七标签页） =====
//
// 结构对齐 mockup：app-head（logo/标题/meta/关闭）+ 左标签栏（表格/填表/推进/时光机/迁移/日志/设置）
// + 右内容区。各标签页渲染函数在同目录 *-tab.ts；结构变更（模板/分组编辑等）后调用 refresh('tables') 局部重渲。
import { WORKBENCH_CSS, el, esc, workbenchDoc, decorateAnnotations, decorateCollapsibleCards, closeTransientDialogs, type WorkbenchDeps } from './shared';
import { renderTablesTab } from './tables-tab';
import { renderFillTab } from './fill-tab';
import { renderPlotTab } from './plot-tab';
import { renderTimeMachineTab } from './time-machine-tab';
import { renderMigrateTab } from './migrate-tab';
import { renderLogTab } from './log-tab';
import { renderSettingsTab } from './settings-tab';
import { renderMergeTab } from './merge-tab';
import { summaryWarning } from '../../core/summary-warning';

export type { WorkbenchDeps } from './shared';
export interface WorkbenchHost { open(tab?: TabKey): void; unmount(): void; refreshSettings(): void }

export interface TabCtx {
  deps: WorkbenchDeps;
  doc: Document;
  /** 请求重渲某个标签页（当前激活时立即生效）。 */
  refresh(key: TabKey): void;
  /** 结构已变化（表/分组/模板）：刷新表格页并刷新世界书投影。 */
  structureChanged(): void;
}

export type TabKey = 'tables' | 'fill' | 'plot' | 'tm' | 'merge' | 'migrate' | 'log' | 'settings';

/** 填表运行状态（canonical.fill.getState/subscribe 的返回形状；只取横幅需要的字段）。 */
interface FillBarState {
  running?: boolean;
  entries?: { label?: string; attempt?: number; maxAttempts?: number }[];
}

/** 悬浮入口拖拽位置存档键（宿主 localStorage；{x,y}）。 */
const LAUNCHER_POS_KEY = 'sese-ledger-launcher-pos';
const LAUNCHER_SIZE = 46;
const DRAG_THRESHOLD = 4;
const EXT_MENU_CONTAINER_ID = 'slw-ext-menu-container';
const EXT_MENU_ITEM_ID = 'slw-ext-menu-item';
const EXT_MENU_MAX_RETRIES = 60;

export function mountWorkbenchPanel(deps: WorkbenchDeps): WorkbenchHost {
  // 挂载点 parent.document 优先：TH 脚本跑在隐藏 iframe 里，fixed 定位挂自己 document 上不可见
  // （弹窗 helper 共用同一口径 `workbenchDoc`）
  const doc: Document = workbenchDoc(deps);
  const style = el(doc, 'style');
  style.textContent = WORKBENCH_CSS;
  doc.head.appendChild(style);

  let launcher: HTMLButtonElement | null = null;
  let overlay: HTMLDivElement | null = null;
  let activeTab: TabKey = 'tables';
  let disposed = false;
  let extMenuEntry: HTMLElement | null = null;
  let extMenuRetryTimer: number | null = null;
  let extMenuRetries = 0;
  let resizeBound = false;
  let compactMode = false;
  let cardMode = false;
  let phoneMode = false;
  let compactObserver: ResizeObserver | null = null;
  let compactResizeHandler: (() => void) | null = null;
  let compactRaf = 0;
  let kbDisposer: (() => void) | null = null;
  /** 面板打开期间的表更新订阅（纪要数量警告条用）。 */
  let summaryWarnUnsub: (() => void) | null = null;
  /** 填表横幅的「终止已发出」态（避免下一次进度事件把按钮恢复成可点）。 */
  let fillTerminating = false;
  let fillWasRunning = false;

  /** 宿主窗口（launcher 挂在 parent.document 上，视口尺寸必须取 parent 的）。 */
  function hostWin(): Window {
    try { return doc.defaultView || deps.window; } catch (_e) { return deps.window; }
  }

  function appEl(): HTMLElement | null {
    try { return overlay?.querySelector('.slw-app') as HTMLElement | null; } catch (_e) { return null; }
  }

  /** 当前激活页签的说明块/大编辑卡片按紧凑状态折叠/展开。 */
  function syncAnnotations(): void {
    const pane = overlay?.querySelector('.slw-pane.on') as HTMLElement | null;
    if (!pane) return;
    const compact = compactMode || cardMode;
    decorateCollapsibleCards(pane, compact);
    decorateAnnotations(pane, compact);
  }

  /** 按工作台容器宽度切换紧凑外壳 / 卡片表格 / 全屏手机（桌面 1024+ 不触发）。 */
  function computeCompact(): void {
    if (disposed || !overlay) return;
    const app = appEl();
    if (!app) return;
    const w = app.getBoundingClientRect().width || hostWin().innerWidth || 0;
    const h = hostWin().innerHeight || 0;
    const landscape = w > h && h < 560;
    compactMode = w < 700 || landscape;
    cardMode = w < 900;
    phoneMode = w < 560;
    app.classList.toggle('slw-compact', compactMode);
    app.classList.toggle('slw-card-tables', cardMode);
    app.classList.toggle('slw-phone', phoneMode);
    overlay.classList.toggle('slw-phone', phoneMode);
    try {
      const root = doc.documentElement;
      root.classList.toggle('slw-compact-doc', compactMode);
      root.classList.toggle('slw-card-doc', cardMode);
      root.classList.toggle('slw-phone-doc', phoneMode);
    } catch (_e) { /* ignore */ }
    syncAnnotations();
  }

  function scheduleCompact(): void {
    if (compactRaf) return;
    try {
      compactRaf = hostWin().requestAnimationFrame(() => { compactRaf = 0; computeCompact(); });
    } catch (_e) {
      compactRaf = 0;
      computeCompact();
    }
  }

  function bindCompactWatcher(): void {
    unbindCompactWatcher();
    try {
      if (typeof ResizeObserver !== 'undefined') {
        compactObserver = new ResizeObserver(scheduleCompact);
        const app = appEl();
        if (app) compactObserver.observe(app);
      } else {
        compactResizeHandler = scheduleCompact;
        hostWin().addEventListener('resize', compactResizeHandler);
      }
    } catch (_e) { /* ignore */ }
  }

  function unbindCompactWatcher(): void {
    try { compactObserver?.disconnect(); } catch (_e) { /* ignore */ }
    compactObserver = null;
    if (compactResizeHandler) {
      try { hostWin().removeEventListener('resize', compactResizeHandler); } catch (_e) { /* ignore */ }
      compactResizeHandler = null;
    }
    if (compactRaf) {
      try { hostWin().cancelAnimationFrame(compactRaf); } catch (_e) { /* ignore */ }
      compactRaf = 0;
    }
  }

  function clearDocModes(): void {
    try {
      const root = doc.documentElement;
      root.classList.remove('slw-compact-doc', 'slw-card-doc', 'slw-phone-doc');
      root.style.removeProperty('--slw-kb-h');
      root.style.removeProperty('--slw-kb-top');
    } catch (_e) { /* ignore */ }
  }

  /** 软键盘遮挡量：只在面板打开时挂监听，关闭即摘（手机侧同款 visualViewport 口径）。 */
  function startKeyboardWatch(): void {
    stopKeyboardWatch();
    const win = hostWin();
    const vv = win.visualViewport;
    if (!vv) return;
    let lastH = -1;
    let lastT = -1;
    const apply = (): void => {
      const overlap = Math.max(0, Math.round(win.innerHeight - vv.height));
      const top = overlap > 0 ? Math.round(vv.offsetTop) : 0;
      if (overlap === lastH && top === lastT) return;
      lastH = overlap;
      lastT = top;
      try {
        doc.documentElement.style.setProperty('--slw-kb-h', `${overlap}px`);
        doc.documentElement.style.setProperty('--slw-kb-top', `${top}px`);
      } catch (_e) { /* ignore */ }
    };
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    apply();
    kbDisposer = () => {
      try { vv.removeEventListener('resize', apply); vv.removeEventListener('scroll', apply); } catch (_e) { /* ignore */ }
      try {
        doc.documentElement.style.removeProperty('--slw-kb-h');
        doc.documentElement.style.removeProperty('--slw-kb-top');
      } catch (_e) { /* ignore */ }
    };
  }

  function stopKeyboardWatch(): void {
    if (!kbDisposer) return;
    try { kbDisposer(); } catch (_e) { /* ignore */ }
    kbDisposer = null;
  }

  function launcherStorage(): Storage | null {
    for (const win of [hostWin(), deps.window]) {
      try { return win.localStorage; } catch (_e) { /* 跨域/禁用时换下一个 */ }
    }
    return null;
  }

  function readLauncherPos(): { x: number; y: number } | null {
    const store = launcherStorage();
    if (!store) return null;
    try {
      const raw = store.getItem(LAUNCHER_POS_KEY);
      if (!raw) return null;
      const pos = JSON.parse(raw) as { x?: unknown; y?: unknown } | null;
      if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') return null;
      if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return null;
      return { x: pos.x, y: pos.y };
    } catch (_e) {
      return null;
    }
  }

  function writeLauncherPos(x: number, y: number): void {
    const store = launcherStorage();
    if (!store) return;
    try { store.setItem(LAUNCHER_POS_KEY, JSON.stringify({ x: Math.round(x), y: Math.round(y) })); } catch (_e) { /* ignore */ }
  }

  /** 视口钳制：保证按钮完整落在 parent 视口内（窗口缩小/换设备后存档坐标自愈）。 */
  function clampLauncherPos(x: number, y: number, width: number, height: number): { x: number; y: number } {
    const win = hostWin();
    const vw = win.innerWidth || 0;
    const vh = win.innerHeight || 0;
    return {
      x: Math.min(Math.max(0, x), Math.max(0, vw - width)),
      y: Math.min(Math.max(0, y), Math.max(0, vh - height)),
    };
  }

  function applyLauncherPos(btn: HTMLElement, x: number, y: number): void {
    btn.style.left = `${Math.round(x)}px`;
    btn.style.top = `${Math.round(y)}px`;
    btn.style.right = 'auto';
    btn.style.bottom = 'auto';
  }

  function clampLauncherOnResize(): void {
    if (!launcher) return;
    const saved = readLauncherPos();
    if (!saved) return;
    const p = clampLauncherPos(saved.x, saved.y, launcher.offsetWidth || LAUNCHER_SIZE, launcher.offsetHeight || LAUNCHER_SIZE);
    applyLauncherPos(launcher, p.x, p.y);
    if (p.x !== saved.x || p.y !== saved.y) writeLauncherPos(p.x, p.y);
  }

  /** 仅当用户真的拖过（存在存档）时才挂 resize 监听：未触发拖拽时零常驻监听。 */
  function ensureLauncherResizeClamp(): void {
    if (resizeBound) return;
    resizeBound = true;
    try { hostWin().addEventListener('resize', clampLauncherOnResize); } catch (_e) { /* ignore */ }
  }

  // 拖拽：pointer 单轨 + setPointerCapture（鼠标/触摸/笔统一）；右/下定位先换 left/top 再动，
  // 否则 CSS 的 right/bottom 优先级会让 left/top 不生效（这是「拖不动」的根因）。
  function bindLauncherDrag(btn: HTMLButtonElement, onDragMoved: () => void): void {
    let dragging = false;
    let moved = false;
    let pointerId = -1;
    let startX = 0;
    let startY = 0;
    let baseLeft = 0;
    let baseTop = 0;

    btn.addEventListener('pointerdown', (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      dragging = true;
      moved = false;
      pointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      const rect = btn.getBoundingClientRect();
      baseLeft = rect.left;
      baseTop = rect.top;
      try { btn.setPointerCapture(e.pointerId); } catch (_e) { /* ignore */ }
      btn.classList.add('slw-launcher-dragging');
      e.preventDefault();
    });

    btn.addEventListener('pointermove', (e: PointerEvent) => {
      if (!dragging || e.pointerId !== pointerId) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!moved && Math.abs(dx) <= DRAG_THRESHOLD && Math.abs(dy) <= DRAG_THRESHOLD) return;
      moved = true;
      const p = clampLauncherPos(
        baseLeft + dx,
        baseTop + dy,
        btn.offsetWidth || LAUNCHER_SIZE,
        btn.offsetHeight || LAUNCHER_SIZE,
      );
      applyLauncherPos(btn, p.x, p.y);
    });

    const finish = (e: PointerEvent): void => {
      if (!dragging || e.pointerId !== pointerId) return;
      dragging = false;
      btn.classList.remove('slw-launcher-dragging');
      if (!moved) return;
      const rect = btn.getBoundingClientRect();
      const p = clampLauncherPos(rect.left, rect.top, rect.width || LAUNCHER_SIZE, rect.height || LAUNCHER_SIZE);
      applyLauncherPos(btn, p.x, p.y);
      writeLauncherPos(p.x, p.y);
      ensureLauncherResizeClamp();
      onDragMoved();
      e.stopPropagation();
      e.preventDefault();
    };
    btn.addEventListener('pointerup', finish);
    btn.addEventListener('pointercancel', finish);
  }

  function restoreLauncherPos(btn: HTMLButtonElement): void {
    const saved = readLauncherPos();
    if (!saved) return;
    const p = clampLauncherPos(saved.x, saved.y, btn.offsetWidth || LAUNCHER_SIZE, btn.offsetHeight || LAUNCHER_SIZE);
    applyLauncherPos(btn, p.x, p.y);
    if (p.x !== saved.x || p.y !== saved.y) writeLauncherPos(p.x, p.y);
    ensureLauncherResizeClamp();
  }

  function renderLauncher(): void {
    if (disposed) return;
    if (launcher) launcher.remove();
    launcher = null;
    if (deps.settings.get().showLauncher === false) return;
    const btn = el(doc, 'button', { class: 'slw-launcher', type: 'button', title: '瑟瑟台账（按住可拖动）' });
    btn.textContent = '账';
    // 拖完的残留 click 不能当点击（600ms 时间戳法；一次性捕获会吞掉紧随其后的正常点击）
    let suppressClickUntil = 0;
    btn.onclick = () => {
      if (Date.now() < suppressClickUntil) return;
      open();
    };
    bindLauncherDrag(btn, () => { suppressClickUntil = Date.now() + 600; });
    doc.body.appendChild(btn);
    launcher = btn;
    syncLauncherFill(readFillState()?.running === true);
    restoreLauncherPos(btn);
  }

  // ===== 酒馆扩展菜单入口（#extensionsMenu）=====
  // 悬浮按钮只是「快捷入口」：被设置页关掉后，扩展菜单里必须仍有一个稳定入口可打开工作台。
  function removeExtensionMenuEntry(): void {
    try { extMenuEntry?.remove(); } catch (_e) { /* ignore */ }
    extMenuEntry = null;
    try { doc.getElementById(EXT_MENU_CONTAINER_ID)?.remove(); } catch (_e) { /* ignore */ }
  }

  function closeExtensionsMenu(): boolean {
    try {
      const menu = doc.getElementById('extensionsMenu');
      const button = doc.getElementById('extensionsMenuButton');
      if (!menu || !button) return false;
      const visible = menu.offsetWidth > 0 || menu.offsetHeight > 0 || menu.classList.contains('open');
      if (!visible) return false;
      button.click();
      return true;
    } catch (_e) {
      return false;
    }
  }

  function show(): void {
    if (disposed) return;
    if (!overlay) open();
  }

  function registerExtensionMenuEntry(): void {
    if (disposed) return;
    let menu: HTMLElement | null = null;
    try { menu = doc.getElementById('extensionsMenu'); } catch (_e) { menu = null; }
    if (!menu) {
      // 宿主菜单可能晚于脚本出现：有限次重试，注入成功即停（不做常驻轮询）
      if (extMenuRetries >= EXT_MENU_MAX_RETRIES) return;
      extMenuRetries += 1;
      try { extMenuRetryTimer = hostWin().setTimeout(registerExtensionMenuEntry, 1000); } catch (_e) { /* ignore */ }
      return;
    }
    removeExtensionMenuEntry();
    const container = el(doc, 'div', {
      class: 'extension_container interactable',
      id: EXT_MENU_CONTAINER_ID,
      tabindex: '0',
    });
    const item = el(doc, 'div', {
      class: 'list-group-item flex-container flexGap5 interactable',
      id: EXT_MENU_ITEM_ID,
      title: '打开瑟瑟台账',
    });
    const icon = el(doc, 'div', { class: 'fa-fw fa-solid fa-book extensionsMenuExtensionButton' });
    const label = el(doc, 'span');
    label.textContent = '瑟瑟台账';
    item.appendChild(icon);
    item.appendChild(label);
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      // 菜单没收起时先触发收起、等动画让开再挂面板（宿主的抽屉层叠在面板之上）
      if (closeExtensionsMenu()) {
        try { hostWin().setTimeout(show, 150); } catch (_e) { show(); }
      } else {
        show();
      }
    });
    container.appendChild(item);
    menu.appendChild(container);
    extMenuEntry = container;
  }

  function close(): void {
    // 面板内的对话框（分组成员/建表向导等）直挂宿主 body 且带全屏遮罩——关面板时一并清掉，
    // 否则残留遮罩（z-index 10040）会继续挡住宿主页面输入。
    const activePane = overlay?.querySelector('.slw-pane.on') as HTMLElement | null;
    const cleanup = (activePane as any)?.__slwCleanup;
    if (typeof cleanup === 'function') {
      try { cleanup(); } catch (_e) { /* ignore */ }
    }
    unbindCompactWatcher();
    stopKeyboardWatch();
    clearDocModes();
    compactMode = false;
    cardMode = false;
    phoneMode = false;
    // 面板内的对话框/编辑弹窗直挂宿主 body 且带全屏遮罩——关面板时一并收口：
    // 先走统一清理（确认框 Promise、编辑器 keydown、单例），再兜底移除残留遮罩。
    try { closeTransientDialogs(doc); } catch (_e) { /* ignore */ }
    if (summaryWarnUnsub) {
      try { summaryWarnUnsub(); } catch (_e) { /* ignore */ }
      summaryWarnUnsub = null;
    }
    overlay?.remove();
    overlay = null;
    // 面板关闭后恢复悬浮钮进行中动效（面板打开期间由顶部横幅指示，暂停动画避免被遮罩盖住仍空转）。
    syncLauncherFill(readFillState()?.running === true);
  }

  const TAB_DEFS: { key: TabKey; icon: string; label: string }[] = [
    { key: 'tables', icon: '▦', label: '表格' },
    { key: 'fill', icon: '✎', label: '填表' },
    { key: 'plot', icon: '▶', label: '推进' },
    { key: 'tm', icon: '⏱', label: '时光机' },
    { key: 'merge', icon: '⇉', label: '纪要合并' },
    { key: 'migrate', icon: '⇄', label: '迁移' },
    { key: 'log', icon: '☰', label: '日志' },
    { key: 'settings', icon: '⚙', label: '设置' },
  ];

  /** 日志页错误计数徽标（rail 上）：未读错误条目数 >0 时显示；点错误条目 / 写日志 / 清空由订阅刷新。 */
  function renderLogBadge(): void {
    if (!overlay) return;
    const badge = overlay.querySelector('[data-log-badge]') as HTMLElement | null;
    if (!badge) return;
    const n = deps.log.unreadErrors();
    badge.textContent = n > 99 ? '99+' : String(n);
    badge.style.display = n > 0 ? '' : 'none';
  }

  /** 读当前填表状态（canonical.fill 单出口；旧桩 / 真数据库模式缺方法时按空闲处理）。 */
  function readFillState(): FillBarState | null {
    try { return deps.canonical?.fill?.getState?.() || null; } catch (_e) { return null; }
  }

  /** 悬浮钮进行中动效：只切类名，动画全在 CSS；面板打开（被遮罩盖住）时暂停，空闲时无动画。 */
  function syncLauncherFill(running: boolean): void {
    if (!launcher) return;
    try { launcher.classList.toggle('slw-launcher-filling', running && !overlay); } catch (_e) { /* ignore */ }
  }

  /** 填表进行中横幅的明细文案（单组「分组1 · 重试 1/3」；多组并排；批次间隙「正在准备下一批」）。 */
  function fillBarDetail(state: FillBarState | null): string {
    const entries = state && Array.isArray(state.entries) ? state.entries : [];
    if (entries.length === 0) return '正在准备下一批';
    return entries.map((entry) => {
      const label = esc(String(entry?.label || '填表').trim() || '填表');
      const attempt = Math.max(1, Math.trunc(Number(entry?.attempt) || 1));
      const maxAttempts = Math.max(attempt, Math.trunc(Number(entry?.maxAttempts) || attempt));
      return `<b>${label}</b> · 重试 ${attempt}/${maxAttempts}`;
    }).join(' ｜ ');
  }

  /** 顶部填表横幅：与纪要警告条同结构；面板未打开时早退（launcher 动效仍会更新）。 */
  function renderFillBar(state?: FillBarState | null): void {
    if (!overlay) return;
    const bar = overlay.querySelector('[data-fill-bar]') as HTMLElement | null;
    if (!bar) return;
    const current = state === undefined ? readFillState() : state;
    const running = current?.running === true;
    bar.hidden = !running;
    if (!running) { fillTerminating = false; return; }
    const textEl = bar.querySelector('[data-fill-text]') as HTMLElement | null;
    if (textEl) textEl.innerHTML = `填表进行中 · ${fillBarDetail(current)}`;
    const btn = bar.querySelector('[data-act="terminate-fill"]') as HTMLButtonElement | null;
    if (btn) {
      btn.disabled = fillTerminating;
      btn.textContent = fillTerminating ? '终止中…' : '终止填表';
    }
  }

  /** 填表状态推送：悬浮钮常驻生效；横幅只在面板存在时渲染。 */
  function onFillState(state: FillBarState | null): void {
    const running = state?.running === true;
    if (running && !fillWasRunning) fillTerminating = false;
    fillWasRunning = running;
    syncLauncherFill(running);
    renderFillBar(state);
  }

  /** 顶部纪要数量警告条：超过阈值才显示；按钮切到「纪要合并」标签。 */
  function renderSummaryWarn(): void {
    if (!overlay) return;
    const bar = overlay.querySelector('[data-summary-warn]') as HTMLElement | null;
    if (!bar) return;
    // 真数据库模式：台账不是表格后端，横幅不提示；合并走状态栏。
    if (deps.realDbPresent) { bar.hidden = true; return; }
    const info = summaryWarning(deps.runtime.book(), deps.settings.get());
    bar.hidden = !info.over;
    if (!info.over) return;
    const count = bar.querySelector('[data-warn-count]') as HTMLElement | null;
    const limit = bar.querySelector('[data-warn-limit]') as HTMLElement | null;
    if (count) count.textContent = String(info.count);
    if (limit) limit.textContent = String(info.limit);
  }

  /** 纪要合并侧栏徽标：运行中显示已完成段数；待提交显示 !。 */
  function renderMergeBadge(state?: any): void {
    if (!overlay) return;
    const badge = overlay.querySelector('[data-merge-badge]') as HTMLElement | null;
    if (!badge) return;
    const svc = deps.canonical?.summaryMerge;
    const s = state || (svc && typeof svc.getState === 'function' ? svc.getState() : null);
    if (!s) { badge.style.display = 'none'; return; }
    if (s.phase === 'running') {
      const segments = Array.isArray(s.segments) ? s.segments : [];
      const done = segments.filter((x: any) => x.status === 'success' || x.status === 'failed' || x.status === 'skipped' || x.status === 'omitted').length;
      badge.textContent = String(done);
      badge.style.display = 'inline-block';
      badge.title = '合并进行中 ' + done + '/' + segments.length + ' 段';
    } else if (s.phase === 'done') {
      badge.textContent = '!';
      badge.style.display = 'inline-block';
      badge.title = '合并已完成，待提交';
    } else {
      badge.style.display = 'none';
      badge.removeAttribute('title');
    }
  }

  function tabCtx(): TabCtx {
    return {
      deps,
      doc,
      refresh(key) { if (overlay && key === activeTab) renderPane(key); },
      structureChanged() {
        // 结构编辑（分组/频率/注入/增删表）**不 bump runtime.revision**，非 force 刷新会被
        // 「未变更跳过门」吃掉 ⇒ 世界书要等下一条消息落账才收敛，而那一轮生成已用了旧投影。
        // 结构编辑是低频用户点击，force 只多一次 getWorldbook + 重建比对，直接强制刷新。
        void deps.refreshWorldbook({ force: true });
        if (overlay && activeTab === 'tables') renderPane('tables');
      },
    };
  }

  const RENDERERS: Record<TabKey, (ctx: TabCtx, pane: HTMLElement) => void> = {
    tables: renderTablesTab,
    fill: renderFillTab,
    plot: renderPlotTab,
    tm: renderTimeMachineTab,
    merge: renderMergeTab,
    migrate: renderMigrateTab,
    log: renderLogTab,
    settings: renderSettingsTab,
  };

  function renderPane(key: TabKey): void {
    const pane = overlay?.querySelector(`#slw-pane-${key}`);
    if (!pane) return;
    // 页签重渲前先执行上一轮登记的清理（日志订阅等），否则旧闭包会持续吃日志事件。
    const cleanup = (pane as any).__slwCleanup;
    if (typeof cleanup === 'function') {
      try { cleanup(); } catch (_e) { /* ignore */ }
    }
    (pane as any).__slwCleanup = undefined;
    pane.innerHTML = '';
    RENDERERS[key](tabCtx(), pane as HTMLElement);
    decorateCollapsibleCards(pane as HTMLElement, compactMode || cardMode);
    decorateAnnotations(pane as HTMLElement, compactMode || cardMode);
  }

  function activate(key: TabKey): void {
    if (!overlay) return;
    // 切走时先注销上一页签的常驻资源（当前只有日志订阅；隐藏的 pane 仍 isConnected，
    // 只靠回调里的 isConnected 检查不会解绑）。
    if (activeTab !== key) {
      const prevPane = overlay.querySelector(`#slw-pane-${activeTab}`) as HTMLElement | null;
      const prevCleanup = (prevPane as any)?.__slwCleanup;
      if (typeof prevCleanup === 'function') {
        try { prevCleanup(); } catch (_e) { /* ignore */ }
      }
      if (prevPane) (prevPane as any).__slwCleanup = undefined;
    }
    activeTab = key;
    overlay.querySelectorAll('.slw-rail button').forEach((b) => b.classList.toggle('on', (b as HTMLElement).dataset.tab === key));
    overlay.querySelectorAll('.slw-pane').forEach((p) => p.classList.toggle('on', p.id === `slw-pane-${key}`));
    renderPane(key);
    // 切页签 = 换主体：显式回顶（项目铁律 #27）
    const content = overlay.querySelector('.slw-content') as HTMLElement | null;
    if (content) {
      content.scrollTop = 0;
      content.scrollLeft = 0;
    }
  }

  function open(tab?: TabKey): void {
    // 已打开时：带目标页签＝直接切过去（状态栏「去台账合并」深链）；不带＝关闭（悬浮按钮开关语义）。
    if (overlay) { if (tab) activate(tab); else close(); return; }
    // H8：每次打开默认从表格页开始；状态栏导航可指定 merge。
    activeTab = tab || 'tables';
    overlay = el(doc, 'div', { class: 'slw-root' });
    const chatLen = deps.getChat().length;
    const backend = deps.realDbPresent ? '真数据库在场（台账旁观，canonical API 可用）' : '后端：台账引擎（未检测到真数据库，已接管）';
    // H9：首次打开还没建账时给明确指引（不自动建账，避免用户只是想看看就凭空落一份空账）。
    const metaText = deps.runtime.isReady()
      ? `${backend} · 当前聊天 ${chatLen} 楼`
      : '台账尚未建账：先推进剧情（发送一条消息）触发自动更新；建账后这里会显示表清单与各表状态';
    const app = el(doc, 'div', { class: 'slw-app' });
    app.innerHTML = `
      <div class="slw-head">
        <div class="logo">账</div>
        <div class="slw-head-info">
          <div class="title">瑟瑟台账 · 工作台</div>
          <div class="meta">${esc(metaText)}</div>
        </div>
        <button class="close" data-act="close">关闭</button>
      </div>
      <div class="slw-fillbar" data-fill-bar hidden>
        <span class="fill-spin"></span>
        <span data-fill-text>填表进行中</span>
        <button class="slw-btn sm danger" type="button" data-act="terminate-fill">终止填表</button>
      </div>
      <div class="slw-warnbar" data-summary-warn hidden>
        <span class="warn-dot">!</span>
        <span>纪要已达 <b data-warn-count>0</b> 条，超过建议上限 <b data-warn-limit>200</b> 条 —— 历史纪要继续增长可能会影响召回的效率和准确度。</span>
        <button class="slw-btn sm" type="button" data-act="merge">去合并</button>
      </div>
      <div class="slw-body">
        <div class="slw-rail">
          ${TAB_DEFS.map((t) => `<button data-tab="${t.key}" class="${t.key === activeTab ? 'on' : ''}"><span class="ic">${t.icon}</span>${t.label}${t.key === 'log' ? '<span class="slw-rail-badge" data-log-badge style="display:none"></span>' : ''}${t.key === 'merge' ? '<span class="slw-rail-badge" data-merge-badge style="display:none"></span>' : ''}</button>`).join('')}
        </div>
        <div class="slw-content">
          ${TAB_DEFS.map((t) => `<div class="slw-pane ${t.key === activeTab ? 'on' : ''}" id="slw-pane-${t.key}"></div>`).join('')}
        </div>
      </div>`;
    overlay.appendChild(app);
    overlay.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target === overlay) { close(); return; }
      if (target.closest('[data-act="close"]')) close();
      if (target.closest('[data-act="merge"]')) { activate('merge'); return; }
      const terminateFillBtn = target.closest('[data-act="terminate-fill"]') as HTMLButtonElement | null;
      if (terminateFillBtn) {
        fillTerminating = true;
        try { deps.canonical?.fill?.terminate?.(); } catch (_e) { /* ignore */ }
        renderFillBar();
        return;
      }
      const railBtn = target.closest('.slw-rail button');
      if (railBtn) activate((railBtn as HTMLElement).dataset.tab as TabKey);
    });
    doc.body.appendChild(overlay);
    // 面板打开＝有顶部横幅指示；暂停悬浮钮动画（它在遮罩之下，继续播放只是空转）。
    syncLauncherFill(readFillState()?.running === true);
    // 先按容器宽度定紧凑/卡片/全屏类，再渲染首屏（说明块折叠依赖该状态）
    computeCompact();
    bindCompactWatcher();
    startKeyboardWatch();
    renderPane(activeTab);
    renderLogBadge();
    renderMergeBadge();
    renderSummaryWarn();
    renderFillBar();
    // 面板打开期间订阅一次表更新：填表/合并落账后横幅即时更新；关闭即退订。
    if (summaryWarnUnsub) {
      try { summaryWarnUnsub(); } catch (_e) { /* ignore */ }
      summaryWarnUnsub = null;
    }
    try {
      summaryWarnUnsub = deps.runtime.onTableUpdate(() => renderSummaryWarn());
    } catch (_e) { summaryWarnUnsub = null; }
  }

  const onReady = (): void => {
    renderLauncher();
    registerExtensionMenuEntry();
  };
  if (doc.body) onReady();
  else doc.addEventListener('DOMContentLoaded', onReady, { once: true });

  // 设置页切换「悬浮按钮」开关后重挂（事件经 deps.window 广播）
  try {
    deps.window.addEventListener?.('slw-render-launcher', renderLauncher as EventListener);
  } catch (_e) { /* ignore */ }

  // 日志错误计数徽标：写日志 / 点错误条目 / 清空即时刷新（面板未打开时 renderLogBadge 早退，零渲染开销）
  const logBadgeUnsub = deps.log.subscribe(renderLogBadge);
  // 填表运行状态：驱动悬浮钮动效（面板关闭也生效）+ 顶部横幅（面板未打开时 renderFillBar 早退）。
  let fillStateUnsub: (() => void) | null = null;
  try {
    const fillApi = deps.canonical?.fill;
    if (typeof fillApi?.subscribe === 'function') fillStateUnsub = fillApi.subscribe(onFillState);
  } catch (_e) { fillStateUnsub = null; }
  // 纪要合并侧栏徽标：服务进度事件驱动（面板未打开时 renderMergeBadge 早退）。
  const summaryMergeUnsub = deps.canonical?.summaryMerge?.subscribe
    ? deps.canonical.summaryMerge.subscribe((s: any) => renderMergeBadge(s))
    : null;
  // 设置页改阈值后即时刷新顶部横幅（低频事件，不轮询）。
  const summaryWarnRefreshHandler = (): void => renderSummaryWarn();
  try { deps.window.addEventListener?.('slw-summary-warn-refresh', summaryWarnRefreshHandler as EventListener); } catch (_e) { /* ignore */ }

  return {
    open,
    /** 主项目配置变更后：只在设置页正显示时重渲（避免打断别的页签正在编辑的输入）。 */
    refreshSettings() {
      if (overlay && activeTab === 'settings') renderPane('settings');
    },
    unmount() {
      disposed = true;
      if (extMenuRetryTimer !== null) {
        try { hostWin().clearTimeout(extMenuRetryTimer); } catch (_e) { /* ignore */ }
        extMenuRetryTimer = null;
      }
      try { doc.removeEventListener('DOMContentLoaded', onReady); } catch (_e) { /* ignore */ }
      if (resizeBound) {
        try { hostWin().removeEventListener('resize', clampLauncherOnResize); } catch (_e) { /* ignore */ }
        resizeBound = false;
      }
      close();
      launcher?.remove();
      launcher = null;
      removeExtensionMenuEntry();
      style.remove();
      try { logBadgeUnsub(); } catch (_e) { /* ignore */ }
      try { fillStateUnsub?.(); } catch (_e) { /* ignore */ }
      try { summaryMergeUnsub?.(); } catch (_e) { /* ignore */ }
      try { deps.window.removeEventListener?.('slw-summary-warn-refresh', summaryWarnRefreshHandler as EventListener); } catch (_e) { /* ignore */ }
      try { deps.window.removeEventListener?.('slw-render-launcher', renderLauncher as EventListener); } catch (_e) { /* ignore */ }
    },
  };
}
