// ===== 台账 1A 请求装配（纯函数层） =====
//
// 填表与剧情推进共用主项目 1A 同构结构：结构头（破限＋反八股＋任务段）→ 内容项（用户段与固定块混排）
// → 结构尾（尾部破限）。固定块内容由引擎生成、界面只读、仅顺序可调：
//   · scan        参考资料块：1A 原生中段槽位（世界书 before/after + 用户人设/角色卡描述/性格/场景/示例对话），
//                 前面带【参考资料】抬头；扫描激活条目与角色卡设定都插在这里
//   · dossier     资料块：填表=【当前台账】/ 推进=【已有纪要】
//   · context     上下文块：填表=【当前正文】/ 推进=【上轮正文】＋【当前输入】
//   · prevDirective 上轮推进结果块（仅推进）：按块项 tags 多选，从上轮最终指令里提取所选标签（原 $6）
// 触发注入（position:'none' + should_scan）由传输层按各请求的扫描素材另行注册，不进提示词。

import { STANDARD_PROMPT_MIDDLE } from '../../unified-statusbar/core/ai-request-pipeline';

export type LedgerBlockId = 'scan' | 'dossier' | 'context' | 'prevDirective' | 'tableData';

export const LEDGER_BLOCK_LABELS: Record<LedgerBlockId, string> = {
  scan: '参考资料块',
  dossier: '资料块',
  context: '上下文块',
  prevDirective: '上轮推进结果块',
  tableData: '表数据块',
};

/**
 * 参考资料块展开的 1A 原生中段槽位（顺序与主项目 STANDARD_PROMPT_MIDDLE 一致）。
 * 台账去掉 chat_history / user_input：台账恒 max_chat_history=0、上下文走【当前正文】/【上轮正文】，
 * 指令由调用方作为 user 段/输出要求句发出。其余槽位全部保留——缺省时角色卡描述、用户人设、
 * 场景、示例对话与 after 位置的世界书条目都不会进请求。
 */
export type LedgerNativeSlot = Exclude<(typeof STANDARD_PROMPT_MIDDLE)[number], 'chat_history' | 'user_input'>;

export const LEDGER_NATIVE_SLOTS: readonly LedgerNativeSlot[] = STANDARD_PROMPT_MIDDLE.filter(
  (slot): slot is LedgerNativeSlot => slot !== 'chat_history' && slot !== 'user_input',
);

/** 各请求可用的固定块（顺序 = 默认顺序）。 */
export const FILL_BLOCK_IDS: LedgerBlockId[] = ['scan', 'dossier', 'context'];
export const DIRECTOR_BLOCK_IDS: LedgerBlockId[] = ['scan', 'dossier', 'context', 'prevDirective'];
/** 推进侧可插入的固定块全清单（含只能显式插入的表数据块——它带自己的取值配置，不参与顺序归一化）。 */
export const DIRECTOR_BLOCK_CATALOG: LedgerBlockId[] = [...DIRECTOR_BLOCK_IDS, 'tableData'];

/** 参考资料块抬头（1A 原生中段槽位内容紧随其后注入）。 */
export const LEDGER_SCAN_HEADING = '【参考资料】';

/** 表数据块配置：取指定表里指定行的某列（＝数据库 `{[db.表.where(列,值).get(列)]}` 的等价形态）。 */
export interface LedgerTableBlockConfig {
  /** 表名/uid（中文表名优先）。 */
  table: string;
  /** 行定位列（留空＝不过滤 → 整表投影）。 */
  matchColumn?: string;
  /** 行定位值（与 matchColumn 同时给才生效）。 */
  matchValue?: string;
  /** 取值列（留空＝整行以 | 拼接）。 */
  valueColumn?: string;
  /** 块抬头（留空＝取值列名 > 表名）。 */
  label?: string;
}

/**
 * 存储形态的内容项（设置与预设里存的就是它，界面直接编辑）：
 * - 普通段：{ role, content }；固定块：{ block }（tableData 另带 table 配置；
 *   prevDirective 另带 tags＝从上轮最终指令里提取哪些标签）。
 * - hidden=true：该段/块不参与请求（顺序位保留，便于随时打开）。
 */
export interface LedgerPromptItemSpec {
  role?: string;
  content?: string;
  block?: LedgerBlockId;
  hidden?: boolean;
  table?: LedgerTableBlockConfig;
  /** 仅 prevDirective：要注入的上轮输出标签（多选；空＝整块不出）。 */
  tags?: string[];
}

/** 默认内容项（三块顺序）。 */
function defaultSpecsOf(ids: LedgerBlockId[]): LedgerPromptItemSpec[] {
  return ids.map((block) => ({ block }));
}

/** 内容项归一化：过滤非法项、去重固定块（同名块只留首个）、补齐缺省块到尾部。 */
export function normalizePromptSpecs(value: unknown, fallback: LedgerBlockId[] = []): LedgerPromptItemSpec[] {
  // 允许的固定块恒含全部块（含只能显式插入的表数据块）；fallback 只决定「缺省补齐到尾部」的顺序
  const allowed = new Set<string>([...FILL_BLOCK_IDS, ...DIRECTOR_BLOCK_CATALOG, ...fallback]);
  const out: LedgerPromptItemSpec[] = [];
  const seenBlocks = new Set<string>();
  const push = (spec: LedgerPromptItemSpec): void => { out.push(spec); };
  if (Array.isArray(value)) {
    for (const raw of value) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as LedgerPromptItemSpec;
      const hidden = item.hidden === true;
      if (item.block) {
        const id = String(item.block) as LedgerBlockId;
        if (!allowed.has(id) || seenBlocks.has(id)) continue;
        seenBlocks.add(id);
        if (id === 'tableData') {
          push({ block: id, hidden, ...(item.table ? { table: { ...item.table } } : {}) });
        } else if (id === 'prevDirective') {
          const tags = Array.isArray(item.tags) ? item.tags.map((t) => String(t).trim()).filter(Boolean) : [];
          push({ block: id, hidden, ...(tags.length ? { tags } : {}) });
        } else {
          push({ block: id, hidden });
        }
        continue;
      }
      if (typeof item.content !== 'string') continue;
      push({ role: String(item.role || 'user'), content: item.content, ...(hidden ? { hidden: true } : {}) });
    }
  }
  for (const id of fallback) {
    if (seenBlocks.has(id)) continue;
    seenBlocks.add(id);
    push({ block: id });
  }
  return out;
}

/** 内容项 → 展开用内容项（跳过 hidden 与空段；表数据块由调用方 materialize，这里整体跳过）。 */
export function specsToItems(specs: LedgerPromptItemSpec[]): LedgerPromptItem[] {
  const out: LedgerPromptItem[] = [];
  for (const spec of specs) {
    if (spec.hidden === true) continue;
    if (spec.block) {
      if (spec.block === 'tableData') continue;
      out.push({ kind: 'block', block: spec.block });
      continue;
    }
    const content = String(spec.content ?? '');
    if (!content.trim()) continue;
    out.push({ kind: 'segment', role: String(spec.role || 'user'), content });
  }
  return out;
}

/** 空内容项（缺省＝三块默认顺序）。 */
export function defaultPromptSpecs(ids: LedgerBlockId[] = FILL_BLOCK_IDS): LedgerPromptItemSpec[] {
  return defaultSpecsOf(ids);
}

export interface LedgerBlockContents {
  /** 资料块正文（抬头由调用方拼：填表=【当前台账】/推进=【已有纪要】）。 */
  dossier?: string;
  /** 上下文块正文（抬头由调用方拼：填表=【当前正文】/推进=【上轮正文】＋【当前输入】）。 */
  context?: string;
  /** 上轮推进结果块正文（抬头【上轮推进结果】由本层拼）。 */
  prevDirective?: string;
  /** 参考资料块功能说明行（紧随抬头、在激活条目与角色卡设定之前；缺省＝只有抬头）。 */
  scan?: string;
}

export interface LedgerSegmentItem {
  kind: 'segment';
  role: string;
  content: string;
}

export interface LedgerBlockItem {
  kind: 'block';
  block: LedgerBlockId;
}

export type LedgerPromptItem = LedgerSegmentItem | LedgerBlockItem;

/** 展开后的提示条目：普通消息 或 1A 原生槽位标记。 */
export type ExpandedPromptEntry = { role: string; content: string } | LedgerNativeSlot;

export function isLedgerBlockItem(item: LedgerPromptItem | undefined | null): item is LedgerBlockItem {
  return !!item && (item as LedgerBlockItem).kind === 'block';
}

/** 参考资料块正文：抬头 + 功能说明行（说明缺省不出；原生槽位内容随后注入）。 */
export function scanBlockText(contents: LedgerBlockContents | undefined | null): string {
  const note = String(contents?.scan || '').trim();
  return note ? LEDGER_SCAN_HEADING + '\n' + note : LEDGER_SCAN_HEADING;
}

/** 取块正文（含抬头）；空内容返回空串（该块整体不出条，不留空壳）。 */
export function blockMessageText(block: LedgerBlockId, contents: LedgerBlockContents): string {
  if (block === 'scan') return scanBlockText(contents);
  // 表数据块的内容由调用方按项配置 materialize 成普通段（见 specsToItems），此处恒空
  if (block === 'tableData') return '';
  // 资料块/上下文块：正文原样透传（各自抬头与功能说明由调用方拼——填表侧与推进侧的抬头不同）
  if (block === 'dossier') return String(contents.dossier || '').trim();
  if (block === 'context') return String(contents.context || '').trim();
  const body = String(contents.prevDirective || '').trim();
  return body ? '【上轮推进结果】\n\n' + body : '';
}

/**
 * 展开内容项为 ordered_prompts 条目。
 * - 参考资料块 → 一条只读抬头消息（含功能说明行） + 1A 原生中段整组槽位标记（世界书激活条目与
 *   角色卡/人设/场景等设定按槽位顺序插在抬头之后）——抬头消息与槽位组始终同出，不受后续块顺序影响。
 * - 资料块/上下文块/上轮推进结果块 → 单条 system 消息（正文由调用方给定，已含各自抬头）。
 * - 空正文的块整块跳过（但参考资料块恒出：槽位需要落点）。
 */
export function expandLedgerItems(items: LedgerPromptItem[], contents: LedgerBlockContents): ExpandedPromptEntry[] {
  const out: ExpandedPromptEntry[] = [];
  for (const item of items) {
    if (!isLedgerBlockItem(item)) {
      const content = String(item?.content ?? '');
      if (!content.trim()) continue;
      out.push({ role: String(item?.role || 'system'), content });
      continue;
    }
    if (item.block === 'scan') {
      out.push({ role: 'system', content: scanBlockText(contents) });
      // 参考资料块＝1A 原生中段整组槽位（世界书 before/after + 用户人设/角色卡描述/性格/场景/示例对话）
      out.push(...LEDGER_NATIVE_SLOTS);
      continue;
    }
    // 表数据块应在调用方（buildPromptItems）按项配置 materialize 成普通段；漏到这里＝无内容，整体不出条
    if (item.block === 'tableData') continue;
    if (item.block === 'context') {
      const body = String(contents.context || '').trim();
      if (body) out.push({ role: 'system', content: body });
      continue;
    }
    if (item.block === 'prevDirective') {
      const text = blockMessageText('prevDirective', contents);
      if (text) out.push({ role: 'system', content: text });
      continue;
    }
    const text = blockMessageText('dossier', contents);
    if (text) out.push({ role: 'system', content: text });
  }
  return out;
}

/** 由块顺序构内容项序列（固定块按顺序排列，中间无用户段）。 */
export function blockItemsOf(order: LedgerBlockId[]): LedgerPromptItem[] {
  return order.map((block) => ({ kind: 'block', block }) as LedgerBlockItem);
}
