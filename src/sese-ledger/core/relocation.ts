// ===== 一键搬家：台账数据结转（经主项目 __ubStorageRelocation 桥注册） =====
//
// 背景：搬家为父聊天生成全新 storageId 并只复制主项目三域（story-core/story-map/portraits）。
// 台账自己的两文件 sl_<storageId>_book.json / _entries.json 不在其列；而新聊天首行若只带
// unifiedStatusbar、不带 seseLedger 身份，台账会按「全新聊天」建一本空账（用户感知＝空表格）。
//
// 正确语义不是整本 fork（父账本快照可能停在很早的折叠点，只挑新聊天可见的流水会丢掉切割层之前
// 的全部行）。这里用台账自带的 bakeStateAt：把切割层（含本层）的状态烘焙成新账本快照，再只结转
// 切割层之后、且新聊天里真实存在的条目，并把楼层号改写到新聊天坐标系（切割层＝第 1 层）。
//
// 契约：best-effort。失败/抛错由主项目桥吞掉，绝不阻断搬家主流程；未注册时零开销。

import type { StorageRelocationCopyContext } from '../../unified-statusbar/core/storage-relocation-bridge';
import type { LedgerRuntime } from './runtime';
import type { IndexFileStore, LedgerChatMeta, SlChatOwner } from './identity';
import { SL_META_NAMESPACE, isSafeStorageId, makeStorageId, writeChatLink } from './identity';
import type { LedgerFilesLike } from './ledger-store';
import { createLedgerStore } from './ledger-store';
import type { LedgerEntry } from './types';
import { activeAnchors, aiFloorOfAnchor, aiFloorOrdinalAt, ledgerAnchorFor } from './floor-scope';
import { createBook, projectWorkbook } from './book';

export interface LedgerRelocationDeps {
  runtime: LedgerRuntime;
  files: LedgerFilesLike;
  index: IndexFileStore;
  /** 当前（父）聊天消息数组：切割层在台账口径下的 AI 楼序号要按它现算。 */
  getChat: () => any[];
  now?: () => number;
  onLog?: (message: string, detail?: string) => void;
}

function safeLog(deps: LedgerRelocationDeps, message: string): void {
  try { deps.onLog?.(message); } catch (_e) { /* 上报失败不影响搬家 */ }
}

/** 新聊天的第一个 AI 楼层锚点（＝切割层在新聊天里的锚点）。 */
function firstAiAnchor(chat: any[]): string {
  for (let i = 0; i < chat.length; i += 1) {
    const anchor = ledgerAnchorFor(chat[i], i);
    if (anchor) return anchor;
  }
  return '';
}

/**
 * 把父账本在切割层的状态写进新 storageId，并让新聊天绑定到它。
 * 返回 true = 已写出并读回确认（调用方据此决定是否提示）；false = 没有可结转数据/条件不满足。
 */
export async function copyLedgerStorageForRelocation(
  context: StorageRelocationCopyContext,
  deps: LedgerRelocationDeps,
): Promise<boolean> {
  // 台账自己的父身份来自运行时（与主项目外部存储 storageId 不是同一套 id；context.newStorageId 是主项目的）。
  // 新账本另外分配自己的 storageId，绝不与主项目外部存储共用（两套身份命名空间相互独立）。
  const parentId = String(deps.runtime.storageId() || '');
  if (!isSafeStorageId(parentId)) return false;
  const newId = makeStorageId();
  if (!isSafeStorageId(newId) || newId === parentId) return false;

  const cutMessageIndex = Number(context.cutMessageIndex);
  if (!Number.isInteger(cutMessageIndex) || cutMessageIndex < 0) return false;
  const retainedChat = Array.isArray(context.retainedChat) ? (context.retainedChat as any[]) : null;
  if (!retainedChat || retainedChat.length === 0) return false;

  const newOwner = context.newOwner;
  if (!newOwner || newOwner.kind !== 'character' || !newOwner.avatar) return false;
  const chatKey = String(context.newChatId || newOwner.chatId || '');
  if (!chatKey) return false;

  const parentChat = deps.getChat();
  if (!Array.isArray(parentChat) || cutMessageIndex >= parentChat.length) return false;

  const store = deps.runtime.__store();
  if (!store) return false;

  // 台账口径的切割层楼层号（锚点候选计数，与记账条目 at.aiFloor 同源；不用主项目的非 user 计数，
  // 系统消息/无稳定身份的楼层在两套口径里不同）。
  const cutAiFloor = aiFloorOrdinalAt(parentChat, cutMessageIndex);
  if (cutAiFloor < 1) return false;

  // 烘焙到切割层（含本层）：这就是新聊天起始时应有的整库状态。
  const baked = deps.runtime.bakeStateAt(cutAiFloor);
  if (!baked) return false; // 未建账 / 没有快照 → 没有可结转的数据

  const anchors = activeAnchors(retainedChat);
  const cutAnchor = firstAiAnchor(retainedChat);
  const all = store.peekEntries();
  let maxSeq = 0;
  for (const e of all) if (e.seq > maxSeq) maxSeq = e.seq;

  const carried: LedgerEntry[] = [];
  for (const e of all) {
    // 切割层及之前已进快照；切割层之后的楼层只结转新聊天里真实存在的锚点。
    if (!anchors.has(e.at.anchor) || e.at.anchor === cutAnchor) continue;
    const newFloor = aiFloorOfAnchor(retainedChat, e.at.anchor);
    if (!newFloor || newFloor < 1) continue;
    carried.push({ ...e, at: { ...e.at, aiFloor: newFloor } });
  }

  const target = createLedgerStore({ files: deps.files, storageId: newId, now: deps.now });
  try {
    // 落盘形态去 sourceData（与台账正常折叠一致），避免把面板/导出形状永久写进快照。
    let snapshot = baked;
    try { snapshot = projectWorkbook(createBook(baked), { forStorage: true }); } catch (_e) { /* 保持原样 */ }
    const okSnapshot = await target.persistSnapshot(
      snapshot,
      cutAnchor,
      1,
      maxSeq,
    );
    if (!okSnapshot) return false;
    target.replaceEntries(carried);
    // 填表水位也必须搬到新楼层坐标系：不搬会让新聊天把已结转的楼层当「未处理」再填一遍
    // （重复插行/覆盖刚烘焙的状态）。父水位 - (切割层-1)，再用结转流水涉及的表兜底抬高，
    // 保证「有结转数据的楼层」一律视为已处理。
    const offset = cutAiFloor - 1;
    const parentSchedule = store.getSchedule();
    const schedule: Record<string, number> = {};
    for (const [tableId, raw] of Object.entries(parentSchedule)) {
      const old = Math.max(0, Math.trunc(Number(raw) || 0));
      schedule[tableId] = old > 0 ? Math.max(1, old - offset) : 0;
    }
    for (const entry of carried) {
      for (const tableId of entry.changedTables || []) {
        schedule[tableId] = Math.max(schedule[tableId] || 0, entry.at.aiFloor);
      }
    }
    if (Object.keys(schedule).length > 0) await target.patchSchedule(schedule);
    const okFlush = await target.flush();
    if (!okFlush) return false;
  } finally {
    target.destroy();
  }

  const owner: SlChatOwner = { kind: 'character', ownerKey: newOwner.avatar, chatKey };
  const createdAt = (deps.now ? deps.now() : Date.now());
  const meta: LedgerChatMeta = { storageId: newId, createdAt, chatKey, forkFrom: parentId };

  // 新聊天首行元数据补丁（主项目搬家合并进 chatMetadata），让台账首次打开直接复用新账本。
  if (context.chatMetadataPatch) {
    context.chatMetadataPatch[SL_META_NAMESPACE] = meta;
  }

  // 全局索引 + 链接文件（第二份指针）：写失败不回收已写账本（数据已落盘确认）。
  try {
    const current = await deps.index.readIndex();
    const chats: Record<string, any> = { ...(current?.chats || {}) };
    chats[newId] = {
      ownerKind: owner.kind,
      ownerKey: owner.ownerKey,
      chatKey: owner.chatKey,
      createdAt,
      lastSeenAt: createdAt,
      forkFrom: parentId,
    };
    await deps.index.writeIndex({ ...(current || {}), chats } as any);
  } catch (e) {
    safeLog(deps, `台账搬家：索引写入失败（${e instanceof Error ? e.message : String(e)}）`);
  }
  try {
    const link = await writeChatLink(deps.files, owner, { storageId: newId, forkFrom: parentId, updatedAt: createdAt });
    if (!link.ok) safeLog(deps, `台账搬家：链接文件写入失败（${link.error || '未知原因'}）`);
  } catch (_e) { /* best-effort */ }

  safeLog(deps, `台账搬家：已结转切割层状态（新账本 ${String(newId).slice(0, 12)}…，${carried.length} 条后续流水）`);
  return true;
}

// ─── 主项目搬家桥（跨 bundle：window.__ubStorageRelocation，含就绪广播补注册） ───

interface RelocationBridge {
  register: (copier: unknown) => unknown;
  /** 新版主项目提供；旧版没有 → 卸载时无法摘除复制器（旧版上下文也没有切割信息，复制器会安全退出）。 */
  unregister?: (copier: unknown) => unknown;
}

function bridgeWindows(): any[] {
  const out: any[] = [];
  const push = (value: unknown): void => {
    try {
      const w = value as any;
      if (w && typeof w.addEventListener === 'function' && out.indexOf(w) < 0) out.push(w);
    } catch (_e) { /* cross-origin */ }
  };
  try { push(typeof window !== 'undefined' ? window : null); } catch (_e) { /* ignore */ }
  try { push((window as any)?.parent); } catch (_e) { /* ignore */ }
  try { push((window as any)?.top); } catch (_e) { /* ignore */ }
  return out;
}

function findRelocationBridge(): RelocationBridge | null {
  for (const w of bridgeWindows()) {
    try {
      const bridge = w.__ubStorageRelocation;
      if (bridge && typeof bridge.register === 'function') return bridge as RelocationBridge;
    } catch (_e) { /* cross-origin */ }
  }
  return null;
}

/**
 * boot 调用一次：注册搬家复制器（幂等）。
 * 台账脚本可能先于状态栏装载 → 监听 `ub-storage-relocation-ready` 补注册；返回解绑函数。
 */
export function bindLedgerRelocationCopy(deps: LedgerRelocationDeps): () => void {
  const copier = (context: StorageRelocationCopyContext) => copyLedgerStorageForRelocation(context, deps);
  let registered = false;

  const tryRegister = (): boolean => {
    if (registered) return true;
    const bridge = findRelocationBridge();
    if (!bridge) return false;
    try {
      bridge.register(copier);
      registered = true;
      return true;
    } catch (_e) {
      return false;
    }
  };

  const listeners: Array<{ target: any; handler: () => void }> = [];
  const onReady = (): void => { tryRegister(); };
  for (const w of bridgeWindows()) {
    try {
      w.addEventListener('ub-storage-relocation-ready', onReady);
      listeners.push({ target: w, handler: onReady });
    } catch (_e) { /* ignore */ }
  }
  tryRegister();

  return () => {
    for (const item of listeners) {
      try { item.target.removeEventListener('ub-storage-relocation-ready', item.handler); } catch (_e) { /* ignore */ }
    }
    // 真卸载（脚本重注入）必须摘掉旧复制器：它闭包着已 dispose 的 runtime，留着会在下次搬家被调用。
    try {
      const bridge = findRelocationBridge();
      if (registered && bridge && typeof bridge.unregister === 'function') bridge.unregister(copier);
    } catch (_e) { /* 旧版主项目无 unregister：旧复制器缺切割上下文，会安全返回 false */ }
    registered = false;
  };
}
