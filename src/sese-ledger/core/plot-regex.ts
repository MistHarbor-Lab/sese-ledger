// ===== 剧情推进显示正则注入/撤除（酒馆全局正则）=====
//
// 先例：unified-statusbar/core/skill-regex.ts（getTavernRegexes / importRawTavernRegex /
// updateTavernRegexesWith + 脚本名前缀作归属锚点）。
// 脚本定义单一事实源 = core/plot-regex-template.ts（面板 HTML 与两条脚本）。
// 生命周期只随 driverEnabled：开启时缺哪补哪、内容漂移原地治愈；关闭时按前缀整族撤除。
// 不随台账脚本卸载撤除（避免每次重注入都触发整聊重载；开关关闭时由设置页显式撤除）。

import { PLOT_REGEX_PREFIX, plotRegexScripts, type PlotRegexScript } from './plot-regex-template';

export interface PlotRegexHost {
  getTavernRegexes?: (option: unknown) => unknown;
  importRawTavernRegex?: (name: string, raw: string) => unknown;
  updateTavernRegexesWith?: (updater: unknown, option: unknown) => Promise<unknown>;
}

export interface PlotRegexSyncResult {
  added: number;
  removed: number;
}

const nameOf = (r: unknown): string => String(
  (r as { script_name?: unknown })?.script_name
  ?? (r as { scriptName?: unknown })?.scriptName
  ?? '',
);
const findOf = (r: unknown): string => String(
  (r as { find_regex?: unknown })?.find_regex
  ?? (r as { findRegex?: unknown })?.findRegex
  ?? '',
);
const replaceOf = (r: unknown): string => String(
  (r as { replace_string?: unknown })?.replace_string
  ?? (r as { replaceString?: unknown })?.replaceString
  ?? '',
);

async function removeByPrefix(host: PlotRegexHost): Promise<number> {
  let removed = 0;
  await host.updateTavernRegexesWith!((list: unknown[]) => {
    const arr = Array.isArray(list) ? list : [];
    const kept = arr.filter((r) => !nameOf(r).startsWith(PLOT_REGEX_PREFIX));
    removed = arr.length - kept.length;
    return kept;
  }, { type: 'global' });
  return removed;
}

/**
 * 幂等同步：enabled=true 时缺哪补哪 + 内容漂移治愈 + 清理本前缀下已下线的旧脚本；
 * enabled=false 时撤除本前缀全部脚本。返回本次新增/撤除条数。
 * API 不可用时静默返回 0（由调用方决定是否告警）。
 */
export async function syncPlotRegex(host: PlotRegexHost | null, enabled: boolean): Promise<PlotRegexSyncResult> {
  if (!host || typeof host.updateTavernRegexesWith !== 'function') return { added: 0, removed: 0 };
  if (!enabled) return { added: 0, removed: await removeByPrefix(host) };
  if (typeof host.getTavernRegexes !== 'function' || typeof host.importRawTavernRegex !== 'function') {
    return { added: 0, removed: 0 };
  }

  const scripts = plotRegexScripts();
  const desired = new Map(scripts.map((s) => [s.scriptName, s] as const));
  const current = host.getTavernRegexes({ type: 'global' });
  const existing = new Map<string, unknown>();
  const obsolete: string[] = [];
  for (const r of Array.isArray(current) ? current : []) {
    const name = nameOf(r);
    if (!name) continue;
    existing.set(name, r);
    if (name.startsWith(PLOT_REGEX_PREFIX) && !desired.has(name)) obsolete.push(name);
  }

  let added = 0;
  const stale: PlotRegexScript[] = [];
  for (const script of scripts) {
    const cur = existing.get(script.scriptName);
    if (!cur) {
      const ok = host.importRawTavernRegex(script.scriptName, JSON.stringify(script));
      if (!ok) throw new Error(`剧情推进显示正则「${script.scriptName}」注入失败`);
      added++;
      continue;
    }
    if (findOf(cur) !== script.findRegex || replaceOf(cur) !== script.replaceString) stale.push(script);
  }

  const obsoleteSet = new Set(obsolete);
  if (stale.length || obsoleteSet.size) {
    const patchByName = new Map(stale.map((s) => [s.scriptName, s] as const));
    await host.updateTavernRegexesWith((list: unknown[]) => {
      const arr = Array.isArray(list) ? list : [];
      const next: unknown[] = [];
      for (const r of arr) {
        const name = nameOf(r);
        if (obsoleteSet.has(name)) continue;
        const patch = patchByName.get(name);
        next.push(patch ? { ...(r as Record<string, unknown>), find_regex: patch.findRegex, replace_string: patch.replaceString } : r);
      }
      return next;
    }, { type: 'global' });
  }

  return { added, removed: obsoleteSet.size };
}
