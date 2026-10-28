// ===== 台账 AI 请求传输层（1A 同构：破限头尾 + 扫描钩 + 受保 generateRaw） =====
//
// 复用主项目共享件（台账与其同处一个宿主窗口，直接 import）：
//   · 破限头 / 尾部破限 —— core/jailbreak-config（与主项目共享同一份设置）
//   · 扫描钩 withNativeScanWorldbook —— core/worldbook-entry（条目黑名单两份 + 台账族剔除）
//   · <safe> 出口剥除 —— core/ai-parse.stripTailSafeBlock
//   · 受保 generateRaw —— core/env.getTavernHelper（宿主工具注入防护）
// 触发注入（position:'none' + should_scan:true + once:true）在此注册：素材只喂绿灯扫描、不进提示词。

import { STANDARD_MAX_CHAT_HISTORY } from '../../unified-statusbar/core/ai-request-pipeline';
import { getJailbreakHeadPrompts, getJailbreakTailPrompts } from '../../unified-statusbar/core/jailbreak-config';
import { withNativeScanWorldbook } from '../../unified-statusbar/core/worldbook-entry';
import { stripTailSafeBlock } from '../../unified-statusbar/core/ai-parse';
import { getTavernHelper, makeGenerationId, stopGenerationById } from '../../unified-statusbar/core/env';
import { isDatabaseEntry, isManagedEntry } from './lens';
import { expandLedgerItems, type LedgerBlockContents, type LedgerPromptItem } from './ai-request';
import type { LedgerApiPurpose } from './host-config';

export interface LedgerAiSpec {
  /** 结构头任务段（填表＝填表提示词；推进＝预设说明；留空则只有破限头内建文本）。 */
  task?: string;
  /** 叙事规划类传 true（拼反八股）；SQL 类（填表）不传。 */
  antiCliche?: boolean;
  /** 内容项（用户段与固定块混排；块的内容由 blocks 提供）。 */
  items: LedgerPromptItem[];
  blocks: LedgerBlockContents;
  /** 触发注入素材（只参与世界书扫描，不进提示词；空串＝不注册）。 */
  scanText?: string;
  /** 扫描钩：命中台账受管投影或数据库系条目即剔除（填表=true——两族都不进填表提示词；推进=false，推进要用数据库条目）。
   *  数据库系含无前缀例外族（模板整表导出裸名 / 总结·重要人物裸名词根，见 lens.isDatabaseEntryName）。 */
  suspendLedgerFamily?: boolean;
  /** 逃生口：需要宿主工具调用时传 true（默认全受保）。 */
  allowHostTools?: boolean;
  /** API 来源用途：填表（含建表向导/时光机重填）或剧情推进。缺省 fill。 */
  apiPurpose?: LedgerApiPurpose;
  /** 填表请求所属分组（按分组独立时决定用哪套 API；缺省/无分组按基准）。推进忽略。 */
  groupId?: number;
}

export interface LedgerAiTransportDeps {
  /** 本次请求的 custom_api（按用途解析：填表 / 推进各用各的设置；undefined＝酒馆主 API）。
   *  groupId 仅填表生效：按分组独立时取该分组的绑定。 */
  resolveCustomApi(purpose: LedgerApiPurpose, groupId?: number): Record<string, unknown> | undefined;
  /** 数据库系整表导出「裸名」集合（无 TavernDB-ACU- 前缀的条目名；填表扫描剔除用）。
   *  运行时收集（随模板预设与账本变化），故传函数；缺省只按前缀族剔除。 */
  getDatabaseBareNames?(): ReadonlySet<string> | null;
}

export interface LedgerAiTransport {
  request(spec: LedgerAiSpec, opts?: { signal?: AbortSignal; generationId?: string }): Promise<string>;
}

const SCAN_INJECTION_ID = 'sl_scan_material';

export function createLedgerAiTransport(deps: LedgerAiTransportDeps): LedgerAiTransport {
  let seq = 0;
  return {
    async request(spec, opts = {}) {
      const th = getTavernHelper();
      if (!th || typeof th.generateRaw !== 'function') throw new Error('无法访问酒馆助手 API（generateRaw）');
      const generationId = opts.generationId || makeGenerationId(`sl-${++seq}`);
      const signal = opts.signal;
      const onAbort = () => { stopGenerationById(generationId); };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const scanText = String(spec.scanText || '').trim();
        if (scanText && typeof th.injectPrompts === 'function') {
          // once:true 只对下一次生成生效 ⇒ 调用方每次重试都要重新走本函数（站点均如此）
          th.injectPrompts([{
            id: SCAN_INJECTION_ID,
            position: 'none',
            depth: 0,
            role: 'system',
            content: scanText,
            should_scan: true,
          }], { once: true });
        }
        const orderedPrompts: unknown[] = [
          ...getJailbreakHeadPrompts({ antiCliche: spec.antiCliche === true, task: spec.task }),
          ...expandLedgerItems(spec.items, spec.blocks),
          ...getJailbreakTailPrompts(),
        ];
        const customApi = deps.resolveCustomApi(spec.apiPurpose || 'fill', spec.groupId);
        const request: Record<string, unknown> = {
          should_silence: true,
          ordered_prompts: orderedPrompts,
          max_chat_history: STANDARD_MAX_CHAT_HISTORY,
          generation_id: generationId,
          ...(customApi ? { custom_api: customApi } : {}),
          ...(spec.allowHostTools === true ? { allow_host_tools: true } : {}),
        };
        const raw = await withNativeScanWorldbook(
          spec.suspendLedgerFamily === true
            ? { suspend: (entry: any) => isManagedEntry(entry) || isDatabaseEntry(entry, deps.getDatabaseBareNames?.() ?? null) }
            : {},
          () => th.generateRaw(request),
        );
        return stripTailSafeBlock(String(raw ?? ''));
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    },
  };
}
