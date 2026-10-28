// ===== 台账运行时：单写者引擎 =====
//
// 把 行式账本 / 外部存储 / 楼层身份 / 回调广播 串成单写者模型：
// - 一切写经 commitOps（内存即时应用 → 真实 diff 校准 → 追加记账条目 → 防抖落盘 → 通知）；
// - AI 填表与用户写天然串行（无需写集/修订链机器）；
// - CHAT_CHANGED = 屏障 flush → 身份解析（fresh/改名/fork）→ 双文件载入 → 锚点过滤重放 → 通知；
// - 删楼/swipe = 锚点裁剪事务；深回退 = 重放按锚点过滤；
// - 无可写 AI 楼层时提交失败（对齐原库语义：findTableLatestFloor=-1 拒写）。

import type { LedgerEntry, LedgerOp, WorkbookJson } from './types';
import {
  applyOp,
  createBook,
  diffChangedTables,
  projectWorkbook,
  replayEntries,
  resolveTable,
  workbookSignatures,
  type BookModel,
} from './book';
import { createLedgerStore, FOLD_KEEP, FOLD_TRIGGER, foldSnapshot, type LedgerFilesLike, type LedgerStore } from './ledger-store';
import type { LedgerLogLevel } from './ledger-log';
import { activeAnchors, aiFloorOfAnchor, isAnchorCandidate, ledgerAnchorFor, pruneEntriesByAnchors, removedAnchors, writeScope, entriesVisibleWithin } from './floor-scope';
import {
  bookFileName,
  entriesFileName,
  inferOwner,
  isSafeStorageId,
  listIndexCandidates,
  makeStorageId,
  readChatLink,
  readChatMeta,
  resolveIdentity,
  writeChatLink,
  writeChatMeta,
  type HostContext,
  type IndexFileStore,
  type LedgerChatMeta,
  type SlChatOwner,
} from './identity';
import { convergeBookToTemplate, normalizeTemplate } from './blueprint';

export type LedgerSource = LedgerEntry['source'];

export interface RuntimeHost {
  context(): {
    chat: any[];
    host: HostContext;
    /** 角色卡头像标识（ownerKey 真源）。 */
    characterId?: unknown;
    /** 历史索引里写过的角色卡数组下标（只作匹配别名）。 */
    characterIndex?: unknown;
    groupName?: unknown;
    chatKey: string;
  } | null;
}

/** 可恢复台账候选（列表阶段只做存在性探测，不下载账本内容）。 */
export interface LedgerRecoveryCandidate {
  storageId: string;
  source: 'current' | 'link' | 'index' | 'forkFrom';
  ownerKind?: 'character' | 'group';
  ownerKey?: string;
  chatKey?: string;
  createdAt?: number;
  lastSeenAt?: number;
  forkFrom?: string;
  /** 文件存在性（宿主支持 verify 时给；未探测 = undefined）。 */
  hasBook?: boolean;
  hasEntries?: boolean;
}

/** 候选详情（用户选中后才下载并重放统计）。 */
export interface LedgerRecoveryInspection extends LedgerRecoveryCandidate {
  ok: boolean;
  error?: string;
  tableCount: number;
  rowCount: number;
  entryCount: number;
  snapshotAnchor?: string;
  snapshotAiFloor?: number;
  seq: number;
}

export interface LedgerRecoveryStatus {
  /** true = 当前聊天需要用户介入（meta 丢失/文件缺失/锚点全部失配），此时不建账、不落盘。 */
  needed: boolean;
  reason: string | null;
  /** 流水非空但全部与当前楼层对不上（锚点漂移）。 */
  anchorOrphan: boolean;
  orphanEntries: number;
  totalEntries: number;
  storageId: string | null;
}

/** 填表落点钉住：请求前捕获目标 AI 楼锚点；落账时按锚点反查**当前**楼层号（防异步期间楼位移）。 */
export interface LedgerWriteTarget {
  anchor: string;
  aiFloor: number;
}

export interface CommitResult {
  ok: boolean;
  changedTables: string[];
  errors: string[];
  entry: LedgerEntry | null;
  /** 本次实际使用的落点（钉住 target 时＝锚点解析后的当前楼层号）。 */
  at?: LedgerWriteTarget;
}

export interface LedgerRuntime {
  /** 就绪（当前聊天已建账）。 */
  isReady(): boolean;
  storageId(): string | null;
  owner(): SlChatOwner | null;
  book(): BookModel | null;
  visibleEntries(): LedgerEntry[];
  /** CHAT_CHANGED 全周期。 */
  onChatChanged(): Promise<void>;
  /** 屏障 flush。 */
  flush(): Promise<boolean>;
  pending(): boolean;
  /** 单写者提交入口（无变化不记账——防空洞条目）。
   *  target 非空＝填表钉住的落点：锚点已失联（请求期间被删除/重生成）时拒绝落账，绝不改记到新的尾楼。 */
  commitOps(source: LedgerSource, ops: LedgerOp[], opts?: { notify?: boolean; target?: LedgerWriteTarget }): CommitResult;
  /** SQL 桥路径：操作已由执行器即时应用，只按执行前签名记账。 */
  commitAppliedOps(source: LedgerSource, ops: LedgerOp[], before: Map<string, string>, opts?: { notify?: boolean }): CommitResult;
  /** 删楼 / swipe 裁剪事务（按当前聊天活跃锚点比对；同时回退填表水位并重排条目楼层号）。 */
  pruneRemovedAnchors(): { pruned: number } | null;
  /** 新楼层落地后同步楼层顺序（删楼/swipe 由 pruneRemovedAnchors 自收尾）。 */
  syncFloors(): void;
  /** 显式锚点裁剪（时光机回滚本层：物理裁剪给定锚点上的全部条目并重放）。 */
  pruneEntriesAtAnchors(anchors: Set<string>): { pruned: number; changedTables: string[] } | null;
  /** 手动填表前的「清空所选表在该批楼层的增量」预演（只读：返回将裁掉的条目/操作数与涉及表名）。 */
  countTableIncrements(anchors: Set<string>, tableIds: string[]): { entries: number; ops: number } | null;
  /** 手动填表前的「清空所选表在该批楼层的增量」（按 op 粒度裁：只去这些表的写，其余条目/操作原样保留）。 */
  pruneTableIncrements(anchors: Set<string>, tableIds: string[]): { entries: number; ops: number } | null;
  /** 通知广播（兼容面全量快照回调；重入合并）。返回注销器（unregisterTableUpdateCallback 用）。 */
  onTableUpdate(cb: (data: WorkbookJson) => void): () => void;
  notifyUpdate(): void;
  onFillStart(cb: () => void): void;
  notifyFillStart(): void;
  /** 搬家烘焙：重放到指定 AI 楼序的状态（exportFullCheckpointAtMessageIndex 的台账等价物）。 */
  bakeStateAt(aiFloor: number): WorkbookJson | null;
  /** 初始建账（无文件时以标准模板建结构）。先等聊天装载队列稳定，再判断是否真需要建账。 */
  ensureSeeded(): Promise<boolean>;
  /** 清除当前聊天数据（删两个外部存储文件 + 内存复位为「未建账」；随后 ensureSeeded 重建空账本）。 */
  clearCurrentChatData(): Promise<{ files: number; reset: boolean }>;
  /** restore 模式导入：只换内存不落账（对齐原库 persist:false 语义）。 */
  restoreInMemory(data: WorkbookJson): boolean;
  /** 结构直写（模板切换/修复/导入：全量快照 + 结构变更记账）。 */
  commitSnapshotReplace(source: LedgerSource, data: WorkbookJson, opts?: { notify?: boolean }): CommitResult;
  /** 条目数过阈即结转（外部事件驱动）。 */
  foldIfNeeded(): Promise<boolean>;
  /** 手动「全部折叠」：把当前全部活跃增量一次折进快照并清空流水（保留窗口＝0）。 */
  foldAll(): Promise<{ ok: boolean; folded: number }>;
  /** 数据修订号：任何会改变账本投影的写入/重放都会 +1（世界书刷新跳过的失效键）。 */
  revision(): number;
  /** 填表调度状态（book 文件持久化）。 */
  getSchedule(): Record<string, number>;
  patchSchedule(schedule: Record<string, number>): Promise<boolean>;
  /** 只读保护状态（读取失败/损坏/元数据不可写）。 */
  isWriteProtected(): boolean;
  /** 聊天切换是否已落定（onChatChanged 完成且未被更新的代次取代）。
   *  投影层只在落定后判断「未建账 = 空投影」；装载中一律不动世界书。 */
  isChatSettled(): boolean;
  /** 同步标记「聊天正在切换」（CHAT_CHANGED 事件到达即调用，防投影在异步装载窗口按旧账本写入）。 */
  markChatChanging(): void;
  /** 恢复状态（meta 丢失、文件缺失、锚点全部失配）。 */
  recoveryStatus(): LedgerRecoveryStatus;
  /** 列出可恢复候选（索引/链接/forkFrom；只做存在性探测，不下载账本）。 */
  recoveryCandidates(): Promise<LedgerRecoveryCandidate[]>;
  /** 详情（下载并重放统计；用户选中后调用）。 */
  inspectRecovery(storageId: string): Promise<LedgerRecoveryInspection | null>;
  /** 导出候选为可导入的全量备份（不改变当前聊天绑定）。 */
  exportRecovery(storageId: string): Promise<WorkbookJson | null>;
  /** 把当前聊天重绑到指定 storageId（写链接+meta 校验后载入）。 */
  rebindStorage(storageId: string): Promise<{ ok: boolean; error?: string; metaWritten?: boolean }>;
  /** 不动旧文件，生成一份全新空账本（仅用户明确选择时调用）。 */
  startFreshLedger(): Promise<{ ok: boolean; storageId?: string; error?: string }>;
  /** 锚点漂移自救：按 aiFloor 序号把失配条目重绑到当前楼层锚点（dryRun=只统计）。 */
  replayInvisibleEntries(opts?: { dryRun?: boolean }): Promise<{ ok: boolean; entries: number; total: number; error?: string }>;
  /** 测试钩子。 */
  __store(): LedgerStore | null;
}

export function createLedgerRuntime(deps: {
  host: RuntimeHost;
  files: LedgerFilesLike;
  index: IndexFileStore;
  standardTemplate: WorkbookJson;
  /** 建账模板解析（缺省 = standardTemplate）：新聊天 / 首次建账时套本聊天绑定模板。 */
  resolveSeedTemplate?: () => WorkbookJson;
  /** 收敛模板解析（缺省 = 不收敛）：**回放之后**按当前模板丢弃模板外表/列（结构真源＝模板，见实施案 §5）。 */
  resolveConvergeTemplate?: () => WorkbookJson | null;
  /** 旧聊天文件是否仍存在（fork 判定用）：true=存在 / false=已不存在 / null=查不到（保守按 fork）。 */
  previousChatExists?(chatKey: string): Promise<boolean | null>;
  now?: () => number;
  /** 运行日志上报（工作台「日志」页）：落盘失败 / 只读态 / 建账结果；不传＝保持静默。 */
  onLog?(entry: { level: LedgerLogLevel; source?: string; message: string; detail?: string }): void;
  /** 进入只读保护时给用户的常驻提示（读取失败/文件损坏/元数据不可写）；不传＝只进日志。 */
  onBlocked?(message: string): void;
  /** 进入可恢复状态（文件缺失/身份丢失/锚点全部失配）时提示用户去「迁移 → 台账恢复」。 */
  onRecoverable?(message: string, status: LedgerRecoveryStatus): void;
  /** 自动找回成功（链接/索引/父账本续传）后提示一次。 */
  onRecovered?(message: string, storageId: string): void;
}): LedgerRuntime {
  const now = deps.now || (() => Date.now());
  const updateCallbacks = new Set<(data: WorkbookJson) => void>();
  const fillStartCallbacks = new Set<() => void>();
  let book: BookModel | null = null;
  let store: LedgerStore | null = null;
  let visible: LedgerEntry[] = [];
  let seq = 0;
  let storageId: string | null = null;
  /** 上一次已知的楼层顺序（1-based AI 楼序号 = 下标+1）：删楼/swipe 靠它识别序号位移。
   *  必须在每次聊天追加楼层后同步（index.ts 的 MESSAGE_RECEIVED / onChatChanged / 裁剪事务自身）。 */
  let floorOrder: string[] = [];
  let owner: SlChatOwner | null = null;
  /** 非空 = 当前聊天进入只读保护（账本读取失败/损坏/元数据不可写）；不建账、不落盘。 */
  let loadBlocked: string | null = null;
  /** 非空 = 身份/文件/锚点异常，等用户从「迁移 → 台账恢复」介入；期间不建账、不落盘。 */
  let recoveryNeededReason: string | null = null;
  /** 当前聊天的锚点健康度：orphan=失配条数，total=流水总数，remappable=失配但 aiFloor 仍落在当前楼层内的条数
   *  （只有 remappable>0 才是“锚点漂移”的可自救信号；单纯删楼留下的死条目 aiFloor 超出当前楼层，属正常）。 */
  let anchorHealth = { orphan: 0, total: 0, remappable: 0 };
  /** CHAT_CHANGED 代次：慢请求返回时若代次已变，丢弃结果，避免把旧聊天身份写进新聊天。 */
  let chatGeneration = 0;
  /** 本轮聊天切换是否已落定（true 才允许投影层按账本状态重建/清空世界书）。 */
  let chatSettled = false;
  /** onChatChanged 串行链（初始装载与 CHAT_CHANGED 不再并发交叉）。 */
  let chatChangeChain: Promise<void> = Promise.resolve();
  /** 结转单飞 promise（closeStore/flush 先等它收尾，防旧流水残留）。 */
  let folding: Promise<boolean> | null = null;
  let notifying = false;
  let pendingNotify = false;
  /** 修订号：每次可能改变投影内容的写入/重放自增（见 LedgerRuntime.revision 注释）。 */
  let revision = 0;
  const bumpRevision = (): void => { revision += 1; };

  /** 运行日志上报（上报失败不影响运行链路）。 */
  function report(entry: { level: LedgerLogLevel; source?: string; message: string; detail?: string }): void {
    try { deps.onLog?.(entry); } catch (_e) { /* ignore */ }
  }

  /** store 构造统一出口：落盘失败上报一并接线（三处构造点不各写一遍）。 */
  function makeStore(sid: string): LedgerStore {
    return createLedgerStore({
      files: deps.files,
      storageId: sid,
      now,
      onError: (message) => report({ level: 'error', source: '存储', message }),
    });
  }

  function notifyUpdate(): void {
    if (notifying) { pendingNotify = true; return; }
    notifying = true;
    try {
      const data = book ? projectWorkbook(book) : {};
      for (const cb of updateCallbacks) {
        try { cb(data); } catch (_e) { /* 单回调故障不阻塞 */ }
      }
    } finally {
      notifying = false;
      if (pendingNotify) { pendingNotify = false; notifyUpdate(); }
    }
  }

  /** 记账条目里的结构类 op（data_replace/sheet_replace/meta）——收敛只清「数据面」，不参与判定。
   *  收敛在**完整回放之后**执行：模板外内容一律丢弃（内存先丢；物理清理发生在结转）。 */
  function convergeInPlace(target: BookModel | null = book): void {
    if (!target) return;
    const template = deps.resolveConvergeTemplate ? deps.resolveConvergeTemplate() : null;
    if (!template) return;
    try { convergeBookToTemplate(target, template); } catch (_e) { /* 收敛失败不阻断装载（结构按账本现状跑） */ }
  }

  /** 现取宿主上下文（生产 host 的 chatMetadata/chatKey 是 live getter；这里每次重新拿 chat 数组）。 */
  function liveContext(): ReturnType<RuntimeHost['context']> {
    try { return deps.host.context(); } catch (_e) { return null; }
  }

  function readLiveMeta(): LedgerChatMeta | null {
    const ctx = liveContext();
    return ctx ? readChatMeta(ctx.host) : null;
  }

  function stale(gen: number): boolean {
    return gen !== chatGeneration;
  }

  /** 写 meta 时总是现取宿主；expectedStorageId 防止并发实例已改绑后被覆盖。 */
  async function writeLiveMeta(meta: LedgerChatMeta, expectedStorageId?: string | null): Promise<boolean> {
    const ctx = liveContext();
    if (!ctx) return false;
    return writeChatMeta(ctx.host, meta, {
      expectedChatKey: ctx.chatKey,
      ...(expectedStorageId === undefined ? {} : { expectedStorageId }),
    });
  }

  function currentRecoveryStatus(): LedgerRecoveryStatus {
    const total = anchorHealth.total;
    return {
      needed: !!recoveryNeededReason,
      reason: recoveryNeededReason,
      anchorOrphan: total > 0 && anchorHealth.orphan === total && anchorHealth.remappable > 0,
      orphanEntries: anchorHealth.orphan,
      totalEntries: total,
      storageId,
    };
  }

  /** 进入可恢复状态：不建账、不落盘。
   *  keepBook=true 仅用于锚点漂移：保留已载入的 book（快照里可能还有折叠数据），只暂停写入。 */
  function enterRecovery(reason: string, opts: { keepBook?: boolean } = {}): void {
    const changed = recoveryNeededReason !== reason;
    recoveryNeededReason = reason;
    loadBlocked = null;
    if (!opts.keepBook) clearBookState();
    if (changed) {
      report({ level: 'warn', source: '存储', message: reason });
      try { deps.onRecoverable?.(reason, currentRecoveryStatus()); } catch (_e) { /* 提示失败不影响状态 */ }
    }
  }

  function replayFromSnapshot(snapshot: WorkbookJson, allEntries: LedgerEntry[], trackHealth = false): void {
    const chat = liveContext()?.chat || [];
    const anchors = activeAnchors(chat);
    visible = entriesVisibleWithin(allEntries, anchors);
    if (trackHealth) {
      let remappable = 0;
      if (anchors.size > 0) {
        for (const e of allEntries) {
          if (anchors.has(e.at.anchor)) continue;
          // 当前 AI 楼序号从 1 起；aiFloor 落在现有楼层内 ⇒ 可能只是锚点变了，可尝试按序号重绑。
          if (e.at.aiFloor >= 1 && e.at.aiFloor <= anchors.size) remappable += 1;
        }
      }
      anchorHealth = { orphan: Math.max(0, allEntries.length - visible.length), total: allEntries.length, remappable };
    }
    book = createBook(snapshot);
    replayEntries(book, visible);
    convergeInPlace(book);
  }

  /** 载入完成后检查锚点健康度：流水非空但全部失配 ⇒ 报警并暂停写入，避免在半坏基线上继续写。 */
  function checkAnchorHealth(): void {
    const { orphan, total, remappable } = anchorHealth;
    // 只有“失配且序号仍落在现有楼层内”才判锚点漂移；单纯删楼留下的死条目序号越界，属正常待折叠内容。
    if (total > 0 && orphan === total && remappable > 0) {
      enterRecovery(`账本流水 ${total} 条与当前楼层全部对不上（可能消息锚点变化）；已暂停写入，请到「迁移 → 台账恢复」处理`, { keepBook: true });
    }
  }

  /** 清掉内存账本（保留 store/storageId，供「清除当前聊天数据」自救）。 */
  function clearBookState(): void {
    book = null;
    visible = [];
    seq = 0;
    bumpRevision();
    notifyUpdate();
  }

  /** 进入只读保护：不建账、不落盘；已有 store/storageId 保留，用户可手动清除后重建。 */
  function enterReadOnly(reason: string): void {
    const changed = loadBlocked !== reason;
    loadBlocked = reason;
    clearBookState();
    if (changed) {
      report({ level: 'error', source: '存储', message: reason });
      try { deps.onBlocked?.(reason); } catch (_e) { /* 提示失败不影响只读保护 */ }
    }
  }

  /** 封存旧 store：先等在途结转收尾、把防抖内容落盘，再阻断后续写入（切聊天/卸载的唯一出口）。 */
  async function closeStore(): Promise<void> {
    const old = store;
    // store 立即置空：切换期间任何提交都判「未就绪」，不会写错聊天。
    store = null;
    // 等结转收尾（它已捕获旧 store，仍能完成快照+流水清理），避免流水残留导致重载重复回放。
    while (folding) {
      try { await folding; } catch (_e) { /* 结转失败由 store 错误通道上报 */ }
    }
    if (!old) return;
    try { await old.close(); } catch (_e) { /* best-effort */ }
  }

  /** CHAT_CHANGED 全周期入口：串行化 + 代次守卫。
   *  初始装载与 CHAT_CHANGED 防抖可能重叠；没有代次守卫时，慢请求后返回会把旧聊天的
   *  store/storageId 写进新聊天（A4 之外的新竞态）。 */
  function onChatChanged(): Promise<void> {
    const gen = ++chatGeneration;
    chatSettled = false;
    const run = chatChangeChain.then(() => doChatChanged(gen), () => doChatChanged(gen)).catch((e) => {
      if (!stale(gen)) enterReadOnly(`聊天切换处理失败：${e instanceof Error ? e.message : String(e)}；本次不建账`);
    }).finally(() => {
      // 被更新代次取代的旧轮次不得把 settled 置回 true（新轮次自己会落定）。
      if (!stale(gen)) chatSettled = true;
    });
    chatChangeChain = run.then(() => undefined, () => undefined);
    return run;
  }

  /** CHAT_CHANGED 到达时同步置为未落定：先于防抖/异步装载，防止投影按旧账本写入。 */
  function markChatChanging(): void {
    chatSettled = false;
  }

  /** 把父账本内容复制到新 id（父文件不动）。返回是否复制成功。 */
  async function copyParentToTarget(
    targetId: string,
    parentLoaded: Awaited<ReturnType<LedgerStore['load']>>,
    gen: number,
  ): Promise<boolean> {
    const target = makeStore(targetId);
    storageId = targetId;
    store = target;
    seq = 0;
    for (const e of parentLoaded?.entries || []) if (e.seq > seq) seq = e.seq;
    if (parentLoaded?.seq && parentLoaded.seq > seq) seq = parentLoaded.seq;
    replayFromSnapshot(parentLoaded?.snapshot || {}, parentLoaded?.entries || [], true);
    if (parentLoaded) {
      const scope = writeScope(liveContext()?.chat || []);
      target.replaceEntries(visible.slice());
      const ok = await target.persistSnapshot(
        parentLoaded.snapshot,
        scope?.anchor || parentLoaded.anchor,
        scope?.aiFloor || parentLoaded.aiFloor,
        seq,
      );
      if (!ok) {
        target.destroy();
        if (store === target) { store = null; storageId = null; }
        report({ level: 'error', source: '存储', message: 'fork 数据复制失败：快照写入失败（父账本未改动）' });
        return false;
      }
      await target.flush();
    }
    if (stale(gen)) { target.destroy(); store = null; storageId = null; return false; }
    return true;
  }

  /** fork：先读父账本 → 写新 id 数据 → 最后写 meta。
   *  中途刷新/失败时聊天仍指向父身份，链接文件带着 forkFrom 可在下次继续（不会永久指向空账本）。 */
  async function loadFork(
    resolution: Extract<Awaited<ReturnType<typeof resolveIdentity>>, { action: 'fork' }>,
    chatOwner: SlChatOwner,
    existingMeta: LedgerChatMeta | null,
    gen: number,
  ): Promise<void> {
    const parent = makeStore(resolution.parentStorageId);
    const parentLoaded = await parent.load();
    const parentErr = parent.lastLoadError();
    parent.destroy();
    if (stale(gen)) return;
    if (parentErr) {
      enterRecovery(`父账本读取失败：${parentErr}；本次未结转，原身份未改动`);
      return;
    }
    const targetId = resolution.storageId;
    // 链接先写（带 forkFrom）：即使 meta 还没写、或复制中途刷新，下次也能找回/续传。
    const linkWrite = await writeChatLink(deps.files, chatOwner, {
      storageId: targetId,
      forkFrom: resolution.parentStorageId,
      updatedAt: now(),
    });
    if (stale(gen)) return;
    if (!linkWrite.ok) report({ level: 'warn', source: '存储', message: `链接文件写入失败：${linkWrite.error || '未知原因'}（索引/元数据仍可恢复）` });

    const copied = await copyParentToTarget(targetId, parentLoaded, gen);
    if (stale(gen)) return;
    if (!copied && parentLoaded) {
      enterRecovery('fork 数据复制失败（父账本仍完好）；请重试或到「迁移 → 台账恢复」处理');
      return;
    }
    // meta 最后写：复制成功/父账本为空才落新身份。
    const metaOk = await writeLiveMeta(resolution.meta, existingMeta?.storageId ?? null);
    if (stale(gen)) return;
    if (!metaOk) {
      // 父身份仍在、链接指向新 id；下次打开会沿 forkFrom 续传（不会把旧账本弄丢）。
      report({ level: 'warn', source: '存储', message: 'fork 身份写入未确认（链接文件已写；下次打开会自动续传）' });
      try { deps.onRecoverable?.('fork 身份写入未确认：链接文件已保存，下次打开会自动续传', currentRecoveryStatus()); } catch (_e) { /* ignore */ }
    } else if (parentLoaded) {
      report({ level: 'info', source: '存储', message: `复制聊天已建账并从父账本结转（${String(targetId).slice(0, 12)}…）` });
    } else {
      report({ level: 'warn', source: '存储', message: '父账本不存在或为空：已按新账本处理（复制聊天没有可结转的数据）' });
    }
    if (parentLoaded) checkAnchorHealth();
    notifyUpdate();
  }

  /** 载入候选并统计（不改变当前状态；恢复列表选中后才调用）。 */
  async function inspectStorage(storageIdToInspect: string, source: LedgerRecoveryCandidate['source'] = 'index'): Promise<LedgerRecoveryInspection | null> {
    if (!isSafeStorageId(storageIdToInspect)) return null;
    const probe = makeStore(storageIdToInspect);
    const loaded = await probe.load();
    const err = probe.lastLoadError();
    if (err) {
      return { storageId: storageIdToInspect, source, ok: false, error: err, tableCount: 0, rowCount: 0, entryCount: 0, seq: 0 };
    }
    if (!loaded) return { storageId: storageIdToInspect, source, ok: true, tableCount: 0, rowCount: 0, entryCount: 0, seq: 0 };
    const b = createBook(loaded.snapshot);
    replayEntries(b, loaded.entries);
    let rowCount = 0;
    for (const t of b.tables.values()) rowCount += t.rows.size;
    let maxSeq = Number(loaded.seq || 0);
    for (const e of loaded.entries) if (e.seq > maxSeq) maxSeq = e.seq;
    return {
      storageId: storageIdToInspect,
      source,
      ok: true,
      tableCount: b.tables.size,
      rowCount,
      entryCount: loaded.entries.length,
      snapshotAnchor: loaded.anchor,
      snapshotAiFloor: loaded.aiFloor,
      seq: maxSeq,
    };
  }

  /** 索引里找可恢复候选：只加载前几个有文件记录的候选来判定“有没有数据”。 */
  async function tryRecoverFromIndex(chatOwner: SlChatOwner, chatKey: string, gen: number): Promise<boolean> {
    let idx: { chats: Record<string, any> } | null = null;
    try { idx = await deps.index.readIndex(); } catch (e) {
      report({ level: 'warn', source: '存储', message: `恢复候选读取索引失败：${e instanceof Error ? e.message : String(e)}` });
      return false;
    }
    if (stale(gen)) return false;
    // 自动找回只认「chatKey 完全一致」的候选：同角色其他聊天的旧账本不能因为 ownerKey 相同就被绑进来。
    // 改名/跨聊天找回必须走恢复页由用户显式选择（列表页仍会显示全部同 owner 候选）。
    const candidates = listIndexCandidates(idx, chatOwner)
      .filter((c) => c.storageId && isSafeStorageId(c.storageId) && String(c.entry.chatKey || '') === String(chatKey))
      .slice(0, 6);
    if (candidates.length === 0) return false;
    // 上次 fork 中断的候选：即使链接文件没写成，索引里的 forkFrom 也能把它续传完。
    for (const c of candidates) {
      if (!c.entry.forkFrom) continue;
      const resumed = await resumeFork(c.storageId, String(c.entry.forkFrom), chatOwner, chatKey, gen);
      if (resumed || stale(gen)) return true;
    }
    const withData: Array<{ storageId: string; inspection: LedgerRecoveryInspection }> = [];
    for (const c of candidates) {
      if (stale(gen)) return false;
      const inspection = await inspectStorage(c.storageId, 'index');
      if (inspection?.ok && (inspection.rowCount > 0 || inspection.entryCount > 0)) withData.push({ storageId: c.storageId, inspection });
    }
    if (stale(gen)) return false;
    if (withData.length === 1) {
      return adoptStorage(withData[0].storageId, { source: 'index', chatKey, gen });
    }
    if (withData.length > 1) {
      enterRecovery(`聊天里没有台账身份，但索引里发现 ${withData.length} 本可能属于它的旧账本；请在「迁移 → 台账恢复」选择要绑定的那一本`);
      return true;
    }
    return false;
  }

  /** 把当前聊天绑定到指定 storageId（链接+meta 校验后载入）。 */
  async function adoptStorage(
    targetId: string,
    opts: { source: LedgerRecoveryCandidate['source']; chatKey: string; gen?: number },
  ): Promise<boolean> {
    if (!isSafeStorageId(targetId)) return false;
    const target = makeStore(targetId);
    const loaded = await target.load();
    const err = target.lastLoadError();
    if (err) { target.destroy(); enterRecovery(`候选账本读取失败：${err}`); return true; }
    if (!loaded) {
      // 链接指向一个未写完的 fork：尝试从 forkFrom 续传（由调用方处理），这里只报告未命中。
      target.destroy();
      return false;
    }
    if (opts.gen !== undefined && stale(opts.gen)) { target.destroy(); return true; }
    await closeStore();
    storageId = targetId;
    store = target;
    seq = 0;
    loadBlocked = null;
    recoveryNeededReason = null;
    for (const e of loaded.entries) if (e.seq > seq) seq = e.seq;
    if (loaded.seq > seq) seq = loaded.seq;
    replayFromSnapshot(loaded.snapshot, loaded.entries, true);
    const ctx = liveContext();
    const liveOwner = owner || (ctx ? inferOwner({ characterId: ctx.characterId, characterIndex: ctx.characterIndex, groupName: ctx.groupName, chatKey: ctx.chatKey }) : null);
    if (liveOwner) {
      const linkWrite = await writeChatLink(deps.files, liveOwner, { storageId: targetId, updatedAt: now() });
      if (!linkWrite.ok) report({ level: 'warn', source: '存储', message: `恢复链接文件写入失败：${linkWrite.error || '未知原因'}` });
    }
    const curMeta = readLiveMeta();
    const metaOk = await writeLiveMeta({ storageId: targetId, createdAt: curMeta?.createdAt || now(), chatKey: opts.chatKey }, curMeta?.storageId ?? null);
    if (!metaOk) {
      report({ level: 'warn', source: '存储', message: '恢复后聊天元数据写入未确认（链接文件已尝试写入；下次打开仍可找回）' });
    }
    checkAnchorHealth();
    notifyUpdate();
    report({ level: 'info', source: '存储', message: `已从${opts.source === 'link' ? '链接文件' : opts.source === 'index' ? '全局索引' : '备份身份'}恢复台账（${String(targetId).slice(0, 12)}…）` });
    try { deps.onRecovered?.(`已找回本聊天的旧台账（${String(targetId).slice(0, 12)}…）`, targetId); } catch (_e) { /* ignore */ }
    return true;
  }

  /** meta 存在但文件缺失：先试 forkFrom 续传，再试链接/索引候选；都不行则进入恢复态（绝不空建账）。 */
  async function recoverExistingLedger(existingMeta: LedgerChatMeta, chatOwner: SlChatOwner, chatKey: string, gen: number): Promise<boolean> {
    if (existingMeta.forkFrom) {
      const resumed = await resumeFork(existingMeta.storageId, existingMeta.forkFrom, chatOwner, chatKey, gen);
      if (resumed) return true;
      if (stale(gen)) return true;
    }
    const linkRead = await readChatLink(deps.files, chatOwner);
    if (stale(gen)) return true;
    if (linkRead.link && linkRead.link.storageId !== existingMeta.storageId) {
      const adopted = await adoptStorage(linkRead.link.storageId, { source: 'link', chatKey, gen });
      if (adopted) return true;
      if (stale(gen)) return true;
    }
    return tryRecoverFromIndex(chatOwner, chatKey, gen);
  }

  /** 续传一个未完成的 fork：目标文件缺失时从父账本复制；目标已有数据则直接采用。 */
  async function resumeFork(
    targetId: string,
    parentId: string,
    chatOwner: SlChatOwner,
    chatKey: string,
    gen: number,
  ): Promise<boolean> {
    if (!isSafeStorageId(targetId) || !isSafeStorageId(parentId)) return false;
    // 目标已有数据：直接重绑（链接/meta 由 adoptStorage 写）。
    if (await adoptStorage(targetId, { source: 'forkFrom', chatKey, gen })) return true;
    if (stale(gen)) return true;
    const parent = makeStore(parentId);
    const parentLoaded = await parent.load();
    const parentErr = parent.lastLoadError();
    parent.destroy();
    if (stale(gen)) return true;
    if (parentErr) { enterRecovery(`父账本读取失败：${parentErr}；fork 续传未完成`); return true; }
    if (!parentLoaded) {
      // 父账本为空：视为无数据可结转，交给用户选择新建空账本（不自动 seed）。
      enterRecovery('fork 目标文件缺失且父账本为空；请选择「重试恢复」或「新建空账本」');
      return true;
    }
    const linkWrite = await writeChatLink(deps.files, chatOwner, { storageId: targetId, forkFrom: parentId, updatedAt: now() });
    if (!linkWrite.ok) report({ level: 'warn', source: '存储', message: `续传链接写入失败：${linkWrite.error || '未知原因'}` });
    const copied = await copyParentToTarget(targetId, parentLoaded, gen);
    if (stale(gen)) return true;
    if (!copied) { enterRecovery('fork 续传复制失败；请重试'); return true; }
    const metaOk = await writeLiveMeta({ storageId: targetId, createdAt: now(), chatKey, forkFrom: parentId }, readLiveMeta()?.storageId ?? null);
    if (!metaOk) report({ level: 'warn', source: '存储', message: 'fork 续传完成但身份写入未确认（链接文件已写）' });
    checkAnchorHealth();
    notifyUpdate();
    try { deps.onRecovered?.(`已续传复制聊天的父账本（${String(targetId).slice(0, 12)}…）`, targetId); } catch (_e) { /* ignore */ }
    return true;
  }

  async function doChatChanged(gen: number): Promise<void> {
    loadBlocked = null;
    recoveryNeededReason = null;
    anchorHealth = { orphan: 0, total: 0, remappable: 0 };
    let ctx = liveContext();
    // 无聊天上下文：不能继续拿上一个聊天的账本跑（A4）。
    if (!ctx) {
      await closeStore();
      if (stale(gen)) return;
      ctx = liveContext();
      if (!ctx) {
        storageId = null;
        owner = null;
        floorOrder = [];
        clearBookState();
        return;
      }
    }
    if (!String(ctx.chatKey || '').trim()) {
      // 聊天尚未加载（chatId 为空）：绝不用 'chat' 兜底（会让所有聊天共用身份）。
      // 先封存旧 store，再给宿主一次加载完成的机会；仍然为空才清空并等待 CHAT_CHANGED。
      await closeStore();
      if (stale(gen)) return;
      ctx = liveContext();
      if (!ctx || !String(ctx.chatKey || '').trim()) {
        storageId = null;
        owner = null;
        floorOrder = [];
        clearBookState();
        report({ level: 'warn', source: '存储', message: '聊天尚未加载（chatId 为空）：本次不解析台账身份，等待 CHAT_CHANGED' });
        return;
      }
    }
    floorOrder = currentFloorOrder(ctx.chat);
    // 1) 屏障 + 封存旧 store：store 立即置空 ⇒ 切换期间任何提交都判「未就绪」，不会写错聊天。
    await closeStore();
    if (stale(gen)) return;
    storageId = null;
    owner = null;
    clearBookState();
    // 2) 现取上下文 + 身份解析（角色卡 ownerKey 用头像，数字下标只作匹配别名）
    ctx = liveContext();
    if (!ctx) return;
    // closeStore 期间聊天可能已经加载完/换过数组：楼层序号以现取上下文为准。
    floorOrder = currentFloorOrder(ctx.chat);
    const chatKey = String(ctx.chatKey || '').trim();
    if (!chatKey) return;
    const chatOwner = inferOwner({
      characterId: ctx.characterId,
      characterIndex: ctx.characterIndex,
      groupName: ctx.groupName,
      chatKey,
    });
    if (chatOwner.kind === 'character' && (!chatOwner.ownerKey || chatOwner.ownerKey === 'unknown')) {
      report({ level: 'warn', source: '存储', message: '无法解析角色卡头像（characterId 未就绪）：本次不解析台账身份' });
      return;
    }
    owner = chatOwner;
    const existingMeta = readChatMeta(ctx.host);

    // 2.1) meta 丢失：先读链接文件（第二份指针），能直接找回就不走 fresh。
    if (!existingMeta) {
      const linkRead = await readChatLink(deps.files, chatOwner);
      if (stale(gen)) return;
      if (linkRead.error) report({ level: 'warn', source: '存储', message: `链接文件读取失败：${linkRead.error}（继续尝试索引）` });
      if (linkRead.link) {
        if (linkRead.link.forkFrom && linkRead.link.storageId) {
          const resumed = await resumeFork(linkRead.link.storageId, linkRead.link.forkFrom, chatOwner, chatKey, gen);
          if (resumed) return;
          if (stale(gen)) return;
        }
        const adopted = await adoptStorage(linkRead.link.storageId, { source: 'link', chatKey, gen });
        if (adopted) return;
        if (stale(gen)) return;
      }
    }

    let resolution: Awaited<ReturnType<typeof resolveIdentity>>;
    try {
      resolution = await resolveIdentity(existingMeta, chatOwner, deps.index, now, { previousChatExists: deps.previousChatExists });
    } catch (e) {
      if (!stale(gen)) enterReadOnly(`聊天身份解析失败：${e instanceof Error ? e.message : String(e)}；为避免写错账本本次不建账`);
      return;
    }
    if (stale(gen)) return;
    if (resolution.action === 'read-only') { enterReadOnly(resolution.error); return; }
    if (resolution.indexDegraded) report({ level: 'warn', source: '存储', message: resolution.indexDegraded });

    // 2.2) 没有 meta 且判定 fresh：先查索引候选；有数据就自动/显式恢复，不直接建新账。
    if (!existingMeta && resolution.action === 'fresh') {
      const recovered = await tryRecoverFromIndex(chatOwner, chatKey, gen);
      if (recovered) return;
      if (stale(gen)) return;
    }

    // 3) fork：数据先写、meta 最后写。
    if (resolution.action === 'fork') {
      await loadFork(resolution, chatOwner, existingMeta, gen);
      return;
    }

    // 4) 先载入再写身份：读取失败/文件损坏时绝不先写链接/meta（否则会在坏存储上登记新身份）。
    storageId = resolution.storageId;
    store = makeStore(storageId);
    const loaded = await store.load();
    if (stale(gen)) { store.destroy(); store = null; storageId = null; return; }
    const loadErr = store.lastLoadError();
    if (loadErr) { enterReadOnly(`${loadErr}；已暂停写入，避免覆盖账本`); return; }
    if (!loaded && existingMeta) {
      // 身份存在但文件缺失：先尝试 fork 续传/链接/索引；都不行进入恢复态，绝不空建账。
      const handled = await recoverExistingLedger(existingMeta, chatOwner, chatKey, gen);
      if (handled) return;
      if (stale(gen)) return;
      enterRecovery(`账本身份存在（${String(existingMeta.storageId).slice(0, 12)}…）但 book/entries 文件缺失；已暂停建账，请到「迁移 → 台账恢复」找回或新建空账本`);
      return;
    }

    // 5) fresh / reuse：身份有变化才写链接（正常打开已有聊天不额外写文件），meta 最后写。
    const expectedStorageId = existingMeta ? existingMeta.storageId : null;
    const metaNeedsWrite = resolution.action !== 'reuse'
      || !existingMeta
      || (resolution.meta.chatKey || '') !== (existingMeta.chatKey || '');
    if (metaNeedsWrite) {
      const linkWrite = await writeChatLink(deps.files, chatOwner, { storageId: resolution.storageId, updatedAt: now() });
      if (stale(gen)) return;
      if (!linkWrite.ok) report({ level: 'warn', source: '存储', message: `链接文件写入失败：${linkWrite.error || '未知原因'}（索引仍可恢复）` });
    }
    const metaOk = metaNeedsWrite ? await writeLiveMeta(resolution.meta, expectedStorageId) : true;
    if (stale(gen)) return;
    if (!metaOk) {
      if (resolution.action === 'fresh') {
        // 保留原有告警锚点（日志页/测试按此文案）
        enterReadOnly('当前聊天为只读态：聊天元数据写入失败（storageId 未登记，台账不建账也不落盘）');
        return;
      }
      report({ level: 'warn', source: '存储', message: '聊天元数据写入失败：本次继续使用聊天内已有身份（链接/索引下次打开可找回）' });
    }
    if (!loaded) {
      // 全新聊天：无文件，保持未建账；首次读/写时 ensureSeeded 兜底。
      return;
    }
    for (const e of loaded.entries) if (e.seq > seq) seq = e.seq;
    if (loaded.seq > seq) seq = loaded.seq;
    replayFromSnapshot(loaded.snapshot, loaded.entries, true);
    checkAnchorHealth();
    notifyUpdate();
  }

  /** 内部建账：只在确认「当前聊天确实未建账」后调用。
   *  ★ 禁在 chatChangeChain（doChatChanged）内部 await ensureSeeded —— 会等自己而死锁。 */
  async function seedNow(): Promise<boolean> {
    if (book) return true;
    // 只读保护（读取失败/损坏/元数据不可写）：绝不建账覆盖（A1/A10）。
    if (loadBlocked) return false;
    // 身份/文件异常待恢复：必须等用户从恢复页选择，绝不空建账把旧账本“盖没”。
    if (recoveryNeededReason) return false;
    if (!store || !storageId) return false;
    const normalized = normalizeTemplate(deps.resolveSeedTemplate ? deps.resolveSeedTemplate() : deps.standardTemplate);
    if (!normalized.ok || !normalized.template) {
      report({ level: 'warn', source: '其他', message: '建账失败：本聊天绑定的模板解析不通过（请到「表格」页检查模板或改绑标准模板）' });
      return false;
    }
    book = createBook(normalized.template);
    visible = [];
    const ctx = deps.host.context();
    const scope = ctx ? writeScope(ctx.chat) : null;
    // 落盘快照＝瘦身形态（v2 表不带 sourceData；装载由 def 派生、随后被绑定模板覆盖，见 projectSheet）
    const ok = await store.persistSnapshot(projectWorkbook(book, { forStorage: true }), scope?.anchor || '', scope?.aiFloor || 0, seq);
    if (!ok) {
      book = null;
      report({ level: 'warn', source: '其他', message: '建账失败：快照写入失败（外部存储不可用）；本聊天仍未建账' });
      return false;
    }
    bumpRevision();
    notifyUpdate();
    report({ level: 'info', source: '其他', message: `当前聊天已建账：${book.tables.size} 张表（storageId ${String(storageId).slice(0, 12)}…）` });
    return true;
  }

  /** 公开建账入口：先等聊天装载队列稳定，再由 seedNow 判断是否真需要建账。
   *  装载期间 book 临时为 null、而 store/storageId 已发布；此时直接建账会把空模板写进
   *  已有 book 文件（覆盖全部数据）。等待期间若又切了聊天，继续等最新一轮。
   *  ★ 只可从加载链外部调用（链内一律走 seedNow），否则自等待死锁。 */
  async function ensureSeeded(): Promise<boolean> {
    if (book) return true;
    let pending: Promise<void>;
    do {
      pending = chatChangeChain;
      await pending;
    } while (pending !== chatChangeChain);
    return seedNow();
  }

  function restoreInMemory(data: WorkbookJson): boolean {
    if (!store) return false;
    book = createBook(data || {});
    bumpRevision();
    notifyUpdate();
    return true;
  }

  function commitOps(source: LedgerSource, ops: LedgerOp[], opts?: { notify?: boolean; target?: LedgerWriteTarget }): CommitResult {
    if (!book || !store) return { ok: false, changedTables: [], errors: ['台账未就绪'], entry: null };
    if (recoveryNeededReason) return { ok: false, changedTables: [], errors: ['台账待恢复：请先到「迁移 → 台账恢复」处理'], entry: null };
    const ctx = deps.host.context();
    let scope: LedgerWriteTarget | null;
    if (opts?.target) {
      // 钉住的落点只认锚点：请求期间尾楼新增/位移都不能把结果改记到别的楼层。
      const aiFloor = aiFloorOfAnchor(ctx?.chat || [], opts.target.anchor);
      if (aiFloor === null) {
        return { ok: false, changedTables: [], errors: ['目标楼层已失效（填表期间被删除或重生成）：本组结果已作废，请重跑'], entry: null };
      }
      scope = { anchor: opts.target.anchor, aiFloor };
    } else {
      scope = ctx ? writeScope(ctx.chat) : null;
      if (!scope) return { ok: false, changedTables: [], errors: ['当前聊天没有可写入的 AI 楼层'], entry: null };
    }
    bumpRevision();
    const before = workbookSignatures(book);
    const errors: string[] = [];
    for (const op of ops) {
      const r = applyOp(book, op);
      if (!r.ok && r.error) errors.push(r.error);
    }
    const changedTables = diffChangedTables(book, before);
    let entry: LedgerEntry | null = null;
    if (changedTables.length > 0) {
      seq += 1;
      entry = { seq, at: { anchor: scope.anchor, aiFloor: scope.aiFloor }, source, ops, changedTables, atTime: now() };
      store.appendEntry(entry);
      visible.push(entry);
      if (visible.length >= FOLD_TRIGGER) void foldIfNeeded();
    }
    if (opts?.notify !== false) notifyUpdate();
    return { ok: errors.length === 0, changedTables, errors, entry, at: scope };
  }

  /** 结构直写：data_replace 语义（模板导入/修复/迁移收尾）。只落记账条目不直写快照——
   *  条目随楼层回退自然裁剪（快照直写会突破楼层语义：删楼后状态回不去）。 */
  function commitSnapshotReplace(source: LedgerSource, data: WorkbookJson, opts?: { notify?: boolean }): CommitResult {
    if (!store) return { ok: false, changedTables: [], errors: ['台账未就绪'], entry: null };
    if (recoveryNeededReason) return { ok: false, changedTables: [], errors: ['台账待恢复：请先到「迁移 → 台账恢复」处理'], entry: null };
    const ctx = deps.host.context();
    const scope = ctx ? writeScope(ctx.chat) : null;
    if (!scope) return { ok: false, changedTables: [], errors: ['当前聊天没有可写入的 AI 楼层'], entry: null };
    bumpRevision();
    const fresh = createBook(data || {});
    book = fresh;
    const changedTables = [...fresh.tables.keys()];
    seq += 1;
    const entry: LedgerEntry = {
      seq,
      at: { anchor: scope.anchor, aiFloor: scope.aiFloor },
      source,
      ops: [{ kind: 'data_replace', data }],
      changedTables,
      atTime: now(),
    };
    store.appendEntry(entry);
    visible.push(entry);
    if (opts?.notify !== false) notifyUpdate();
    return { ok: true, changedTables, errors: [], entry };
  }

  /** SQL 桥路径：操作已即时应用，按执行前签名做真实 diff 记账。 */
  function commitAppliedOps(source: LedgerSource, ops: LedgerOp[], before: Map<string, string>, opts?: { notify?: boolean }): CommitResult {
    if (!book || !store) return { ok: false, changedTables: [], errors: ['台账未就绪'], entry: null };
    if (recoveryNeededReason) return { ok: false, changedTables: [], errors: ['台账待恢复：请先到「迁移 → 台账恢复」处理'], entry: null };
    const ctx = deps.host.context();
    const scope = ctx ? writeScope(ctx.chat) : null;
    if (!scope) return { ok: false, changedTables: [], errors: ['当前聊天没有可写入的 AI 楼层'], entry: null };
    bumpRevision();
    const changedTables = diffChangedTables(book, before);
    let entry: LedgerEntry | null = null;
    if (changedTables.length > 0) {
      seq += 1;
      entry = { seq, at: { anchor: scope.anchor, aiFloor: scope.aiFloor }, source, ops, changedTables, atTime: now() };
      store.appendEntry(entry);
      visible.push(entry);
      if (visible.length >= FOLD_TRIGGER) void foldIfNeeded();
    }
    if (opts?.notify !== false) notifyUpdate();
    return { ok: true, changedTables, errors: [], entry };
  }

  /** 结转单飞：同一时间只跑一次；期间新追加的条目原样保留（A5）。 */
  async function foldIfNeeded(): Promise<boolean> {
    if (!book || !store) return false;
    if (folding) return folding;
    const task = doFold();
    let wrapped: Promise<boolean>;
    wrapped = task.finally(() => {
      if (folding === wrapped) folding = null;
      // 结转期间可能又跨过阈值：再检查一次（单飞链，不会并发）。
      // 必须有实际流水才重试，避免 visible/entries 偶发不一致时空转。
      if (visible.length >= FOLD_TRIGGER && store && store.peekEntries().length > 0) void foldIfNeeded();
    });
    folding = wrapped;
    return wrapped;
  }

  async function doFold(): Promise<boolean> {
    const target = store;
    if (!book || !target) return false;
    // 只折活跃（锚点仍在）的条目：流水里可能有扩展未运行时删楼的死条目，不能把它们重放进快照
    const active = visible.slice();
    if (active.length <= FOLD_KEEP) return false;
    // 切分点＝保留最近 FOLD_KEEP 条；但不能把同一楼层切成两半（否则该层一半已折叠、一半还可审核）
    const keepFrom = active.length - FOLD_KEEP;
    let cut = keepFrom;
    while (cut > 0 && cut < active.length && active[cut - 1].at.aiFloor === active[cut].at.aiFloor) cut -= 1;
    // 极端：单层条目就超过保留量时按条切，避免流水无界增长
    if (cut === 0) cut = keepFrom;
    if (cut <= 0) return false;
    // 先拍下本次要折叠的前缀；结转期间新来的条目不在其中 ⇒ 不会被清掉（A5）
    const prefix = active.slice(0, cut);
    return foldPrefix(target, prefix);
  }

  /** 把指定条目前缀折进快照并清出流水（自动结转与手动全量折叠共用；调用方已保证 prefix 升序）。
   *  折叠点状态＝旧快照 + 前缀重放（**不能用当前 book**：它已包含后面要保留的流水，重载会二次重放）。 */
  async function foldPrefix(target: LedgerStore, prefix: LedgerEntry[]): Promise<boolean> {
    const prefixSet = new Set(prefix);
    const foldedBook = createBook(target.peekSnapshot() || {});
    replayEntries(foldedBook, prefix);
    convergeInPlace(foldedBook);
    // 同口径走瘦身形态（见 projectSheet 的 forStorage）
    const folded = foldSnapshot(projectWorkbook(foldedBook, { forStorage: true }), prefix);
    const ok = await target.persistSnapshot(folded.snapshot, folded.anchor, folded.aiFloor, folded.seq);
    if (!ok) return false;
    // 保留前缀之后的活跃条目 + 折叠期间新到的条目；死条目（不在 visible）不再回写流水
    visible = visible.filter((e) => !prefixSet.has(e));
    target.replaceEntries(visible.slice());
    await target.flush();
    return true;
  }

  /** 手动「全部折叠」（工作台时光机页按钮）：把当前全部活跃增量一次折进快照，流水清空。
   *  与自动结转同源，区别只在保留窗口＝0；锚点已失效的死条目一并清出流水（重载本来就会被过滤）。
   *  折叠期间新到的条目仍留在流水里（同 doFold 口径），不会丢。 */
  async function foldAll(): Promise<{ ok: boolean; folded: number }> {
    // 等在途结转收尾（单飞链），随后重新取一份完整的活跃集。
    while (folding) {
      try { await folding; } catch (_e) { /* 在途结转失败由 store 错误通道上报；这里继续折剩余 */ }
    }
    if (!book || !store) return { ok: false, folded: 0 };
    let folded = 0;
    let wrapped: Promise<boolean>;
    const task = (async () => {
      const target = store;
      if (!book || !target) return false;
      const active = visible.slice();
      if (active.length > 0) {
        const ok = await foldPrefix(target, active);
        if (!ok) return false;
        folded = active.length;
      } else {
        // 没有活跃条目：只把死条目清出流水（否则它们会永远留在文件里）。
        target.replaceEntries([]);
        await target.flush();
      }
      return true;
    })();
    wrapped = task.finally(() => {
      if (folding === wrapped) folding = null;
      // 折叠期间可能又攒够阈值：交给自动结转继续（单飞链，不会并发）。
      if (visible.length >= FOLD_TRIGGER && store && store.peekEntries().length > 0) void foldIfNeeded();
    });
    folding = wrapped;
    try {
      const ok = await wrapped;
      return { ok, folded };
    } catch (_e) {
      return { ok: false, folded: 0 };
    }
  }

  /** 当前聊天的活跃锚点顺序（下标+1 = AI 楼序号，与 ledgerAnchorFor 同口径）。 */
  function currentFloorOrder(chat: any[]): string[] {
    const order: string[] = [];
    for (let i = 0; i < chat.length; i++) {
      if (!isAnchorCandidate(chat[i])) continue;
      const anchor = ledgerAnchorFor(chat[i], i);
      if (anchor) order.push(anchor);
    }
    return order;
  }

  function syncFloors(): void {
    floorOrder = currentFloorOrder(deps.host.context()?.chat || []);
  }

  /** 条目楼层号重排：删楼后后续楼层整体前移，旧 at.aiFloor 必须跟着新顺序改。 */
  function rebaseEntryFloors(entries: LedgerEntry[], order: string[]): boolean {
    const ordinal = new Map<string, number>();
    for (let i = 0; i < order.length; i++) ordinal.set(order[i], i + 1);
    let changed = false;
    for (const e of entries) {
      const next = ordinal.get(e.at.anchor);
      if (next && e.at.aiFloor !== next) {
        e.at = { ...e.at, aiFloor: next };
        changed = true;
      }
    }
    return changed;
  }

  /** 填表水位回退：水位＝「已填到第几层」，按幸存楼层重算。
   *  删楼 k：旧序号 ≥ k 的幸存楼层前移一位（水位 ≥ k 减 1）；
   *  swipe k：层数不变但第 k 层内容已换（水位压到 k-1）。两者同一条公式。 */
  function rebaseSchedule(beforeOrder: string[], afterOrder: string[]): boolean {
    if (!store || beforeOrder.length === 0) return false;
    const schedule = store.getSchedule();
    const keys = Object.keys(schedule);
    if (keys.length === 0) return false;
    const alive = new Set(afterOrder);
    const survivingOld: number[] = [];
    for (let i = 0; i < beforeOrder.length; i++) if (alive.has(beforeOrder[i])) survivingOld.push(i + 1);
    const next: Record<string, number> = {};
    let changed = false;
    for (const tableId of keys) {
      const old = Math.max(0, Math.trunc(Number(schedule[tableId]) || 0));
      let filled = 0;
      for (const ordinal of survivingOld) if (ordinal <= old) filled += 1;
      // 水位只降不升（异常插入/未同步尾部时宁可多重填，也不能把没填的层跳过）
      next[tableId] = Math.min(old, filled);
      if (next[tableId] !== old) changed = true;
    }
    if (!changed) return false;
    void store.patchSchedule(next);
    return true;
  }

  function pruneRemovedAnchors(): { pruned: number } | null {
    const chat = deps.host.context()?.chat || [];
    const afterOrder = currentFloorOrder(chat);
    const beforeOrder = floorOrder;
    floorOrder = afterOrder;
    if (!book || !store) return null;
    const after = new Set(afterOrder);
    const before = new Set<string>([...after, ...visible.map((e) => e.at.anchor)]);
    const removed = removedAnchors(before, after);
    let pruned = 0;
    if (removed.size > 0) {
      bumpRevision();
      const all = store.peekEntries();
      const { kept } = pruneEntriesByAnchors(all, removed);
      store.replaceEntries(kept);
      visible = pruneEntriesByAnchors(visible, removed).kept;
      const snapshot = store.peekSnapshot();
      if (snapshot) replayFromSnapshot(snapshot, kept);
      pruned = removed.size;
    }
    // 删掉的楼即使没有台账条目，楼层序号仍整体前移 → 水位必须跟着回退
    const renumbered = rebaseEntryFloors(store.peekEntries(), afterOrder) || rebaseEntryFloors(visible, afterOrder);
    rebaseSchedule(beforeOrder, afterOrder);
    if (removed.size > 0 || renumbered) notifyUpdate();
    return { pruned };
  }

  function pruneEntriesAtAnchors(anchors: Set<string>): { pruned: number; changedTables: string[] } | null {
    if (!book || !store || anchors.size === 0) return null;
    const all = store.peekEntries();
    const hit = all.filter((e) => anchors.has(e.at.anchor));
    if (hit.length === 0) return { pruned: 0, changedTables: [] };
    bumpRevision();
    const changedTables: string[] = [];
    for (const e of hit) for (const t of e.changedTables) if (!changedTables.includes(t)) changedTables.push(t);
    const { kept } = pruneEntriesByAnchors(all, anchors);
    store.replaceEntries(kept);
    visible = pruneEntriesByAnchors(visible, anchors).kept;
    const snapshot = store.peekSnapshot();
    if (snapshot) replayFromSnapshot(snapshot, kept);
    notifyUpdate();
    return { pruned: hit.length, changedTables };
  }

  /** 手动填表前的增量清理：按 op 粒度裁掉「给定锚点 × 给定表」的写（data_replace 整本条目不动）。
   *  口径（用户定案 A）：手动填表 = 这些表在这些层「重来一遍」，先清空它们的旧增量再填；
   *  其他表/其他功能的写入原样保留。返回 { entries, ops } = 被丢弃的条目数与操作数；dryRun 时只统计不落盘。 */
  function shrinkTableIncrements(anchors: Set<string>, tableIds: string[], dryRun: boolean): { entries: number; ops: number } | null {
    if (!book || !store) return null;
    if (anchors.size === 0 || tableIds.length === 0) return { entries: 0, ops: 0 };
    // op.table 可能是 tableId 或中文表名（桥/SQL 两路来源），两种写法都收
    const tables = new Set<string>();
    for (const id of tableIds) {
      tables.add(id);
      const t = resolveTable(book, id);
      if (t) { tables.add(t.tableId); tables.add(t.name); }
    }
    const all = store.peekEntries();
    let entries = 0;
    let ops = 0;
    const next: LedgerEntry[] = [];
    for (const e of all) {
      if (!anchors.has(e.at.anchor)) { next.push(e); continue; }
      const list = e.ops || [];
      const keptOps = list.filter((op) => op.kind === 'data_replace' || !tables.has((op as { table?: string }).table || ''));
      const removed = list.length - keptOps.length;
      if (removed === 0) { next.push(e); continue; }
      ops += removed;
      if (keptOps.length === 0) { entries += 1; continue; } // 整条只剩被裁 op → 条目一并丢弃
      const changedTables = [...new Set(keptOps.filter((op) => op.kind !== 'data_replace').map((op) => (op as { table: string }).table))];
      next.push({ ...e, ops: keptOps, changedTables });
    }
    if (dryRun || (entries === 0 && ops === 0)) return { entries, ops };
    bumpRevision();
    store.replaceEntries(next);
    const snapshot = store.peekSnapshot();
    if (snapshot) replayFromSnapshot(snapshot, next);
    notifyUpdate();
    return { entries, ops };
  }

  function bakeStateAt(aiFloor: number): WorkbookJson | null {
    if (!store) return null;
    const snapshot = store.peekSnapshot();
    if (!snapshot) return null;
    const all = store.peekEntries();
    const upto = all.filter((e) => e.at.aiFloor <= aiFloor);
    const baked = createBook(snapshot);
    replayEntries(baked, upto);
    convergeInPlace(baked); // 时光机/导出同口径：历史视图也不含模板外内容
    return projectWorkbook(baked);
  }

  /** 清除当前聊天数据（工作台清理工具）：停旧 store（先断防抖写入）→ 内存复位为「未建账」→ 删外部存储两文件。
   *  必须换新 store 实例：旧实例仍持旧快照/条目的脏标记，留着会在下一次 flush 把已删文件写回来。
   *  调用方随后 ensureSeeded 即按当前模板重建空账本（世界书投影由调用方刷新）。
   *  本聊天无账本内容（book/快照/条目皆空）时不动：返回 reset=false，避免「清除」反而凭空建账。 */
  async function clearCurrentChatData(): Promise<{ files: number; reset: boolean }> {
    const sid = storageId;
    // 只读保护（读取失败/损坏）也算「有数据可清」——这是用户的唯一自救出口。
    const hasData = !!book || !!loadBlocked || !!recoveryNeededReason
      || (!!store && (store.peekEntries().length > 0 || !!store.peekSnapshot()));
    if (!sid || !store || !hasData) return { files: 0, reset: false };
    // 先落盘再封存：在途写入结束后才删文件，避免删完被旧写回（A8）。
    await closeStore();
    store = makeStore(sid);
    book = null;
    visible = [];
    seq = 0;
    loadBlocked = null;
    recoveryNeededReason = null;
    anchorHealth = { orphan: 0, total: 0, remappable: 0 };
    bumpRevision();
    notifyUpdate();
    let files = 0;
    const del = deps.files.delete;
    if (typeof del === 'function') {
      for (const name of [bookFileName(sid), entriesFileName(sid)]) {
        try {
          const r = await del.call(deps.files, `/user/files/${name}`);
          if (r?.ok) files += 1;
        } catch (_e) { /* 单文件失败不阻塞（下次建账会覆盖） */ }
      }
    }
    return { files, reset: true };
  }

  /** 列出可恢复候选：当前身份 / 链接 / 索引 / fork 父账本。
   *  列表阶段只用 verify 探测文件存在性，不下载账本内容（正常用户不会走到这里）。 */
  async function recoveryCandidates(): Promise<LedgerRecoveryCandidate[]> {
    const ctx = liveContext();
    const liveOwner = owner || (ctx
      ? inferOwner({ characterId: ctx.characterId, characterIndex: ctx.characterIndex, groupName: ctx.groupName, chatKey: ctx.chatKey })
      : null);
    const out = new Map<string, LedgerRecoveryCandidate>();
    const add = (candidate: LedgerRecoveryCandidate): void => {
      if (!candidate.storageId || !isSafeStorageId(candidate.storageId) || out.has(candidate.storageId)) return;
      out.set(candidate.storageId, candidate);
    };
    const liveMeta = ctx ? readChatMeta(ctx.host) : null;
    if (liveMeta) {
      add({ storageId: liveMeta.storageId, source: 'current', chatKey: liveMeta.chatKey, forkFrom: liveMeta.forkFrom });
      if (liveMeta.forkFrom) add({ storageId: liveMeta.forkFrom, source: 'forkFrom' });
    }
    if (storageId) add({ storageId, source: 'current', chatKey: liveMeta?.chatKey });
    if (liveOwner) {
      const linkRead = await readChatLink(deps.files, liveOwner);
      if (linkRead.link) {
        add({
          storageId: linkRead.link.storageId,
          source: 'link',
          ownerKind: linkRead.link.ownerKind,
          ownerKey: linkRead.link.ownerKey,
          chatKey: linkRead.link.chatKey,
          forkFrom: linkRead.link.forkFrom,
          lastSeenAt: linkRead.link.updatedAt,
        });
        if (linkRead.link.forkFrom) add({ storageId: linkRead.link.forkFrom, source: 'forkFrom' });
      }
      let idx: { chats: Record<string, any> } | null = null;
      try { idx = await deps.index.readIndex(); } catch (e) {
        report({ level: 'warn', source: '存储', message: `恢复候选读取索引失败：${e instanceof Error ? e.message : String(e)}` });
      }
      for (const c of listIndexCandidates(idx, liveOwner)) {
        add({
          storageId: c.storageId,
          source: 'index',
          ownerKind: c.entry.ownerKind,
          ownerKey: c.entry.ownerKey,
          chatKey: c.entry.chatKey,
          createdAt: c.entry.createdAt,
          lastSeenAt: c.entry.lastSeenAt,
          forkFrom: c.entry.forkFrom,
        });
      }
    }
    const list = [...out.values()];
    // fork 父账本也纳入候选（续传入口）。
    for (const c of list.slice()) if (c.forkFrom) add({ storageId: c.forkFrom, source: 'forkFrom' });
    const verify = (deps.files as { verify?: (paths: string[]) => Promise<Record<string, boolean>> }).verify;
    if (typeof verify === 'function') {
      const names: string[] = [];
      for (const c of list) names.push(`/user/files/${bookFileName(c.storageId)}`, `/user/files/${entriesFileName(c.storageId)}`);
      try {
        const existence = await verify.call(deps.files, names);
        for (const c of list) {
          c.hasBook = existence[`/user/files/${bookFileName(c.storageId)}`] === true;
          c.hasEntries = existence[`/user/files/${entriesFileName(c.storageId)}`] === true;
        }
      } catch (_e) { /* 探测失败：保持 undefined，详情阶段再读 */ }
    }
    const rank = (c: LedgerRecoveryCandidate): number => c.source === 'current' ? 0 : c.source === 'link' ? 1 : c.source === 'forkFrom' ? 2 : 3;
    list.sort((a, b) => rank(a) - rank(b) || Number(b.lastSeenAt || 0) - Number(a.lastSeenAt || 0));
    return list;
  }

  async function inspectRecovery(targetId: string): Promise<LedgerRecoveryInspection | null> {
    return inspectStorage(targetId, 'index');
  }

  async function exportRecovery(targetId: string): Promise<WorkbookJson | null> {
    if (!isSafeStorageId(targetId)) return null;
    const probe = makeStore(targetId);
    const loaded = await probe.load();
    if (probe.lastLoadError() || !loaded) { probe.destroy(); return null; }
    const b = createBook(loaded.snapshot);
    replayEntries(b, loaded.entries);
    return projectWorkbook(b);
  }

  async function rebindStorage(targetId: string): Promise<{ ok: boolean; error?: string; metaWritten?: boolean }> {
    if (!isSafeStorageId(targetId)) return { ok: false, error: 'storageId 不安全' };
    const target = makeStore(targetId);
    const loaded = await target.load();
    const err = target.lastLoadError();
    if (err) { target.destroy(); return { ok: false, error: err }; }
    if (!loaded) { target.destroy(); return { ok: false, error: '该 storageId 没有可用的账本文件（可能已被清理）' }; }
    await closeStore();
    storageId = targetId;
    store = target;
    seq = 0;
    loadBlocked = null;
    recoveryNeededReason = null;
    for (const e of loaded.entries) if (e.seq > seq) seq = e.seq;
    if (loaded.seq > seq) seq = loaded.seq;
    replayFromSnapshot(loaded.snapshot, loaded.entries, true);
    const ctx = liveContext();
    const chatKey = String(ctx?.chatKey || '').trim();
    const liveOwner = owner || (ctx
      ? inferOwner({ characterId: ctx.characterId, characterIndex: ctx.characterIndex, groupName: ctx.groupName, chatKey })
      : null);
    let metaWritten = false;
    if (liveOwner && chatKey) {
      const linkWrite = await writeChatLink(deps.files, liveOwner, { storageId: targetId, updatedAt: now() });
      if (!linkWrite.ok) report({ level: 'warn', source: '存储', message: `恢复链接写入失败：${linkWrite.error || '未知原因'}` });
      const curMeta = readLiveMeta();
      metaWritten = await writeLiveMeta(
        { storageId: targetId, createdAt: curMeta?.createdAt || now(), chatKey },
        curMeta?.storageId ?? null,
      );
      if (!metaWritten) report({ level: 'warn', source: '存储', message: '恢复后身份写入未确认（链接文件已尝试写入；下次打开仍可找回）' });
    }
    checkAnchorHealth();
    bumpRevision();
    notifyUpdate();
    report({ level: 'info', source: '存储', message: `已手动重绑台账（${String(targetId).slice(0, 12)}…）` });
    return { ok: true, metaWritten };
  }

  async function startFreshLedger(): Promise<{ ok: boolean; storageId?: string; error?: string }> {
    const ctx = liveContext();
    const chatKey = String(ctx?.chatKey || '').trim();
    const liveOwner = owner || (ctx
      ? inferOwner({ characterId: ctx.characterId, characterIndex: ctx.characterIndex, groupName: ctx.groupName, chatKey })
      : null);
    if (!ctx || !chatKey || !liveOwner) return { ok: false, error: '当前聊天身份未就绪（先等聊天加载完成）' };
    const newId = makeStorageId();
    await closeStore();
    storageId = newId;
    store = makeStore(newId);
    book = null;
    visible = [];
    seq = 0;
    loadBlocked = null;
    recoveryNeededReason = null;
    anchorHealth = { orphan: 0, total: 0, remappable: 0 };
    const linkWrite = await writeChatLink(deps.files, liveOwner, { storageId: newId, updatedAt: now() });
    if (!linkWrite.ok) report({ level: 'warn', source: '存储', message: `新建空账本链接写入失败：${linkWrite.error || '未知原因'}` });
    const metaOk = await writeLiveMeta({ storageId: newId, createdAt: now(), chatKey }, readLiveMeta()?.storageId ?? null);
    if (!metaOk) {
      enterReadOnly('新建空账本失败：聊天元数据写入未确认（旧账本文件保留，可稍后重试恢复）');
      return { ok: false, error: '聊天元数据写入失败' };
    }
    const seeded = await seedNow();
    if (!seeded) return { ok: false, error: '空账本快照写入失败（外部存储不可用）' };
    report({ level: 'info', source: '存储', message: `已新建空账本（${String(newId).slice(0, 12)}…；旧文件未删除，可在恢复页找回）` });
    return { ok: true, storageId: newId };
  }

  /** 锚点漂移自救：流水里的 aiFloor 序号仍然有效时，把失配条目的 anchor 重绑到当前该序号的楼层。
   *  dryRun 只统计；真正执行前调用方必须先导出备份。 */
  async function replayInvisibleEntries(opts: { dryRun?: boolean } = {}): Promise<{ ok: boolean; entries: number; total: number; error?: string }> {
    if (!store) return { ok: false, entries: 0, total: 0, error: '台账未就绪' };
    const ctx = liveContext();
    if (!ctx) return { ok: false, entries: 0, total: 0, error: '当前没有聊天上下文' };
    const order = currentFloorOrder(ctx.chat);
    if (order.length === 0) return { ok: false, entries: 0, total: 0, error: '当前聊天没有可用的 AI 楼层' };
    const ordinal = new Map<number, string>();
    for (let i = 0; i < order.length; i += 1) ordinal.set(i + 1, order[i]);
    const active = new Set(order);
    const all = store.peekEntries();
    let changed = 0;
    const next: LedgerEntry[] = all.map((e) => {
      if (active.has(e.at.anchor)) return e;
      const anchor = ordinal.get(e.at.aiFloor);
      if (!anchor) return e;
      changed += 1;
      return { ...e, at: { ...e.at, anchor } };
    });
    if (changed === 0 || opts.dryRun) return { ok: true, entries: changed, total: all.length };
    store.replaceEntries(next);
    const snapshot = store.peekSnapshot();
    if (snapshot) replayFromSnapshot(snapshot, next, true);
    recoveryNeededReason = null;
    bumpRevision();
    checkAnchorHealth();
    notifyUpdate();
    report({ level: 'info', source: '存储', message: `锚点漂移自救：重绑 ${changed} 条流水（共 ${all.length} 条）` });
    return { ok: true, entries: changed, total: all.length };
  }

  return {
    isReady: () => !!book,
    storageId: () => storageId,
    owner: () => owner,
    book: () => book,
    visibleEntries: () => visible,
    onChatChanged,
    // 屏障 flush：先等在途结转收尾（否则结转的半途状态可能被当成已落盘）。
    flush: async () => {
      while (folding) {
        try { await folding; } catch (_e) { /* 结转失败由 store 错误通道上报 */ }
      }
      return store ? store.flush() : true;
    },
    pending: () => (store ? store.pending() : false),
    commitOps,
    commitAppliedOps,
    pruneRemovedAnchors,
    syncFloors,
    pruneEntriesAtAnchors,
    countTableIncrements: (anchors, tableIds) => shrinkTableIncrements(anchors, tableIds, true),
    pruneTableIncrements: (anchors, tableIds) => shrinkTableIncrements(anchors, tableIds, false),
    onTableUpdate: (cb) => { updateCallbacks.add(cb); return () => { updateCallbacks.delete(cb); }; },
    notifyUpdate,
    onFillStart: (cb) => { fillStartCallbacks.add(cb); },
    notifyFillStart: () => { for (const cb of fillStartCallbacks) { try { cb(); } catch (_e) { /* 同上 */ } } },
    bakeStateAt,
    ensureSeeded,
    clearCurrentChatData,
    restoreInMemory,
    commitSnapshotReplace,
    foldIfNeeded,
    foldAll,
    revision: () => revision,
    getSchedule: () => (store ? store.getSchedule() : {}),
    patchSchedule: (schedule) => (store ? store.patchSchedule(schedule) : Promise.resolve(false)),
    isWriteProtected: () => !!loadBlocked,
    isChatSettled: () => chatSettled,
    markChatChanging,
    recoveryStatus: currentRecoveryStatus,
    recoveryCandidates,
    inspectRecovery,
    exportRecovery,
    rebindStorage,
    startFreshLedger,
    replayInvisibleEntries,
    __store: () => store,
  };
}
