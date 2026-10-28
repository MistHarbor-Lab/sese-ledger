// ===== 设置与预设库（extensionSettings sese_ledger_v1 命名空间） =====
//
// 全局模板预设库与原库同策略：{templateStr, updatedAt}（模板 JSON 字符串整体存）。
// 推进预设（driver presets）见 director 模块，同一命名空间下的 plotPresets 键。

import type { LedgerPromptItemSpec } from './ai-request';
import { normalizeTemplateAny, type NormalizedAnyTemplate } from './blueprint';

export const SETTINGS_KEY = 'sese_ledger_v1';

export interface TemplatePresetEntry { templateStr: string; updatedAt: number }

/** 分组级填表 API 绑定：presetId 非空＝固定预设；否则按 mode（follow=跟随主项目全局 / tavern=酒馆主 API）。 */
export interface LedgerApiBinding {
  presetId?: string;
  mode?: 'follow' | 'tavern';
}

export interface LedgerSettings {
  templatePresets?: Record<string, TemplatePresetEntry>;
  defaultTemplatePreset?: string;
  /** AI 填表总开关。 */
  autoFillEnabled?: boolean;
  /** 剧情推进总开关（默认开；仅显式 false 关闭）。 */
  driverEnabled?: boolean;
  driverPresetName?: string;
  plotPresets?: Record<string, unknown>;
  /** 悬浮入口按钮显示（默认开）。 */
  showLauncher?: boolean;
  /** 填表/推进进度通知持久化（默认开；显式 false＝显示 3 秒后自动隐去，避免遮挡；失败告警恒常驻）。 */
  progressPersist?: boolean;
  /** API 来源：''=跟随主项目全局；否则指定主项目预设 id。（apiPreset 旧直连三输入框已退役，字段忽略。）
   *  ⚠ 旧单来源字段：仍作 fill/driver 新字段缺省时的回退（存量零变化）。 */
  apiPresetId?: string;
  /** API 覆盖模式：follow=跟随主项目全局（默认）；tavern=强制酒馆主 API（不覆盖）。旧字段。 */
  apiMode?: 'follow' | 'tavern';
  /** 填表 API 来源：字符串（含空串＝跟随）一旦存在即覆盖旧 apiPresetId。
   *  按分组独立开启时，本字段作未单独设置分组的「基准」，建表向导也走分组1的解析结果。 */
  fillApiPresetId?: string;
  fillApiMode?: 'follow' | 'tavern';
  /** 填表 API 是否按分组独立；true 时 fillApiPresetId/fillApiMode 仍是基准（切换前的选择）。
   *  分组覆盖只影响填表请求；推进 API 不受影响。 */
  fillApiPerGroup?: boolean;
  /** 分组级填表 API 覆盖（key=String(groupId)）；缺省=沿用基准。停用组配置保留但不生效。 */
  fillGroupApis?: Record<string, LedgerApiBinding>;
  /** 剧情推进 API 来源；字符串（含空串＝跟随）一旦存在即覆盖旧 apiPresetId。 */
  driverApiPresetId?: string;
  driverApiMode?: 'follow' | 'tavern';
  /** 高级调度参数（全局；分组频率之外仅存的调度参数）。 */
  autoUpdateThreshold?: number;
  skipUpdateFloors?: number;
  /** 校验失败重试次数上限（含首次；缺省 3）。填表与建表向导共用（剧情推进的重试在各推进预设内设置）。 */
  fillMaxAttempts?: number;
  /** 手动填表：处理最近 N 层（缺省=全局触达层数）。 */
  fillRecentFloors?: number;
  /** 手动填表：每 N 层合并为一次请求（缺省=3）。 */
  fillMergeEvery?: number;
  /** 纪要数量警告阈值（默认 200；0 = 关闭提醒）。超过时工作台顶部横幅 + 填表完成后提示一次。 */
  summaryWarnThreshold?: number;
  /** 填表系统提示词覆盖（开放编辑；空 = 内置 SQL 格式）。 */
  fillSystemPrompt?: string;
  /** 填表内容项清单（段 + 固定块混排；缺省 = 三块默认顺序）。 */
  fillPrompt?: LedgerPromptItemSpec[];
}

/** 剧情推进是否开启：未设置视为开启，只有显式 false 才关闭。 */
export function isDriverEnabled(s: LedgerSettings): boolean {
  return s.driverEnabled !== false;
}

/** 填表/推进进度通知是否常驻：默认关（未设置/显式 false 都自动隐去），只有显式 true 才常驻。 */
export function isProgressPersistEnabled(s: LedgerSettings): boolean {
  return s.progressPersist === true;
}

export interface SettingsDeps {
  read(): LedgerSettings | null;
  write(s: LedgerSettings): void | Promise<void>;
}

export interface SettingsStore {
  get(): LedgerSettings;
  update(patch: Partial<LedgerSettings>): Promise<LedgerSettings>;
  /** 模板预设 CRUD（写入即落盘）。 */
  listTemplatePresetNames(): string[];
  saveTemplatePreset(name: string, templateStr: string): Promise<void>;
  loadTemplatePreset(name: string): unknown | null;
  /** 解析并校验模板预设（按预设版本记忆化；v1 自动转换）。无该预设/JSON 坏 → null。 */
  loadTemplatePresetNormalized(name: string): NormalizedAnyTemplate | null;
  deleteTemplatePreset(name: string): Promise<void>;
}

/** 模板预设解析缓存条目（revision＝updatedAt；保存/删除时整体清空，防同毫秒写入撞键）。 */
interface PresetCacheEntry { revision: number; value: NormalizedAnyTemplate }

export type SettingsPersistMode = 'debounced' | 'immediate';

interface SettingsPersistTarget {
  saveSettingsDebounced?: unknown;
  saveSettings?: unknown;
}

/** 触发酒馆把 extensionSettings 写回磁盘。
 *  上游 ST/TT 只暴露 saveSettingsDebounced（防抖写盘）；部分宿主另有 saveSettings（立即写）。
 *  按候选顺序尝试，返回实际使用的方法；全部不可用返回 null。 */
export async function persistExtensionSettings(targets: readonly unknown[]): Promise<SettingsPersistMode | null> {
  for (const target of targets) {
    if (!target || (typeof target !== 'object' && typeof target !== 'function')) continue;
    const candidates: [keyof SettingsPersistTarget, SettingsPersistMode][] = [
      ['saveSettingsDebounced', 'debounced'],
      ['saveSettings', 'immediate'],
    ];
    for (const [key, mode] of candidates) {
      const fn = (target as SettingsPersistTarget)[key];
      if (typeof fn !== 'function') continue;
      try {
        const result = (fn as () => unknown).call(target);
        if (result && typeof (result as PromiseLike<unknown>).then === 'function') await result;
        return mode;
      } catch (_e) { /* 换下一个候选 */ }
    }
  }
  return null;
}

/** extensionSettings 命名空间 + 落盘（读/写/预设 CRUD 的唯一入口）。
 *  targets 依次取 extensionSettings 与落盘 API（ctx=getContext()，兜底全局 SillyTavern）。 */
export function createExtensionSettingsStore(options: {
  targets: readonly unknown[];
  onPersistUnavailable?: () => void;
}): SettingsStore {
  const { targets, onPersistUnavailable } = options;
  let extensionSettings: Record<string, unknown> | null = null;
  for (const target of targets) {
    if (!target || typeof target !== 'object') continue;
    const root = (target as { extensionSettings?: unknown }).extensionSettings;
    if (root && typeof root === 'object') { extensionSettings = root as Record<string, unknown>; break; }
  }
  return createSettingsStore({
    read: () => (extensionSettings?.[SETTINGS_KEY] as LedgerSettings) || {},
    write: async (s) => {
      if (!extensionSettings) { onPersistUnavailable?.(); return; }
      extensionSettings[SETTINGS_KEY] = s;
      if (!await persistExtensionSettings(targets)) onPersistUnavailable?.();
    },
  });
}

export function createSettingsStore(deps: SettingsDeps): SettingsStore {
  let presetCache = new Map<string, PresetCacheEntry>();
  function clearPresetCache(): void { presetCache = new Map(); }
  async function persist(next: LedgerSettings): Promise<LedgerSettings> {
    await deps.write(next);
    return next;
  }
  return {
    get(): LedgerSettings {
      return deps.read() || {};
    },
    async update(patch) {
      if (Object.prototype.hasOwnProperty.call(patch, 'templatePresets')) clearPresetCache();
      const next = { ...this.get(), ...patch };
      return persist(next);
    },
    listTemplatePresetNames() {
      return Object.keys(this.get().templatePresets || {}).sort();
    },
    async saveTemplatePreset(name, templateStr) {
      const s = this.get();
      const presets = { ...(s.templatePresets || {}) };
      presets[name] = { templateStr, updatedAt: Date.now() };
      clearPresetCache();
      await persist({ ...s, templatePresets: presets });
    },
    loadTemplatePreset(name) {
      const entry = this.get().templatePresets?.[name];
      if (!entry || typeof entry.templateStr !== 'string') return null;
      try { return JSON.parse(entry.templateStr); } catch (_e) { return null; }
    },
    loadTemplatePresetNormalized(name) {
      const entry = this.get().templatePresets?.[name];
      if (!entry || typeof entry.templateStr !== 'string') return null;
      const cached = presetCache.get(name);
      if (cached && cached.revision === entry.updatedAt) return cached.value;
      let parsed: unknown;
      try { parsed = JSON.parse(entry.templateStr); } catch (_e) { return null; }
      const value = normalizeTemplateAny(parsed);
      presetCache.set(name, { revision: entry.updatedAt, value });
      return value;
    },
    async deleteTemplatePreset(name) {
      const s = this.get();
      const presets = { ...(s.templatePresets || {}) };
      delete presets[name];
      const patch: LedgerSettings = { templatePresets: presets };
      if (s.defaultTemplatePreset === name) patch.defaultTemplatePreset = '';
      clearPresetCache();
      await persist({ ...s, ...patch });
    },
  };
}
