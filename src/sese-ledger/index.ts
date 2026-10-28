// ===== 瑟瑟台账（SeseLedger）主入口 =====
//
// 装载与双全局注册（规格 §3.2 方案 C）：
// - canonical：window.SeseLedgerAPI（window/parent 双可达）；
// - 装载时探测真数据库（AutoCardUpdaterAPI / __ACU_STAR_DB_III_LOADED__）：
//   未检测到 → defineProperty 条件注册 AutoCardUpdaterAPI=legacyFace（老版状态栏+现版小手机
//   产物零改动实机跑通——S4 红线）；检测到 → 不注册旁观。
// - 事件接线：CHAT_CHANGED 全周期 / MESSAGE_RECEIVED 屏障+自动填表 /
//   MESSAGE_DELETED·SWIPED 裁剪 / pagehide 屏障 flush。
// - V2：API 来源 = 统一状态栏预设体系（host-config 只读自举）；删手动推进；增删投影/时光机/向导。

import TEMPLATE_JSON from '../unified-statusbar/docs/色色灵感数据库模板V3.3.4.json';
import STANDARD_TEMPLATE_JSON from './assets/standard-template.json';
import { serverFileStore } from '../unified-statusbar/core/server-file-store';
import { createSillyChatMetadataHost } from '../unified-statusbar/core/silly-chat-metadata-host';
import { UB_EVENT } from '../unified-statusbar/core/events';
import type { LedgerIndexFile, WorkbookJson } from './core/types';
import { createLedgerRuntime } from './core/runtime';
import { createLegacyFace } from './core/legacy-face';
import { createExtensionSettingsStore, isDriverEnabled, isProgressPersistEnabled } from './core/settings-store';
import { INDEX_FILE_NAME } from './core/identity';
import { isStoppedTable, resolveTable, resolveColumn } from './core/book';
import { normalizeTemplateAny } from './core/blueprint';
import { runManualFill, runRefillForStory, runScheduledFill, fillPromptSpecsOf } from './core/scribe';
import { createFillNotifier, createPersistentNotifier, createProgressToast } from './core/fill-notify';
import { collectDatabaseBareNames, collectTemplateExportEntryNames, stripDatabaseEntries, stripManagedEntries } from './core/lens';
import { createLedgerProjectionBridge } from './core/projection-bridge';
import { resolveCurrentPrimaryWorldbook } from '../unified-statusbar/core/worldbook-projection';
import { migrateFromDbFrames, planTemplateAlignment } from './core/migrator';
import { createDirectorRuntime } from './core/director-runtime';
import { createHostSendIndicator } from './core/host-send-indicator';
import { syncPlotRegex } from './core/plot-regex';
import { BUILTIN_PRESET_NAMES, DEFAULT_PRESET_NAME, builtinDriverPreset, defaultDriverPreset, isValidDriverPreset, normalizeDriverPreset } from './core/director';
import { createLedgerAiTransport } from './core/host-ai';
import { createLedgerLog } from './core/ledger-log';
import { FILL_BLOCK_IDS, normalizePromptSpecs, type LedgerPromptItemSpec } from './core/ai-request';
import { createTimeMachine } from './core/time-machine';
import { createHostConfigBridge, type HostConfigBridge } from './core/host-config';
import { createSummaryMergeMarkerStore } from './core/summary-merge-markers';
import { buildMergeInstruction, createSummaryMergeService, extractChronicle, type SummaryMergeConfig } from './core/summary-merge';
import { summaryWarning } from './core/summary-warning';
import { bindLedgerRelocationCopy } from './core/relocation';
import { isAnchorCandidate, ledgerAnchorFor } from './core/floor-scope';
import { canBindToCard, readBoundTemplateName, writeBoundTemplateName } from './core/card-binding';
import { mountWorkbenchPanel, type WorkbenchHost, type WorkbenchDeps } from './settings/panel/shell';

/** 主项目 v1 模板原形（**只喂两处**：数据库系裸名族的真名集 `collectTemplateExportEntryNames`、迁移边界的
 *  外文名对照——两处都要 entryName/DDL，而 v2 模板不含；台账运行结构不从这里来，见 STANDARD_TEMPLATE）。 */
const STANDARD_TEMPLATE_RAW = TEMPLATE_JSON as WorkbookJson;
/** 内置模板定名（＝标准模板资产的名字；外部契约：卡变量绑定与全局默认预设里存的就是它）。 */
const STANDARD_PRESET_NAME = '台账标准模板';
const LEDGER_VERSION = 'SeseLedger V2.031';

function hostWindow(): Window {
  try {
    if (typeof window !== 'undefined') return window;
  } catch (_e) { /* ignore */ }
  return globalThis as unknown as Window;
}

// ===== 在场角色表落账信号（台账接管时立绘每轮更新的唯一触发源） =====
// 口径：只有「在场角色表」所在分组本轮填表成功时才发；其它表的落账、投影、配置变更都不发。
// 拓扑：台账跑在脚本 iframe、状态栏主模块注入在父页，故同一 Event 派发到 自身 + parent + top，
// 监听方按 detail.token 去重（同一信号多窗口到达只算一次）。
function signalWindows(): Window[] {
  const out: Window[] = [];
  const push = (x: unknown): void => {
    try {
      const w = x as any;
      if (!w || typeof w.dispatchEvent !== 'function') return;
      if (out.indexOf(w) < 0) out.push(w as Window);
    } catch (_e) { /* cross-origin */ }
  };
  push(hostWindow());
  try { push((hostWindow() as any).parent); } catch (_e) { /* ignore */ }
  try { push((hostWindow() as any).top); } catch (_e) { /* ignore */ }
  return out;
}

let _presenceSignalSeq = 0;

/** 广播「在场角色表本轮落账完成」。token 逐信号唯一（同一次广播跨窗口恒定）。 */
function broadcastPresenceFilled(payload: { aiFloor: number; tableNames: string[] }): void {
  try {
    const detail = {
      token: `${payload.aiFloor}@${Date.now().toString(36)}@${++_presenceSignalSeq}`,
      aiFloor: payload.aiFloor,
      tableNames: payload.tableNames,
    };
    const event = new CustomEvent(UB_EVENT.ledgerPresenceFilled, { detail });
    for (const w of signalWindows()) {
      try { w.dispatchEvent(event); } catch (_e) { /* 单窗口故障不阻塞 */ }
    }
  } catch (_e) { /* 非浏览器环境 / CustomEvent 不可用：静默 */ }
}

function parentDoc(): Document | null {
  try {
    const p = (hostWindow() as any).parent;
    if (p?.document) return p.document as Document;
  } catch (_e) { /* cross-origin */ }
  return null;
}

function getStContext(): any {
  try {
    const w = hostWindow() as any;
    const rawSt = w.SillyTavern || w.TavernHelper?.SillyTavern;
    return typeof rawSt?.getContext === 'function' ? rawSt.getContext() : rawSt;
  } catch (_e) {
    return null;
  }
}

function getToastr(): any {
  try {
    return (hostWindow() as any).toastr || null;
  } catch (_e) {
    return null;
  }
}

export function bootLedger(): { dispose: () => Promise<void> } {
  const w = hostWindow() as any;
  const th = w.TavernHelper;
  const disposers: (() => void)[] = [];
  // ---- 运行日志（工作台「日志」页；只存内存，刷新/重载即空） ----
  const ledgerLog = createLedgerLog();
  /** info 档：控制台照旧，同时进日志页（装载/建账/落账/投影等时间线）。 */
  const log = (...args: unknown[]) => {
    console.log('[瑟瑟台账]', ...args);
    try { ledgerLog.push('info', '其他', args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ')); } catch (_e) { /* ignore */ }
  };
  /** warn 档：toast 照旧；source 缺省「其他」，调用点按需点名（配置/推进/…）。 */
  const warn = (message: string, source = '其他') => {
    try { getToastr()?.warning?.(message); } catch (_e) { /* ignore */ }
    console.warn('[瑟瑟台账]', message);
    try { ledgerLog.push('warn', source, message); } catch (_e) { /* ignore */ }
  };
  const notify = (message: string, title = '瑟瑟台账') => { try { getToastr()?.success?.(message, title); } catch (_e) { /* ignore */ } };
  // 常驻通知（不自动消失、点关闭才消失）：推进失败/终止这类「必须看到」的运行期提示走这条，
  // 同文案 5 分钟去重——自动管线连发同因失败不堆叠（与填表失败通知同口径）。
  const persistNotifier = createPersistentNotifier({ getToastr });
  /** warn 档 + 常驻 toast（控制台与日志页照旧记一笔）。 */
  const warnPersist = (message: string, source = '其他') => {
    console.warn('[瑟瑟台账]', message);
    try { ledgerLog.push('warn', source, message); } catch (_e) { /* ignore */ }
    persistNotifier.notify('warning', message);
  };

  // ---- 标准模板 v2（内置 = 台账自持的 v2 模板资产；与主项目 v1 模板解耦，换代＝换 assets/standard-template.json） ----
  const standardNorm = normalizeTemplateAny(STANDARD_TEMPLATE_JSON as unknown);
  if (!standardNorm.ok || !standardNorm.workbook || !standardNorm.v2) throw new Error('内置标准模板解析失败：' + standardNorm.errors.join('；'));
  const STANDARD_TEMPLATE = standardNorm.workbook;
  const STANDARD_TEMPLATE_V2 = { ...standardNorm.v2, name: STANDARD_PRESET_NAME };

  // ---- 设置（extensionSettings sese_ledger_v1） ----
  // 上游 ST/TT 的落盘 API 是 saveSettingsDebounced（防抖），没有 saveExtensionSettings；
  // 兜底再试全局 SillyTavern（getContext 不可用时 ctx0 本身就是它）。
  const ctx0 = getStContext();
  let settingsPersistWarned = false;
  const settings = createExtensionSettingsStore({
    targets: [ctx0, (hostWindow() as any).SillyTavern, (hostWindow() as any).TavernHelper?.SillyTavern],
    onPersistUnavailable: () => {
      if (settingsPersistWarned) return;
      settingsPersistWarned = true;
      warn('酒馆未提供设置持久化接口（saveSettingsDebounced），台账设置与预设刷新后可能丢失', '配置');
    },
  });

  // ---- 主项目 API 预设只读桥（host-config；请求前尽力自举，配置变更即时跟随） ----
  const hostConfig: HostConfigBridge = createHostConfigBridge({ warn: (m) => warn(m, '配置') });
  // parent/top 上的监听活得比本 iframe 久 ⇒ 重注入必须解绑（dispose 链统一撤）。
  disposers.push(hostConfig.bindSync(w));
  void hostConfig.boot();

  // ---- 全局索引（sl_index.json）----
  // 读失败必须与「404 干净缺失」区分（审计 A2）：带 error 一律抛出，identity 层据此沿用聊天内记录
  // 或进入只读，绝不用 `{}` 覆盖原索引。写失败同样抛出，由 identity 层降级为「本次不更新索引」。
  const indexStore = {
    async readIndex() {
      const r = await serverFileStore.readJson<LedgerIndexFile>(INDEX_FILE_NAME);
      if (r.error) throw new Error(r.error);
      if (!r.found || !r.value) return null;
      if (typeof r.value !== 'object' || !r.value.chats || typeof r.value.chats !== 'object') {
        throw new Error('全局索引文件格式损坏（chats 不是对象）');
      }
      return r.value;
    },
    async writeIndex(idx: LedgerIndexFile) {
      const r = await serverFileStore.uploadJson(INDEX_FILE_NAME, idx);
      if (!r.ok) throw new Error(r.error || '上传失败');
    },
  };

  // ---- 运行时 ----
  /** 本聊天生效的模板名：角色卡绑定优先（同卡各聊天共用）→ 全局默认预设 → 内置标准模板。
   *  绑定指向的预设已删时回落默认预设（并提示一次），不留悬空绑定阻断建账。 */
  function boundTemplateName(): string {
    const bound = readBoundTemplateName();
    if (bound) {
      if (bound === STANDARD_PRESET_NAME || settings.listTemplatePresetNames().includes(bound)) return bound;
      if (bound !== warnedMissingBinding) { warnedMissingBinding = bound; warn(`角色卡绑定的模板「${bound}」不存在，已回落默认预设（重新选一次模板即可改绑）`, '配置'); }
    }
    const fallback = String(settings.get().defaultTemplatePreset || '');
    return fallback || STANDARD_PRESET_NAME;
  }
  let warnedMissingBinding = '';

  /** 收敛模板（回放后用）：绑定模板 workbook（取不到 = null → 跳过收敛，按账本现状跑）。
   *  解析结果按预设版本记忆化（G1/G3）：回放/时光机 bake 不再每次 JSON.parse + 校验整份模板。 */
  function boundTemplateWorkbook(): WorkbookJson | null {
    const name = boundTemplateName();
    if (!name || name === STANDARD_PRESET_NAME) return STANDARD_TEMPLATE;
    const normalized = settings.loadTemplatePresetNormalized(name);
    if (normalized?.ok && normalized.workbook) {
      if (normalized.warnings?.length && warnedConvergeTemplate !== name) {
        warnedConvergeTemplate = name;
        warn(`模板「${name}」：${normalized.warnings.join('；')}`, '配置');
      }
      return normalized.workbook;
    }
    return STANDARD_TEMPLATE;
  }
  let warnedConvergeTemplate = '';

  /** 建账/收敛模板：按 boundTemplateName 取名解码（含其分组），取不到回落内置标准模板。 */
  function seedTemplateWorkbook(): WorkbookJson {
    // 与收敛模板共用同一份记忆化解析结果（含 v1→v2 转换）。
    return boundTemplateWorkbook() || STANDARD_TEMPLATE;
  }
  /** 旧聊天文件是否仍存在（fork/改名判定）：复用主项目已测的 ownerExists（角色卡 chats / 群聊 all）。 */
  const chatMetaHost = createSillyChatMetadataHost();
  async function previousChatExistsFor(chatKey: string): Promise<boolean | null> {
    if (!chatKey) return null;
    try {
      const ctx = getStContext();
      if (!ctx) return null;
      if (ctx.groupId !== undefined && ctx.groupId !== null && String(ctx.groupId) !== '') {
        const r = await chatMetaHost.ownerExists({ kind: 'group', chatId: chatKey });
        return r === 'exists' ? true : r === 'missing' ? false : null;
      }
      const avatar = liveCharacterAvatar(ctx);
      if (!avatar) return null;
      const r = await chatMetaHost.ownerExists({ kind: 'character', avatar, chatId: chatKey });
      return r === 'exists' ? true : r === 'missing' ? false : null;
    } catch (_e) {
      return null;
    }
  }

  /** 现取宿主上下文（不要在 context() 里缓存成闭包快照：ST 的 getContext().chatMetadata 是值快照，
   *  聊天加载/切换会整体替换 chat_metadata；缓存后写入会落到旧对象，回读却“成功”（A9 根因）。 */
  function liveStContext(): any {
    return getStContext();
  }
  function liveChatKeyOf(ctx: any): string {
    return String(ctx?.chatId || ctx?.chat_metadata?.file_name || '').trim();
  }
  /** 角色卡头像（ownerKey 真源）；ST 的 characterId 是数组下标，不是头像。
   *  兼容少数把 characterId 直接给成头像的宿主；拿不准时返回空（让 runtime 延迟解析，绝不写 'unknown'）。 */
  function liveCharacterAvatar(ctx: any): string {
    const raw = ctx?.characterId;
    if (raw === undefined || raw === null || raw === '') return '';
    const chars = Array.isArray(ctx.characters) ? ctx.characters : [];
    const index = Number(raw);
    if (Number.isInteger(index) && index >= 0) {
      const byIndex = chars[index];
      return byIndex?.avatar ? String(byIndex.avatar) : '';
    }
    const direct = String(raw).trim();
    if (!direct) return '';
    if (chars.some((c: any) => String(c?.avatar || '') === direct)) return direct;
    return /\.(png|jpe?g|webp)$/i.test(direct) ? direct : '';
  }

  const runtime = createLedgerRuntime({
    host: {
      context() {
        const ctx = liveStContext();
        if (!ctx || !Array.isArray(ctx.chat)) return null;
        const chatKey = liveChatKeyOf(ctx);
        return {
          chat: ctx.chat,
          host: {
            chat: ctx.chat,
            get chatMetadata() { return liveStContext()?.chatMetadata || {}; },
            saveChatMetadata: async () => {
              const live = liveStContext();
              const save = live?.saveMetadata || live?.saveChat || live?.saveChatConditional;
              if (typeof save === 'function') await save.call(live);
            },
            get chatKey() { return liveChatKeyOf(liveStContext()); },
          },
          characterId: liveCharacterAvatar(ctx),
          characterIndex: String(ctx.characterId ?? ''),
          groupName: ctx.groupId,
          chatKey,
        };
      },
    },
    // 复制聊天（fork）与改名的唯一区分依据：旧聊天文件是否还存在（审计 A3）。
    previousChatExists: previousChatExistsFor,
    files: serverFileStore,
    index: indexStore,
    standardTemplate: STANDARD_TEMPLATE,
    resolveSeedTemplate: seedTemplateWorkbook,
    // 结构真源＝本聊天绑定模板：回放后按它收敛（模板外内容丢弃；物理清理在结转）
    resolveConvergeTemplate: () => boundTemplateWorkbook(),
    // 运行日志：落盘失败 / 只读态 / 建账结果（工作台「日志」页）
    onLog: (entry) => { try { ledgerLog.push(entry.level, entry.source || '其他', entry.message, entry.detail); } catch (_e) { /* ignore */ } },
    // 只读保护要让用户看见（读不到/文件坏/元数据写不进时不能只进日志页）
    onBlocked: (message) => warnPersist(message, '存储'),
    // 可恢复状态（文件缺失/身份丢失/锚点全部失配）与自动找回都让用户看见
    onRecoverable: (message) => warnPersist(message, '存储'),
    onRecovered: (message) => warn(message, '存储'),
  });

  // ---- 世界书投影（统一走状态栏 worldbook-projection 协调器）----
  // 台账不再自己 getWorldbook/replaceWorldbook 做持续刷新：注册 `ledger-projections` 外部描述符，
  // 由协调器串行化整书读写、切聊天 epoch、refreshAll 批量；本函数只负责 revision 跳过门与请求。
  const projectionBridge = createLedgerProjectionBridge({
    runtime,
    window: hostWindow(),
    getHelper: () => w.TavernHelper,
    log: (level, source, message) => {
      try { ledgerLog.push(level, source, message); } catch (_e) { /* ignore */ }
    },
  });
  /** 请求一次投影：默认带「storageId|revision 未变则跳过」门；force 绕过（切聊天/显式刷新/删投影后重建）。 */
  function refreshWorldbook(opts: { force?: boolean } = {}): Promise<boolean> {
    return projectionBridge.request(opts);
  }
  /** 手工清理 sweep 与投影共用协调器队列，避免并发 read-modify-write 互相覆盖。 */
  function runProjectionExclusive<T>(task: () => Promise<T>): Promise<T> {
    return projectionBridge.exclusive(task);
  }

  /** 只扫**当前角色卡主世界书**剔除匹配条目（删数据库世界书用——绝不碰其他角色卡的世界书；
   *  与主项目投影/协调器同口径，不再回落附加世界书）。取不到时返回 null（调用方据此提示，
   *  不静默当作「删了 0 条」；读失败同样归 null，不再用空数组伪装成「本来就没有」）。 */
  async function sweepCardWorldbook(strip: (entries: any[]) => { changed: boolean; kept: any[] }): Promise<number | null> {
    try {
      const thApi = w.TavernHelper;
      const name = resolveCurrentPrimaryWorldbook(thApi);
      if (!thApi || !name) return null;
      const entries: any[] = await thApi.getWorldbook(name);
      if (!Array.isArray(entries)) return null;
      const { changed, kept } = strip(entries);
      if (changed) await thApi.replaceWorldbook(name, kept);
      return changed ? entries.length - kept.length : 0;
    } catch (_e) {
      return null;
    }
  }

  /** 扫全部世界书剔除匹配条目（删台账投影用）；返回删除条数。 */
  async function sweepWorldbooks(strip: (entries: any[]) => { changed: boolean; kept: any[] }): Promise<number> {
    try {
      const thApi = w.TavernHelper;
      if (!thApi?.getWorldbook || !thApi?.replaceWorldbook) return 0;
      const names: string[] = thApi.getWorldbookNames?.() || [];
      let removed = 0;
      for (const name of names) {
        const entries: any[] = await thApi.getWorldbook(name).catch(() => []);
        if (!Array.isArray(entries)) continue;
        const { changed, kept } = strip(entries);
        if (changed) {
          removed += entries.length - kept.length;
          await thApi.replaceWorldbook(name, kept);
        }
      }
      return removed;
    } catch (_e) {
      return 0;
    }
  }

  // ---- 数据库系「裸名」族（整表导出的条目名）----
  /** 真数据库插件的**整表/合并导出**只写 entryName 本身、不带 TavernDB-ACU- 前缀 ⇒ 只按前缀删会漏。
   *  真名集 = 内置标准模板 v1 原形 + 用户模板预设 + 当前账本表名（v2 转换丢 entryName，故必须从原形取）。
   *  按「来源指纹」记忆化：填表每次请求的扫描钩都会问，预设解析不宜每次都跑。 */
  let bareNamesMemo: { key: string; value: Set<string> } | null = null;
  function dbBareNames(): Set<string> {
    const presetNames = settings.listTemplatePresetNames();
    const book = runtime.book();
    const tableNames = book ? [...book.tables.values()].map((t) => String(t.name || '')) : [];
    const key = `${presetNames.join('|')}##${tableNames.join('|')}`;
    if (bareNamesMemo && bareNamesMemo.key === key) return bareNamesMemo.value;
    const lists: string[][] = [collectTemplateExportEntryNames(STANDARD_TEMPLATE_RAW), tableNames];
    for (const name of presetNames) {
      try {
        // loadTemplatePreset 返回**已解析**的模板对象（v1 原形或 v2 模板）——直接用，不要再取 .templateStr
        const parsed = settings.loadTemplatePreset(name) as any;
        if (!parsed || typeof parsed !== 'object') continue;
        // v1 原形优先：entryName 只存在于 v1 形状（v1→v2 转换会丢）；v2 预设回落转换后的 workbook（表名即条目名）
        const rawNames = collectTemplateExportEntryNames(parsed);
        if (rawNames.length) { lists.push(rawNames); continue; }
        const normalized = settings.loadTemplatePresetNormalized(name);
        if (normalized?.ok && normalized.workbook) lists.push(collectTemplateExportEntryNames(normalized.workbook));
      } catch (_e) { /* 单预设读取失败不阻塞 */ }
    }
    const value = collectDatabaseBareNames(...lists);
    bareNamesMemo = { key, value };
    return value;
  }

  /** 清一次**本卡世界书**里的数据库系条目（手动清理按钮与「应用迁移」自动清理共用同一口径）。
   *  返回删除条数；0 = 本就没有（幂等空转）；null = 世界书解析不到 / 助手 API 不可用（调用方点名提示）。 */
  async function purgeCardDatabaseEntries(): Promise<number | null> {
    return runProjectionExclusive(() => sweepCardWorldbook((entries) => stripDatabaseEntries(entries, dbBareNames())));
  }

  // ---- AI 请求通道（1A 同构：破限头尾 + 扫描钩 + 受保 generateRaw；API 来源 = 主项目预设体系） ----
  const ledgerAi = createLedgerAiTransport({
    resolveCustomApi: (purpose, groupId) => hostConfig.resolve(settings.get(), purpose, groupId).customApi as any,
    getDatabaseBareNames: () => dbBareNames(),
  });

  // ---- 兼容门面 + 条件别名（S4 红线） ----
  const face: any = createLegacyFace({
    runtime,
    settings,
    getChat: () => getStContext()?.chat || [],
    standardTemplate: STANDARD_TEMPLATE,
    standardPresetName: STANDARD_PRESET_NAME,
    refreshWorldbook,
    // SQL 桥写入失败 → 工作台日志（只记失败；来源归「其他」，不扩张六类口径）。
    onLog: (entry) => {
      try { ledgerLog.push(entry.level, entry.source || '其他', entry.message, entry.detail); } catch (_e) { /* ignore */ }
    },
    downloadJson: (filename, value) => {
      try {
        const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      } catch (_e) { /* ignore */ }
    },
  });
  const realDbPresent = !!(w.AutoCardUpdaterAPI || w.__ACU_STAR_DB_III_LOADED__);
  if (!realDbPresent) {
    try {
      // 条件别名：真数据库后装载时让位（setter 只接受非台账的赋值源）
      let override: unknown = null;
      Object.defineProperty(w, 'AutoCardUpdaterAPI', {
        get: () => override || face,
        set: (v: unknown) => {
          if (v && (v as any).__sese_ledger__ !== true) {
            override = v;
            console.warn('[瑟瑟台账] 检测到真数据库后装载，AutoCardUpdaterAPI 已让位（台账转旁观）');
          }
        },
        configurable: true,
      });
      log('已条件注册 AutoCardUpdaterAPI 别名（未检测到真数据库）');
    } catch (_e) { /* defineProperty 失败（宿主限制）则仅 canonical */ }
  } else {
    log('检测到真数据库在场，台账旁观（canonical API 仍可用）');
  }

  // ---- 填表 / 推进 ----
  // 填表终止（进度通知点击）：abort 所有在跑的填表 run（三入口共用一套控制器）——
  // 当前请求立即停（host-ai 走 stopGenerationById），后续批次与分组不再执行；已落账的改动保留。
  const activeFillRuns = new Set<AbortController>();
  /** 全局填表互斥（B13）：自动/手动/定向重填共用一个开关；运行中一律拒绝新入口。 */
  let fillBusy = false;
  /** 填表运行状态（工作台横幅 / 悬浮钮动效的数据源）：运行中 + 当前在跑请求的进度快照。
   *  纯事件推送，无轮询；面板关闭时无人订阅 ⇒ 零渲染开销。 */
  interface FillActivityState { running: boolean; entries: { label: string; attempt: number; maxAttempts: number }[] }
  const fillStateListeners = new Set<(state: FillActivityState) => void>();
  function fillStateSnapshot(): FillActivityState {
    return { running: fillBusy, entries: fillNotifier.runningEntries() };
  }
  function emitFillState(): void {
    const snapshot = fillStateSnapshot();
    for (const cb of [...fillStateListeners]) {
      try { cb(snapshot); } catch (_e) { /* 单个订阅故障不影响填表 */ }
    }
  }
  function beginFillRun(): { signal: AbortSignal; end: () => void } | null {
    if (fillBusy) return null;
    fillBusy = true;
    const ctrl = new AbortController();
    activeFillRuns.add(ctrl);
    emitFillState();
    return {
      signal: ctrl.signal,
      end: () => {
        activeFillRuns.delete(ctrl);
        if (activeFillRuns.size === 0) fillBusy = false;
        emitFillState();
      },
    };
  }
  function terminateFill(): void {
    if (activeFillRuns.size === 0) return;
    for (const ctrl of activeFillRuns) ctrl.abort();
    warnPersist('已终止本次填表：当前请求已停止，后续批次与分组不再执行（已落账的改动保留）', '填表');
  }
  // 填表通知：进度 toast（原位改文案 + 点击终止）+ 失败通知（只能手动关闭）；三入口共用同一 notifier。
  // 进度是否常驻跟随设置「填表/推进持久化」（缺省开）；失败通知不受影响、恒常驻。
  const progressPersistent = () => isProgressPersistEnabled(settings.get());
  const fillNotifier = createFillNotifier({ getToastr, onTerminate: terminateFill, isPersistent: progressPersistent });
  const fillerDeps = {
    runtime,
    getChat: () => getStContext()?.chat || [],
    readSettings: () => settings.get(),
    // 填表：不挂反八股（输出 SQL）；扫描钩剔除台账投影族 + 数据库系条目（两族都不进填表提示词）
    requestFill: (spec: any, opts?: { signal?: AbortSignal }) => ledgerAi.request({
      task: spec.task,
      antiCliche: false,
      items: spec.items,
      blocks: spec.blocks,
      scanText: spec.scanText,
      suspendLedgerFamily: true,
      apiPurpose: 'fill',
      groupId: spec.groupId,
    }, opts),
    refreshWorldbook,
    warn: (m: string) => warn(m, '填表'),
    progress: (event: any) => { fillNotifier.progress(event); emitFillState(); },
    fail: (message: string) => fillNotifier.fail(message),
    /** 运行日志上报（尝试违规明细 / 落账 / 跳过原因 / 原始 AI 输出）；来源固定「填表」。 */
    report: (event: { level: 'error' | 'warn' | 'info'; message: string; detail?: string; raw?: string }) => {
      try { ledgerLog.push(event.level, '填表', event.message, event.detail, event.raw); } catch (_e) { /* ignore */ }
      console.log('[瑟瑟台账]', `[填表·${event.level}] ${event.message}`);
    },
    // 本轮「在场角色表」分组落账完成 → 广播给状态栏（立绘每轮更新的唯一触发源）。
    onPresenceTableFilled: broadcastPresenceFilled,
  };

  // ---- 纪要合并（台账独占） ----
  // 标记存储：台账自己的 chat_metadata.seseLedgerMerge；不读写状态栏 chronicle.mergeMarkers。
  const summaryMarkers = createSummaryMergeMarkerStore({
    getChatMetadata: () => {
      const ctx = liveStContext();
      return (ctx?.chatMetadata && typeof ctx.chatMetadata === 'object') ? ctx.chatMetadata : null;
    },
    saveChat: async () => {
      const ctx = liveStContext();
      const save = ctx?.saveChatConditional || ctx?.saveChat || ctx?.saveMetadata;
      if (typeof save !== 'function') return false;
      try { await save.call(ctx); return true; } catch (_e) { return false; }
    },
  });
  const summaryMerge = createSummaryMergeService({
    book: () => runtime.book(),
    markers: summaryMarkers,
    requestAi: async (entries, maxWords, signal) => {
      try {
        const raw = await ledgerAi.request({
          task: '',
          antiCliche: false,
          items: [{ kind: 'segment', role: 'user', content: buildMergeInstruction(entries, maxWords) }],
          blocks: {},
          scanText: '',
          apiPurpose: 'fill',
        }, { signal });
        return extractChronicle(raw);
      } catch (e: any) {
        return { ok: false, error: String(e?.message || e) };
      }
    },
    commitOps: (source, ops) => runtime.commitOps(source, ops),
    flush: async () => { await runtime.flush(); },
    refreshWorldbook: () => refreshWorldbook({ force: true }),
    isFillRunning: () => fillBusy,
    warn: (m, source) => warn(m, source || '纪要合并'),
    notify: (m, title) => notify(m, title),
    log: (level, source, message) => {
      try { ledgerLog.push(level, source, message); } catch (_e) { /* ignore */ }
    },
  });

  /** 填表完成后检查纪要条数；超过阈值时每个聊天/阈值只提醒一次（跌回阈值以下后重置）。 */
  let lastSummaryWarnKey: string | null = null;
  function maybeWarnSummaryCount(): void {
    try {
      const info = summaryWarning(runtime.book(), settings.get());
      if (!info.over) { lastSummaryWarnKey = null; return; }
      const key = `${runtime.storageId() || 'no-store'}|${info.limit}`;
      if (lastSummaryWarnKey === key) return;
      lastSummaryWarnKey = key;
      warnPersist(`纪要已达 ${info.count} 条（建议上限 ${info.limit}）：建议到工作台 → 纪要合并压缩`, '纪要合并');
    } catch (_e) { /* 提醒失败不影响填表 */ }
  }

  async function autoFillOnce(): Promise<void> {
    // 全局互斥：手动/重填正在跑时不重复发起自动填表（B13）。
    const run = beginFillRun();
    if (!run) return;
    try {
      await runScheduledFill(fillerDeps, { signal: run.signal });
    } finally {
      run.end();
      maybeWarnSummaryCount();
    }
  }

  const directorProgress = createProgressToast({ getToastr, isPersistent: progressPersistent });
  // 推进中发送图标：与进度 toast 同一生命周期；通知自动隐去后图标仍保留到规划结束。
  const plotIndicator = createHostSendIndicator({ getDocument: parentDoc });
  const director = createDirectorRuntime({
    runtime,
    getChat: () => getStContext()?.chat || [],
    getTavernHelper: () => w.TavernHelper,
    getEventSource: () => getStContext()?.eventSource || null,
    getEventType: (name) => getStContext()?.eventTypes?.[name],
    requestTask: (spec: any, opts?: { signal?: AbortSignal }) => ledgerAi.request({
      task: spec.task,
      antiCliche: true,
      items: spec.items,
      blocks: spec.blocks,
      scanText: spec.scanText,
      apiPurpose: 'driver',
      // 推进不剔除台账/数据库投影条目（角色现行数据靠关键词命中进上下文）；黑名单两份照常生效
    }, opts),
    readDriverConfig: () => {
      const s = settings.get();
      return { enabled: isDriverEnabled(s), presetName: s.driverPresetName || DEFAULT_PRESET_NAME, presets: (s.plotPresets || {}) as Record<string, unknown> };
    },
    saveDriverConfig: () => { /* 预设切换走工作台面板 */ },
    updateUserMessage: async (index, patch) => {
      const ctx = getStContext();
      const msg = ctx?.chat?.[index];
      if (!msg) return false;
      try {
        Object.assign(msg, patch);
        await (ctx.saveChatConditional?.() ?? ctx.saveChat?.());
        return true;
      } catch (_e) {
        return false;
      }
    },
    // 输入框 #send_textarea 在主页面：iframe 里的 jQuery 根文档是 iframe 自身，选择器查不到 → 走 parent document 原生元素（同主项目模式）
    getInputBox: () => {
      try {
        const doc = parentDoc();
        return String((doc?.getElementById('send_textarea') as HTMLTextAreaElement | null)?.value ?? '');
      } catch (_e) { return ''; }
    },
    setInputBox: (text) => {
      try {
        const input = parentDoc()?.getElementById('send_textarea') as HTMLTextAreaElement | null;
        if (!input) return;
        const nativeSetter = Object.getOwnPropertyDescriptor((w as any).HTMLTextAreaElement.prototype, 'value')!.set!;
        nativeSetter.call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      } catch (_e) { /* ignore */ }
    },
    // 重置本轮：删最新用户楼及其后的 AI 楼 → 原输入放回输入框 → 标记意图并点击发送。
    // 序列在台账（父窗口）执行，面板 iframe 随消息删除销毁也不会中断。
    deleteLastMessage: async () => {
      const ctx = getStContext();
      if (!ctx || typeof ctx.deleteLastMessage !== 'function') throw new Error('聊天上下文不支持删除消息');
      await ctx.deleteLastMessage();
    },
    // 推进中止/失败＝本次发送作废（同数据库项目）：停宿主当前生成，避免原文继续发出去。
    stopGeneration: () => {
      try {
        const ctx = getStContext();
        if (typeof ctx?.stopGeneration === 'function') { ctx.stopGeneration(); return; }
      } catch (_e) { /* ignore */ }
      try { (hostWindow() as any).SillyTavern?.stopGeneration?.(); } catch (_e) { /* ignore */ }
    },
    clickSend: () => {
      try {
        const btn = parentDoc()?.getElementById('send_but') as HTMLElement | null;
        if (!btn) return false;
        btn.click();
        return true;
      } catch (_e) {
        return false;
      }
    },
    canSend: () => {
      try {
        const doc = parentDoc();
        if (!doc) return { ok: false, reason: '无法访问聊天页面' };
        const stop = doc.getElementById('stop_but') as HTMLElement | null;
        const stopVisible = !!stop && !!(stop.offsetWidth || stop.offsetHeight || stop.getClientRects().length);
        if (stopVisible) return { ok: false, reason: 'AI 正在生成中，请稍后再重置' };
        const send = doc.getElementById('send_but') as HTMLButtonElement | null;
        if (!send || send.disabled) return { ok: false, reason: '发送按钮不可用' };
        const boxes = doc.querySelectorAll('.mes_edit_box, .mes_edit_textarea');
        for (let i = 0; i < boxes.length; i++) {
          const box = boxes[i] as HTMLElement;
          if (box.offsetWidth || box.offsetHeight || box.getClientRects().length) return { ok: false, reason: '请先退出消息编辑模式' };
        }
        return { ok: true };
      } catch (_e) {
        return { ok: false, reason: '无法检查聊天状态' };
      }
    },
    notify: (message: string) => { try { getToastr()?.info?.(message); } catch (_e) { /* ignore */ } },
    // 推进进度：toast（原位改文案，同填表载体）——点 toast 本体＝终止本轮推进，点关闭按钮＝只关通知
    notifyProgress: (text, onAbort) => {
      // 两条终止入口（点通知本体 / 点发送图标）共用同一序列：先还原图标、再清通知、最后 abort 请求。
      // 图标先还原：即便底层请求不响应 abort，界面也不会一直停在「推进中」。
      const terminate = () => {
        plotIndicator.stop();
        directorProgress.close();
        onAbort();
      };
      directorProgress.show(text, { onClick: terminate });
      plotIndicator.start(terminate);
    },
    clearProgress: () => {
      directorProgress.close();
      plotIndicator.stop();
    },
    warn: (m: string) => warnPersist(m, '推进'),
    /** 运行日志上报（规划失败 / 重试耗尽 / 用户楼写入失败；附原始 AI 输出）；来源固定「推进」。 */
    report: (event: { level: 'error' | 'warn' | 'info'; message: string; detail?: string; raw?: string }) => {
      try { ledgerLog.push(event.level, '推进', event.message, event.detail, event.raw); } catch (_e) { /* ignore */ }
      console.log('[瑟瑟台账]', `[推进·${event.level}] ${event.message}`);
    },
    now: () => Date.now(),
  });

  /** 剧情推进显示正则同步：开启时注入/治愈，关闭时按前缀撤除。 */
  async function syncPlotRegexOnce(): Promise<void> {
    try {
      const res = await syncPlotRegex(w.TavernHelper || null, isDriverEnabled(settings.get()));
      if (res.added) log(`剧情推进显示正则已注入 ${res.added} 条`);
      if (res.removed) log(`剧情推进显示正则已撤除 ${res.removed} 条`);
    } catch (e) {
      warn(`剧情推进显示正则同步失败：${e instanceof Error ? e.message : String(e)}`, '推进');
    }
  }

  // ---- 时光机（回滚/重填接线在此；纯函数在 core/time-machine.ts） ----
  const timeMachine = createTimeMachine({ runtime, warn });
  /** 某一 AI 楼的原文与当前锚点（回滚重填据此钉住落点，不依赖"最后一条 AI 楼"）。 */
  function floorInfoAt(aiFloor: number): { text: string; anchor: string | null } {
    const chat = getStContext()?.chat || [];
    let ordinal = 0;
    for (let i = 0; i < chat.length; i++) {
      if (!isAnchorCandidate(chat[i])) continue;
      ordinal += 1;
      if (ordinal === aiFloor) return { text: String(chat[i]?.mes || ''), anchor: ledgerAnchorFor(chat[i], i) };
    }
    return { text: '', anchor: null };
  }
  async function rollbackFloor(aiFloor: number, opts: { refill?: boolean } = {}): Promise<{ ok: boolean; pruned: number; refilled?: number }> {
    const entries = runtime.visibleEntries().filter((e) => Number(e.at?.aiFloor) === aiFloor);
    if (entries.length === 0) return { ok: false, pruned: 0 };
    const anchors = new Set(entries.map((e) => e.at.anchor));
    const pruned = runtime.pruneEntriesAtAnchors(anchors);
    if (!pruned) return { ok: false, pruned: 0 };
    // 调度回退到上一层
    const schedule = runtime.getSchedule();
    for (const t of pruned.changedTables) {
      if ((schedule[t] ?? 0) >= aiFloor) schedule[t] = Math.max(0, aiFloor - 1);
    }
    await runtime.patchSchedule(schedule);
    await runtime.flush();
    let refilled: number | undefined;
    if (opts.refill) {
      const names = pruned.changedTables.map((tid) => runtime.book()?.tables.get(tid)?.name || tid);
      const floor = floorInfoAt(aiFloor);
      const target = floor.anchor ? { anchor: floor.anchor, aiFloor } : undefined;
      const run = beginFillRun();
      if (run) {
        try {
          const summary = await runRefillForStory(fillerDeps, names, floor.text, run.signal, target);
          refilled = summary.filledOps;
        } finally {
          run.end();
        }
      } else {
        warnPersist('已有填表在执行：回滚已完成，本次未重填（可稍后手动填表）', '填表');
      }
    }
    void refreshWorldbook();
    maybeWarnSummaryCount();
    return { ok: true, pruned: pruned.pruned, refilled };
  }

  // ---- 事件接线 ----
  const eventSource = ctx0?.eventSource;
  const eventTypes = ctx0?.eventTypes || {};
  const on = (name: string, cb: (...args: any[]) => void) => {
    if (eventSource && eventTypes[name]) {
      eventSource.on(eventTypes[name], cb);
      disposers.push(() => { try { eventSource.off?.(eventTypes[name], cb); } catch (_e) { /* ignore */ } });
    }
  };
  let chatChangeTimer: ReturnType<typeof setTimeout> | null = null;
  on('CHAT_CHANGED', () => {
    // 同步置「未落定」：状态栏 refreshAll 可能先于本台账异步装载到达，避免按旧账本投影。
    runtime.markChatChanging();
    if (chatChangeTimer) clearTimeout(chatChangeTimer);
    chatChangeTimer = setTimeout(() => {
      void runtime.onChatChanged().then(() => {
        // 落定后再请求；若状态栏 refreshAll 已连带跑过，revision 跳过门会直接跳过。
        void refreshWorldbook();
      });
    }, 50);
  });
  on('MESSAGE_RECEIVED', (_id: number, type: string) => {
    if (type === 'first_message') return; // V3.639 教训
    // 新楼层落地即同步序号基准：删楼/swipe 时靠它识别水位该回退几层
    runtime.syncFloors();
    void runtime.flush();
    void autoFillOnce();
    void refreshWorldbook();
  });
  on('MESSAGE_DELETED', () => { runtime.pruneRemovedAnchors(); void refreshWorldbook(); });
  on('MESSAGE_SWIPED', () => { runtime.pruneRemovedAnchors(); });
  const onPageHide = () => { void runtime.flush(); };
  hostWindow().addEventListener?.('pagehide', onPageHide);
  disposers.push(() => hostWindow().removeEventListener?.('pagehide', onPageHide));
  director.bind();
  disposers.push(() => director.unbind());
  // 一键搬家：把台账账本按切割层烘焙结转进新聊天（经主项目 __ubStorageRelocation 桥注册；
  // 主项目晚装载时由 ub-storage-relocation-ready 补注册）。
  disposers.push(bindLedgerRelocationCopy({
    runtime,
    files: serverFileStore,
    index: indexStore,
    getChat: () => getStContext()?.chat || [],
    onLog: (message) => ledgerLog.push('warn', '存储', message),
  }));
  void syncPlotRegexOnce();

  // 初始装载：当前聊天
  void runtime.onChatChanged().then(() => {
    void refreshWorldbook();
  });

  // ---- canonical API ----
  const canonical = {
    version: LEDGER_VERSION,
    ready: Promise.resolve(),
    /** 兼容方法面（老形态 API 的直接投影；两项目探测 SeseLedgerAPI 优先时经此桥接）。 */
    __legacyFace: face,
    /** 外部模块（状态栏/小手机）上报操作失败到工作台日志；source 非六类时自动归「其他」。
     *  低频失败专用——调用方不得在成功路径逐笔上报。 */
    reportIssue(level: 'error' | 'warn' | 'info', source: string, message: string, detail?: string): void {
      ledgerLog.push(level, source, message, detail);
    },
    snapshot(): WorkbookJson { return face.exportTableAsJson(); },
    query(tableName: string, options: any) { return face.queryTableRows({ tableName, ...options }); },
    readCell(tableName: string, rowId: number, column: string): string {
      const book = runtime.book();
      const table = book ? resolveTable(book, tableName) : null;
      if (!table) return '';
      const idx = resolveColumn(table, column);
      return idx >= 0 ? String(table.rows.get(Number(rowId))?.[idx] ?? '') : '';
    },
    /** 指定表是否由台账投影世界书（v2 定义 worldbook.enabled；表名/uid 两路寻址）。
     *  主项目据此退让重复注入（如人物关系表由台账投影时，不再加 UBS-关系-* 条目）。
     *  **停用组（所在分组频率 0）的表一律不投影** ⇒ 这里同样返回 false——主项目投影按既有让位口径自动回来。 */
    tableWorldbookInjection(tableName: string): boolean {
      const book = runtime.book();
      const table = book ? resolveTable(book, tableName) : null;
      return table?.v2def?.worldbook?.enabled === true && !isStoppedTable(table);
    },
    apply(ops: any[], options?: any) { return runtime.commitOps(options?.source || 'bridge', ops, { notify: options?.notify }); },
    onChange(cb: (data: WorkbookJson) => void) { runtime.onTableUpdate(cb); },
    getBlueprint(options?: any) { return face.getTableTemplate(options); },
    applyBlueprint(json: unknown, options?: any) { return face.importTemplateFromData(json, options); },
    listBlueprintPresets() { return [...settings.listTemplatePresetNames()]; },
    /** 模板绑定（跟随角色卡）：同卡各聊天共用一份绑定；群聊/欢迎页不可写 → 回落全局默认预设。 */
    templateBinding: {
      name(): string { return boundTemplateName(); },
      writable(): boolean { return canBindToCard(); },
      boundToCard(): string { return canBindToCard() ? readBoundTemplateName() : ''; },
      set(name: string): { ok: boolean; message: string } {
        const target = String(name || '').trim() || STANDARD_PRESET_NAME;
        if (!canBindToCard()) {
          void settings.update({ defaultTemplatePreset: target });
          return { ok: true, message: `群聊/无角色卡上下文：已把全局默认预设设为「${target}」（下次建账生效）` };
        }
        const ok = writeBoundTemplateName(target);
        return ok
          ? { ok: true, message: `本角色卡模板已设为「${target}」（该卡所有聊天跟随）` }
          : { ok: false, message: '写入角色卡变量失败（角色卡可能只读），模板绑定未变' };
      },
      /** 收敛用：当前生效模板的 workbook（取不到 → null，调用方跳过收敛）。 */
      workbook(): WorkbookJson | null {
        return boundTemplateWorkbook();
      },
    },
    exportBook(): WorkbookJson { return face.exportTableAsJson(); },
    async importBook(json: unknown) {
      const ok = await face.importTableAsJson(typeof json === 'string' ? json : JSON.stringify(json));
      // 全量导入会整体替换纪要表：旧合并标记不再可信，清掉（新表按 1 合 1 起算）。
      if (ok) await summaryMarkers.clear();
      return ok;
    },
    /** 台账找回（A9/文件缺失/锚点漂移）。工作台「迁移 → 台账恢复」与远程支持共用。 */
    recovery: {
      status: () => runtime.recoveryStatus(),
      candidates: () => runtime.recoveryCandidates(),
      inspect: (storageId: string) => runtime.inspectRecovery(storageId),
      export: (storageId: string) => runtime.exportRecovery(storageId),
      rebind: async (storageId: string) => {
        const r = await runtime.rebindStorage(storageId);
        if (r?.ok) await summaryMarkers.clear();
        return r;
      },
      startFresh: async () => {
        const r = await runtime.startFreshLedger();
        if (r?.ok) await summaryMarkers.clear();
        return r;
      },
      replayInvisible: (opts?: { dryRun?: boolean }) => runtime.replayInvisibleEntries(opts),
    },
    bakeStateAt(aiFloor: number) { return runtime.bakeStateAt(aiFloor); },
    driver: {
      /** 内置预设定名清单（工作台下拉的固定项）。 */
      builtinNames(): string[] { return [...BUILTIN_PRESET_NAMES]; },
      getPreset() {
        const s = settings.get();
        const name = String(s.driverPresetName || '');
        const builtin = builtinDriverPreset(name);
        if (builtin) return builtin;
        return normalizeDriverPreset((s.plotPresets || {})[name]) || defaultDriverPreset();
      },
      /** 重置本轮（面板重置按钮）：删本轮楼 → 原输入回填 → 标记意图重新推进。 */
      async resetRound(input: string) {
        return director.resetRound(String(input || ''));
      },
      /** 预设形状校验（面板列预设/导入都走它；旧格式一律不合格）。 */
      isValidPreset(value: unknown): boolean {
        return isValidDriverPreset(value);
      },
      async setPreset(preset: unknown, name: string) {
        const normalized = normalizeDriverPreset(preset);
        if (!normalized) throw new Error('推进预设格式不正确（只接受台账新格式）');
        if (BUILTIN_PRESET_NAMES.includes(name)) throw new Error(`「${name}」是内置预设名，请换一个名字（内置不可覆盖）`);
        normalized.name = name || normalized.name || '自定义预设';
        const s = settings.get();
        const presets = { ...(s.plotPresets || {}) };
        presets[normalized.name] = normalized;
        await settings.update({ plotPresets: presets, driverPresetName: normalized.name });
      },
      /** 删除预设（含旧格式残留）。 */
      async deletePreset(name: string): Promise<boolean> {
        if (!name || BUILTIN_PRESET_NAMES.includes(name)) return false;
        const s = settings.get();
        const presets = { ...(s.plotPresets || {}) };
        if (!(name in presets)) return false;
        delete presets[name];
        await settings.update({ plotPresets: presets, ...(s.driverPresetName === name ? { driverPresetName: DEFAULT_PRESET_NAME } : {}) });
        return true;
      },
    },
    fill: {
      /** 全局是否正在填表（面板据此禁用按钮，跨页签重画也不会恢复可点）。 */
      isRunning(): boolean { return fillBusy; },
      /** 运行状态快照（工作台横幅 / 悬浮钮动效；含当前在跑请求的分组与重试次数）。 */
      getState(): FillActivityState { return fillStateSnapshot(); },
      /** 订阅运行状态（开始 / 进度 / 结束都会推送；返回注销器）。 */
      subscribe(fn: (state: FillActivityState) => void): () => void {
        if (typeof fn !== 'function') return () => { /* noop */ };
        fillStateListeners.add(fn);
        try { fn(fillStateSnapshot()); } catch (_e) { /* 初始推送失败不影响订阅 */ }
        return () => { fillStateListeners.delete(fn); };
      },
      /** 终止本次填表（与点进度通知本体同一套 abort 逻辑）。 */
      terminate(): void { terminateFill(); },
      async runNow(options?: Parameters<typeof runManualFill>[1]) {
        const run = beginFillRun();
        if (!run) {
          return { skipped: true, reason: '已有填表在执行（请等待完成或点击进度通知终止）', groups: 0, filledOps: 0, errors: [] };
        }
        try {
          return await runManualFill(fillerDeps, options || {}, run.signal);
        } finally {
          run.end();
          maybeWarnSummaryCount();
        }
      },
      async refreshWorldbook() { return refreshWorldbook({ force: true }); },
    },
    /** 纪要合并（台账独占）：工作台「纪要合并」标签的唯一入口。 */
    summaryMerge: {
      getState: () => summaryMerge.getState(),
      getInfo: () => summaryMerge.getInfo(),
      getRowList: () => summaryMerge.getRowList(),
      getLastConfig: () => summaryMerge.getLastConfig(),
      preview: (config: SummaryMergeConfig) => summaryMerge.preview(config),
      start: (config: SummaryMergeConfig) => summaryMerge.start(config),
      abort: () => summaryMerge.abort(),
      resume: (indices?: number[]) => summaryMerge.resume(indices),
      commit: () => summaryMerge.commit(),
      reset: () => summaryMerge.reset(),
      subscribe: (fn: (state: any) => void) => summaryMerge.subscribe(fn),
    },
    migrate: {
      async fromDb(): Promise<unknown> {
        const ctx = getStContext();
        if (!ctx?.chat) return { ok: false, warnings: ['无法获取聊天上下文'] };
        const dbExport = realDbPresent && typeof w.AutoCardUpdaterAPI?.exportTableAsJson === 'function' && !(w.AutoCardUpdaterAPI as any).__sese_ledger__
          ? w.AutoCardUpdaterAPI.exportTableAsJson()
          : null;
        // 外文名对照要吃带 DDL 的原始 v1 模板：STANDARD_TEMPLATE 是 v2 转换产物（sourceData.ddl 恒空）
        return migrateFromDbFrames({ chat: ctx.chat, chatMetadata: ctx.chatMetadata, standardTemplate: STANDARD_TEMPLATE, foreignNameTemplate: STANDARD_TEMPLATE_RAW, dbExport });
      },
      /** 按当前模板对齐迁移产物（差异四 Case 报告 + 数据行容错；有历史改动时保留 row_id 并重写列名）。 */
      alignToTemplate(report: any, templateWorkbook: WorkbookJson, templateName: string) {
        if (!report?.ok || !report.snapshot) return null;
        const result = planTemplateAlignment({ ...(report.snapshot as any) }, templateWorkbook, templateName, { entries: report.entries || [] });
        // 重写后的条目写回工作对象：apply() 直接用 report.entries 落盘。
        if (result?.entries) report.entries = result.entries;
        return result;
      },
      /** 应用迁移产物（迁移向导确认后调用）。 */
      async apply(report: any, aligned?: WorkbookJson | null): Promise<boolean> {
        if (!report?.ok || !report.snapshot) return false;
        const store = runtime.__store();
        if (!store) return false;
        let maxSeq = 0;
        for (const e of report.entries || []) maxSeq = Math.max(maxSeq, e.seq);
        const snapshot = aligned || report.snapshot;
        const okSnap = await store.persistSnapshot(snapshot, report.snapshotAnchor || '', report.snapshotAiFloor || 0, maxSeq);
        await store.replaceEntries(report.entries || []);
        const okEntries = await store.flush();
        // 推进历史平移：用户楼 qrf_plot → sl_plot
        const ctx = getStContext();
        let moved = 0;
        if (ctx?.chat) {
          for (const floor of report.plotFloors || []) {
            const msg = ctx.chat[floor.messageIndex];
            if (msg && msg.qrf_plot && !msg.sl_plot) { msg.sl_plot = msg.qrf_plot; moved++; }
          }
          if (moved > 0) await (ctx.saveChatConditional?.() ?? ctx.saveChat?.());
        }
        await runtime.onChatChanged();
        await refreshWorldbook();
        // 应用迁移＝台账接管存量：顺手清一次**本卡世界书**里残留的数据库系条目（旧注入 + 换词根前的旧投影）。
        // 幂等口径：已经清过（本卡世界书里已无数据库系条目）＝ 匹配 0 条，不重复动作也不提示；
        // 世界书解析不到（无卡上下文 / 助手 API 不可用）返回 null → 点名提醒走清理工具手动执行，不静默当「已清」。
        if (okSnap && okEntries) {
          // 迁移/导入替换了纪要表：旧合并标记不再可信，清掉（新表按 1 合 1 起算）。
          await summaryMarkers.clear();
          const purged = await purgeCardDatabaseEntries();
          if (purged === null) warn('迁移后未能解析本卡世界书：数据库系条目未自动清理（可在「迁移 → 清理工具」手动执行）');
          else if (purged > 0) notify(`迁移后自动清理：本卡世界书里 ${purged} 条数据库系条目已删除`);
        }
        return okSnap && okEntries;
      },
    },
    timemachine: {
      timeline: () => timeMachine.timeline(),
      foldBoundary: () => timeMachine.foldBoundary(),
      diffAtFloor: (floor: number) => timeMachine.diffAtFloor(floor),
      veto: (floor: number, diffs: any[]) => timeMachine.veto(floor, diffs),
      exportFloor: (floor: number) => timeMachine.exportFloor(floor),
      rollbackFloor,
      reload: () => timeMachine.timeline(),
    },
    wizard: {
      // 请求与解析由工作台面板直接驱动（canonical.aiRequest 见下，走 1A 传输）
    },
    prompts: {
      getFillSystem(): string {
        const s = settings.get();
        return String(s.fillSystemPrompt || '').trim();
      },
      async setFillSystem(text: string) {
        await settings.update({ fillSystemPrompt: String(text || '').trim() });
      },
      /** 填表内容项清单（段 + 固定块混排）。 */
      getFillPrompt(): LedgerPromptItemSpec[] {
        return fillPromptSpecsOf(settings.get());
      },
      async setFillPrompt(specs: unknown) {
        // null/undefined = 清掉覆盖，继续跟随内置默认（与任务段「留空=内置」同口径）。
        if (specs == null) {
          await settings.update({ fillPrompt: undefined });
          return;
        }
        await settings.update({ fillPrompt: normalizePromptSpecs(specs, FILL_BLOCK_IDS) });
      },
    },
    /** 删除台账的全部世界书投影（只删受管 SeseLedger-* 条目，不碰其他条目；删除后可「刷新当前投影」重建）。 */
    async deleteAllProjections(): Promise<number> {
      const removed = await runProjectionExclusive(() => sweepWorldbooks(stripManagedEntries));
      projectionBridge.invalidate(); // 投影已被清空：作废 revision 跳过门（显式刷新按钮本身走 force，双保险）
      return removed;
    },
    /** 删除**当前角色卡主世界书**里的数据库系条目（真数据库全族：`TavernDB-ACU-*` 含 `ACU-[code]-` 隔离前缀形态
     *  + 两类无前缀例外——整表导出裸名（模板 entryName + -表头/-包裹-上/-包裹-下）与总结/小总结/重要人物裸名词根）。
     *  **只扫当前角色卡的主世界书（与主项目投影同口径），绝不碰其他角色卡的世界书**。
     *  只删世界书条目，不碰消息与其他条目；红线：真数据库在场时删这些等于删真库的注入内容，UI 已二次确认。
     *  返回删除条数；世界书解析不到/读取失败 → null（UI 提示，不静默当「删了 0 条」）。 */
    async deleteDatabaseWorldbooks(): Promise<number | null> {
      return purgeCardDatabaseEntries();
    },
    /** 清除当前聊天数据（工作台清理工具）：删当前聊天两个外部存储文件 + 删台账世界书投影 + 按当前模板重建空账本。
     *  返回 {files, reset, projections, seeded}（删除文件数 / 是否已复位建账 / 删除投影条目数 / 是否已重建空账本）。
     *  本聊天尚未建账时不建账（用户没数据可清，凭空建一份反而突兀）：只清投影。 */
    async clearCurrentChatData(): Promise<{ files: number; reset: boolean; projections: number; seeded: boolean }> {
      const { files, reset } = await runtime.clearCurrentChatData();
      // 清除当前聊天数据：台账独占的合并标记一并清掉（旧纪要不在了，计数无意义）。
      await summaryMarkers.clear();
      // 投影来自刚清掉的旧数据：先整族删（含纪要包裹条目），再按空账本刷新（此时无数据行，只登记空态）
      const projections = await runProjectionExclusive(() => sweepWorldbooks(stripManagedEntries));
      projectionBridge.invalidate();
      const seeded = reset ? await runtime.ensureSeeded() : false;
      if (reset) await refreshWorldbook({ force: true });
      return { files, reset, projections, seeded };
    },
    /** 数据库系整表导出「裸名」族当前真名集（无 TavernDB-ACU- 前缀；删除清单/扫描剔除共用，UI 提示用）。 */
    databaseBareNames(): string[] {
      return [...dbBareNames()].sort();
    },
    /** 清理数据库消息残留（消息上的 TavernDB_ACU_* 帧字段；世界书条目见「删除所有数据库世界书」），执行前 UI 已确认。 */
    async cleanupDbMessageFields(): Promise<number> {
      let messageCount = 0;
      const ctx = getStContext();
      if (ctx?.chat) {
        const fields = ['TavernDB_ACU_IsolatedData', 'TavernDB_ACU_Data', 'TavernDB_ACU_SummaryData', 'TavernDB_ACU_IndependentData', 'TavernDB_ACU_Identity', 'TavernDB_ACU_LocalMessageAnchor', 'TavernDB_ACU_ModifiedKeys', 'TavernDB_ACU_UpdateGroupKeys'];
        for (const msg of ctx.chat) {
          let touched = false;
          for (const f of fields) {
            if (msg && msg[f] !== undefined) { delete msg[f]; touched = true; }
          }
          if (touched) messageCount++;
        }
        if (messageCount > 0) await (ctx.saveChatConditional?.() ?? ctx.saveChat?.());
      }
      return messageCount;
    },
    hostConfig,
    standardTemplateV2: STANDARD_TEMPLATE_V2,
    standardTemplateWorkbook: STANDARD_TEMPLATE,
    standardPresetName: STANDARD_PRESET_NAME,
    /** 建表向导等工具请求：走同一 1A 传输（破限头尾＋受保 generateRaw），但不带台账固定块与扫描素材。
     *  首条 system 段充当结构头任务段，其余段按序发出；AI 来源跟随分组1（按分组独立时的用户定案）。 */
    aiRequest: (messages: Array<{ role: string; content: string }>, opts?: { signal?: AbortSignal }) => {
      const list = (messages || []).filter((m) => m && typeof m.content === 'string' && m.content.trim());
      const first = list[0];
      const isTask = !!first && (first.role === 'system' || first.role === 'assistant');
      return ledgerAi.request({
        task: isTask ? first.content : '',
        items: (isTask ? list.slice(1) : list).map((m) => ({ kind: 'segment' as const, role: m.role, content: m.content })),
        blocks: {},
        scanText: '',
        apiPurpose: 'fill',
        groupId: 1,
      }, opts);
    },
    openSettings(tab?: string): void { panelHost.open(tab as any); },
    /** 设置页推进开关联动：注入/撤除剧情推进显示正则。 */
    async syncPlotRegex(): Promise<void> { await syncPlotRegexOnce(); },
    runtime,
  };

  // ---- 工作台面板（六标签页） ----
  const panelDeps: WorkbenchDeps = {
    window: hostWindow(),
    settings,
    runtime,
    canonical: canonical as any,
    hostConfig,
    realDbPresent,
    standardPresetName: STANDARD_PRESET_NAME,
    standardTemplateV2: STANDARD_TEMPLATE_V2,
    notify,
    warn,
    log: ledgerLog,
    getChat: () => getStContext()?.chat || [],
    refreshWorldbook,
    requestAiMessages: canonical.aiRequest,
    diagWorldbook: () => projectionBridge.diag(),
  };
  const panelHost: WorkbenchHost = mountWorkbenchPanel(panelDeps);
  // 主项目新增/删除/切换 API 预设 → hostConfig 重读 → 设置页即时刷新（无需刷新酒馆）。
  disposers.push(hostConfig.onSynced(() => panelHost.refreshSettings()));

  // ---- 双全局注册 ----
  w.SeseLedgerAPI = canonical;
  try { (hostWindow().parent as any).SeseLedgerAPI = canonical; } catch (_e) { /* cross-origin */ }
  w.__SL_LOADED__ = true;

  log(`装载完成（${LEDGER_VERSION}${realDbPresent ? '，真数据库在场：旁观模式' : '，已接管 AutoCardUpdaterAPI'}）`);
  void th;

  return {
    async dispose() {
      // 先撤外部投影注册：协调器里残留的描述符不得再读到本实例已封存的 runtime。
      try { projectionBridge.dispose(); } catch (_e) { /* ignore */ }
      for (const d of disposers) { try { d(); } catch (_e) { /* ignore */ } }
      // 最后一批脏数据落盘 + 就地封存存储：必须在「下一份实例装载」之前完成，否则旧实例的
      // 防抖计时器/在途写会以陈旧状态覆盖新实例已载入的文件（跨注入的数据竞争）。
      try { await runtime.flush(); } catch (_e) { /* best-effort */ }
      try { await runtime.__store()?.close(); } catch (_e) { /* best-effort */ }
      try { runtime.__store()?.destroy(); } catch (_e) { /* ignore */ }
      try { summaryMerge.dispose(); } catch (_e) { /* ignore */ }
      try { plotIndicator.dispose(); } catch (_e) { /* ignore */ }
      panelHost.unmount();
      try { if (!realDbPresent) delete (w as any).AutoCardUpdaterAPI; } catch (_e) { /* ignore */ }
      try { if (w.SeseLedgerAPI === canonical) delete w.SeseLedgerAPI; } catch (_e) { /* ignore */ }
      try {
        const p = (hostWindow() as any).parent;
        if (p && p !== w && p.SeseLedgerAPI === canonical) delete p.SeseLedgerAPI;
      } catch (_e) { /* cross-origin */ }
      w.__SL_LOADED__ = false;
    },
  };
}

// 装载入口（重复装载：旧实例真卸载后再重启）。
// 卸载器发布到「父窗口」而非自有 window：酒馆助手脚本重注入 = 全新 iframe（自有 window 上的防重
// 标记全部归零），而旧实例挂在 eventSource / parent document / TavernHelper.generate 上的钩子与
// 在途文件写入都还在——不真卸载就会出现「每条消息被 N 份实例处理、N 份 AI 请求、双写同一对存储
// 文件」的越用越卡（本文件的 __sl_booting 只防同窗口重求值）。
const w0 = hostWindow() as any;
const sharedHost: any = (() => {
  try { const p = w0.parent; if (p && p !== w0) return p; } catch (_e) { /* cross-origin */ }
  return null;
})();
function takeStaleDisposer(): (() => void | Promise<void>) | null {
  for (const holder of [w0, sharedHost]) {
    if (!holder) continue;
    try {
      const stale = holder.__SL_DISPOSE__;
      if (typeof stale === 'function') { holder.__SL_DISPOSE__ = null; return stale; }
    } catch (_e) { /* ignore */ }
  }
  return null;
}
if (!w0.__sl_booting) {
  w0.__sl_booting = true;
  void (async () => {
    try {
      const stale = takeStaleDisposer();
      if (stale) {
        try { await stale(); } catch (e) { console.warn('[瑟瑟台账] 旧实例卸载失败（继续装载新实例）：', e); }
      }
      const inst = bootLedger();
      w0.__SL_INSTANCE__ = inst;
      try { w0.__SL_DISPOSE__ = inst.dispose; } catch (_e) { /* ignore */ }
      if (sharedHost) { try { sharedHost.__SL_DISPOSE__ = inst.dispose; } catch (_e) { /* ignore */ } }
    } catch (e) {
      console.error('[瑟瑟台账] 装载失败：', e);
    } finally {
      w0.__sl_booting = false;
    }
  })();
}
