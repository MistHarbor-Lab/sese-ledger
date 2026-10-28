// ===== 主项目配置引导（只读）——台账 API 来源桥 =====
//
// 台账不再单独配置 API（需求2）：推进 / 填表 / 时光机重填 / 建表向导的 AI 请求
// 全部读统一状态栏的 API 预设体系（customApiPresets 仓库 + 全局模式解析）。
// 做法与小手机 host-config 同款：自举一份**只读**配置实例接在与主项目相同的
// 偏好外部文件（usb_global_preferences_<h>.json）+ extensionSettings 密钥影子上，
// 写方法静默拦截并告警一次——台账对主项目配置只读。
// 解析口径（对齐主项目 api-config）：
// - apiMode='tavern' → 酒馆主 API（custom_api 不传）；
// - apiMode='custom' → activeApiPresetId 指向预设；
// - apiMode='per-feature' → 台账无自己的功能位，回退酒馆主 API（方案 §9-3 默认）；
// - settings.apiPresetId 非空时优先（台账侧「指定预设」覆盖行为）；
// - 预设被删 → 告警一次 + 回退主 API，不阻断。

import {
  configureConfigStorage,
  getConfig,
  invalidateConfigCache,
  STATUSBAR_CONFIG_CHANGED_EVENT,
} from '../../unified-statusbar/core/config-store';
import {
  createExternalObjectStore,
  type ExternalObjectStore,
} from '../../unified-statusbar/core/external-object-store';
import { createServerFileStore } from '../../unified-statusbar/core/server-file-store';
import type { LedgerFilesLike } from './ledger-store';
import type { LedgerApiBinding } from './settings-store';

export type HostConfigState = 'ready' | 'missing' | 'error';

export interface HostPresetBrief {
  id: string;
  name: string;
  model: string;
}

/** generateRaw 的 custom_api 形态（对齐主项目 CustomApiConfig 子集）。
 *  六项数值参数必须**全部显式给出**（缺省值写 'unset'）：generateRaw 对「未给」按
 *  'same_as_preset' 处理，会保留酒馆全局采样值；主项目正是靠 'unset' 把它们从请求体删掉。 */
export interface LedgerCustomApi {
  apiurl?: string;
  key?: string;
  model?: string;
  max_tokens?: 'same_as_preset' | 'unset' | number;
  temperature?: 'same_as_preset' | 'unset' | number;
  frequency_penalty?: 'same_as_preset' | 'unset' | number;
  presence_penalty?: 'same_as_preset' | 'unset' | number;
  top_p?: 'same_as_preset' | 'unset' | number;
  top_k?: 'same_as_preset' | 'unset' | number;
}

export interface ResolvedLedgerApi {
  /** undefined = 酒馆主 API。 */
  customApi?: LedgerCustomApi;
  /** 展示名（设置页/向导显示）。 */
  label: string;
  mode: 'tavern' | 'custom' | 'per-feature' | 'pinned';
}

/** 台账两条 AI 管线各自选择 API 来源（用户定案：填表 / 推进分别设置）。 */
export type LedgerApiPurpose = 'fill' | 'driver';

/** 台账设置中与 API 来源相关的字段（新字段缺省时回退旧单来源字段）。 */
export interface LedgerApiScopeSettings {
  apiPresetId?: string;
  apiMode?: string;
  fillApiPresetId?: string;
  fillApiMode?: string;
  fillApiPerGroup?: boolean;
  fillGroupApis?: Record<string, LedgerApiBinding>;
  driverApiPresetId?: string;
  driverApiMode?: string;
}

/** 取某个用途的来源设置：新字段是字符串（含空串＝跟随）就用它，否则回退旧字段。
 *  旧配置（只有 apiPresetId/apiMode）在首次升级后仍对两条管线同时生效，用户不动就零变化。 */
function scopedApiSettings(
  settings: LedgerApiScopeSettings | null | undefined,
  purpose: LedgerApiPurpose,
): { apiPresetId: string; apiMode: string } {
  const prefix = purpose === 'driver' ? 'driver' : 'fill';
  const idRaw = (settings as Record<string, unknown> | null | undefined)?.[`${prefix}ApiPresetId`];
  const modeRaw = (settings as Record<string, unknown> | null | undefined)?.[`${prefix}ApiMode`];
  return {
    apiPresetId: typeof idRaw === 'string' ? idRaw : String(settings?.apiPresetId || ''),
    apiMode: typeof modeRaw === 'string' ? modeRaw : String(settings?.apiMode || ''),
  };
}

let _state: HostConfigState = 'error';
let _warnedWrite = false;
let _warnedMissingPreset = false;
let _bound = false;
let _syncInFlight: Promise<void> | null = null;
let _syncDisposers: Array<() => void> = [];
const _syncedListeners = new Set<() => void>();

interface HostPresetLike {
  id?: unknown;
  name?: unknown;
  model?: unknown;
  url?: unknown;
  key?: unknown;
  maxTokens?: unknown;
  temperature?: unknown;
  frequencyPenalty?: unknown;
  presencePenalty?: unknown;
  topP?: unknown;
  topK?: unknown;
}

function readOnlyView(store: ExternalObjectStore): ExternalObjectStore {
  const swallow = (label: string) => {
    if (!_warnedWrite) {
      _warnedWrite = true;
      console.warn('[瑟瑟台账] 拦截了一次对主项目偏好文件的写入（台账对主项目配置只读）:', label);
    }
    return true;
  };
  return {
    load: () => store.load(),
    sync: () => store.sync(),
    read: (key, fallback) => store.read(key, fallback),
    readAll: () => store.readAll(),
    patch: () => Promise.resolve(swallow('patch')),
    replaceAll: () => Promise.resolve(swallow('replaceAll')),
    patchCommit: async () => ({ ok: true, confirmed: true, retryable: false }),
    replaceCommit: async () => ({ ok: true, confirmed: true, retryable: false }),
    flush: () => store.flush(),
    status: () => store.status(),
    _internal: store._internal,
  };
}

export interface HostConfigBridge {
  boot(): Promise<HostConfigState>;
  state(): HostConfigState;
  refresh(): Promise<HostConfigState>;
  /** 主项目预设清单（设置页下拉用）。 */
  listPresets(): HostPresetBrief[];
  /** 当前 API 模式与激活预设名（下拉首项文案用）。 */
  describeGlobalMode(): string;
  /** 解析台账 AI 请求应使用的 custom_api（purpose: 填表 / 推进。缺省 fill）。
   *  groupId 仅填表生效：按分组独立开启且有绑定则用分组绑定，否则沿用基准。 */
  resolve(settings: LedgerApiScopeSettings, purpose?: LedgerApiPurpose, groupId?: number): ResolvedLedgerApi;
  /** 配置变更监听（主项目切换/删除预设后台账即时跟随）。 */
  onSynced(listener: () => void): () => void;
  /** 事件绑定（幂等；监听自身 + parent/top 的主项目配置落盘推送）。返回解绑函数（重注入必须调用）。 */
  bindSync(w: { addEventListener?: unknown } | null | undefined): () => void;
  /** 测试/重载用：直接读配置（自举失败时返回 null）。 */
  readConfig(): Record<string, any> | null;
}

type LedgerNumericParam = 'same_as_preset' | 'unset' | number;

/**
 * 预设数值参数 → custom_api 值。`'same_as_preset'` / `'unset'` 原样保留；
 * 缺省 / 非有限数 / 越界 → `'unset'`。
 *
 * ★缺省必须显式落成 `'unset'`，不能省字段：generateRaw 对「未给」的数值参数按
 * `'same_as_preset'` 处理（保留酒馆全局值），只有 `'unset'` 才会把它从请求体删除。
 * 台账曾因漏传 top_p 继承了全局 Top P=0，被 DeepSeek 以 400 `Invalid top_p value` 拒绝。
 */
function numericParamOf(value: unknown, valid?: (n: number) => boolean): LedgerNumericParam {
  if (value === 'same_as_preset' || value === 'unset') return value;
  if (typeof value === 'number' && Number.isFinite(value) && (!valid || valid(value))) return value;
  return 'unset';
}

function presetToCustomApi(preset: HostPresetLike): LedgerCustomApi {
  const cfg: LedgerCustomApi = {};
  if (preset.url && String(preset.url).trim()) cfg.apiurl = String(preset.url).trim();
  if (preset.key) cfg.key = String(preset.key);
  if (preset.model && String(preset.model).trim()) cfg.model = String(preset.model).trim();
  // 六项数值参数与主项目 api-config.presetToCustomApiConfig 同口径：一律透传（含 'unset'）。
  cfg.max_tokens = numericParamOf(preset.maxTokens);
  cfg.temperature = numericParamOf(preset.temperature);
  cfg.frequency_penalty = numericParamOf(preset.frequencyPenalty);
  cfg.presence_penalty = numericParamOf(preset.presencePenalty);
  // top_p 合法区间 (0, 1]（DeepSeek 明确拒绝 0 / null）；越界按 'unset' 不外发。
  cfg.top_p = numericParamOf(preset.topP, (n) => n > 0 && n <= 1);
  cfg.top_k = numericParamOf(preset.topK);
  return cfg;
}

export function createHostConfigBridge(deps: { files?: LedgerFilesLike; now?: () => number; warn?: (m: string) => void } = {}): HostConfigBridge {
  const warn = deps.warn || ((m: string) => console.warn('[瑟瑟台账]', m));

  async function boot(): Promise<HostConfigState> {
    try {
      const store = createExternalObjectStore({
        files: (deps.files || createServerFileStore()) as any,
        namespace: 'preferences',
        writerId: 'sese-ledger-readonly',
        now: deps.now || (() => Date.now()),
        makeId: (prefix: string) => `${prefix}_${Date.now().toString(36)}`,
      });
      const status = await store.load();
      configureConfigStorage('external', readOnlyView(store));
      invalidateConfigCache();
      _state = status.state === 'ready' ? 'ready' : status.state === 'uninitialized' ? 'missing' : 'error';
      return _state;
    } catch (_e) {
      _state = 'error';
      return _state;
    }
  }

  function presetsOf(): HostPresetLike[] {
    try {
      const list = (getConfig() as any)?.customApiPresets;
      return Array.isArray(list) ? list : [];
    } catch (_e) {
      return [];
    }
  }

  function findPreset(id: string): HostPresetLike | null {
    if (!id) return null;
    return presetsOf().find((p) => String(p?.id) === id) || null;
  }

  function describeGlobalMode(): string {
    try {
      const cfg = getConfig() as any;
      const mode = String(cfg?.apiMode || 'tavern');
      if (mode === 'custom') {
        const preset = findPreset(String(cfg?.activeApiPresetId || ''));
        return `自定义 · ${preset ? (preset.model || preset.name || '未命名预设') : '（预设缺失）'}`;
      }
      if (mode === 'per-feature') return '按功能分配（台账回退酒馆主 API）';
      return '酒馆主 API';
    } catch (_e) {
      return '酒馆主 API';
    }
  }

  function warnMissingPreset(): void {
    if (_warnedMissingPreset) return;
    _warnedMissingPreset = true;
    warn('台账指定的 API 预设已被删除，已回退（可在台账设置页重选）');
  }

  /** 分组绑定 → 解析口径；未配置 / 非填表 / 无 groupId 返回 null（沿用基准）。 */
  function groupScopeOf(
    settings: LedgerApiScopeSettings,
    groupId?: number,
  ): { apiPresetId: string; apiMode: string } | null {
    if (settings.fillApiPerGroup !== true) return null;
    if (typeof groupId !== 'number' || !Number.isFinite(groupId) || groupId <= 0) return null;
    const binding = settings.fillGroupApis?.[String(Math.trunc(groupId))];
    if (!binding || typeof binding !== 'object') return null;
    if (binding.mode === 'tavern') return { apiPresetId: '', apiMode: 'tavern' };
    const presetId = typeof binding.presetId === 'string' ? binding.presetId.trim() : '';
    return presetId
      ? { apiPresetId: presetId, apiMode: 'follow' }
      : { apiPresetId: '', apiMode: 'follow' };
  }

  function resolveScoped(scoped: { apiPresetId: string; apiMode: string }): ResolvedLedgerApi {
    if (scoped.apiMode === 'tavern') {
      return { customApi: undefined, label: '酒馆主 API（不覆盖）', mode: 'tavern' };
    }
    const pinnedId = String(scoped.apiPresetId || '').trim();
    if (pinnedId) {
      const preset = findPreset(pinnedId);
      if (!preset) warnMissingPreset();
      else return { customApi: presetToCustomApi(preset), label: String(preset.name || preset.model || '预设'), mode: 'pinned' };
    }
    let mode: ResolvedLedgerApi['mode'] = 'tavern';
    let activeId = '';
    try {
      const cfg = getConfig() as any;
      mode = cfg?.apiMode === 'custom' ? 'custom' : cfg?.apiMode === 'per-feature' ? 'per-feature' : 'tavern';
      activeId = mode === 'custom' ? String(cfg?.activeApiPresetId || '') : '';
    } catch (_e) { /* 读失败按 tavern */ }
    if (mode === 'custom' && activeId) {
      const preset = findPreset(activeId);
      if (preset) return { customApi: presetToCustomApi(preset), label: String(preset.name || preset.model || '预设'), mode: 'custom' };
    }
    return { customApi: undefined, label: '酒馆主 API', mode };
  }

  function resolve(settings: LedgerApiScopeSettings, purpose: LedgerApiPurpose = 'fill', groupId?: number): ResolvedLedgerApi {
    const base = scopedApiSettings(settings, purpose);
    if (purpose !== 'fill') return resolveScoped(base);
    const override = groupScopeOf(settings, groupId);
    if (!override) return resolveScoped(base);
    // 分组指定了已删除的预设 → 回退基准（不让单个分组的坏配置波及全局）。
    if (override.apiMode !== 'tavern' && override.apiPresetId && !findPreset(override.apiPresetId)) {
      warnMissingPreset();
      return resolveScoped(base);
    }
    return resolveScoped(override);
  }

  return {
    boot,
    state: () => _state,
    refresh: boot,
    listPresets: () => presetsOf().map((p) => ({ id: String(p?.id || ''), name: String(p?.name || ''), model: String(p?.model || '') })),
    describeGlobalMode,
    resolve,
    onSynced(listener) {
      _syncedListeners.add(listener);
      return () => { _syncedListeners.delete(listener); };
    },
    bindSync(w) {
      const noop = () => { /* 无可用目标 / 已绑定 */ };
      if (_bound || !w || typeof (w as any).addEventListener !== 'function') return noop;
      _bound = true;
      // 台账与状态栏是两个独立 bundle（通常各在自己 iframe，parent = 酒馆宿主页）。
      // 状态栏把事件广播到自身 + parent；台账必须同样监听 parent/top，否则永远收不到
      // （旧实现只监听自身 iframe ⇒ 改主项目 API 预设要刷新酒馆才生效）。
      const targets: any[] = [];
      const push = (t: unknown) => {
        if (!t || targets.indexOf(t) >= 0) return;
        if (typeof (t as any).addEventListener !== 'function') return;
        targets.push(t);
      };
      push(w);
      try { push((w as any).parent); } catch (_e) { /* cross-origin */ }
      try { push((w as any).top); } catch (_e) { /* cross-origin */ }
      if (!targets.length) { _bound = false; return noop; }
      const onChanged = () => {
        // 同一轮广播可能同时落到多个候选窗口；合并为一次重读。
        if (_syncInFlight) return;
        _syncInFlight = boot().then(() => {
          for (const listener of _syncedListeners) {
            try { listener(); } catch (_e) { /* 单监听器故障不阻断 */ }
          }
        }).finally(() => { _syncInFlight = null; });
      };
      for (const target of targets) {
        try {
          target.addEventListener(STATUSBAR_CONFIG_CHANGED_EVENT, onChanged);
          // parent/top 活得比台账 iframe 久：脚本重注入必须解绑，否则旧闭包常驻 + 重读死实例。
          _syncDisposers.push(() => {
            try { target.removeEventListener(STATUSBAR_CONFIG_CHANGED_EVENT, onChanged); } catch (_e) { /* ignore */ }
          });
        } catch (_e) { /* 该窗口不可用不影响其余候选 */ }
      }
      return () => {
        for (const dispose of _syncDisposers) {
          try { dispose(); } catch (_e) { /* ignore */ }
        }
        _syncDisposers = [];
        _bound = false;
      };
    },
    readConfig: () => {
      try { return getConfig() as any; } catch (_e) { return null; }
    },
  };
}
