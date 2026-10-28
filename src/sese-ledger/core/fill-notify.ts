// ===== 常驻通知载体：进度 toast（原位改文案 + 点击终止）与一次性常驻消息 =====
//
// 形态对齐数据库插件：进度 toast `timeOut:0` 常驻、跑完由引擎清掉，
// 文案含「第几次尝试 / 最多几次」；失败 toast 常驻、只能手动点关闭。
// 与数据库插件的差异：**不向 toastr 注入 HTML**（酒馆全局 escapeHtml:true 会把标签当文字显示），
// 「终止」改由点 toast 本体触发（关闭按钮留给「只关通知、不终止」）；改文案走 toastr 返回句柄的
// `.toast-message` 直改文本（句柄失效则重建）。
// 落地：填表（自动/手动/定向重填共用 createFillNotifier）与剧情推进（createProgressToast）共用本模块；
// 进度通知默认常驻；设置「填表/推进持久化」关闭后改为展示 3 秒自动隐去（失败/错误告警恒常驻）。
// 关闭一律按句柄清——**禁 toastr.clear() 全清**（会连别人的常驻通知一起点掉）。

/** 填表进度事件（scribe 上报；label 由 scribe 组装）。 */
export interface FillProgressEvent {
  /** attempt = 一次请求尝试（会原位改文案）；end = 该请求收尾（带 key 只摘它、不带 key 全清）。 */
  phase: 'attempt' | 'end';
  /** 展示标签：「分组1（核心）」/「手动填表 1/2 批」/「定向重填」。 */
  label?: string;
  /** 在跑请求标识（同批多分组并发时区分条目；缺省回落 label）。 */
  key?: string;
  /** 第几次尝试（1-based）。 */
  attempt?: number;
  maxAttempts?: number;
}

/** 单条进度文案：「分组1 填表中，重试 1/3」。 */
export function fillProgressEntryText(label: unknown, attempt: unknown, maxAttempts: unknown): string {
  const name = String(label || '填表').trim() || '填表';
  const a = Math.max(1, Math.trunc(Number(attempt) || 1));
  const max = Math.max(a, Math.trunc(Number(maxAttempts) || a));
  return `${name} 填表中，重试 ${a}/${max}`;
}

/** 进度文案（单条形态：「分组1 填表中，重试 1/3（点击终止）」）。 */
export function fillProgressText(event: Pick<FillProgressEvent, 'label' | 'attempt' | 'maxAttempts'>): string {
  return `${fillProgressEntryText(event?.label, event?.attempt, event?.maxAttempts)}（点击终止）`;
}

/** 失败文案：首条错误 + 总项数（错误原文可能很长，截断保可读）。 */
export function fillFailureText(errors: string[]): string {
  const list = (Array.isArray(errors) ? errors : []).map((e) => String(e ?? '').trim()).filter(Boolean);
  if (list.length === 0) return '填表失败：未知原因';
  const head = list[0].length > 160 ? list[0].slice(0, 160) + '…' : list[0];
  return `填表失败：${head}${list.length > 1 ? `（共 ${list.length} 项）` : ''}`;
}

/** 常驻 toastr 选项（与主项目 PERSIST_OPTS 同口径：不自动消失 + 关闭按钮 + ub-persist 皮肤档）。
 *  「填表/推进持久化」关闭时仍用这套选项，由 createProgressToast 自己计时关闭（不依赖 toastr 的 timeOut）。 */
export const PERSIST_OPTS: Record<string, unknown> = {
  timeOut: 0,
  extendedTimeOut: 0,
  tapToDismiss: true,
  closeButton: true,
  extraClasses: 'ub-persist',
};

/** 一次性常驻消息去重窗（同「级别|文案」窗口内只弹一条；用户关掉后窗口期内同因不再堆叠）。 */
export const FAIL_DEDUP_WINDOW_MS = 5 * 60 * 1000;

/** 去重器：同键在窗口内重复 = 抑制（true）；表有界，顺手清过期项。 */
function createDedup(now: () => number, windowMs = FAIL_DEDUP_WINDOW_MS) {
  const seen = new Map<string, number>();
  return (key: string): boolean => {
    const t = now();
    const last = seen.get(key);
    if (last != null && t - last < windowMs) return true;
    if (seen.size > 50) {
      for (const [k, at] of [...seen]) if (t - at >= windowMs) seen.delete(k);
    }
    seen.set(key, t);
    return false;
  };
}

/** toastr 返回句柄（jQuery 对象或原生元素）→ 原生元素。 */
function toastElementOf(handle: any): HTMLElement | null {
  if (!handle) return null;
  if (handle.nodeType === 1) return handle as HTMLElement;
  if (handle[0] && handle[0].nodeType === 1) return handle[0] as HTMLElement;
  return null;
}

/** 原位改文案（句柄失效 = 已被宿主移除 → false，调用方另开一条）。 */
function setToastText(handle: any, text: string): boolean {
  const el = toastElementOf(handle);
  if (!el || el.isConnected === false) return false; // 用户手动关掉 / 容器重建 → 句柄失效
  const msg = typeof el.querySelector === 'function' ? el.querySelector('.toast-message') : null;
  if (!msg) return false;
  msg.textContent = text;
  return true;
}

/** 按句柄清一条（禁无参 toastr.clear()：那是全清，会点掉别的常驻通知）。 */
function closeToast(getToastr: () => any, handle: any): void {
  if (!handle) return;
  const el = toastElementOf(handle);
  if (el && el.isConnected === false) return; // 已被宿主移除（用户点关 / 容器重建）→ 无需再清
  try {
    const toastr = getToastr();
    // 必须 force：toastr 2.x 遇「toast 内有焦点」会拒绝单条隐藏并退化为清空整个容器。
    if (toastr && typeof toastr.clear === 'function') { toastr.clear(handle, { force: true }); return; }
  } catch (_e) { /* 回退直删 */ }
  try { el?.remove?.(); } catch (_e) { /* ignore */ }
}

/** 进度通知在「非持久」模式下的自动隐去延时。 */
export const PROGRESS_AUTO_HIDE_MS = 3000;

/** 进度通知的持久化选项（设置「填表/推进持久化」；缺省＝常驻，显式 false＝展示后自动隐去）。 */
export interface ProgressPersistOpts {
  /** 每次调用取当前设置：true＝常驻（当前形态），false＝autoHideMs 后自动隐去。缺省按常驻。 */
  isPersistent?: () => boolean;
  /** 自动隐去延时（缺省 PROGRESS_AUTO_HIDE_MS）。 */
  autoHideMs?: number;
  /** 定时器注入（测试用；缺省全局 setTimeout/clearTimeout）。 */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** 进度 toast（单句柄）：show 首条创建 / 后续原位改文案，close 按句柄关闭；持久化关闭时展示后自动隐去。 */
export interface ProgressToast {
  /** 展示/更新文案；onClick = 点 toast 本体时回调（点关闭按钮不算——toastr 已 stopPropagation）。 */
  show(text: string, opts?: { onClick?: () => void }): void;
  close(): void;
}

export function createProgressToast(deps: ProgressPersistOpts & { getToastr(): any; title?: string; level?: 'info' | 'warning' }): ProgressToast {
  const title = deps.title || '瑟瑟台账';
  const level = deps.level || 'info';
  const setTimer = deps.setTimer || ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer || ((h: unknown) => clearTimeout(h as any));
  const autoHideMs = deps.autoHideMs == null ? PROGRESS_AUTO_HIDE_MS : Math.max(0, Number(deps.autoHideMs) || 0);
  let handle: any = null;
  let hideTimer: unknown = null;
  function cancelHide(): void {
    if (hideTimer == null) return;
    const h = hideTimer;
    hideTimer = null;
    try { clearTimer(h); } catch (_e) { /* ignore */ }
  }
  function close(): void {
    cancelHide();
    const h = handle;
    handle = null;
    closeToast(deps.getToastr, h);
  }
  /** 非持久模式：每次展示（含原位改文案）重置计时，避免长任务通知一直挂着遮挡。 */
  function armAutoHide(): void {
    cancelHide();
    let persistent = true;
    try { persistent = deps.isPersistent ? !!deps.isPersistent() : true; } catch (_e) { /* 读设置失败按常驻 */ }
    if (persistent || autoHideMs <= 0) return;
    hideTimer = setTimer(() => {
      hideTimer = null;
      close();
    }, autoHideMs);
  }
  return {
    show(text, opts) {
      try {
        const t = String(text || '').trim();
        if (!t) return;
        if (handle && setToastText(handle, t)) { armAutoHide(); return; }
        closeToast(deps.getToastr, handle);
        handle = null;
        const toastr = deps.getToastr();
        const fn = toastr && typeof toastr[level] === 'function' ? toastr[level] : null;
        // onClick 恒挂：未给回调时点击＝只关通知（toastr 的 onclick 分支自带 hideToast）
        handle = fn ? fn.call(toastr, t, title, {
          ...PERSIST_OPTS,
          onclick: () => { try { opts?.onClick?.(); } catch (_e) { /* 终止动作失败不影响通知 */ } },
        }) : null;
        if (handle) armAutoHide();
      } catch (_e) { /* 通知失败不影响主流程 */ }
    },
    close,
  };
}

/** 一次性常驻通知（warning / error）：同「级别|文案」窗口期内去重，只能手动点关闭。 */
export interface PersistentNotifier {
  notify(level: 'warning' | 'error', message: string): void;
}

export function createPersistentNotifier(deps: { getToastr(): any; title?: string; now?: () => number }): PersistentNotifier {
  const title = deps.title || '瑟瑟台账';
  const suppressed = createDedup(deps.now || (() => Date.now()));
  return {
    notify(level, message) {
      try {
        const text = String(message || '').trim();
        if (!text) return;
        if (suppressed(`${level}|${text}`)) return;
        const toastr = deps.getToastr();
        const fn = toastr && typeof toastr[level] === 'function' ? toastr[level] : null;
        if (fn) fn.call(toastr, text, title, { ...PERSIST_OPTS });
      } catch (_e) { /* ignore */ }
    },
  };
}

/** 当前在跑请求的快照（横幅 / 悬浮钮动效的数据源；只读、副本）。 */
export interface FillRunningEntry {
  label: string;
  attempt: number;
  maxAttempts: number;
}

export interface FillNotifier {
  /** 进度：attempt 原位改文案（句柄失效自动重建；同批多分组并发＝并排显示），请求收尾摘该条，end 全清。 */
  progress(event: FillProgressEvent): void;
  /** 失败：常驻 error（去重键 = 文案）。 */
  fail(message: string): void;
  /** 当前在跑请求（副本；与进度 toast 共用同一份 running Map，不另建状态源）。 */
  runningEntries(): FillRunningEntry[];
}

export function createFillNotifier(deps: ProgressPersistOpts & { getToastr(): any; title?: string; now?: () => number; onTerminate?: () => void }): FillNotifier {
  // 只有进度通知跟随「填表/推进持久化」；失败告警恒常驻（必须看到）。
  const toast = createProgressToast({
    getToastr: deps.getToastr,
    title: deps.title,
    isPersistent: deps.isPersistent,
    autoHideMs: deps.autoHideMs,
    setTimer: deps.setTimer,
    clearTimer: deps.clearTimer,
  });
  const persist = createPersistentNotifier({ getToastr: deps.getToastr, title: deps.title, now: deps.now });
  /** 在跑请求（key → 当前尝试）：同批各分组并发跑时**并排显示在同一条常驻通知里**，谁先收尾谁摘掉。 */
  const running = new Map<string, FillRunningEntry>();
  function render(): void {
    if (running.size === 0) { toast.close(); return; }
    const list = [...running.values()];
    const text = list.length === 1
      ? fillProgressText(list[0])
      : `${list.map((e) => fillProgressEntryText(e.label, e.attempt, e.maxAttempts)).join(' ｜ ')}（点击终止）`;
    toast.show(text, { onClick: deps.onTerminate });
  }
  return {
    progress(event) {
      if (!event || event.phase === 'end') {
        const key = String(event?.key || event?.label || '').trim();
        if (key) running.delete(key); else running.clear();
        render();
        return;
      }
      const label = String(event.label || '填表').trim() || '填表';
      const key = String(event.key || label);
      running.set(key, { label, attempt: Number(event.attempt) || 1, maxAttempts: Number(event.maxAttempts) || Number(event.attempt) || 1 });
      render();
    },
    fail(message) { persist.notify('error', message); },
    runningEntries() { return [...running.values()].map((e) => ({ ...e })); },
  };
}
