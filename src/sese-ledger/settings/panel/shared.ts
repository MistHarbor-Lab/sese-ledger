// ===== 工作台共享：依赖类型 / CSS（像素级移植自历史工作台对照稿，已清理）/ DOM 助手 =====
import type { LedgerRuntime } from '../../core/runtime';
import type { SettingsStore } from '../../core/settings-store';
import type { HostConfigBridge } from '../../core/host-config';
import type { LedgerLog } from '../../core/ledger-log';
import type { LedgerTemplateV2 } from '../../core/types';
import type { DriverPromptMessage } from '../../core/director';
import { LEDGER_BLOCK_LABELS, type LedgerBlockId, type LedgerPromptItemSpec, type LedgerTableBlockConfig } from '../../core/ai-request';
import type { TabCtx } from './shell';
import { projectWorkbook, specialFormOf, type BookModel } from '../../core/book';
import { workbookToV2Template } from '../../core/blueprint';

export interface WorkbenchDeps {
  window: Window;
  settings: SettingsStore;
  runtime: LedgerRuntime;
  canonical: any;
  hostConfig: HostConfigBridge;
  realDbPresent: boolean;
  standardPresetName: string;
  standardTemplateV2: LedgerTemplateV2;
  notify(message: string): void;
  warn(message: string): void;
  /** 运行日志（日志页数据源：只存内存，刷新 / 重载即空）。 */
  log: LedgerLog;
  getChat(): any[];
  /** 刷新世界书投影；opts.force=true 绕过「未变更跳过」门（显式刷新按钮用）。 */
  refreshWorldbook(opts?: { force?: boolean }): Promise<boolean> | void;
  requestAiMessages(messages: DriverPromptMessage[], opts?: { signal?: AbortSignal }): Promise<string>;
  diagWorldbook(): { count: number; at: number };
}

export function esc(text: unknown): string {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

export function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, attrs?: Record<string, string | boolean>, html?: string): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === true) node.setAttribute(k, '');
      else if (v !== false && v !== undefined && v !== null) node.setAttribute(k, String(v));
    }
  }
  if (html !== undefined) node.innerHTML = html;
  return node;
}

/** 下载 JSON（导出用）。锚点建在**工作台宿主文档**（parent），不在隐藏 iframe 里触发下载。 */
export function downloadJsonFile(deps: WorkbenchDeps, filename: string, value: unknown): void {
  try {
    const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const doc = workbenchDoc(deps);
    const a = doc.createElement('a');
    a.href = url;
    a.download = filename;
    doc.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 1000);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (_e) { /* ignore */ }
}

/** 读本地 JSON 文件（导入用）。input 建在**工作台宿主文档**，避免隐藏 iframe 在移动端被拦截。
 *  H5：点取消也要正常结束并清理。现代内核用 `cancel` 事件；旧内核用窗口重新聚焦兜底（1.5s 后仍无文件）。
 *  解析前剥 BOM：部分编辑器/下载链路会给 UTF-8 文件加 BOM，JSON.parse 会直接失败。 */
export function pickJsonFile(deps: WorkbenchDeps, accept: string): Promise<any | null> {
  return new Promise((resolve) => {
    try {
      const doc = workbenchDoc(deps);
      const win = doc.defaultView || deps.window;
      const input = doc.createElement('input');
      input.type = 'file';
      input.accept = accept;
      input.style.position = 'fixed';
      input.style.left = '-9999px';
      input.style.top = '0';
      let settled = false;
      function finish(value: any | null): void {
        if (settled) return;
        settled = true;
        try { win.removeEventListener('focus', onFocus); } catch (_e) { /* ignore */ }
        try { input.remove(); } catch (_e) { /* ignore */ }
        resolve(value);
      }
      function onFocus(): void {
        setTimeout(() => {
          if (!settled && (!input.files || input.files.length === 0)) finish(null);
        }, 1500);
      }
      input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file) { finish(null); return; }
        try {
          const text = (await file.text()).replace(/^\uFEFF/, '');
          finish(JSON.parse(text));
        } catch (e) {
          deps.warn(`JSON 解析失败：${e instanceof Error ? e.message : String(e)}`);
          finish(null);
        }
      });
      input.addEventListener('cancel', () => finish(null));
      win.addEventListener('focus', onFocus);
      doc.body.appendChild(input);
      input.click();
    } catch (_e) {
      resolve(null);
    }
  });
}

// ===== 说明块折叠（紧凑模式） =====
// 工作台里大量 .slw-annot 在手机上是十几行说明，会把操作按钮推到很远的下面。
// 这里把普通 div.slw-annot 原地升级成 details：桌面 open + 隐藏 summary（视觉与原 div 一致），
// 紧凑模式显示 summary 并默认收起。只改 DOM 结构，不改文案与引擎逻辑。
/** 只在「紧凑状态真的变化」时改 open，键盘引起的高度变化不会把用户刚展开的卡片又收起。 */
function applyCompactOpen(details: HTMLDetailsElement, compact: boolean): void {
  const state = compact ? '1' : '0';
  if (details.getAttribute('data-slw-compact-state') === state) return;
  details.setAttribute('data-slw-compact-state', state);
  details.open = !compact;
}

export function decorateAnnotations(root: HTMLElement, compact: boolean): void {
  const nodes = Array.from(root.querySelectorAll<HTMLElement>('.slw-annot'));
  for (const node of nodes) {
    if (node.tagName === 'DETAILS') continue;
    const doc = node.ownerDocument;
    const details = doc.createElement('details');
    details.className = `${node.className} slw-annot-details`.trim();
    const style = node.getAttribute('style');
    if (style) details.setAttribute('style', style);
    const summary = doc.createElement('summary');
    summary.textContent = '说明';
    const body = doc.createElement('div');
    body.className = 'slw-annot-body';
    while (node.firstChild) body.appendChild(node.firstChild);
    details.appendChild(summary);
    details.appendChild(body);
    applyCompactOpen(details, compact);
    node.replaceWith(details);
  }
  root.querySelectorAll<HTMLDetailsElement>('details.slw-annot-details').forEach((d) => {
    applyCompactOpen(d, compact);
  });
}

// ===== 大编辑卡片折叠（紧凑模式） =====
// 填表提示词 / 推进预设编辑在手机上是数屏长表单。这里把 h3 之后的内容包进 details：
// 桌面 open + 隐藏 summary（视觉与原卡片一致），紧凑模式只留标题 +「展开…」一行。
// 只移动节点、不克隆，节点上已绑定的事件处理器保持有效。
export function decorateCollapsibleCards(root: HTMLElement, compact: boolean): void {
  const cards = Array.from(root.querySelectorAll<HTMLElement>('.slw-collapsible-card'));
  for (const card of cards) {
    let body = Array.from(card.children).find(
      (n) => n.tagName === 'DETAILS' && n.classList.contains('slw-collapse-body'),
    ) as HTMLDetailsElement | undefined;
    if (!body) {
      const h3 = Array.from(card.children).find((n) => n.tagName === 'H3') as HTMLElement | undefined;
      if (!h3) continue;
      const doc = card.ownerDocument;
      body = doc.createElement('details');
      body.className = 'slw-collapse-body';
      const summary = doc.createElement('summary');
      summary.textContent = card.getAttribute('data-collapse-label') || '展开编辑';
      body.appendChild(summary);
      let node = h3.nextSibling;
      while (node) {
        const next = node.nextSibling;
        body.appendChild(node);
        node = next;
      }
      h3.after(body);
    }
    applyCompactOpen(body, compact);
  }
}

// ===== 工作台弹窗（原生 confirm / alert / prompt 的统一替代） =====
// 原生浏览器对话框（标题是 `127.0.0.1:8000` 那种、样式与宿主主题无关、且阻塞整页）在工作台里一律换成同一套
// `.slw-dialog` 壳：单实现 `openSlwModal` 收敛（标题 + 消息 + 可选输入框 + 确定/取消），三个入口只是它的三种读法。
// 遮罩/关闭口径与既有配置弹窗一致：点遮罩 = 取消、✕ = 取消、Esc = 取消、Enter = 确定。

export interface SlwDialogOpts {
  /** 标题（缺省「瑟瑟台账」）。 */
  title?: string;
  okText?: string;
  cancelText?: string;
  /** 危险操作：确定按钮走 danger 皮肤（删除/清空/回滚这类不可恢复动作）。 */
  danger?: boolean;
  /** 单按钮形态（alertDialog 用）：不出取消按钮。 */
  okOnly?: boolean;
  /** 输入框形态（promptDialog 用）：给了 value 或 placeholder 即渲染输入框。 */
  value?: string;
  placeholder?: string;
}

/** 工作台宿主文档（与 shell 同口径：TH 脚本跑在隐藏 iframe 里，fixed 定位挂自己 document 上不可见）。 */
export function workbenchDoc(deps: WorkbenchDeps): Document {
  try {
    const p = (deps.window as any).parent;
    if (p?.document?.body) return p.document as Document;
  } catch (_e) { /* cross-origin */ }
  return deps.window.document;
}

/** 弹窗内容（纯函数：标题行 + 消息体 + 可选输入框 + 按钮行）——消息体 `pre-wrap`，原生 `\n` 排版原样保留。 */
export function slwDialogBody(message: string, opts: SlwDialogOpts = {}): string {
  const withInput = opts.value !== undefined || opts.placeholder !== undefined;
  const danger = opts.danger === true && opts.okOnly !== true;
  return `
    <h3>${esc(opts.title || '瑟瑟台账')} <button class="x" type="button" data-slw-ask-cancel style="float:right;background:none;border:0;color:#8b8676;font-size:16px;cursor:pointer">✕</button></h3>
    <div class="slw-msg">${esc(message)}</div>
    ${withInput ? `<div class="slw-row"><input type="text" data-slw-ask-input value="${esc(opts.value ?? '')}" placeholder="${esc(opts.placeholder ?? '')}" style="flex:1;min-width:0"></div>` : ''}
    <div class="slw-row" style="justify-content:flex-end;margin-top:12px">
      ${opts.okOnly === true ? '' : `<button class="slw-btn" type="button" data-slw-ask-cancel>${esc(opts.cancelText || '取消')}</button>`}
      <button class="slw-btn ${danger ? 'danger' : 'primary'}" type="button" data-slw-ask-ok>${esc(opts.okText || '确定')}</button>
    </div>`;
}

/** 同屏单例收口：脚本重注入会新建一份模块实例，旧实例的弹窗还在 parent 文档里（遮罩 z-index 10040 挡住宿主输入）。 */
let openModalCloser: ((value: string | null) => void) | null = null;

/** 统一模态核心：取消/✕/遮罩/Esc → null；确定 → 输入框当前值（无输入框时为空串）。 */
export function openSlwModal(deps: WorkbenchDeps, message: string, opts: SlwDialogOpts = {}): Promise<string | null> {
  const doc = workbenchDoc(deps);
  openModalCloser?.(null);
  try { doc.querySelectorAll('[data-slw-ask]').forEach((n) => n.remove()); } catch (_e) { /* ignore */ }
  return new Promise((resolve) => {
    let settled = false;
    const readInput = (): string | null => {
      const input = dialog.querySelector('[data-slw-ask-input]') as HTMLInputElement | null;
      return input ? input.value : null;
    };
    const close = (value: string | null): void => {
      if (settled) return;
      settled = true;
      if (openModalCloser === close) openModalCloser = null;
      try { doc.removeEventListener('keydown', onKey, true); } catch (_e) { /* ignore */ }
      mask.remove();
      resolve(value);
    };
    const onKey = (e: KeyboardEvent): void => {
      // 中文输入法选词/组合期间的回车不提交（H1：否则选词会被当成「确定」）。
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape') { e.preventDefault(); close(null); return; }
      if (e.key === 'Enter' && !e.shiftKey) {
        // 焦点在「取消」按钮上：放行原生点击，不能把取消变成确定（危险弹窗尤其重要）。
        const active = doc.activeElement as HTMLElement | null;
        if (active?.closest?.('[data-slw-ask-cancel]')) return;
        e.preventDefault();
        close(readInput() ?? '');
      }
    };
    const mask = el(doc, 'div', { class: 'slw-dialog-mask', 'data-slw-ask': '1' });
    const dialog = el(doc, 'div', { class: 'slw-dialog' }, slwDialogBody(message, opts));
    mask.appendChild(dialog);
    dialog.querySelectorAll('[data-slw-ask-ok]').forEach((b) => { (b as HTMLElement).onclick = () => close(readInput() ?? ''); });
    dialog.querySelectorAll('[data-slw-ask-cancel]').forEach((b) => { (b as HTMLElement).onclick = () => close(null); });
    mask.addEventListener('click', (e) => { if (e.target === mask) close(null); });
    doc.body.appendChild(mask);
    doc.addEventListener('keydown', onKey, true);
    (dialog.querySelector('[data-slw-ask-input]') as HTMLInputElement | null)?.focus();
    openModalCloser = close;
  });
}

/** 确认框（替代 `window.confirm`）：确定 → true，取消/✕/遮罩/Esc → false。 */
export async function confirmDialog(deps: WorkbenchDeps, message: string, opts: SlwDialogOpts = {}): Promise<boolean> {
  return (await openSlwModal(deps, message, opts)) !== null;
}

/** 输入框（替代 `window.prompt`）：取消/✕/遮罩/Esc → null，确定 → 当前输入值（可为空串）。 */
export function promptDialog(deps: WorkbenchDeps, message: string, value = '', opts: SlwDialogOpts = {}): Promise<string | null> {
  return openSlwModal(deps, message, { ...opts, value });
}

/** 提示框（替代 `window.alert`）：只有一个确定按钮。 */
export async function alertDialog(deps: WorkbenchDeps, message: string, opts: SlwDialogOpts = {}): Promise<void> {
  await openSlwModal(deps, message, { ...opts, okOnly: true });
}

// ===== 大编辑弹窗（填表预设 / 推进预设共用） =====
// 与 openSlwModal 同一套遮罩口径，但结构固定为：标题 → 工具条 → 独立滚动正文 → 固定底栏。
// 两个编辑器只提供 content / actions，尺寸、安全区、关闭确认、单例、ESC 让行都在这里收口。

export interface EditorDialogOpts {
  title: string;
  subtitle?: string;
  /** 工具条 HTML（可空；按钮由调用方在返回的 handle.root 里绑定）。 */
  toolbar?: string;
  /** 正文容器（调用方建好并绑定事件；只挂载、不重建）。 */
  content: HTMLElement;
  /** 底部操作容器（调用方建好并绑定事件）。 */
  actions: HTMLElement;
  /** 关闭前确认：返回 false 取消关闭；返回 Promise 时等待。 */
  beforeClose?: () => boolean | Promise<boolean>;
  onClosed?: () => void;
}

export interface EditorDialogHandle {
  root: HTMLElement;
  content: HTMLElement;
  actions: HTMLElement;
  /** 更新标题/副标题（导入/新建后换预设名用）。 */
  setTitle(title: string, subtitle?: string): void;
  /** 请求关闭（走 beforeClose；✕/遮罩/ESC/取消按钮都用它）。 */
  requestClose(): void;
  /** 强制关闭（保存成功后用）。 */
  close(force?: boolean): void;
  /** 是否有子弹窗（确认框 / 表数据块 / 标签多选）打开。 */
  hasNestedDialog(): boolean;
}

let openEditorCloser: (() => void) | null = null;

/** 大编辑弹窗：内容区独立滚动，标题/工具条/底部操作始终可见。 */
export function openEditorDialog(deps: WorkbenchDeps, opts: EditorDialogOpts): EditorDialogHandle {
  const doc = workbenchDoc(deps);
  openEditorCloser?.();
  // 脚本重注入会留下旧实例的编辑器遮罩；这里一并清掉（旧实例的 keydown 自带 isConnected 自清）。
  try { doc.querySelectorAll('[data-slw-editor]').forEach((n) => n.remove()); } catch (_e) { /* ignore */ }

  const mask = el(doc, 'div', { class: 'slw-dialog-mask slw-editor-mask', 'data-slw-editor': '1' });
  const dialog = el(doc, 'div', { class: 'slw-dialog slw-editor', role: 'dialog', 'aria-modal': 'true' });
  dialog.innerHTML = `
    <div class="slw-editor-head">
      <div class="slw-editor-title"><h3>${esc(opts.title)}</h3><div class="sub">${esc(opts.subtitle || '')}</div></div>
      <button class="x" type="button" aria-label="关闭">✕</button>
    </div>
    ${opts.toolbar ? `<div class="slw-editor-toolbar">${opts.toolbar}</div>` : ''}
    <div class="slw-editor-body"></div>
    <div class="slw-editor-foot"></div>`;
  const body = dialog.querySelector('.slw-editor-body') as HTMLElement;
  const foot = dialog.querySelector('.slw-editor-foot') as HTMLElement;
  body.appendChild(opts.content);
  opts.actions.classList.add('slw-editor-actions');
  foot.appendChild(opts.actions);
  mask.appendChild(dialog);
  doc.body.appendChild(mask);

  let settled = false;
  let closing = false;
  let cleaned = false;

  function cleanup(): void {
    if (cleaned) return;
    cleaned = true;
    try { doc.removeEventListener('keydown', onKey, true); } catch (_e) { /* ignore */ }
    mask.remove();
    if (openEditorCloser === forceClose) openEditorCloser = null;
    opts.onClosed?.();
  }

  function forceClose(): void {
    if (settled) return;
    settled = true;
    cleanup();
  }

  function requestClose(): void {
    if (settled || closing) return;
    closing = true;
    Promise.resolve()
      .then(() => (opts.beforeClose ? opts.beforeClose() : true))
      .then((ok) => {
        if (!ok) return;
        settled = true;
        cleanup();
      })
      .catch((err) => {
        deps.warn('关闭编辑器失败：' + (err instanceof Error ? err.message : String(err)));
      })
      .finally(() => { closing = false; });
  }

  const onKey = (e: KeyboardEvent): void => {
    // 旧实例的遮罩已被移除时自清监听（脚本重注入场景）。
    if (!mask.isConnected) {
      try { doc.removeEventListener('keydown', onKey, true); } catch (_e) { /* ignore */ }
      return;
    }
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key !== 'Escape') return;
    // 子弹窗（确认框 / 表数据块 / 标签多选）在上面时让行，避免一次 ESC 连关两层。
    if (doc.querySelectorAll('.slw-dialog-mask').length > 1) return;
    e.preventDefault();
    requestClose();
  };

  dialog.querySelector('.slw-editor-head .x')?.addEventListener('click', requestClose);
  mask.addEventListener('click', (e) => { if (e.target === mask) requestClose(); });
  doc.addEventListener('keydown', onKey, true);
  openEditorCloser = forceClose;

  return {
    root: dialog,
    content: opts.content,
    actions: opts.actions,
    setTitle(title: string, subtitle?: string) {
      const h3 = dialog.querySelector('.slw-editor-head h3');
      const sub = dialog.querySelector('.slw-editor-head .sub');
      if (h3) h3.textContent = title;
      if (sub) sub.textContent = subtitle || '';
    },
    requestClose,
    close(force = false) {
      if (force) forceClose();
      else requestClose();
    },
    hasNestedDialog() {
      return doc.querySelectorAll('.slw-dialog-mask').length > 1;
    },
  };
}

/** 面板关闭时统一回收：确认框 Promise、编辑器监听、残留遮罩（含表数据块等子弹窗）。 */
export function closeTransientDialogs(doc: Document): void {
  try { openModalCloser?.(null); } catch (_e) { /* ignore */ }
  try { openEditorCloser?.(); } catch (_e) { /* ignore */ }
  try { doc.querySelectorAll('.slw-dialog-mask').forEach((n) => n.remove()); } catch (_e) { /* ignore */ }
}

/** 可用的派生预设名（避免撞名；内置模板不可改 → 结构编辑落到派生模板并改绑本卡）。 */
function derivedPresetName(deps: WorkbenchDeps, base: string): string {
  const taken = new Set(deps.settings.listTemplatePresetNames());
  const stamp = new Date().toISOString().slice(0, 10);
  let name = `${base}·派生 ${stamp}`;
  let i = 2;
  while (taken.has(name)) { name = `${base}·派生 ${stamp}-${i}`; i += 1; }
  return name;
}

/** 把当前账本回写成 v2 模板，写回**本聊天生效的模板**（＝角色卡绑定的预设；绑定内置/无卡上下文时回落全局默认预设）。
 *  绑定指向内置标准模板时：内置不可写 → 自动另存为派生预设 + 改绑本角色卡（结构编辑不落空、也不污染内置）。 */
export async function writeBackCurrentPreset(ctx: TabCtx): Promise<boolean> {
  const { deps } = ctx;
  const binding = deps.canonical?.templateBinding;
  const boundOrEmpty = String(binding?.name?.() || deps.settings.get().defaultTemplatePreset || '');
  const book = deps.runtime.book();
  if (!book) return false;
  if (!boundOrEmpty || boundOrEmpty === deps.standardPresetName) {
    if (!binding?.set) return false;
    const derived = derivedPresetName(deps, '默认模板');
    const v2Derived = workbookToV2Template(projectWorkbook(book), derived);
    if (!v2Derived) return false;
    await deps.settings.saveTemplatePreset(derived, JSON.stringify(v2Derived));
    const r = binding.set(derived);
    if (r?.ok === false) { deps.warn(r.message || '改绑派生模板失败'); return false; }
    deps.notify(`内置模板不可改：已另存为「${derived}」并改绑本角色卡`);
    return true;
  }
  const v2 = workbookToV2Template(projectWorkbook(book), boundOrEmpty);
  if (!v2) return false;
  await deps.settings.saveTemplatePreset(boundOrEmpty, JSON.stringify(v2));
  return true;
}

// ===== 全局数据表 / 纪要表分组一致性（时间跨度依赖「同一批请求」） =====
// 纪要表的时间跨度由引擎写成「上一条结束 ~ 本轮全局当前时间」；两张表不在同一分组时，
// 填表会拆成两次请求，纪要只能取到全局表上一次的当前时间。分组保存前统一告警并确认。

const GLOBAL_TABLE_NAME = '全局数据表';

export interface SummaryGroupAssignment {
  name: string;
  tableId: string;
  groupId: number;
  isSummary: boolean;
}

export interface SummaryGroupConflict {
  global: SummaryGroupAssignment;
  summary: SummaryGroupAssignment;
}

/** 从当前账本取两张表的拟分组（overrides 用于保存前的未落盘改动；按 tableId 覆盖）。 */
export function summaryGroupAssignmentsOfBook(
  book: BookModel,
  overrides?: { tableId: string; groupId: number }[],
): SummaryGroupAssignment[] {
  const out: SummaryGroupAssignment[] = [];
  for (const t of book.tables.values()) {
    const isSummary = specialFormOf(t.name, t.v2def) === 'summary';
    if (t.name !== GLOBAL_TABLE_NAME && !isSummary) continue;
    const override = overrides?.find((o) => o.tableId === t.tableId);
    out.push({
      name: t.name,
      tableId: t.tableId,
      groupId: Number(override ? override.groupId : (t.v2def?.groupId ?? t.updateConfig?.groupId ?? 0)),
      isSummary,
    });
  }
  return out;
}

/** 从待套用的 v2 模板取两张表的分组（模板切换/导入预检用）。 */
export function summaryGroupAssignmentsOfV2(v2: LedgerTemplateV2 | null | undefined): SummaryGroupAssignment[] {
  const tables = Array.isArray(v2?.tables) ? v2!.tables : [];
  return tables
    .filter((t) => t.name === GLOBAL_TABLE_NAME || specialFormOf(t.name, t) === 'summary')
    .map((t) => ({
      name: t.name,
      tableId: String(t.tableId || ''),
      groupId: Number(t.groupId ?? 0),
      isSummary: specialFormOf(t.name, t) === 'summary',
    }));
}

/** 两张表都在且分组不同 → 冲突；缺一张或同组 → null。 */
export function findSummaryGroupConflict(assignments: SummaryGroupAssignment[]): SummaryGroupConflict | null {
  const global = assignments.find((a) => !a.isSummary && a.name === GLOBAL_TABLE_NAME);
  const summary = assignments.find((a) => a.isSummary);
  if (!global || !summary) return null;
  if (Number(global.groupId) === Number(summary.groupId)) return null;
  return { global, summary };
}

function groupLabelOf(groups: { id: number; name: string }[], id: number): string {
  const g = groups.find((x) => Number(x.id) === Number(id));
  return `分组${id}${g?.name ? ' · ' + g.name : ''}`;
}

/** 分组保存前的统一确认：返回 true＝继续保存；false＝取消本次保存（调用方不得落盘）。 */
export async function confirmSummaryGroupSplit(
  ctx: TabCtx,
  assignments: SummaryGroupAssignment[],
  groups: { id: number; name: string }[],
): Promise<boolean> {
  const conflict = findSummaryGroupConflict(assignments);
  if (!conflict) return true;
  const message = [
    `${conflict.global.name}在「${groupLabelOf(groups, conflict.global.groupId)}」，${conflict.summary.name}在「${groupLabelOf(groups, conflict.summary.groupId)}」。`,
    '两张表不在同一分组：填表不会在同一批请求里更新全局数据表，纪要表的时间跨度只能取到上一次的全局当前时间，取不到本轮刚填出来的时间。',
    '仍要保存吗？',
  ].join('\n');
  return confirmDialog(ctx.deps, message, { title: '分组提醒', okText: '仍然保存', cancelText: '返回调整' });
}

/** 结构/分组编辑统一收尾：**不落增量日志**（结构真源＝模板，见 src/sese-ledger/docs/台账增量语义与模板真源实施案.md §5）
 *  → 回写本聊天绑定模板（内置时自动另存派生预设并改绑）→ 刷新投影与表格页。 */
export function commitTemplateEdit(ctx: TabCtx, notifyText?: string): void {
  const { deps } = ctx;
  const book = deps.runtime.book();
  if (!book) return;
  void writeBackCurrentPreset(ctx);
  // 单次重渲：structureChanged 已在表格页激活时 renderPane('tables')（G2）。
  ctx.structureChanged();
  if (notifyText) deps.notify(notifyText);
}

export const LEDGER_VERSION_LABEL = 'SeseLedger V2.031';

// ===== 提示词段 + 固定块 混排编辑器（填表 / 推进共用同一套交互） =====

export interface PromptEditorOpts {
  /** 列表容器（每次 render() 重写其 innerHTML）。 */
  box: HTMLElement;
  /** 底部动作行容器（＋添加段 / 插入固定块 / 占位符提示）。 */
  actions: HTMLElement;
  /** 内容项清单（就地修改）。 */
  items: LedgerPromptItemSpec[];
  /** 可插入的固定块（顺序＝插入菜单顺序）。 */
  blockIds: LedgerBlockId[];
  /** 固定块说明文案（缺省用块名）。 */
  hints?: Partial<Record<LedgerBlockId, string>>;
  /** 允许「表数据块」的配置按钮（推进侧 true；填表侧无表数据块）。 */
  allowTableBlock?: boolean;
  /** 占位符提示（渲染在动作行右侧）。 */
  placeholderHint?: string;
  /** 结构变化后回调（外层如需同步别的视图）。 */
  onChange?: () => void;
  /** 打开表数据块配置（由调用方弹窗；缺省无「配置」按钮）。 */
  onConfigTableBlock?: (index: number) => void;
  /** 打开上轮推进结果块的标签多选（由调用方弹窗；缺省无按钮）。 */
  onConfigPrevDirective?: (index: number) => void;
}

/** 表数据块配置摘要（块行上的一句话说明）。 */
export function tableBlockSummary(cfg: LedgerTableBlockConfig | undefined): string {
  if (!cfg || !cfg.table) return '尚未配置：点「配置」选表与取值列';
  const match = cfg.matchColumn && String(cfg.matchValue ?? '').trim()
    ? `${cfg.matchColumn}＝${cfg.matchValue}`
    : '整表投影';
  const value = cfg.valueColumn ? `→ 取「${cfg.valueColumn}」` : '';
  return `${cfg.table} · ${match}${value}（取不到时该块不出条）`;
}

/** 上轮推进结果块的标签多选摘要（块行上的一句话说明）。 */
export function prevDirectiveSummary(tags: string[] | undefined): string {
  const list = (tags || []).map((t) => String(t).trim()).filter(Boolean);
  return list.length ? `注入标签：${list.join('、')}` : '未选择标签（整块不出）';
}

/** 挂载段+块混排编辑器：段＝可改/可增删/可换 role/可隐藏；固定块＝只能改顺序与显隐（内容引擎生成）。 */
export function mountPromptEditor(o: PromptEditorOpts): { render: () => void } {
  const { box, actions, items } = o;
  function render(): void {
    box.innerHTML = items.map((m, i) => {
      if (m.block) {
        const id = m.block;
        const off = m.hidden === true;
        const base = o.hints?.[id] || '';
        const hint = id === 'tableData'
          ? tableBlockSummary(m.table)
          : id === 'prevDirective'
            ? `${base}${base ? ' · ' : ''}${prevDirectiveSummary(m.tags)}`
            : base;
        return `
        <div class="slw-blockrow${off ? ' off' : ''}">
          <span class="slw-tag info">固定块</span>
          <b>${id === 'scan' ? '★ ' : ''}${esc(LEDGER_BLOCK_LABELS[id])}</b>
          <span class="slw-muted" style="flex:1;min-width:0">${esc(hint)}</span>
          <span class="slw-switch ${off ? '' : 'on'}" data-toggle="${i}" title="显示/隐藏该固定块（隐藏＝本轮请求不带它，顺序位保留）"></span>
          ${o.allowTableBlock && id === 'tableData' ? `<button class="slw-btn sm" data-cfg="${i}">配置</button>` : ''}
          ${o.onConfigPrevDirective && id === 'prevDirective' ? `<button class="slw-btn sm" data-cfg-prev="${i}">选择标签</button>` : ''}
          <button class="slw-btn sm" data-up="${i}">↑</button><button class="slw-btn sm" data-down="${i}">↓</button>
        </div>`;
      }
      const off = m.hidden === true;
      return `
      <div class="slw-itemrow"${off ? ' style="opacity:.55"' : ''}>
        <div class="slw-row" style="margin:0 0 4px">
          <select data-role="${i}" style="width:92px">
            <option value="system" ${m.role === 'system' ? 'selected' : ''}>system</option>
            <option value="user" ${m.role !== 'system' && m.role !== 'assistant' ? 'selected' : ''}>user</option>
            <option value="assistant" ${m.role === 'assistant' ? 'selected' : ''}>assistant</option>
          </select>
          ${off ? '<span class="slw-tag dim">已隐藏</span>' : ''}
          <span style="flex:1"></span>
          <span class="slw-switch ${off ? '' : 'on'}" data-toggle="${i}" title="显示/隐藏该段"></span>
          <button class="slw-btn sm" data-up="${i}">↑</button><button class="slw-btn sm" data-down="${i}">↓</button>
          <button class="slw-btn sm danger" data-del="${i}">删</button>
        </div>
        <textarea rows="8" data-text="${i}" placeholder="段内容（留空＝该段不出条）">${esc(m.content || '')}</textarea>
      </div>`;
    }).join('') || '<div class="slw-muted">（无内容项：只发结构头与输出要求句）</div>';

    const present = new Set(items.map((m) => m.block).filter(Boolean) as LedgerBlockId[]);
    const missing = o.blockIds.filter((id) => !present.has(id));
    actions.innerHTML = `
      <button class="slw-btn sm" data-add="top">＋ 在顶部添加段</button>
      <button class="slw-btn sm" data-add="bottom">＋ 在底部添加段</button>
      <select data-block-pick style="width:150px"${missing.length === 0 ? ' disabled' : ''}>
        ${missing.length === 0
          ? '<option>（固定块已全部插入）</option>'
          : missing.map((id) => `<option value="${id}">${esc(LEDGER_BLOCK_LABELS[id])}</option>`).join('')}
      </select>
      <button class="slw-btn sm" data-block-add${missing.length === 0 ? ' disabled' : ''}>＋ 插入固定块</button>
      ${o.placeholderHint ? `<span class="slw-muted">${esc(o.placeholderHint)}</span>` : ''}`;

    const indexOf = (n: Element, key: string): number => Number((n as HTMLElement).dataset[key]);
    const redraw = (): void => { render(); o.onChange?.(); };
    box.querySelectorAll('[data-role]').forEach((n) => n.addEventListener('change', (e) => {
      items[indexOf(n, 'role')].role = (e.target as HTMLSelectElement).value;
      o.onChange?.();
    }));
    // 用 input 而不是 change：焦点还在 textarea 里就点关闭时，草稿也必须是最新的
    box.querySelectorAll('[data-text]').forEach((n) => n.addEventListener('input', (e) => {
      items[indexOf(n, 'text')].content = (e.target as HTMLTextAreaElement).value;
      o.onChange?.();
    }));
    box.querySelectorAll('[data-del]').forEach((n) => (n as HTMLElement).onclick = () => { items.splice(indexOf(n, 'del'), 1); redraw(); });
    // 显隐（段与块共用同一开关语义）
    box.querySelectorAll('[data-toggle]').forEach((n) => (n as HTMLElement).onclick = () => {
      const i = indexOf(n, 'toggle');
      items[i].hidden = items[i].hidden !== true;
      redraw();
    });
    const move = (i: number, delta: number): void => {
      const to = i + delta;
      if (!Number.isFinite(i) || to < 0 || to >= items.length) return;
      [items[i], items[to]] = [items[to], items[i]];
      redraw();
    };
    box.querySelectorAll('[data-up]').forEach((n) => (n as HTMLElement).onclick = () => move(indexOf(n, 'up'), -1));
    box.querySelectorAll('[data-down]').forEach((n) => (n as HTMLElement).onclick = () => move(indexOf(n, 'down'), 1));
    box.querySelectorAll('[data-cfg]').forEach((n) => (n as HTMLElement).onclick = () => o.onConfigTableBlock?.(indexOf(n, 'cfg')));
    box.querySelectorAll('[data-cfg-prev]').forEach((n) => (n as HTMLElement).onclick = () => o.onConfigPrevDirective?.(indexOf(n, 'cfgPrev')));
    actions.querySelector('[data-add="top"]')?.addEventListener('click', () => { items.unshift({ role: 'user', content: '' }); redraw(); });
    actions.querySelector('[data-add="bottom"]')?.addEventListener('click', () => { items.push({ role: 'user', content: '' }); redraw(); });
    actions.querySelector('[data-block-add]')?.addEventListener('click', () => {
      const pick = actions.querySelector('[data-block-pick]') as HTMLSelectElement | null;
      const id = pick?.value as LedgerBlockId | undefined;
      if (!id || !o.blockIds.includes(id)) return;
      items.push({ block: id });
      redraw();
    });
  }
  render();
  return { render };
}

// ===== CSS（.slw-root 作用域；变量与规则逐条对齐 mockup :root / 组件类） =====
export const WORKBENCH_CSS = `
/* 悬浮入口：移动端 SillyTavern 给 <html> 加 transform/perspective，fixed 的 right/bottom
   会相对被折叠的 html containing block（实测 ~80px）计算而飞出屏幕。与主项目悬浮球同口径：
   一律用 left/top + viewport 单位换算（26/110 = 桌面距右边/下边；46 = 按钮尺寸，须与 LAUNCHER_SIZE 同步）。 */
.slw-launcher{position:fixed;--slw-l-right:26px;--slw-l-bottom:110px;
  left:calc(100% - var(--slw-l-right) - 46px);
  top:calc(100vh - var(--slw-l-bottom) - 46px);
  top:calc(100dvh - var(--slw-l-bottom) - 46px);
  right:auto;bottom:auto;width:46px;height:46px;border-radius:50%;
  background:rgba(30,32,40,.95);color:#e8d9b0;border:1px solid rgba(232,217,176,.4);
  font-size:18px;cursor:grab;z-index:10035;box-shadow:0 4px 14px rgba(0,0,0,.45);
  touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent}
.slw-launcher:hover{background:rgba(48,52,64,.98)}
.slw-launcher.slw-launcher-dragging{cursor:grabbing}
/* 填表进行中：呼吸光晕（方案 A）。只切 .slw-launcher-filling 类；空闲时零动画。
   动画只改 box-shadow / transform / opacity，单元素 46px，合成开销可忽略。 */
.slw-launcher.slw-launcher-filling{animation:slw-launcher-halo 1.8s ease-in-out infinite}
.slw-launcher.slw-launcher-filling::after{content:'';position:absolute;inset:-7px;border-radius:50%;
  border:2px solid rgba(232,217,176,.55);pointer-events:none;animation:slw-launcher-halo-ring 1.8s ease-in-out infinite}
@keyframes slw-launcher-halo{
  0%,100%{box-shadow:0 4px 14px rgba(0,0,0,.45),0 0 0 0 rgba(232,217,176,0)}
  50%{box-shadow:0 4px 14px rgba(0,0,0,.45),0 0 20px 5px rgba(232,217,176,.38)}
}
@keyframes slw-launcher-halo-ring{0%,100%{transform:scale(.92);opacity:.2}50%{transform:scale(1.12);opacity:.85}}
@media (prefers-reduced-motion: reduce){
  .slw-launcher.slw-launcher-filling,.slw-launcher.slw-launcher-filling::after{animation:none}
}
/* 全屏壳：禁 inset:0 / height:100%（移动端 transformed html 会塌缩）；显式 100vh/100dvh + border-box。 */
.slw-root{position:fixed;top:0;left:0;width:100%;height:100vh;height:100dvh;box-sizing:border-box;
  background:rgba(0,0,0,.5);z-index:10036;display:flex;align-items:center;justify-content:center;padding:2vh 2vw}
/* ★调色板必须同时挂在两个壳上：弹窗（.slw-dialog）是 body 直挂、不是 .slw-root 的后代，
   只挂 .slw-root 时弹窗内所有 var(--panel/--text/--line…) 取值失败（背景透明、输入框无边） */
.slw-root,.slw-dialog{--bg:#1b1d24;--panel:#23252e;--panel2:#1d1f26;--card:#2a2d38;
  --line:rgba(232,217,176,.16);--line2:rgba(232,217,176,.28);
  --gold:#e8d9b0;--gold-dim:#c9b98a;--muted:#8b8676;--text:#dcd7cc;
  --danger:#e07a7a;--ok:#8fce8f;--info:#7fb3d5;
  --annot:rgba(232,180,80,.55)}
.slw-app{position:relative;width:100%;height:96vh;max-width:1120px;background:var(--panel);border:1px solid var(--line2);
  border-radius:14px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 18px 60px rgba(0,0,0,.55);
  font:13px/1.65 "Microsoft YaHei",system-ui,sans-serif;color:var(--text)}
.slw-app *{box-sizing:border-box}
.slw-head{display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid var(--line);flex:0 0 auto}
.slw-head .logo{width:26px;height:26px;border-radius:50%;background:rgba(48,52,64,.98);border:1px solid var(--line2);
  color:var(--gold);display:flex;align-items:center;justify-content:center;font-size:14px}
.slw-head .title{color:var(--gold);font-size:15px;font-weight:600}
.slw-head .meta{color:var(--muted);font-size:11.5px}
.slw-head .close{margin-left:auto;background:var(--card);color:var(--text);border:1px solid var(--line);border-radius:6px;padding:3px 12px;cursor:pointer;font-size:12px}
.slw-body{flex:1;display:flex;min-height:0}
.slw-rail{width:96px;border-right:1px solid var(--line);padding:10px 8px;display:flex;flex-direction:column;gap:4px;flex:0 0 auto}
.slw-rail button{background:transparent;border:0;color:var(--muted);font-size:12.5px;padding:9px 6px;border-radius:8px;cursor:pointer;text-align:center;line-height:1.4;font-family:inherit}
.slw-rail button .ic{display:block;font-size:17px;margin-bottom:2px}
.slw-rail button.on{background:rgba(232,217,176,.10);color:var(--gold)}
.slw-rail button:hover{color:var(--text)}
.slw-content{flex:1;overflow-y:auto;padding:16px 18px;min-width:0}
.slw-pane{display:none}
.slw-pane.on{display:block}
.slw-card{background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-bottom:14px}
.slw-card>h3{margin:0 0 10px;font-size:13.5px;color:var(--gold);border-bottom:1px solid var(--line);padding-bottom:6px;font-weight:600}
.slw-card>h3 .desc{font-size:11px;color:var(--muted);font-weight:400;margin-left:8px}
/* 预设摘要卡（填表 / 推进）：平时只留状态 + 编辑入口，长表单进大弹窗 */
.slw-preset-card{border-color:rgba(127,179,213,.30)}
.slw-preset-card .slw-preset-summary{flex:1;min-width:0;color:#b9b3a4;font-size:12px}
.slw-preset-card .slw-preset-summary b{color:var(--text);font-weight:600}
.slw-preset-card .slw-preset-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px}
.slw-preset-card .slw-preset-actions .slw-btn{flex:0 0 auto}
.slw-row{display:flex;align-items:center;gap:10px;margin:7px 0;flex-wrap:wrap}
.slw-row label{min-width:86px;color:#b9b3a4;font-size:12.5px}
/* 填表 API「按分组独立」：分组行只列频率 > 0 的分组；沿用/独立状态紧跟下拉 */
.slw-groupapi{border:1px solid var(--line2);border-radius:9px;background:rgba(0,0,0,.13);padding:10px 12px;margin:10px 0 4px}
.slw-groupapi-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-bottom:8px;border-bottom:1px dashed var(--line);margin-bottom:4px}
.slw-groupapi-head .t{color:var(--gold);font-size:12.5px;font-weight:600}
.slw-groupapi-head .slw-groupapi-base{margin-left:auto}
.slw-groupapi-row{display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid rgba(232,217,176,.07);flex-wrap:wrap}
.slw-groupapi-row:nth-last-of-type(2){border-bottom:0;padding-bottom:2px}
.slw-groupapi-row .g-name{display:flex;align-items:center;gap:8px;min-width:250px;flex:1}
.slw-groupapi-row .g-name b{color:var(--text);font-weight:600;font-size:12.5px}
.slw-groupapi-row select{min-width:288px}
.slw-groupapi-row .g-state{min-width:44px;text-align:right;color:var(--muted);font-size:11px}
.slw-groupapi-row.changed .g-state{color:var(--ok)}
.slw-groupapi-row.tavern .g-state{color:var(--info)}
.slw-groupapi-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px;padding-top:8px;border-top:1px dashed var(--line)}
.slw-groupapi-foot .slw-btn{margin-left:auto}
.slw-groupapi-empty{border:1px dashed var(--line2);border-radius:8px;padding:10px 12px;color:var(--muted);font-size:12px;margin:8px 0 2px}
.slw-app input[type=text],.slw-app input[type=number],.slw-app input[type=password],.slw-app select,.slw-app textarea,
.slw-editor input[type=text],.slw-editor input[type=number],.slw-editor input[type=password],.slw-editor select,.slw-editor textarea{
  background:#2e313c;border:1px solid var(--line);color:var(--text);border-radius:6px;padding:5px 9px;font-size:12.5px;font-family:inherit}
.slw-app input[type=text],.slw-editor input[type=text]{min-width:150px}
/* ★宿主（SillyTavern）有全局 textarea::placeholder{color:var(--SmartThemeEmColor)!important}（用户主题可达深红），
   工作台不自带 !important 占位符颜色时空输入框文字不可读 ⇒ 两个壳都必须显式写 */
.slw-app input::placeholder,.slw-app textarea::placeholder,.slw-dialog input::placeholder,.slw-dialog textarea::placeholder{color:var(--muted)!important;opacity:1}
.slw-app textarea,.slw-editor textarea{width:100%;resize:vertical}
.slw-btn{background:#3a3d49;color:var(--gold);border:1px solid var(--line2);border-radius:6px;padding:5px 13px;cursor:pointer;font-size:12.5px;font-family:inherit}
.slw-btn:hover{background:#464a58}
.slw-btn.primary{background:#57606f;color:#fff;border-color:#6b7686}
.slw-btn.danger{border-color:rgba(224,110,110,.5);color:var(--danger)}
.slw-btn.sm{padding:2px 9px;font-size:11.5px}
.slw-btn:disabled{opacity:.45;cursor:not-allowed}
.slw-muted{color:var(--muted);font-size:11.5px}
.slw-tag{display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;border:1px solid var(--line2);color:var(--gold-dim)}
.slw-tag.ok{color:var(--ok);border-color:rgba(143,206,143,.4)}
.slw-tag.warn{color:#e0c07a;border-color:rgba(224,192,122,.4)}
.slw-tag.info{color:var(--info);border-color:rgba(127,179,213,.4)}
.slw-tag.dim{color:var(--muted)}
.slw-tag.danger{color:var(--danger);border-color:rgba(224,122,122,.4)}
/* ★表格类名必须带 slw- 前缀：宿主页面（酒馆助手 JS-Slash-Runner 的 manifest css）带 Tailwind 工具表，
   裸 .grid{display:grid} / .fixed{position:fixed} 会命中工作台表格 ⇒ 表脱离文档流（卡片塌高、后续内容压上来）+ 列宽错乱 */
.slw-app table.slw-tbl,.slw-dialog table.slw-tbl{width:100%;border-collapse:collapse;font-size:12.5px}
.slw-app table.slw-tbl th,.slw-dialog table.slw-tbl th{color:var(--gold-dim);font-weight:600;text-align:left;padding:6px 8px;border-bottom:1px solid var(--line2);white-space:nowrap}
.slw-app table.slw-tbl td,.slw-dialog table.slw-tbl td{padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
.slw-app table.slw-tbl tr:last-child td,.slw-dialog table.slw-tbl tr:last-child td{border-bottom:0}
.slw-app table.slw-tbl-fixed,.slw-dialog table.slw-tbl-fixed{table-layout:fixed}
.slw-app table.slw-tbl-fixed td,.slw-dialog table.slw-tbl-fixed td{vertical-align:middle;overflow:hidden}
.slw-ell{display:inline-block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle}
.slw-app textarea.slw-note-area{flex:1;min-width:0;min-height:118px;line-height:1.6;resize:vertical}
.slw-app textarea.slw-trig{flex:1;min-width:0;min-height:54px;line-height:1.55;resize:vertical}
/* 段内容 / 最终指令模板：提示词本体很长（内置段动辄数十行），编辑区给足高度（只能再拖高，不能拖矮到看不清） */
.slw-app .slw-itemrow textarea,.slw-editor .slw-itemrow textarea{min-height:170px;line-height:1.62}
.slw-app textarea[data-g="finalDirectiveTemplate"],.slw-editor textarea[data-g="finalDirectiveTemplate"]{min-height:280px;line-height:1.62}
.slw-annot{border:1px dashed var(--annot);border-radius:8px;padding:8px 12px;margin:10px 0;color:#e5cf9a;font-size:11.5px;background:rgba(232,180,80,.05)}
.slw-annot b{color:#f0d9a4}
.slw-switch{position:relative;width:34px;height:18px;background:#3a3d49;border-radius:10px;cursor:pointer;display:inline-block;vertical-align:middle;border:1px solid var(--line);flex:0 0 auto}
.slw-switch::after{content:"";position:absolute;top:1px;left:2px;width:14px;height:14px;border-radius:50%;background:#8b8676;transition:.15s}
.slw-switch.on{background:rgba(232,217,176,.25)}
.slw-switch.on::after{left:16px;background:var(--gold)}
.slw-seg{display:inline-flex;border:1px solid var(--line2);border-radius:8px;overflow:hidden}
.slw-seg button{background:transparent;border:0;color:var(--muted);padding:5px 14px;cursor:pointer;font-size:12px;border-right:1px solid var(--line);font-family:inherit}
.slw-seg button:last-child{border-right:0}
.slw-seg button.on{background:rgba(232,217,176,.12);color:var(--gold)}
.slw-app .check,.slw-editor .check{accent-color:#c9b98a}
.slw-drawer-mask{position:absolute;inset:0;background:rgba(0,0,0,.45);display:none;z-index:50}
.slw-drawer-mask.open{display:block}
.slw-drawer{position:absolute;top:0;right:0;bottom:0;width:min(560px,88%);background:var(--panel);border-left:1px solid var(--line2);
  display:none;flex-direction:column;z-index:60;box-shadow:-12px 0 40px rgba(0,0,0,.4)}
.slw-drawer.open{display:flex}
.slw-drawer-head{display:flex;align-items:center;padding:12px 16px;border-bottom:1px solid var(--line)}
.slw-drawer-head b{color:var(--gold);font-size:14px}
.slw-drawer-head .x{margin-left:auto;background:none;border:0;color:var(--muted);font-size:16px;cursor:pointer}
.slw-drawer-body{flex:1;overflow-y:auto;padding:14px 16px}
.slw-drawer-foot{padding:10px 16px;border-top:1px solid var(--line);display:flex;gap:10px;justify-content:flex-end}
.slw-app fieldset.fs,.slw-editor fieldset.fs{border:0;border-top:1px solid var(--line);margin:12px 0 0;padding:8px 0 0}
.slw-app fieldset.fs legend,.slw-editor fieldset.fs legend{color:var(--gold-dim);font-size:12px;padding:0 6px}
.slw-cols-edit tbody tr:hover{background:rgba(232,217,176,.04)}
/* 对话框遮罩：同 .slw-root，显式 100vh/100dvh（禁 inset:0 —— 移动端 html 被 transform 后
   inset 的 bottom 相对 ~80px 矮框计算，整块弹窗被摆到屏幕外 = 用户点「扫描」后永远等一个看不见的确认框）。 */
.slw-dialog-mask{position:fixed;top:0;left:0;width:100%;height:100vh;height:100dvh;box-sizing:border-box;
  background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:10040}
.slw-dialog{width:min(640px,92vw);max-height:86vh;overflow-y:auto;background:var(--panel);border:1px solid var(--line2);border-radius:12px;padding:16px 18px;
  font:13px/1.65 "Microsoft YaHei",system-ui,sans-serif;color:var(--text)}
.slw-dialog h3{margin:0 0 10px;color:var(--gold);font-size:14.5px}
.slw-dialog *{box-sizing:border-box}
.slw-dialog .slw-row label{min-width:86px;color:#b9b3a4;font-size:12.5px}
.slw-dialog input[type=text],.slw-dialog select,.slw-dialog textarea{background:#2e313c;border:1px solid var(--line);color:var(--text);border-radius:6px;padding:5px 9px;font-size:12.5px;font-family:inherit}
.slw-dialog textarea{width:100%;resize:vertical}
/* 弹窗消息体（确认/提示框）：原生 confirm 靠 \n 排版，这里用 pre-wrap 原样保留换行与缩进 */
.slw-dialog .slw-msg{white-space:pre-wrap;overflow-wrap:anywhere;margin:0 0 4px}

/* ★大编辑弹窗（填表预设 / 推进预设共用）：桌面 1120×min(90vh,880px)，内部只有正文滚动。
   头/工具条/底栏一律 flex:0 0 auto；正文 min-height:0 才能正常收缩。 */
.slw-dialog.slw-editor{width:min(1120px,96vw);height:min(90vh,880px);max-height:90vh;padding:0;
  display:flex;flex-direction:column;overflow:hidden}
.slw-editor-head{flex:0 0 auto;display:flex;align-items:flex-start;gap:10px;
  padding:14px 18px;border-bottom:1px solid var(--line);
  background:linear-gradient(180deg,rgba(232,217,176,.05),rgba(232,217,176,0))}
.slw-editor-title{min-width:0;flex:1}
.slw-editor-head h3{margin:0 0 3px;font-size:15px;color:var(--gold)}
.slw-editor-head .sub{color:var(--muted);font-size:11.5px;line-height:1.55}
.slw-editor-head .x{flex:0 0 auto;background:none;border:0;color:#8b8676;font-size:18px;cursor:pointer;
  width:34px;height:34px;line-height:1;border-radius:6px;font-family:inherit}
.slw-editor-head .x:hover{background:rgba(232,217,176,.08);color:var(--gold)}
.slw-editor-toolbar{flex:0 0 auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap;
  padding:8px 18px;border-bottom:1px solid var(--line);background:var(--panel2)}
.slw-editor-body{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;
  padding:14px 18px 18px;-webkit-overflow-scrolling:touch}
.slw-editor-foot{flex:0 0 auto;display:flex;align-items:center;gap:10px;flex-wrap:wrap;
  padding:10px 18px;border-top:1px solid var(--line);background:var(--panel)}
.slw-editor-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;flex:1;min-width:0}
.slw-editor-foot .slw-editor-spacer{flex:1;min-width:10px}
.slw-editor-dirty{color:#e0c07a;font-size:11.5px}
.slw-editor textarea.slw-tall{min-height:255px;line-height:1.62}
.slw-editor .slw-fieldlabel{display:block;color:#b9b3a4;font-size:12.5px;margin:10px 0 5px}
.slw-editor .slw-fieldlabel .slw-muted{margin-left:6px}
.slw-editor .slw-structline{display:flex;align-items:center;gap:8px;flex-wrap:wrap;
  border:1px dashed rgba(127,179,213,.35);border-radius:8px;padding:7px 10px;margin:0 0 10px;
  background:rgba(127,179,213,.05);font-size:11.5px;color:#a9c9df}
.slw-editor .slw-structline b{color:#cfe6f4}
.slw-editor .slw-editor-note{color:var(--muted);font-size:11.5px;margin:6px 0 0;line-height:1.7}
.slw-rategrid{display:grid;grid-template-columns:repeat(5,minmax(120px,1fr));gap:8px 10px}
.slw-rategrid label{display:flex;flex-direction:column;gap:3px;min-width:0;color:#b9b3a4;font-size:12px}
.slw-rategrid input{width:100%!important;min-width:0}

.slw-tm{display:flex;gap:14px;min-height:420px}
.slw-tm-left{width:250px;flex:0 0 auto;border:1px solid var(--line);border-radius:10px;background:var(--panel2);overflow-y:auto}
.slw-tm-left h4{margin:0;padding:10px 12px;color:var(--gold-dim);font-size:12px;border-bottom:1px solid var(--line)}
.slw-tm-floor{padding:8px 12px;border-bottom:1px solid var(--line);cursor:pointer}
.slw-tm-floor:hover{background:rgba(232,217,176,.05)}
.slw-tm-floor.on{background:rgba(232,217,176,.10);border-left:3px solid var(--gold)}
.slw-tm-floor b{color:var(--gold);font-size:12.5px}
.slw-tm-floor .slw-muted{display:block}
.slw-tm-right{flex:1;min-width:0}
.slw-tm-group{margin:0 0 8px;border:1px solid var(--line);border-radius:8px;padding:6px 8px}
.slw-tm-group>summary{cursor:pointer;font-weight:600;font-size:12.5px;color:var(--text);padding:2px 0}
.slw-tm-group>summary .slw-muted{font-weight:400;margin-left:6px}
.slw-tm-group>table{margin-top:6px}
.slw-diff-old{color:var(--danger);text-decoration:line-through;padding:1px 6px;background:rgba(224,122,122,.08);border-radius:4px}
.slw-diff-new{color:var(--ok);padding:1px 6px;background:rgba(143,206,143,.10);border-radius:4px}
.slw-steps{display:flex;gap:0;margin-bottom:14px}
.slw-step{flex:1;text-align:center;position:relative;padding:8px 4px;color:var(--muted);font-size:12px;background:var(--panel2);border:1px solid var(--line)}
.slw-step:first-child{border-radius:8px 0 0 8px}.slw-step:last-child{border-radius:0 8px 8px 0}
.slw-step+.slw-step{border-left:0}
.slw-step b{display:block;font-size:15px}
.slw-step.done{color:var(--ok)}.slw-step.cur{color:var(--gold);background:rgba(232,217,176,.08)}
.slw-report{background:#191b21;border:1px solid var(--line);border-radius:8px;padding:10px 12px;font-size:12px;white-space:pre-wrap;max-height:260px;overflow-y:auto;font-family:Consolas,monospace;color:#b9c2a8}
.slw-rulepair{display:flex;gap:8px;align-items:center;margin:5px 0}
.slw-rulepair input{min-width:0;width:150px}
.slw-blockrow{display:flex;align-items:center;gap:8px;background:linear-gradient(180deg,rgba(232,217,176,.06),rgba(232,217,176,.02));
  border:1px solid rgba(232,217,176,.35);border-radius:9px;padding:7px 10px;margin:6px 0}
.slw-blockrow b{color:var(--gold);font-size:12.5px;flex:0 0 auto}
.slw-blockrow .slw-muted{line-height:1.5}
.slw-blockrow.off{border-style:dashed;background:none}
.slw-blockrow.off b{color:var(--muted)}
.slw-itemrow{background:#191b21;border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin:6px 0}
/* 表格勾选网格（手动填表范围；学数据库 TableSelector：上方按钮组 + 下方自动多列勾选） */
.slw-pickgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(176px,1fr));gap:4px 10px;
  max-height:212px;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:8px 10px;background:#191b21;flex:1 1 100%;min-width:0}
.slw-pickgrid label{display:flex;align-items:center;gap:6px;min-width:0;color:var(--text);font-size:12.5px}
.slw-pickgrid label.dim{color:var(--muted)}
.slw-pickgrid label span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.slw-chip{background:#333745;border:1px solid var(--line2);color:var(--gold-dim);border-radius:14px;padding:3px 11px;cursor:pointer;
  font-size:11.5px;font-family:inherit}
.slw-chip:hover{background:#3f4453;color:var(--gold)}
.slw-chip.on{background:#4a4f61;border-color:var(--gold-dim);color:var(--gold)}
.slw-count{color:var(--muted);font-size:11.5px;margin-left:auto}
/* 日志页（左栏 badge + 列表 + 详情）；类名一律 slw- 前缀，防命中宿主 Tailwind 工具表 */
.slw-rail-badge{position:absolute;top:6px;right:8px;min-width:16px;height:16px;border-radius:9px;background:rgba(224,122,122,.9);
  color:#231012;font-size:10.5px;line-height:16px;padding:0 4px;font-weight:600}
.slw-loglist{border:1px solid var(--line);border-radius:8px;background:#191b21;max-height:min(56vh,560px);overflow-y:auto}
.slw-logrow{display:flex;align-items:flex-start;gap:8px;padding:6px 10px;border-bottom:1px solid var(--line)}
.slw-logrow:last-child{border-bottom:0}
.slw-logrow.slw-lv-error,.slw-logrow.slw-logrow-expandable{cursor:pointer}
.slw-logrow:hover{background:rgba(232,217,176,.035)}
.slw-logrow.slw-lv-error:hover{background:rgba(224,122,122,.045)}
/* 未读错误点 / 已读标记：徽章「点一条消一条」的行内反馈 */
.slw-dot-slot{flex:0 0 6px;height:16px;display:flex;align-items:center;justify-content:center;margin-top:1px}
.slw-unread-dot{width:6px;height:6px;border-radius:50%;background:#e07a7a;display:block;box-shadow:0 0 0 2px rgba(224,122,122,.14)}
.slw-logrow.is-read .slw-log-msg{color:#b9b3a4}
.slw-logrow.is-read .slw-tag.danger{color:var(--muted);border-color:rgba(139,134,118,.35)}
.slw-readmark{flex:0 0 auto;color:var(--muted);font-size:10.5px;border:1px dashed rgba(139,134,118,.45);
  border-radius:8px;padding:0 6px;margin-top:1px}
.slw-logrow .slw-log-time{color:var(--muted);font-size:11.5px;font-family:Consolas,monospace;flex:0 0 auto;margin-top:1px}
.slw-logrow .slw-log-src{flex:0 0 auto}
.slw-logrow .slw-log-msg{flex:1;min-width:0;overflow-wrap:anywhere}
.slw-logrow.slw-lv-error .slw-log-msg{color:#f0b9b9}
.slw-logrow.slw-lv-warn .slw-log-msg{color:#e9d6a8}
.slw-logrow.slw-lv-info .slw-log-msg{color:#c8c3b6}
.slw-logrow .slw-log-count{color:var(--muted);font-size:11px;margin-left:6px}
.slw-logrow .slw-log-x{flex:0 0 auto;background:none;border:0;color:var(--gold-dim);cursor:pointer;font-size:11.5px;font-family:inherit;padding:1px 4px}
.slw-logrow .slw-log-x:hover{color:var(--gold)}
.slw-log-detail{margin:0 10px 8px;border-left:2px solid var(--line2);background:#141519;border-radius:0 6px 6px 0;
  padding:7px 10px;font-family:Consolas,monospace;font-size:11.5px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;
  color:#b9c2a8;max-height:220px;overflow-y:auto}
/* 原始 AI 输出块（填表 / 推进告警携带；随展开显示 + 一键复制） */
.slw-log-rawwrap{margin:0 10px 10px}
.slw-log-rawhead{display:flex;align-items:center;gap:8px;margin:0 0 4px}
.slw-log-rawhead .slw-muted{flex:1;min-width:0}
.slw-log-raw{margin:0;border-left:2px solid rgba(232,217,176,.45);background:#101218;border-radius:0 6px 6px 0;
  padding:8px 10px;font-family:Consolas,monospace;font-size:11.5px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;
  color:#d5dcc6;max-height:320px;overflow-y:auto}
.slw-logempty{padding:26px 14px;text-align:center;color:var(--muted);font-size:12px}
.slw-logempty .slw-muted{display:inline-block;margin-top:4px}

/* =========================================================================
   移动端 / 紧凑模式
   shell.ts 按工作台容器宽度在 documentElement 上挂三个类（桌面不触发）：
   - slw-compact-doc：紧凑外壳（容器 <700 或横屏）→ 横向页签、隐藏 meta
   - slw-card-doc：卡片表格 / 16px 输入 / 40px 触控 / 说明折叠（容器 <900）
   - slw-phone-doc：全屏手机（容器 <560）→ 100dvh、安全区、底部弹窗
   说明：桌面 1024+ 不加任何类，原表格与尺寸逐像素保持不变。
   ========================================================================= */

/* 头部：长标题/说明不再把关闭按钮挤成两行（桌面同样受益，无视觉变化） */
.slw-head-info{min-width:0;flex:1}
.slw-head .title{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.slw-head .meta{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.slw-head .close{flex:0 0 auto;white-space:nowrap}

/* 日志徽标定位修复：原先 .slw-rail button 不是定位祖先，徽标会跑到面板右上角 */
.slw-rail button{position:relative}
.slw-rail-badge{top:4px;right:4px}

/* 说明折叠：桌面默认 open 且隐藏 summary（视觉与原 div 一致）；紧凑模式显示 summary 并默认收起 */
.slw-annot-details>summary{display:none;cursor:pointer;color:#f0d9a4;font-weight:600;font-size:12px}
.slw-card-doc .slw-app .slw-annot-details>summary,
.slw-card-doc .slw-dialog .slw-annot-details>summary{display:block}
.slw-card-doc .slw-app .slw-annot-details:not([open])>.slw-annot-body,
.slw-card-doc .slw-dialog .slw-annot-details:not([open])>.slw-annot-body{display:none}
/* 大编辑卡片：桌面 open+隐藏 summary（同原卡片）；紧凑模式只留标题 + 展开行 */
.slw-collapse-body>summary{display:none;cursor:pointer;color:var(--gold-dim);font-size:12.5px;padding:4px 0}
.slw-card-doc .slw-app .slw-collapse-body>summary{display:block}

/* 表格横向滚动兜底（时光机快照等多列表格） */
.slw-tbl-wrap{width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch;overscroll-behavior-x:contain}
.slw-card-doc .slw-app .slw-tbl-wrap>table.slw-tbl,
.slw-card-doc .slw-dialog .slw-tbl-wrap>table.slw-tbl{min-width:560px}

/* ── 紧凑外壳：横向页签 ── */
.slw-compact-doc .slw-app .slw-body{flex-direction:column}
.slw-compact-doc .slw-app .slw-rail{
  width:100%;flex:0 0 auto;flex-direction:row;overflow-x:auto;overflow-y:hidden;
  border-right:0;border-bottom:1px solid var(--line);padding:6px;gap:3px;
  scrollbar-width:none;
}
.slw-compact-doc .slw-app .slw-rail::-webkit-scrollbar{display:none}
.slw-compact-doc .slw-app .slw-rail button{
  width:auto;min-width:48px;min-height:48px;padding:5px 6px;flex:0 0 auto;
}
.slw-compact-doc .slw-app .slw-head{padding:8px 10px}
.slw-compact-doc .slw-app .slw-head .meta{display:none}
.slw-compact-doc .slw-app .slw-content{padding:10px 10px calc(14px + env(safe-area-inset-bottom,0px))}
.slw-compact-doc .slw-app .slw-card{padding:12px;margin-bottom:10px}
.slw-compact-doc .slw-app .slw-card>h3{font-size:14px}
.slw-compact-doc .slw-app .slw-card>h3 .desc{font-size:12px}
.slw-compact-doc .slw-app .slw-row--stack{flex-direction:column;align-items:stretch}
.slw-compact-doc .slw-app .slw-row--stack>label{min-width:0;flex:0 0 auto}
.slw-compact-doc .slw-app .slw-pickgrid{grid-template-columns:1fr;max-height:40vh}
.slw-compact-doc .slw-app .slw-pickgrid label span{white-space:normal;overflow:visible;text-overflow:clip}
.slw-compact-doc .slw-app .slw-steps{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.slw-compact-doc .slw-app .slw-step{border:1px solid var(--line);border-left:1px solid var(--line);border-radius:8px;padding:8px 9px}
.slw-compact-doc .slw-app .slw-tm{flex-direction:column;min-height:0}
.slw-compact-doc .slw-app .slw-tm-left{width:100%;max-height:32vh;min-height:0}
.slw-compact-doc .slw-app .slw-tm-right{width:100%}
.slw-compact-doc .slw-app .slw-tm-right .slw-row .slw-btn{flex:1 1 140px;white-space:normal}
.slw-compact-doc .slw-app .slw-tm-right .slw-row .slw-muted{flex:1 1 100%}
/* 分组 API：窄壳里名称占整行、下拉整宽、状态字让位 */
.slw-compact-doc .slw-app .slw-groupapi-row .g-name,
.slw-card-doc .slw-app .slw-groupapi-row .g-name,
.slw-phone-doc .slw-app .slw-groupapi-row .g-name{min-width:100%}
.slw-compact-doc .slw-app .slw-groupapi-row select,
.slw-card-doc .slw-app .slw-groupapi-row select,
.slw-phone-doc .slw-app .slw-groupapi-row select{min-width:100%;width:100%}
.slw-compact-doc .slw-app .slw-groupapi-row .g-state,
.slw-card-doc .slw-app .slw-groupapi-row .g-state,
.slw-phone-doc .slw-app .slw-groupapi-row .g-state{display:none}

/* ── 卡片表格 / 字号 / 触控（手机与平板） ── */
.slw-card-doc .slw-root,
.slw-card-doc .slw-dialog{--muted:#a5a08f}
.slw-card-doc .slw-app,.slw-card-doc .slw-dialog{font-size:14px}
/* 平板/横屏也可能接键盘：app 按视觉视口压矮，顶对齐（无键盘时 96vh + 2vh padding 位置不变） */
.slw-card-doc .slw-root{align-items:flex-start;transform:translateY(var(--slw-kb-top,0px))}
.slw-card-doc .slw-app{
  max-height:calc(100vh - var(--slw-kb-h,0px));
  max-height:calc(100dvh - var(--slw-kb-h,0px));
}
.slw-card-doc .slw-app .slw-muted,
.slw-card-doc .slw-dialog .slw-muted{font-size:12.5px}
.slw-card-doc .slw-app .slw-tag,
.slw-card-doc .slw-dialog .slw-tag{font-size:12px}
.slw-card-doc .slw-app .slw-annot,
.slw-card-doc .slw-dialog .slw-annot{font-size:12.5px}
.slw-card-doc .slw-app input[type=text],.slw-card-doc .slw-app input[type=number],
.slw-card-doc .slw-app input[type=password],.slw-card-doc .slw-app select,
.slw-card-doc .slw-app textarea,.slw-card-doc .slw-dialog input[type=text],
.slw-card-doc .slw-dialog input[type=number],.slw-card-doc .slw-dialog input[type=password],
.slw-card-doc .slw-dialog select,.slw-card-doc .slw-dialog textarea{
  font-size:16px;min-width:0!important;max-width:100%;
}
.slw-card-doc .slw-app .slw-btn,.slw-card-doc .slw-dialog .slw-btn{min-height:40px}
.slw-card-doc .slw-app .slw-btn.sm,.slw-card-doc .slw-dialog .slw-btn.sm{
  min-height:36px;padding:5px 10px;font-size:12.5px;
}
.slw-card-doc .slw-app .slw-chip{min-height:36px}
.slw-card-doc .slw-app .slw-seg button{min-height:36px}
.slw-card-doc .slw-app .slw-logrow .slw-log-x{min-height:36px}
.slw-card-doc .slw-app .slw-head .close{min-height:40px;min-width:60px;font-size:13px}
.slw-card-doc .slw-app .slw-switch{width:44px;height:26px;border-radius:13px}
.slw-card-doc .slw-app .slw-switch::after{width:20px;height:20px;top:2px;left:3px}
.slw-card-doc .slw-app .slw-switch.on::after{left:19px}
.slw-card-doc .slw-app .slw-switch::before{content:"";position:absolute;inset:-10px}
.slw-card-doc .slw-app input[type=checkbox],.slw-card-doc .slw-app input[type=radio],
.slw-card-doc .slw-dialog input[type=checkbox],.slw-card-doc .slw-dialog input[type=radio]{
  width:20px;height:20px;
}
.slw-card-doc .slw-app button,.slw-card-doc .slw-dialog button,
.slw-card-doc .slw-app .slw-chip,.slw-card-doc .slw-app .slw-switch{
  touch-action:manipulation;-webkit-tap-highlight-color:transparent;
}
.slw-card-doc .slw-app .slw-content{overflow-x:hidden}

/* 固定块：提示独占一行，避免 flex 压成 0 宽后逐字竖排 */
.slw-card-doc .slw-app .slw-blockrow{flex-wrap:wrap}
.slw-card-doc .slw-app .slw-blockrow .slw-muted{flex:1 1 100%;order:3;min-width:0}
.slw-card-doc .slw-app .slw-blockrow .slw-btn,
.slw-card-doc .slw-app .slw-blockrow .slw-switch{flex:0 0 auto}

/* 保存条常驻（填表提示词 / 推进预设） */
.slw-card-doc .slw-app .slw-sticky-actions{
  position:sticky;bottom:0;z-index:4;margin-top:10px;
  padding:10px 0 calc(2px + env(safe-area-inset-bottom,0px));
  background:linear-gradient(180deg,rgba(35,37,46,0),rgba(35,37,46,.98) 36%);
}
/* 手机/平板上提示词编辑器先收短（仍可滚动编辑；桌面保持原高度） */
.slw-card-doc .slw-app .slw-itemrow textarea,
.slw-card-doc .slw-editor .slw-itemrow textarea{min-height:120px}
.slw-card-doc .slw-app textarea[data-g="finalDirectiveTemplate"],
.slw-card-doc .slw-editor textarea[data-g="finalDirectiveTemplate"]{min-height:160px}
.slw-card-doc .slw-app #slw-f-sysprompt,
.slw-card-doc .slw-editor #slw-f-sysprompt{height:180px;min-height:140px}

/* 表格降级为卡片行：表名/操作等关键列不再被固定列宽压成 0 */
.slw-card-doc .slw-app table.slw-responsive thead,
.slw-card-doc .slw-dialog table.slw-responsive thead{display:none}
.slw-card-doc .slw-app table.slw-responsive,
.slw-card-doc .slw-app table.slw-responsive tbody,
.slw-card-doc .slw-app table.slw-responsive tr,
.slw-card-doc .slw-app table.slw-responsive td,
.slw-card-doc .slw-dialog table.slw-responsive,
.slw-card-doc .slw-dialog table.slw-responsive tbody,
.slw-card-doc .slw-dialog table.slw-responsive tr,
.slw-card-doc .slw-dialog table.slw-responsive td{
  display:block;width:auto!important;
}
.slw-card-doc .slw-app table.slw-responsive colgroup,
.slw-card-doc .slw-dialog table.slw-responsive colgroup{display:none}
.slw-card-doc .slw-app table.slw-responsive tr,
.slw-card-doc .slw-dialog table.slw-responsive tr{
  border:1px solid var(--line);border-radius:9px;padding:8px 10px;margin-bottom:7px;
  background:rgba(25,27,33,.55);
}
.slw-card-doc .slw-app table.slw-responsive tr:last-child,
.slw-card-doc .slw-dialog table.slw-responsive tr:last-child{margin-bottom:0}
.slw-card-doc .slw-app table.slw-responsive td,
.slw-card-doc .slw-dialog table.slw-responsive td{
  border:0;padding:2px 0;overflow:visible;white-space:normal;vertical-align:top;
}
.slw-card-doc .slw-app table.slw-responsive td[data-label]::before,
.slw-card-doc .slw-dialog table.slw-responsive td[data-label]::before{
  content:attr(data-label) "：";color:var(--muted);font-size:12px;
}
.slw-card-doc .slw-app table.slw-responsive .slw-ell,
.slw-card-doc .slw-dialog table.slw-responsive .slw-ell{
  white-space:normal;overflow:visible;text-overflow:clip;display:inline;
}
.slw-card-doc .slw-app table.slw-responsive td input[type=text],
.slw-card-doc .slw-app table.slw-responsive td select,
.slw-card-doc .slw-dialog table.slw-responsive td input[type=text],
.slw-card-doc .slw-dialog table.slw-responsive td select{
  width:100%!important;max-width:100%;
}

/* 纵向 KV 表（设置页「请求结构」）：th 在上、td 在下 */
.slw-card-doc .slw-app table.slw-stack,
.slw-card-doc .slw-app table.slw-stack tbody,
.slw-card-doc .slw-app table.slw-stack tr,
.slw-card-doc .slw-app table.slw-stack th,
.slw-card-doc .slw-app table.slw-stack td{display:block;width:auto!important}
.slw-card-doc .slw-app table.slw-stack th{
  border-bottom:0;padding:8px 0 2px;white-space:normal;color:var(--gold-dim);
}
.slw-card-doc .slw-app table.slw-stack td{border-bottom:1px solid var(--line);padding:0 0 8px}
.slw-card-doc .slw-app table.slw-stack tr:last-child td{border-bottom:0}

/* 抽屉：输入框占满、列编辑变卡片、底栏不被键盘盖住 */
.slw-card-doc .slw-app .slw-drawer{box-sizing:border-box}
.slw-card-doc .slw-app .slw-drawer-head{padding:12px}
.slw-card-doc .slw-app .slw-drawer-head .x{min-width:40px;min-height:40px}
.slw-card-doc .slw-app .slw-drawer-body{padding:12px}
.slw-card-doc .slw-app .slw-drawer .slw-row>label{min-width:0;flex:1 1 100%}
.slw-card-doc .slw-app .slw-drawer input[type=text],
.slw-card-doc .slw-app .slw-drawer select{width:100%!important;max-width:100%}

/* 弹窗：16px 输入、40px 按钮、长文案时底部操作行常驻 */
.slw-card-doc .slw-dialog{
  box-sizing:border-box;width:min(640px,calc(100vw - 24px));
  max-height:calc(86vh - var(--slw-kb-h,0px));
  max-height:calc(100dvh - 24px - var(--slw-kb-h,0px));
  padding:14px;
}
/* 大编辑弹窗：平板/窄窗口占满可用宽高；底部操作常驻，正文自己滚 */
.slw-card-doc .slw-dialog.slw-editor{
  width:calc(100vw - 24px);max-width:none;
  height:calc(100dvh - 24px - var(--slw-kb-h,0px));
  max-height:calc(100dvh - 24px - var(--slw-kb-h,0px));
  padding:0;
}
/* 通用「弹窗最后一行粘底」只服务确认框；大编辑弹窗的底栏是 .slw-editor-foot，正文里的最后一行不能被粘住 */
.slw-card-doc .slw-dialog.slw-editor .slw-row:last-child{
  position:static;background:transparent;padding:0;margin:0;
}
.slw-card-doc .slw-editor-head .x{width:40px;height:40px}
.slw-card-doc .slw-editor textarea.slw-tall{min-height:180px}
.slw-card-doc .slw-editor .slw-rategrid{grid-template-columns:repeat(auto-fit,minmax(110px,1fr))}
.slw-card-doc .slw-dialog-mask{
  box-sizing:border-box;padding:12px;
  padding-bottom:calc(12px + var(--slw-kb-h,0px));
  transform:translateY(var(--slw-kb-top,0px));
}
.slw-card-doc .slw-dialog h3 .x{
  min-width:40px;min-height:40px;padding:0;display:flex;
  align-items:center;justify-content:center;
}
.slw-card-doc .slw-dialog .slw-row:last-child{
  position:sticky;bottom:0;z-index:2;background:var(--panel);
  padding:8px 0 calc(2px + env(safe-area-inset-bottom,0px));margin-bottom:0;
}

/* ── 全屏手机 ── */
.slw-phone-doc .slw-root{padding:0;align-items:flex-start;transform:translateY(var(--slw-kb-top,0px))}
.slw-phone-doc .slw-app{
  width:100%;max-width:none;height:100vh;height:100dvh;
  max-height:calc(100vh - var(--slw-kb-h,0px));
  max-height:calc(100dvh - var(--slw-kb-h,0px));
  border-radius:0;border:0;
}
.slw-phone-doc .slw-app .slw-head{
  padding-top:calc(8px + env(safe-area-inset-top,0px));
  padding-left:max(10px,env(safe-area-inset-left,0px));
  padding-right:max(10px,env(safe-area-inset-right,0px));
}
.slw-phone-doc .slw-app .slw-rail{
  padding-left:max(6px,env(safe-area-inset-left,0px));
  padding-right:max(6px,env(safe-area-inset-right,0px));
}
.slw-phone-doc .slw-app .slw-content{
  padding-bottom:calc(14px + env(safe-area-inset-bottom,0px));
}
.slw-phone-doc .slw-app .slw-drawer{width:100%;border-left:0}
.slw-phone-doc .slw-app .slw-drawer-head{
  padding-top:calc(12px + env(safe-area-inset-top,0px));
}
.slw-phone-doc .slw-app .slw-drawer-foot{
  padding-bottom:calc(10px + env(safe-area-inset-bottom,0px));
}
.slw-phone-doc .slw-dialog-mask{
  align-items:flex-end;padding:0 0 var(--slw-kb-h,0px);
}
.slw-phone-doc .slw-dialog{
  width:100%;max-width:100%;border-radius:16px 16px 0 0;
  max-height:calc(100vh - var(--slw-kb-h,0px));
  max-height:calc(100dvh - var(--slw-kb-h,0px));
  padding-bottom:calc(14px + env(safe-area-inset-bottom,0px));
}
/* 大编辑弹窗：手机全屏编辑（不再是底部 sheet）；高度让出键盘，头/底扣安全区 */
.slw-phone-doc .slw-dialog.slw-editor{
  width:100vw;max-width:100vw;height:100vh;
  height:calc(100dvh - var(--slw-kb-h,0px));
  max-height:calc(100dvh - var(--slw-kb-h,0px));
  border-radius:0;border:0;padding:0;
}
.slw-phone-doc .slw-editor-head{
  padding-top:calc(14px + env(safe-area-inset-top,0px));
  padding-left:max(14px,env(safe-area-inset-left,0px));
  padding-right:max(14px,env(safe-area-inset-right,0px));
}
.slw-phone-doc .slw-editor-toolbar{
  padding-left:max(14px,env(safe-area-inset-left,0px));
  padding-right:max(14px,env(safe-area-inset-right,0px));
}
.slw-phone-doc .slw-editor-body{
  padding-left:max(14px,env(safe-area-inset-left,0px));
  padding-right:max(14px,env(safe-area-inset-right,0px));
  padding-bottom:14px;
}
.slw-phone-doc .slw-editor-foot{
  padding-left:max(14px,env(safe-area-inset-left,0px));
  padding-right:max(14px,env(safe-area-inset-right,0px));
  padding-bottom:calc(10px + env(safe-area-inset-bottom,0px));
}
.slw-phone-doc .slw-editor .slw-rategrid{grid-template-columns:repeat(2,minmax(0,1fr))}
.slw-phone-doc .slw-launcher{
  --slw-l-right:max(16px,env(safe-area-inset-right,0px));
  --slw-l-bottom:calc(96px + env(safe-area-inset-bottom,0px));
}
/* 悬浮入口在面板关闭时也要避开刘海/手势条（fixed 子件，按视口而非容器收口） */
@media (max-width:760px){
  .slw-launcher{
    --slw-l-right:max(16px,env(safe-area-inset-right,0px));
    --slw-l-bottom:calc(96px + env(safe-area-inset-bottom,0px));
  }
  .slw-app .slw-groupapi-row .g-name{min-width:100%}
  .slw-app .slw-groupapi-row select{min-width:100%;width:100%}
  .slw-app .slw-groupapi-row .g-state{display:none}
}

/* ===== 纪要合并标签（台账独占） ===== */
.slw-warnbar{flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:7px 14px;
  border-bottom:1px solid rgba(224,122,122,.35);
  background:linear-gradient(90deg,rgba(224,122,122,.18),rgba(224,122,122,.05));
  font-size:12.5px;color:#f0c9a8}
.slw-warnbar[hidden]{display:none}
.slw-warnbar .warn-dot{flex:0 0 auto;width:17px;height:17px;border-radius:50%;background:#b85b4e;color:#fff;
  display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700}
.slw-warnbar b{color:#ffd9b0}
.slw-warnbar .slw-btn{margin-left:auto;flex:0 0 auto}
/* 填表进行中横幅：与 warnbar 同结构；冷色＝进行中语义（不是错误），终止按钮沿用 danger 描边 */
.slw-fillbar{flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:7px 14px;
  border-bottom:1px solid rgba(127,179,213,.35);
  background:linear-gradient(90deg,rgba(127,179,213,.18),rgba(127,179,213,.05));
  font-size:12.5px;color:#cfe6f4}
.slw-fillbar[hidden]{display:none}
.slw-fillbar .fill-spin{flex:0 0 auto;width:17px;height:17px;border-radius:50%;
  border:2px solid rgba(127,179,213,.26);border-top-color:#7fb3d5;animation:slw-fill-spin .9s linear infinite}
.slw-fillbar b{color:#dff0fa;font-weight:600}
.slw-fillbar .slw-btn{margin-left:auto;flex:0 0 auto}
@keyframes slw-fill-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion: reduce){.slw-fillbar .fill-spin{animation:none}}
.slw-merge-stats{display:flex;gap:10px;flex-wrap:wrap;margin:2px 0 10px}
.slw-merge-stat{background:#1d1f26;border:1px solid rgba(232,217,176,.14);border-radius:9px;padding:7px 11px;min-width:104px;flex:1 1 104px}
.slw-merge-stat span{display:block;color:#8b8676;font-size:10.5px;margin-bottom:1px}
.slw-merge-stat b{font-size:19px;color:#e8d9b0;font-weight:600;line-height:1.2;font-variant-numeric:tabular-nums}
.slw-merge-stat b.hot{color:#e8a87c}
.slw-merge-stat b.ok{color:#8fce8f}
.slw-merge-stat em{font-style:normal;color:#8b8676;font-size:10.5px;margin-left:3px}
.slw-merge-modes{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}
.slw-merge-mode{text-align:left;background:#1d1f26;border:1px solid rgba(232,217,176,.16);border-radius:10px;padding:10px 12px;cursor:pointer;color:var(--text);font:12px/1.55 "Microsoft YaHei",system-ui,sans-serif}
.slw-merge-mode:hover{background:#232630;border-color:rgba(232,217,176,.3)}
.slw-merge-mode.on{background:rgba(232,217,176,.09);border-color:var(--gold-dim);box-shadow:inset 0 0 0 1px rgba(232,217,176,.18)}
.slw-merge-mode:disabled{cursor:not-allowed;opacity:.55}
.slw-merge-mode .mt{display:flex;align-items:center;gap:7px;color:var(--gold);font-weight:600;font-size:13px;margin-bottom:2px}
.slw-merge-mode .mi{width:20px;height:20px;border-radius:50%;background:rgba(232,217,176,.12);display:flex;align-items:center;justify-content:center;font-size:12px;flex:0 0 auto}
.slw-merge-mode .md{color:#9d988a;font-size:11.5px;line-height:1.55}
.slw-merge-mode .mh{color:#e0c07a;font-size:11px;margin-top:4px}
.slw-merge-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 18px}
.slw-merge-grid .slw-row{margin:6px 0}
.slw-merge-grid .slw-row label{min-width:88px}
.slw-merge-grid input[type=number]{width:78px}
.slw-merge-preview{margin:9px 0 2px;padding:8px 11px;border-radius:8px;background:rgba(127,179,213,.07);
  border:1px solid rgba(127,179,213,.24);color:#b9d6e8;font-size:12px;line-height:1.7}
.slw-merge-preview b{color:#dff0fa}
.slw-merge-preview .bad{color:#e8a87c}
.slw-merge-warn{margin:8px 0 0;padding:7px 10px;border-radius:7px;border:1px solid rgba(224,192,122,.42);
  background:rgba(224,192,122,.07);color:#e5cf9a;font-size:11.5px;line-height:1.65}
.slw-merge-chart{height:92px;display:flex;align-items:flex-end;gap:1px;padding:6px 2px 0;margin:6px 0 2px;
  border-bottom:1px solid rgba(232,217,176,.14);overflow:hidden}
.slw-merge-chart i{flex:1 1 0;min-width:1px;background:#6f7f94;border-radius:2px 2px 0 0;opacity:.85}
.slw-merge-chart i.z-front{background:#8fb7d8}
.slw-merge-chart i.z-mid{background:#b7bd8f}
.slw-merge-chart i.z-back{background:#d6b98a}
.slw-merge-chart-cap{display:flex;justify-content:space-between;color:#8b8676;font-size:10.5px;margin-top:3px}
.slw-merge-zonelabels{display:flex;gap:2px;color:#8b8676;font-size:10.5px;margin-top:4px}
.slw-merge-zonelabels span{text-align:center;border-left:1px solid rgba(232,217,176,.14);padding:2px 0}
.slw-merge-zonelabels span:first-child{border-left:0}
.slw-merge-seglist{border:1px solid rgba(232,217,176,.16);border-radius:8px;overflow:auto;max-height:330px;background:#191b22;margin-top:8px}
.slw-merge-seg{display:flex;align-items:center;gap:7px;padding:6px 9px;border-bottom:1px solid rgba(232,217,176,.08);
  font-size:11.5px;cursor:pointer;user-select:none;flex-wrap:wrap}
.slw-merge-seg:last-child{border-bottom:0}
.slw-merge-seg:hover{background:rgba(232,217,176,.05)}
.slw-merge-seg .st{flex:0 0 16px;text-align:center;font-weight:700;color:#8b8676}
.slw-merge-seg .am{flex:0 0 auto;color:#cfe6f4;font-family:ui-monospace,Consolas,monospace;font-size:11px}
.slw-merge-seg .meta{flex:0 0 auto;color:#8b8676;font-size:10.5px}
.slw-merge-seg .mass{flex:0 0 auto;color:#e0c07a;font-size:10.5px;border:1px solid rgba(224,192,122,.3);border-radius:9px;padding:0 6px}
.slw-merge-seg .tail{margin-left:auto;color:#8b8676;font-size:10.5px;flex:0 0 auto}
.slw-merge-seg.is-success .st{color:#8fce8f}
.slw-merge-seg.is-success .tail{color:#8fce8f}
.slw-merge-seg.is-failed .st{color:#e07a7a}
.slw-merge-seg.is-failed .tail{color:#e07a7a}
.slw-merge-seg.is-running .st{color:#7fb3d5}
.slw-merge-seg.is-omitted{opacity:.72}
.slw-merge-seg.is-tail{background:rgba(224,192,122,.06)}
.slw-merge-seg-detail{padding:0 11px 9px 32px;background:#16181f;border-bottom:1px solid rgba(232,217,176,.08)}
.slw-merge-orig{padding:5px 0;border-bottom:1px dashed rgba(232,217,176,.1)}
.slw-merge-orig:last-child{border-bottom:0}
.slw-merge-orig .code{color:#cfe6f4;font-family:ui-monospace,Consolas,monospace;font-size:10.5px;margin-right:6px}
.slw-merge-orig .span{color:#8b8676;font-size:10.5px}
.slw-merge-orig .cnt{color:#e0c07a;font-size:10.5px;margin-left:5px}
.slw-merge-orig p{margin:2px 0 0;color:#c9c4b8;font-size:11px;line-height:1.55}
.slw-merge-orig .err{color:#e0a0a0}
.slw-merge-bar{height:7px;border-radius:4px;background:#191b22;border:1px solid rgba(232,217,176,.14);overflow:hidden;margin:4px 0 8px}
.slw-merge-bar>i{display:block;height:100%;background:linear-gradient(90deg,#57606f,#8fce8f);transition:width .12s linear}
.slw-merge-ack{display:flex;align-items:flex-start;gap:7px;color:#e0c07a;font-size:11.5px;line-height:1.6;margin:8px 0;cursor:pointer;user-select:none}
.slw-merge-ack input{margin-top:2px}
.slw-merge-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px}
.slw-merge-actions .spacer{flex:1;min-width:10px}
.slw-merge-success{text-align:center;padding:14px 8px 6px}
.slw-merge-success .big{width:46px;height:46px;border-radius:50%;margin:0 auto 8px;background:rgba(143,206,143,.14);
  border:1px solid rgba(143,206,143,.5);color:#8fce8f;display:flex;align-items:center;justify-content:center;font-size:24px}
.slw-merge-success h4{margin:0 0 3px;color:#e8d9b0;font-size:15px}
.slw-merge-success p{margin:3px 0;color:#b9b3a4;font-size:12px}
.slw-merge-success .num{color:#8fce8f;font-size:20px;font-weight:700;font-variant-numeric:tabular-nums}
.slw-merge-note{color:#8b8676;font-size:11px;line-height:1.65}
.slw-merge-note b{color:#c9b98a}
.slw-merge-statrow{display:flex;gap:12px;flex-wrap:wrap;align-items:center;color:#8b8676;font-size:11px;margin:2px 0 6px}
.slw-merge-statrow b{color:#e8d9b0;font-weight:600}
.slw-merge-statrow .dot{width:5px;height:5px;border-radius:50%;background:#57606f;display:inline-block;margin-right:4px;vertical-align:1px}
@media(max-width:900px){.slw-merge-modes{grid-template-columns:1fr}.slw-merge-grid{grid-template-columns:1fr}}
.slw-phone-doc .slw-merge-modes{grid-template-columns:1fr}
.slw-phone-doc .slw-merge-grid{grid-template-columns:1fr}
.slw-phone-doc .slw-merge-stat{min-width:88px;flex:1 1 88px}
.slw-phone-doc .slw-merge-seg .tail{display:none}
`;
