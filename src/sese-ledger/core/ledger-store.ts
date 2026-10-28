// ===== 账本外部存储：write-behind 落盘 + 屏障 flush + 结转 =====
//
// 每聊天两文件（/user/files/，复用主项目 server-file-store 通道）：
//   sl_<storageId>_book.json     快照（全库当前折叠态 + 楼层锚 + seq）
//   sl_<storageId>_entries.json  记账条目（追加式）
// 纪律（规格 §4）：内存即时应用 + 回调即时通知；300ms 防抖追加落盘；**写路径不碰聊天文件**；
// 屏障 flush = MESSAGE_RECEIVED 入栈前 / CHAT_CHANGED / pagehide；结转只升序（V3.629 教训）；
// 结转把全部条目（含失联锚点，升序）折进快照——回退深度以结转点为界（窗口外语义）。
//
// 读失败三态（上线前审计 A1/A10）：readJson 的 `found:false` 分「404 干净缺失」与「带 error 的读取不确定」。
// 后者一律返回 null + lastLoadError() 文案，由 runtime 进入只读保护——**绝不把读失败当空账本重建**。
//
// 写入串行化（A6/A7）：所有 uploadJson 进同一条 promise 链，旧写不可能后完成盖掉新写；
// 脏标记按版本号清理——上传期间有新入口写（append/replace/新快照）时保留脏标记，下次继续写。
// 真卸载用 close()：先落盘再封存；destroy() 只给测试/强制路径（丢弃未写内容）。

import type { BookFile, EntriesFile, LedgerEntry, WorkbookJson } from './types';
import { bookFileName, entriesFileName } from './identity';

export const ENTRY_DEBOUNCE_MS = 300;
/** 结转后保留在流水里的条目数（可回退窗口；也是加载时的重放成本上界）。 */
export const FOLD_KEEP = 200;
/** 触发结转的条目数：保留窗口填满后再攒满一个窗口才折一次（400 → 折 200 留 200）。 */
export const FOLD_TRIGGER = FOLD_KEEP * 2;

export interface LedgerFilesLike {
  readJson<T>(filename: string): Promise<{ found: boolean; value?: T; error?: string }>;
  uploadJson(filename: string, value: unknown): Promise<{ ok: boolean; error?: string }>;
  /** 删除用户文件（工作台「清除当前聊天数据」用；未提供时该功能只复位内存与投影，文件留给下次建账覆盖）。 */
  delete?(path: string): Promise<{ ok: boolean; error?: string }>;
}

export interface LoadedLedger {
  snapshot: WorkbookJson;
  entries: LedgerEntry[];
  anchor: string;
  aiFloor: number;
  seq: number;
}

export interface LedgerStore {
  load(): Promise<LoadedLedger | null>;
  /** 最近一次 load 的失败原因：404 干净缺失 → null；读取不确定 / 文件损坏 → 文案（runtime 据此进只读）。 */
  lastLoadError(): string | null;
  /** 立即写快照文件（结转/初始建账/结构变更）。 */
  persistSnapshot(snapshot: WorkbookJson, anchor: string, aiFloor: number, seq: number): Promise<boolean>;
  /** 追加条目并按防抖计划落盘。 */
  appendEntry(entry: LedgerEntry): void;
  /** 整体替换条目（删楼/swipe 物理裁剪路径）。 */
  replaceEntries(entries: LedgerEntry[]): void;
  /** 屏障：清定时器立即落盘全部脏文件（失败保脏，下次再试）；在途 flush 直接复用同一 promise。 */
  flush(): Promise<boolean>;
  /** 是否有未落盘内容。 */
  pending(): boolean;
  /** 全量条目只读视图（运行时重放/结转/烘焙用）。 */
  peekEntries(): LedgerEntry[];
  /** 当前快照只读视图。 */
  peekSnapshot(): WorkbookJson | null;
  /** 快照折叠信息（时光机结转边界判定用）。 */
  peekFoldInfo(): { anchor: string; aiFloor: number; seq: number } | null;
  /** 调度状态读取（随 book 文件持久化）。 */
  getSchedule(): Record<string, number>;
  /** 调度状态读写（随 book 文件持久化）。 */
  patchSchedule(schedule: Record<string, number>): Promise<boolean>;
  /** 真卸载：先落盘（两轮收尾）再封存，阻断后续写入。 */
  close(): Promise<void>;
  /** 就地封存：清防抖计时器并阻断后续一切写入（测试/强制路径；不保证未写内容落盘）。 */
  destroy(): void;
  /** 测试钩子：推进防抖时钟。 */
  __tickDebounce(): void;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function createLedgerStore(deps: {
  files: LedgerFilesLike;
  storageId: string;
  now?: () => number;
  debounceMs?: number;
  /** 落盘失败上报（工作台「日志」页；不传＝保持旧行为静默保脏重试）。 */
  onError?(message: string): void;
}): LedgerStore {
  const { files, storageId } = deps;
  const now = deps.now || (() => Date.now());
  const debounceMs = deps.debounceMs ?? ENTRY_DEBOUNCE_MS;
  let entries: LedgerEntry[] = [];
  let snapshotInfo: { snapshot: WorkbookJson; anchor: string; aiFloor: number; seq: number; schedule?: Record<string, number> } | null = null;
  let entriesDirty = false;
  let bookDirty = false;
  /** 内容版本号：上传期间有新写入时，版本不等 ⇒ 不清脏标记（A7）。 */
  let entriesVersion = 0;
  let bookVersion = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timerFire: (() => void) | null = null;
  let flushInFlight: Promise<boolean> | null = null;
  /** false = 已封存：计时器清除、所有写路径关闭（卸载后的旧实例不得再动文件）。 */
  let alive = true;
  /** 最近一次 load 的失败原因（区分 404 干净缺失与读取不确定）。 */
  let lastLoadFailure: string | null = null;
  /** 所有上传串成一条链（A6）：保证发起顺序 = 落盘顺序。 */
  let writeChain: Promise<void> = Promise.resolve();

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = writeChain.then(task, task);
    writeChain = run.then(() => undefined, () => undefined);
    return run;
  }

  /** 落盘失败上报（脏标记保留 ⇒ 下次 flush 自动重试；只报不抛）。 */
  function reportWriteFailure(filename: string, error?: unknown): void {
    const detail = String(error ?? '').trim();
    try { deps.onError?.(`落盘失败：${filename} 上传失败${detail ? `（${detail}）` : ''}；内容保留在内存，下次写盘自动重试`); } catch (_e) { /* 上报失败不影响落盘链路 */ }
  }

  async function load(): Promise<LoadedLedger | null> {
    lastLoadFailure = null;
    const [bookRes, entriesRes] = await Promise.all([
      files.readJson<BookFile>(bookFileName(storageId)),
      files.readJson<EntriesFile>(entriesFileName(storageId)),
    ]);
    // 读取不确定（网络/500/解析失败）——即使总账缺失，流水读取失败也不能当空处理（防覆盖）。
    if (bookRes.error) { lastLoadFailure = `读取账本快照失败：${bookRes.error}`; return null; }
    if (entriesRes.error) { lastLoadFailure = `读取改动流水失败：${entriesRes.error}`; return null; }
    const rawEntries = entriesRes.found ? (entriesRes.value as EntriesFile | undefined)?.entries : [];
    if (entriesRes.found && !Array.isArray(rawEntries)) { lastLoadFailure = '改动流水文件格式损坏（entries 不是数组）'; return null; }
    const loadedEntries = Array.isArray(rawEntries) ? rawEntries : [];
    // 404 干净缺失：没有总账。若仍有非空流水 = 文件状态不一致（总账被删/串档），按读取不确定处理。
    if (!bookRes.found || !bookRes.value) {
      if (loadedEntries.length > 0) { lastLoadFailure = '账本快照缺失但仍有未结转的改动流水（文件状态不一致）'; return null; }
      return null;
    }
    const bookFile = bookRes.value as BookFile;
    if (!isPlainObject(bookFile) || !isPlainObject(bookFile.snapshot)) {
      lastLoadFailure = '账本快照文件格式损坏（缺少 snapshot）';
      return null;
    }
    if (bookFile.storageId && String(bookFile.storageId) !== storageId) {
      lastLoadFailure = '账本快照文件与当前聊天身份不一致（可能被复制/串档）';
      return null;
    }
    entries = loadedEntries;
    snapshotInfo = {
      snapshot: bookFile.snapshot,
      anchor: String(bookFile.anchor || ''),
      aiFloor: Number(bookFile.aiFloor || 0),
      seq: Number(bookFile.seq || 0),
      schedule: bookFile.schedule && typeof bookFile.schedule === 'object' ? bookFile.schedule : {},
    };
    // 载入即视为与盘一致（后续 append 才置脏）
    entriesDirty = false;
    bookDirty = false;
    return {
      snapshot: bookFile.snapshot,
      entries: loadedEntries,
      anchor: snapshotInfo.anchor,
      aiFloor: snapshotInfo.aiFloor,
      seq: snapshotInfo.seq,
    };
  }

  /** 快照写入（入队；版本未变才清脏标记）。 */
  function queueWriteBook(): Promise<boolean> {
    return enqueue(async () => {
      if (!alive) return true;
      if (!snapshotInfo) return false;
      const version = bookVersion;
      const file: BookFile = {
        schemaVersion: 1,
        storageId,
        snapshot: snapshotInfo.snapshot,
        anchor: snapshotInfo.anchor,
        aiFloor: snapshotInfo.aiFloor,
        seq: snapshotInfo.seq,
        foldedAt: now(),
        schedule: snapshotInfo.schedule || {},
      };
      const r = await files.uploadJson(bookFileName(storageId), file);
      if (r.ok) {
        if (bookVersion === version) bookDirty = false;
      } else {
        reportWriteFailure(bookFileName(storageId), r.error);
      }
      return r.ok;
    });
  }

  /** 流水写入（入队；版本未变才清脏标记）。 */
  function queueWriteEntries(): Promise<boolean> {
    return enqueue(async () => {
      if (!alive) return true;
      const version = entriesVersion;
      const file: EntriesFile = { schemaVersion: 1, entries };
      const r = await files.uploadJson(entriesFileName(storageId), file);
      if (r.ok) {
        if (entriesVersion === version) entriesDirty = false;
      } else {
        reportWriteFailure(entriesFileName(storageId), r.error);
      }
      return r.ok;
    });
  }

  function schedule(): void {
    if (!alive) return;
    if (timer) clearTimeout(timer);
    timerFire = () => {
      timer = null;
      timerFire = null;
      void flush();
    };
    timer = setTimeout(timerFire, debounceMs);
  }

  async function flush(): Promise<boolean> {
    if (!alive) return true;
    if (timer) { clearTimeout(timer); timer = null; timerFire = null; }
    if (flushInFlight) return flushInFlight;
    if (!entriesDirty && !bookDirty) return true;
    const task = (async () => {
      let ok = true;
      if (bookDirty) ok = (await queueWriteBook()) && ok;
      if (entriesDirty) ok = (await queueWriteEntries()) && ok;
      return ok;
    })();
    let wrapped: Promise<boolean>;
    wrapped = task.finally(() => { if (flushInFlight === wrapped) flushInFlight = null; });
    flushInFlight = wrapped;
    return wrapped;
  }

  return {
    load,
    lastLoadError: () => lastLoadFailure,
    async persistSnapshot(snapshot, anchor, aiFloor, seq) {
      if (!alive) return false;
      snapshotInfo = { snapshot, anchor, aiFloor, seq, schedule: snapshotInfo?.schedule || {} };
      bookVersion += 1;
      bookDirty = true;
      return queueWriteBook();
    },
    appendEntry(entry) {
      if (!alive) return;
      entries.push(entry);
      entriesVersion += 1;
      entriesDirty = true;
      schedule();
    },
    replaceEntries(next) {
      if (!alive) return;
      entries = next;
      entriesVersion += 1;
      entriesDirty = true;
      schedule();
    },
    flush,
    pending: () => entriesDirty || bookDirty || !!timer,
    peekEntries: () => entries,
    peekSnapshot: () => (snapshotInfo ? snapshotInfo.snapshot : null),
    peekFoldInfo: () => (snapshotInfo ? { anchor: snapshotInfo.anchor, aiFloor: snapshotInfo.aiFloor, seq: snapshotInfo.seq } : null),
    getSchedule: () => (snapshotInfo?.schedule ? { ...snapshotInfo.schedule } : {}),
    async patchSchedule(scheduleTable) {
      if (!alive) return false;
      if (!snapshotInfo) return false;
      snapshotInfo = { ...snapshotInfo, schedule: { ...scheduleTable } };
      bookVersion += 1;
      bookDirty = true;
      return queueWriteBook();
    },
    async close() {
      if (!alive) return;
      // 两轮收尾：第一轮写当前脏数据；若期间又有 append（微任务/在途回调），第二轮补写。
      for (let i = 0; i < 3 && (entriesDirty || bookDirty); i += 1) {
        try { await flush(); } catch (_e) { /* best-effort */ }
      }
      alive = false;
      if (timer) { clearTimeout(timer); timer = null; timerFire = null; }
      if (entriesDirty || bookDirty) {
        // 收尾仍脏：只上报（不再走 reportWriteFailure，保持「两个写文件路径」各自上报的口径）。
        try { deps.onError?.('卸载前仍有未落盘内容（外部存储可能暂时不可用）；下次打开会自动重试'); } catch (_e) { /* ignore */ }
      }
      entriesDirty = false;
      bookDirty = false;
      try { await writeChain; } catch (_e) { /* 已入队写入尽力完成 */ }
    },
    destroy() {
      alive = false;
      if (timer) { clearTimeout(timer); timer = null; timerFire = null; }
      entriesDirty = false;
      bookDirty = false;
    },
    __tickDebounce() {
      if (timer && timerFire) {
        clearTimeout(timer);
        const fire = timerFire;
        timer = null;
        timerFire = null;
        fire();
      }
    },
  };
}

/** 结转：把一批条目（升序前缀）折进快照。调用方传入「旧快照 + 这批前缀重放完成」的投影，
 *  **不能传当前完整账本**（那会包含保留在流水里的后续条目，重载时二次重放）。 */
export function foldSnapshot(
  currentProjection: WorkbookJson,
  entries: LedgerEntry[],
): { snapshot: WorkbookJson; anchor: string; aiFloor: number; seq: number } {
  let anchor = '';
  let aiFloor = 0;
  let seq = 0;
  for (const e of entries) {
    if (e.seq > seq) seq = e.seq;
    if (e.at.aiFloor >= aiFloor) { aiFloor = e.at.aiFloor; anchor = e.at.anchor; }
  }
  return { snapshot: currentProjection, anchor, aiFloor, seq };
}

/** 屏障 flush + 重试包装（pagehide 等尽力路径）。 */
export async function flushBestEffort(store: LedgerStore): Promise<void> {
  try { await store.flush(); } catch (_e) { /* 屏障尽力 */ }
}
