// ===== 聊天身份：storageId 分配 / fork 侦测结转 / 全局索引 sl_index.json =====
//
// 身份契约（对齐主项目 chat-storage-identity 纪律，台账独立命名空间）：
// - chat metadata `seseLedger` 命名空间：{storageId, createdAt, chatKey, forkFrom?}；
// - 索引 sl_index.json：storageId → {ownerKind, ownerKey, chatKey, createdAt, lastSeenAt, forkFrom?}；
// - fork 判定：
//   ① ownerKey 不同（换角色卡/换群）＝ fork；
//   ② ownerKey 相同但 chatKey 变：先看「旧聊天文件是否还存在」——
//      仍存在＝复制聊天（fork：新 storageId + 从父结转）；已不存在＝改名（沿用 storageId）；
//      查不到（宿主无接口/网络失败）＝保守按 fork（宁可多复制一次，也不能父子共用一本账）。
//   **chatKey 必须写进 meta**：ST 的 fork/复制聊天会把整份 chat_metadata 复制过去，
//   只看 ownerKey 无法区分「改名」和「复制」——这正是上线前审计 A3 的根因。
// - 全局索引读取失败（A2）：有 meta 时沿用聊天内 storageId、**不写索引**；无 meta 时进入只读，
//   绝不用 `{}` 覆盖原索引。
// - 链接文件（A9 兜底）：`sl_link_<hash>.json` 是 chat_metadata 之外的**第二份指针**。
//   元数据保存可能被宿主静默吞错（ST 的 saveMetadata=saveChatConditional），链接文件让下次打开
//   仍能自动找回 storageId；它也是 fork 中断后的续传锚（带 forkFrom）。

import { sha256Hex } from '../../unified-statusbar/core/external-storage-codec';

export const SL_META_NAMESPACE = 'seseLedger';

export interface LedgerChatMeta {
  storageId: string;
  createdAt: number;
  forkFrom?: string;
  /** 元数据所属聊天文件名；fork 会整份复制 meta，不一致即视为复制聊天而非改名。 */
  chatKey?: string;
}

export interface SlChatOwner {
  kind: 'character' | 'group';
  /** character=角色卡头像标识；group 恒 'group'。 */
  ownerKey: string;
  /** 旧版登记别名（历史实现曾把 characterId 数字下标当 ownerKey）。只用于匹配，写新记录一律用 ownerKey。 */
  aliases?: string[];
  /** 聊天文件名（区分同卡不同聊天/fork）。 */
  chatKey: string;
}

export interface HostContext {
  chat: any[];
  chatMetadata: Record<string, any>;
  saveChatMetadata(): Promise<void> | void;
  /** 当前聊天文件名（用于写后校验：保存期间宿主若切了聊天，拒绝把元数据当成功）。 */
  chatKey?: string;
}

export function makeStorageId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch (_e) { /* 降级手工 v4 */ }
  const bytes = new Uint8Array(16);
  (typeof crypto !== 'undefined' && crypto.getRandomValues ? crypto.getRandomValues(bytes) : bytes.forEach((_, i) => { bytes[i] = Math.floor(Math.random() * 256); }));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** 从宿主推断聊天 owner（角色卡优先；群聊走 group 包名）。
 *  `characterId` 必须是**头像标识**（production 传 characters[idx].avatar）；
 *  `characterIndex` 是历史版本写进索引的数字下标，只作为匹配别名，避免卡序变化被判成 fork。 */
export function inferOwner(host: { characterId?: any; characterIndex?: any; groupName?: any; chatKey: string }): SlChatOwner {
  if (host.groupName !== undefined && host.groupName !== null && String(host.groupName) !== '') {
    return { kind: 'group', ownerKey: `group:${host.groupName}`, chatKey: host.chatKey };
  }
  const avatar = String(host.characterId ?? '').trim();
  const legacy = String(host.characterIndex ?? '').trim();
  const aliases = legacy && legacy !== avatar ? [legacy] : undefined;
  return { kind: 'character', ownerKey: avatar || 'unknown', chatKey: host.chatKey, ...(aliases ? { aliases } : {}) };
}

function ownerKeysOf(owner: SlChatOwner): Set<string> {
  const keys = new Set<string>();
  keys.add(String(owner.ownerKey || ''));
  for (const alias of owner.aliases || []) if (alias) keys.add(String(alias));
  return keys;
}

/** storageId 安全校验（只允许 UUID/文件名安全字符，恢复入口不接受用户拼路径）。 */
export function isSafeStorageId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,239}$/.test(value) && !value.includes('..');
}

export type IdentityResolution =
  | { action: 'fresh'; storageId: string; meta: LedgerChatMeta; indexDegraded?: string }
  | { action: 'reuse'; storageId: string; meta: LedgerChatMeta; renamed: boolean; indexDegraded?: string }
  | { action: 'fork'; storageId: string; meta: LedgerChatMeta; parentStorageId: string; indexDegraded?: string }
  | { action: 'read-only'; error: string };

export interface IndexFileStore {
  readIndex(): Promise<{ chats: Record<string, any> } | null>;
  writeIndex(index: { chats: Record<string, any> }): Promise<void>;
}

/** 链接文件（chat_metadata 之外的第二份指针；只存身份，不存账本内容）。 */
export interface LedgerChatLink {
  schemaVersion: 1;
  storageId: string;
  ownerKind: 'character' | 'group';
  ownerKey: string;
  chatKey: string;
  /** fork 中断续传用：目标 id 未写完时，下次从这里继续复制。 */
  forkFrom?: string;
  updatedAt: number;
}

/** 链接文件读写只需要这两个能力（与 LedgerFilesLike 结构兼容，避免循环依赖）。 */
export interface LinkFileStore {
  readJson<T>(filename: string): Promise<{ found: boolean; value?: T; error?: string }>;
  uploadJson(filename: string, value: unknown): Promise<{ ok: boolean; error?: string }>;
}

/** 链接文件名：owner + chatKey 确定，元数据丢了也能算出来。 */
export function linkFileName(owner: SlChatOwner): string {
  const identity = ['link', owner.kind, owner.ownerKey, owner.chatKey].join('\u0000');
  return `sl_link_${sha256Hex(identity).slice(0, 24)}.json`;
}

/** 读链接文件。404=没有；带 error=读取不确定（调用方按不可用处理，不覆盖）。 */
export async function readChatLink(
  files: LinkFileStore,
  owner: SlChatOwner,
): Promise<{ link: LedgerChatLink | null; error?: string }> {
  const name = linkFileName(owner);
  try {
    const r = await files.readJson<LedgerChatLink>(name);
    if (r.error) return { link: null, error: r.error };
    const link = r.found ? r.value : null;
    if (!link || typeof link !== 'object' || typeof link.storageId !== 'string' || !link.storageId) return { link: null };
    // 同名 hash 理论上已经绑定了身份；仍校验 chatKey，防止手工复制/损坏串档。
    if (link.chatKey && String(link.chatKey) !== String(owner.chatKey)) return { link: null };
    return { link };
  } catch (e) {
    return { link: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 写链接文件（best-effort：失败只上报，不阻断 meta 写入；索引仍是第二层兜底）。 */
export async function writeChatLink(
  files: LinkFileStore,
  owner: SlChatOwner,
  link: { storageId: string; forkFrom?: string; updatedAt?: number },
): Promise<{ ok: boolean; error?: string }> {
  if (!isSafeStorageId(link.storageId)) return { ok: false, error: 'storageId 不安全' };
  const payload: LedgerChatLink = {
    schemaVersion: 1,
    storageId: link.storageId,
    ownerKind: owner.kind,
    ownerKey: owner.ownerKey,
    chatKey: owner.chatKey,
    ...(link.forkFrom ? { forkFrom: link.forkFrom } : {}),
    updatedAt: Number(link.updatedAt || Date.now()),
  };
  try {
    const r = await files.uploadJson(linkFileName(owner), payload);
    return r.ok ? { ok: true } : { ok: false, error: r.error || '上传失败' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 索引里同一 owner 的候选（含历史数字下标别名 / 同 chatKey 强匹配），最近使用在前。 */
export function listIndexCandidates(
  index: { chats: Record<string, any> } | null,
  owner: SlChatOwner,
): Array<{ storageId: string; entry: Record<string, any> }> {
  if (!index?.chats) return [];
  const keys = ownerKeysOf(owner);
  const out: Array<{ storageId: string; entry: Record<string, any> }> = [];
  for (const [storageId, entry] of Object.entries(index.chats)) {
    if (!entry || typeof entry !== 'object') continue;
    const ownerHit = keys.has(String((entry as any).ownerKey || ''));
    const chatHit = !!owner.chatKey && String((entry as any).chatKey || '') === String(owner.chatKey);
    if (ownerHit || chatHit) out.push({ storageId, entry: entry as Record<string, any> });
  }
  out.sort((a, b) => Number(b.entry.lastSeenAt || 0) - Number(a.entry.lastSeenAt || 0));
  return out;
}

/** 未写完的 fork 目标（同 owner/同 chatKey/同父）：重试时复用它，避免每次刷新都复制一整本。 */
export function findPendingFork(
  index: { chats: Record<string, any> } | null,
  owner: SlChatOwner,
  parentStorageId: string,
): { storageId: string; entry: Record<string, any> } | null {
  if (!index?.chats || !parentStorageId) return null;
  const keys = ownerKeysOf(owner);
  for (const [storageId, entry] of Object.entries(index.chats)) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, any>;
    if (String(e.forkFrom || '') !== String(parentStorageId)) continue;
    if (String(e.chatKey || '') !== String(owner.chatKey)) continue;
    if (!keys.has(String(e.ownerKey || ''))) continue;
    return { storageId, entry: e };
  }
  return null;
}

export interface ResolveIdentityOptions {
  /** 旧聊天文件是否仍存在：true=存在（⇒ fork）/ false=不存在（⇒ 改名）/ null=查不到（保守按 fork）。 */
  previousChatExists?(chatKey: string): Promise<boolean | null>;
}

function withChatKey(meta: LedgerChatMeta, chatKey: string): LedgerChatMeta {
  return { ...meta, chatKey };
}

/** 索引写失败不阻断本次身份解析（索引只是发现面；下次打开会补登记）。
 *  写前重新读一次做**合并**：另一标签页/实例刚登记的 storageId 不能被本次快照整份覆盖。
 *  只让本次 touched 的 storageId 以新值为准，其余条目保留磁盘上的最新版本。 */
async function tryWriteIndex(
  index: IndexFileStore,
  desired: { chats: Record<string, any> },
  touched: string[],
): Promise<string | undefined> {
  try {
    let payload: { chats: Record<string, any> } = desired;
    try {
      const current = await index.readIndex();
      if (current?.chats) {
        const chats: Record<string, any> = { ...current.chats };
        for (const id of touched) if (desired.chats[id]) chats[id] = desired.chats[id];
        for (const [id, entry] of Object.entries(desired.chats)) if (!chats[id]) chats[id] = entry;
        payload = { ...(current as any), chats };
      }
    } catch (_e) {
      // 再读失败（网络抖动）：按本次快照写，与旧行为一致；下次打开会补登记。
    }
    await index.writeIndex(payload);
    return undefined;
  } catch (e) {
    return `全局索引写入失败：${e instanceof Error ? e.message : String(e)}（本次继续，索引下次补登记）`;
  }
}

/** lastSeenAt 落盘节流：正常打开已有聊天不再每次都写 sl_index.json。 */
const INDEX_TOUCH_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * 解析当前聊天的台账身份（不写盘；持久化由调用方按结果执行）。
 * @param meta chat metadata 里的现有台账元数据（无则 null）
 */
export async function resolveIdentity(
  meta: LedgerChatMeta | null,
  owner: SlChatOwner,
  index: IndexFileStore,
  now: () => number = Date.now,
  opts: ResolveIdentityOptions = {},
): Promise<IdentityResolution> {
  let idx: { chats: Record<string, any> } | null;
  try {
    idx = await index.readIndex();
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    // 读取不确定：有聊天内记录时优先沿用；但若 meta 记录的 chatKey 与当前不一致（复制聊天），
    // 无法确认旧文件是否仍在 ⇒ 保守按 fork（新账本 + 父结转），绝不共用一本账（A3）。
    if (meta && typeof meta.storageId === 'string' && meta.storageId) {
      const metaChatKey = String(meta.chatKey || '');
      if (metaChatKey && metaChatKey !== owner.chatKey) {
        const storageId = makeStorageId();
        const forkMeta: LedgerChatMeta = withChatKey({ storageId, createdAt: now(), forkFrom: meta.storageId }, owner.chatKey);
        return {
          action: 'fork',
          storageId,
          meta: forkMeta,
          parentStorageId: meta.storageId,
          indexDegraded: `全局索引读取失败：${reason}；无法确认旧聊天是否仍在，已保守按复制聊天处理（不更新索引）`,
        };
      }
      return {
        action: 'reuse',
        storageId: meta.storageId,
        meta: withChatKey(meta, owner.chatKey),
        renamed: false,
        indexDegraded: `全局索引读取失败：${reason}；本次沿用聊天内记录，不更新索引`,
      };
    }
    return { action: 'read-only', error: `全局索引读取失败：${reason}；当前聊天没有台账记录，为避免误建账本次不建账` };
  }
  const db = idx || { chats: {} };
  if (meta && typeof meta.storageId === 'string' && meta.storageId) {
    const entry = db.chats[meta.storageId];
    if (!entry) {
      // meta 有而索引丢（索引文件被清）→ 补登记，沿用身份
      db.chats[meta.storageId] = { ownerKind: owner.kind, ownerKey: owner.ownerKey, chatKey: owner.chatKey, createdAt: meta.createdAt, lastSeenAt: now() };
      const indexDegraded = await tryWriteIndex(index, db, [meta.storageId]);
      return { action: 'reuse', storageId: meta.storageId, meta: withChatKey(meta, owner.chatKey), renamed: false, ...(indexDegraded ? { indexDegraded } : {}) };
    }
    // 头像 key 完全一致＝同一 owner；历史数字下标别名只在 chatKey 也一致时认（下标可能被别的卡复用，
    // 不能光凭下标把另一张卡的账本当成同一个 owner；改名场景走保守 fork，数据仍会结转）。
    const canonicalSame = String(entry.ownerKey) === owner.ownerKey;
    const aliasSame = !canonicalSame
      && ownerKeysOf(owner).has(String(entry.ownerKey))
      && String(entry.chatKey || '') === String(owner.chatKey);
    const sameOwner = canonicalSame || aliasSame;
    // 历史数字下标登记：匹配成功后就地迁移成头像 key（下次不必再靠别名）。
    const ownerMigrated = sameOwner && String(entry.ownerKey) !== owner.ownerKey;
    // 旧聊天文件名：优先 meta 自己记的；老 meta 没有就用索引里最后一次登记的名字。
    const oldChatKey = String(meta.chatKey || entry.chatKey || '');
    const keyChanged = !!oldChatKey && oldChatKey !== owner.chatKey;
    let fork = !sameOwner;
    if (sameOwner && keyChanged && opts.previousChatExists) {
      let stillExists: boolean | null = null;
      try { stillExists = await opts.previousChatExists(oldChatKey); } catch (_e) { stillExists = null; }
      // 仍存在＝复制聊天；已不存在＝改名；查不到＝保守按复制处理（防父子共用）。
      fork = stillExists !== false;
    }
    if (fork) {
      // fork / 复制聊天：新身份 + 从父结转（父数据不动）。
      // 若索引里已有同 chatKey + 同父的未完成 fork（上次复制中途刷新），复用它：重试不会每次新开一个 id。
      const pending = findPendingFork(db, owner, meta.storageId);
      const storageId = pending ? pending.storageId : makeStorageId();
      const forkMeta: LedgerChatMeta = withChatKey({ storageId, createdAt: pending ? Number(pending.entry.createdAt || now()) : now(), forkFrom: meta.storageId }, owner.chatKey);
      db.chats[storageId] = {
        ...(pending ? pending.entry : {}),
        ownerKind: owner.kind,
        ownerKey: owner.ownerKey,
        chatKey: owner.chatKey,
        createdAt: forkMeta.createdAt,
        lastSeenAt: now(),
        forkFrom: meta.storageId,
      };
      const indexDegraded = await tryWriteIndex(index, db, [storageId]);
      return { action: 'fork', storageId, meta: forkMeta, parentStorageId: meta.storageId, ...(indexDegraded ? { indexDegraded } : {}) };
    }
    // 同卡同聊天 / 改名：沿用 storageId。
    // 正常打开（chatKey/owner 都没变、lastSeenAt 还在节流窗内）不写索引——避免每次切聊天都整份写一个文件。
    const lastSeen = Number(entry.lastSeenAt || 0);
    const shouldTouch = keyChanged || ownerMigrated || !lastSeen || (now() - lastSeen >= INDEX_TOUCH_INTERVAL_MS);
    if (ownerMigrated) entry.ownerKey = owner.ownerKey;
    if (keyChanged) entry.chatKey = owner.chatKey;
    let indexDegraded: string | undefined;
    if (shouldTouch) {
      entry.lastSeenAt = now();
      indexDegraded = await tryWriteIndex(index, db, [meta.storageId]);
    }
    return { action: 'reuse', storageId: meta.storageId, meta: withChatKey(meta, owner.chatKey), renamed: keyChanged, ...(indexDegraded ? { indexDegraded } : {}) };
  }
  // 全新聊天
  const storageId = makeStorageId();
  const freshMeta: LedgerChatMeta = withChatKey({ storageId, createdAt: now() }, owner.chatKey);
  db.chats[storageId] = { ownerKind: owner.kind, ownerKey: owner.ownerKey, chatKey: owner.chatKey, createdAt: freshMeta.createdAt, lastSeenAt: now() };
  const indexDegraded = await tryWriteIndex(index, db, [storageId]);
  return { action: 'fresh', storageId, meta: freshMeta, ...(indexDegraded ? { indexDegraded } : {}) };
}

/** 读 chat metadata 命名空间。 */
export function readChatMeta(host: HostContext): LedgerChatMeta | null {
  const ns = host.chatMetadata?.[SL_META_NAMESPACE];
  return ns && typeof ns === 'object' && typeof ns.storageId === 'string' && ns.storageId ? (ns as LedgerChatMeta) : null;
}

export interface WriteChatMetaOptions {
  /** 写入前要求当前聊天仍是这个 chatKey（防止慢请求把旧聊天的身份写进新聊天）。 */
  expectedChatKey?: string;
  /** null=要求当前没有台账 meta；string=要求当前 meta 仍是这个 storageId；缺省=不校验。 */
  expectedStorageId?: string | null;
}

/** 写 chat metadata 命名空间。
 *  - 写前按 expectedChatKey/expectedStorageId 做一次**读校验**（拒绝把旧聊天的身份写进新聊天）；
 *  - 写后**现取**当前对象回读：保存期间聊天被替换（getContext 的 chatMetadata 是值快照）时，
 *    不再把旧对象上的写入当成成功；检测到替换会向当前对象补写一次；
 *  - 仍无法确认时返回 false（调用方进入只读/恢复态），绝不谎报成功。
 *  注意：宿主 saveMetadata 可能吞掉服务端错误，所以链接文件是持久化的第二道保险。 */
export async function writeChatMeta(
  host: HostContext,
  meta: LedgerChatMeta,
  opts: WriteChatMetaOptions = {},
): Promise<boolean> {
  try {
    const beforeKey = String(host.chatKey || '');
    if (opts.expectedChatKey && beforeKey && beforeKey !== String(opts.expectedChatKey)) return false;
    if (meta.chatKey && beforeKey && beforeKey !== String(meta.chatKey)) return false;

    const beforeMeta = readChatMeta(host);
    if (opts.expectedStorageId === null) {
      if (beforeMeta) return false;
    } else if (typeof opts.expectedStorageId === 'string') {
      if (!beforeMeta || beforeMeta.storageId !== opts.expectedStorageId) return false;
    }

    // 记下当前对象：保存期间若宿主整体替换 chat_metadata，这个引用会变成旧对象。
    const writtenTo = host.chatMetadata;
    writtenTo[SL_META_NAMESPACE] = { ...meta };
    await host.saveChatMetadata();

    // 现取当前对象（production host 的 getter 每次都重新 getContext）。
    const liveObj = host.chatMetadata;
    if (liveObj !== writtenTo) {
      const liveMeta = readChatMeta(host);
      if (!liveMeta || liveMeta.storageId !== meta.storageId) {
        // 这次写入落在了被替换的旧对象上：向当前对象补写一次。
        liveObj[SL_META_NAMESPACE] = { ...meta };
        await host.saveChatMetadata();
      }
    }

    const back = readChatMeta(host);
    if (!back || back.storageId !== meta.storageId) return false;
    if (meta.chatKey && back.chatKey && String(back.chatKey) !== String(meta.chatKey)) return false;
    const finalKey = String(host.chatKey || '');
    if (finalKey && meta.chatKey && finalKey !== String(meta.chatKey)) return false;
    return true;
  } catch (_e) {
    return false;
  }
}

/** 台账外部存储文件名（SAFE_FILENAME_RE 兼容：UUID 含连字符合法）。 */
export function bookFileName(storageId: string): string {
  return `sl_${storageId}_book.json`;
}
export function entriesFileName(storageId: string): string {
  return `sl_${storageId}_entries.json`;
}
export const INDEX_FILE_NAME = 'sl_index.json';
