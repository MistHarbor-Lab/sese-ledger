// ===== 楼层身份：锚点 / AI 楼序 / 删楼·swipe·回退裁剪 =====
//
// 锚点直接复用主项目 external-story-store 的稳定锚体系（schema2 教训已在彼处根治：
// 单变体走消息级稳定身份、多变体按 swipe 区分、fallback 锚保留集防冷启动丢失）。
// 楼层语义（规格 §4）：
// - 写入：记账条目挂目标 AI 楼锚点，不碰聊天文件；
// - 删楼：被删楼锚点下条目物理裁剪 → 快照+剩余条目纯内存重放；
// - swipe：被替换楼锚点条目作废裁剪；
// - 深回退：重放按锚点过滤（目标楼之后的条目不参与）——窗口外语义对齐主项目折叠纪律。

import {
  isAnchorCandidate,
  messageLevelAnchor,
  selectedMessageAnchor,
  selectedMessageAnchorFallback,
} from '../../unified-statusbar/core/external-story-store';
import type { LedgerEntry } from './types';

/**
 * 单楼层的台账活跃锚（变体感知）：
 * - 单变体 / 多变体但选中第 0 变体 → 消息级锚（单变体时期的写入在切回变体 0 时仍可见）；
 * - 多变体且选中其他变体 → 该变体 swipe 锚（原变体写入随之失联=作废重填语义）。
 * 主项目 journal 的保留集刻意同时保留两种锚（防丢），台账楼层语义不同，按变体精确取一。
 */
export function ledgerAnchorFor(message: any, index: number): string | null {
  if (!isAnchorCandidate(message)) return null;
  const multi = Array.isArray(message?.swipes) && message.swipes.length > 1;
  if (!multi) return selectedMessageAnchor(message, index);
  const rawId = Number(message?.swipe_id);
  const swipeId = Number.isInteger(rawId) && rawId >= 0 ? rawId : 0;
  if (swipeId === 0) {
    return messageLevelAnchor(message) || selectedMessageAnchorFallback(message, index);
  }
  return selectedMessageAnchor(message, index);
}

/** 当前聊天全部活跃锚点（重放过滤集）。 */
export function activeAnchors(chat: any[]): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i < chat.length; i++) {
    const anchor = ledgerAnchorFor(chat[i], i);
    if (anchor) set.add(anchor);
  }
  return set;
}

/** 楼层是否为 AI 落点（锚点候选）：用户楼永不是；system 楼须有稳定身份。 */
export { isAnchorCandidate };

/** 第 index 条消息之前（含）的 AI 楼数量——AI 楼序号从 1 起。 */
export function aiFloorOrdinalAt(chat: any[], index: number): number {
  let n = 0;
  for (let i = 0; i <= Math.min(index, chat.length - 1); i++) {
    if (isAnchorCandidate(chat[i])) n++;
  }
  return n;
}

/** 全聊天 AI 楼总数。 */
export function aiFloorCount(chat: any[]): number {
  let n = 0;
  for (const msg of chat) if (isAnchorCandidate(msg)) n++;
  return n;
}

/** 锚点在当前聊天里所属的 AI 楼序号（1 起）；锚点已失联返回 null。
 *  填表钉住落点用：请求期间楼层位移/新增后，以锚点反查**当前**序号（不信任计划时的 raw index）。 */
export function aiFloorOfAnchor(chat: any[], anchor: string): number | null {
  if (!anchor) return null;
  let n = 0;
  for (let i = 0; i < chat.length; i++) {
    if (!isAnchorCandidate(chat[i])) continue;
    n += 1;
    if (ledgerAnchorFor(chat[i], i) === anchor) return n;
  }
  return null;
}

/** 当前写入落点：最后一个 AI 楼的锚点与序号（与 ledgerAnchorFor 同口径防写/读错位）；无 AI 楼返回 null。 */
export function writeScope(chat: any[]): { anchor: string; aiFloor: number } | null {
  for (let i = chat.length - 1; i >= 0; i--) {
    if (isAnchorCandidate(chat[i])) {
      return { anchor: ledgerAnchorFor(chat[i], i) as string, aiFloor: aiFloorOrdinalAt(chat, i) };
    }
  }
  return null;
}

/** 按活跃锚点集过滤条目（深回退重放语义）。 */
export function entriesVisibleWithin(entries: LedgerEntry[], anchors: Set<string>): LedgerEntry[] {
  return entries.filter((e) => anchors.has(e.at.anchor));
}

/** 删除/swipe 事务：物理裁剪锚点命中的条目，返回 {kept, pruned}。 */
export function pruneEntriesByAnchors(entries: LedgerEntry[], removed: Set<string>): { kept: LedgerEntry[]; pruned: LedgerEntry[] } {
  const kept: LedgerEntry[] = [];
  const pruned: LedgerEntry[] = [];
  for (const e of entries) (removed.has(e.at.anchor) ? pruned : kept).push(e);
  return { kept, pruned };
}

/** 比对前后锚点集，得到被移除的锚点（删楼/swipe 检测）。 */
export function removedAnchors(before: Set<string>, after: Set<string>): Set<string> {
  const removed = new Set<string>();
  for (const a of before) if (!after.has(a)) removed.add(a);
  return removed;
}

/** first_message 跳过（V3.639 教训：开场白也发 MESSAGE_RECEIVED，不是真正的 AI 生成楼层）。 */
export function isFirstMessageEvent(type: string | undefined): boolean {
  return type === 'first_message';
}
