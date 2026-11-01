import { resolveTable, type BookModel } from '../sese-ledger/core/book';
import type { LedgerRuntime } from '../sese-ledger/core/runtime';
import { isAnchorCandidate, writeScope, activeAnchors } from '../sese-ledger/core/floor-scope';
import { sha256Hex } from '../unified-statusbar/core/external-storage-codec';
import { VISUAL_GROUPS, ITEM_STATES, isCurrentField, type VisualArchive, type VisualRecord, type VisualEdit } from './contract';
import { TABLES } from './schema';
import { actorKeyForName, fieldKey, tableRows, upsertRowOps, visualSchemaErrors, validateVisualChanges, visualFillCoupling } from './domain';

const SOURCE = { manual: '手动', story: '剧情', design: '设计' } as const;
const text = (v: any, n = 1600): string => typeof v === 'string' ? v.trim().slice(0, n) : '';
function fieldRows(book: BookModel): Array<Record<string, string>> { return [...tableRows(resolveTable(book, TABLES.fixed)), ...tableRows(resolveTable(book, TABLES.current))]; }
function setting(book: BookModel, actor: string, name: string): Record<string, string> {
  return tableRows(resolveTable(book, TABLES.settings)).find(r => r['角色键'] === actor)
    || { 角色键: actor, 姓名: name, 启用: '是', 设计风格: '通用', 衣柜接管: '否', 衣柜配置: '', 旧档案导入: '' };
}
function blank(actorKey: string, name: string, revision: number): VisualRecord {
  return { actorKey, name, revision, enabled: true, style: 'universal', fields: {}, items: {} };
}
export function createVisualLedgerApi(runtime: LedgerRuntime, getContext: () => any) {
  function status() {
    const ctx = getContext(), book = runtime.book(), owner = runtime.owner(), chatKey = String(ctx?.chatId || ctx?.chat_metadata?.file_name || '');
    const errors = book ? visualSchemaErrors(book) : ['台账尚未就绪'];
    const metaId = ctx?.chatMetadata?.seseLedger?.storageId ?? ctx?.chat_metadata?.seseLedger?.storageId;
    const group = ctx?.groupId != null && String(ctx.groupId) !== '';
    const liveOwner = group ? `group:${ctx.groupId}` : ctx?.characters?.[Number(ctx?.characterId)]?.avatar || (typeof ctx?.characterId === 'string' && !/^\d+$/.test(ctx.characterId) ? ctx.characterId : '');
    const sameChat = !!chatKey && !!liveOwner && owner?.ownerKey === liveOwner && owner?.kind === (group ? 'group' : 'character') && owner?.chatKey === chatKey && (!metaId || metaId === runtime.storageId());
    const anchors = activeAnchors(ctx?.chat || []);
    const aligned = runtime.visibleEntries().every(entry => anchors.has(entry.at.anchor));
    if (!aligned) errors.push('台账与当前回复尚未对齐，请稍后重新打开外观详情');
    const ready = runtime.isReady() && runtime.isChatSettled() && sameChat && aligned && errors.length === 0;
    const history = (ctx?.chat || []).map((m: any) => [!!m.is_user, m.swipe_id || 0, Array.isArray(m.swipes) ? m.swipes[m.swipe_id || 0] : m.mes]);
    return { protocol: 1, ready, errors, chatKey, storageId: runtime.storageId(), revision: runtime.revision(), autoFillLinked: !!book && !!visualFillCoupling(book, runtime.getSchedule()), writeProtected: runtime.isWriteProtected() || runtime.recoveryStatus().needed,
      token: `${runtime.storageId()}|${runtime.revision()}|${sha256Hex(JSON.stringify(history))}` };
  }
  function requireCurrent(token: string): BookModel {
    const state = status();
    if (!state.ready || state.writeProtected) throw new Error(state.errors.join('；') || '台账正在装载、只读或等待恢复');
    if (token !== state.token) throw new Error('台账或聊天回复已经变化，请重新打开外观详情后再操作');
    return runtime.book()!;
  }
  function read() {
    const state = status(), archive: VisualArchive = { schema: 1, records: {} }, instances: any[] = [], profiles: Record<string, any> = {};
    if (!state.ready) return { ...state, archive, instances, profiles };
    const book = runtime.book()!, chat = getContext()?.chat || [];
    const aiIndices = chat.map((m: any, i: number) => isAnchorCandidate(m) ? i : -1).filter((i: number) => i >= 0);
    const record = (key: string, name: string) => {
      if (!name || key !== actorKeyForName(book, name)) throw new Error('视觉记录的人物身份无效，请修复台账');
      return archive.records[key] ||= blank(key, name, state.revision);
    };
    for (const row of tableRows(resolveTable(book, TABLES.settings))) {
      const r = record(row['角色键'], row['姓名']); r.enabled = row['启用'] !== '否'; r.style = row['设计风格'] === 'AVS' ? 'avs' : 'universal';
      try { const config = JSON.parse(row['衣柜配置'] || '{}'); profiles[r.actorKey] = { config, managed: row['衣柜接管'] === '是', full: config.visualFullyManaged === true }; } catch { profiles[r.actorKey] = { config: {}, managed: row['衣柜接管'] === '是', full: false }; }
    }
    for (const row of fieldRows(book)) {
      const g = row['分组'] as keyof typeof VISUAL_GROUPS, f = row['字段'];
      if (!Object.hasOwn(VISUAL_GROUPS, g) || !(VISUAL_GROUPS[g] as readonly string[]).includes(f)) continue;
      const r = record(row['角色键'], row['姓名']);
      const floor = aiIndices[Math.max(0, Number(row['记录楼层']) - 1)] ?? -1;
      (r.fields[g] ||= {})[f] = { value: row['内容'], source: row['来源'] === '剧情' ? 'story' : row['来源'] === '设计' ? 'design' : 'manual', evidence: row['依据'], floor };
    }
    for (const row of tableRows(resolveTable(book, TABLES.items))) {
      const r = record(row['角色键'], row['姓名']);
      const stateKey = Object.entries(ITEM_STATES).find(([, label]) => label === row['穿戴状态'])?.[0] || 'stored';
      instances.push({ instanceId: row['实例ID'], actorKey: r.actorKey, ownerName: r.name, catalogItemId: row['衣柜单品ID'], name: row['物品名称'], category: row['类别'], state: stateKey, location: row['具体位置'], condition: row['物品状况'], description: row['设计描述'] });
      profiles[r.actorKey] ||= { config: {}, managed: false, full: false };
      if (row['类别'] !== '其他') profiles[r.actorKey].managed = true;
    }
    return { ...state, archive, instances, profiles };
  }
  function checkIdentity(book: BookModel, actor: string, name: string): void {
    if (!name || name.length > 120 || actor !== actorKeyForName(book, name)) throw new Error('人物身份与台账不一致');
  }
  function rowForEdit(actorKey: string, name: string, edit: VisualEdit): Record<string, string> {
    const g = edit.group, f = edit.field;
    if (!Object.hasOwn(VISUAL_GROUPS, g) || !(VISUAL_GROUPS[g] as readonly string[]).includes(f)) throw new Error('未知外观字段');
    return { 字段键: fieldKey(actorKey, g, f), 角色键: actorKey, 姓名: name, 分组: g, 字段: f, 内容: text(edit.value), 来源: SOURCE[edit.source] || '手动', 依据: text(edit.evidence, 500), 锁定: '是', 记录楼层: String(writeScope(getContext()?.chat || [])?.aiFloor || 0) };
  }
  async function commit(book: BookModel, ops: any[]) {
    const prepared = validateVisualChanges(book, ops, 'bridge');
    if (prepared.errors.length) throw new Error(prepared.errors.join('；'));
    if (!ops.length) return { ok: true, changed: false };
    const result = runtime.commitOps('bridge', prepared.ops);
    if (!result.ok) throw new Error(result.errors.join('；'));
    if (!await runtime.flush()) throw new Error('台账保存尚未确认，请检查存储状态后重新打开核对');
    return { ok: true, changed: result.changedTables.length > 0 };
  }
  async function writeActor(args: { token: string; actorKey: string; name: string; edits: VisualEdit[]; enabled: boolean; style: string }) {
    const book = requireCurrent(args.token); checkIdentity(book, args.actorKey, args.name);
    if (!Array.isArray(args.edits) || args.edits.length > 59) throw new Error('外观编辑清单无效');
    const ops: any[] = [];
    for (const edit of args.edits) {
      const row = rowForEdit(args.actorKey, args.name, edit), table = isCurrentField(edit.group, edit.field) ? TABLES.current : TABLES.fixed;
      if (!row['内容']) { const old = tableRows(resolveTable(book, table)).find(r => r['字段键'] === row['字段键']); if (old) ops.push({ kind: 'row_delete', table, rowId: Number(old.row_id) }); }
      else ops.push(...upsertRowOps(book, table, '字段键', row['字段键'], row));
    }
    const config = setting(book, args.actorKey, args.name);
    ops.push(...upsertRowOps(book, TABLES.settings, '角色键', args.actorKey, { ...config, 启用: args.enabled ? '是' : '否', 设计风格: args.style === 'avs' ? 'AVS' : '通用' }));
    return commit(book, ops);
  }
  function makeItemRow(actorKey: string, name: string, data: any): Record<string, string> {
    const label = ITEM_STATES[data.state as keyof typeof ITEM_STATES];
    if (!label || !text(data.name, 120) || !text(data.instanceId, 200)) throw new Error('物品信息或状态无效');
    return { 实例ID: text(data.instanceId, 200), 角色键: actorKey, 姓名: name, 衣柜单品ID: text(data.catalogItemId, 140), 物品名称: text(data.name, 120), 类别: text(data.category, 20), 穿戴状态: label, 具体位置: text(data.location, 160), 物品状况: text(data.condition, 160), 设计描述: text(data.description), 来源: '手动', 依据: '用户在状态栏或衣柜确认的操作', 记录楼层: String(writeScope(getContext()?.chat || [])?.aiFloor || 0) };
  }
  function itemOps(book: BookModel, actor: string, name: string, data: any): any[] {
    const next = makeItemRow(actor, name, data), ops: any[] = [];
    if (data.state === 'worn' && !['配饰','其他'].includes(next['类别'])) {
      const conflicts = new Set([next['类别'], ...(next['类别'] === '连体服' ? ['上装','下装'] : ['上装','下装'].includes(next['类别']) ? ['连体服'] : [])]);
      for (const old of tableRows(resolveTable(book, TABLES.items))) if (old['角色键'] === actor && old['实例ID'] !== next['实例ID'] && old['穿戴状态'] === '正在穿戴' && conflicts.has(old['类别'])) ops.push(...upsertRowOps(book, TABLES.items, '实例ID', old['实例ID'], { ...old, 穿戴状态: '已经收起', 具体位置: '', 来源: '手动', 依据: '用户明确更换当前槽位物品' }));
    }
    return [...ops, ...upsertRowOps(book, TABLES.items, '实例ID', next['实例ID'], next)];
  }
  async function writeItem(args: any) {
    const book = requireCurrent(args.token); checkIdentity(book, args.actorKey, args.name);
    const config = setting(book, args.actorKey, args.name), wardrobeConfig = JSON.parse(config['衣柜配置'] || '{}');
    wardrobeConfig.autoRandomEnabled = false; delete wardrobeConfig.sourceOutfitId;
    const ops = itemOps(book, args.actorKey, args.name, args.item);
    ops.push(...upsertRowOps(book, TABLES.settings, '角色键', args.actorKey, { ...config, 衣柜接管: config['衣柜接管'] === '是' || args.item.category !== '其他' ? '是' : '否', 衣柜配置: JSON.stringify(wardrobeConfig) }));
    return commit(book, ops);
  }
  async function writeWardrobe(args: any) {
    const book = requireCurrent(args.token), ops: any[] = [];
    for (const entry of args.actors || []) {
      const actor = entry.profile.actorKey;
      const name = actor === 'protagonist' ? tableRows(resolveTable(book, '主角信息表'))[0]?.['姓名'] || '' : entry.profile.displayName;
      checkIdentity(book, actor, name);
      const selected = new Set<string>(entry.itemIds), beforeIds = new Set<string>(entry.beforeItemIds || []), config = setting(book, actor, name);
      const changedCategories = new Set<string>();
      for (const item of entry.catalog || []) if (selected.has(item.id) !== beforeIds.has(item.id)) changedCategories.add(item.category);
      const oldItems = tableRows(resolveTable(book, TABLES.items)).filter(r => r['角色键'] === actor);
      for (const old of oldItems) if (old['穿戴状态'] === '正在穿戴' && !selected.has(old['衣柜单品ID']) && (entry.full || changedCategories.has(old['类别']))) ops.push(...upsertRowOps(book, TABLES.items, '实例ID', old['实例ID'], { ...old, 穿戴状态: '已经收起', 具体位置: '', 来源: '手动', 依据: '用户在衣柜更换穿搭' }));
      for (const item of entry.catalog || []) {
        if (!selected.has(item.id) && !beforeIds.has(item.id)) continue;
        const old = oldItems.find(r => r['衣柜单品ID'] === item.id);
        const row = makeItemRow(actor, name, { ...item, instanceId: old?.['实例ID'] || `${actor}|${item.id}`, catalogItemId: item.id, state: selected.has(item.id) ? 'worn' : 'stored', location: selected.has(item.id) ? '身上' : old?.['穿戴状态'] === '正在穿戴' ? '' : old?.['具体位置'] || '', condition: old?.['物品状况'] || '' });
        ops.push(...upsertRowOps(book, TABLES.items, '实例ID', row['实例ID'], row));
      }
      const priorMetadata = JSON.parse(config['衣柜配置'] || '{}');
      const metadata = { ...priorMetadata, ...entry.profile, visualFullyManaged: priorMetadata.visualFullyManaged === true || entry.full === true }; delete metadata.currentOutfit;
      ops.push(...upsertRowOps(book, TABLES.settings, '角色键', actor, { ...config, 衣柜接管: config['衣柜接管'] === '是' || oldItems.length || selected.size || beforeIds.size ? '是' : '否', 衣柜配置: JSON.stringify(metadata) }));
    }
    return commit(book, ops);
  }
  function importPlan(args: any) {
    const book = requireCurrent(args.token), record = args.record as VisualRecord; checkIdentity(book, record.actorKey, record.name);
    const ops: any[] = [], conflicts: any[] = [], additions: any[] = [], existing = new Map(fieldRows(book).map(r => [r['字段键'], r]));
    for (const [group, values] of Object.entries(record.fields || {})) for (const [field, cell] of Object.entries(values || {})) {
      const key = fieldKey(record.actorKey, group, field), old = existing.get(key);
      if (old) { if (old['内容'] !== cell.value) conflicts.push({ field, old: cell.value, ledger: old['内容'] }); continue; }
      const row = rowForEdit(record.actorKey, record.name, { group: group as any, field, value: cell.value, source: cell.source, evidence: cell.evidence });
      additions.push({ field, value: cell.value });
      ops.push(...upsertRowOps(book, isCurrentField(group as any, field) ? TABLES.current : TABLES.fixed, '字段键', key, row));
    }
    const oldItems = tableRows(resolveTable(book, TABLES.items));
    for (const item of args.items || []) {
      const found = oldItems.find(r => r['角色键'] === record.actorKey && (r['实例ID'] === item.instanceId || (item.catalogItemId && r['衣柜单品ID'] === item.catalogItemId)));
      if (found) { if (found['穿戴状态'] !== ITEM_STATES[item.state as keyof typeof ITEM_STATES] || found['具体位置'] !== item.location) conflicts.push({ field: item.name, old: item.state, ledger: found['穿戴状态'] }); continue; }
      if (item.state === 'worn' && !['配饰','其他'].includes(item.category)) {
        const categories = new Set([item.category, ...(item.category === '连体服' ? ['上装','下装'] : ['上装','下装'].includes(item.category) ? ['连体服'] : [])]);
        const occupied = oldItems.find(r => r['角色键'] === record.actorKey && r['穿戴状态'] === '正在穿戴' && categories.has(r['类别']));
        if (occupied) { conflicts.push({ field: item.name, old: '正在穿戴', ledger: `当前穿戴${occupied['物品名称']}` }); continue; }
      }
      const row = makeItemRow(record.actorKey, record.name, item); additions.push({ field: item.name, value: `${row['穿戴状态']}${row['具体位置'] ? `，${row['具体位置']}` : ''}${row['物品状况'] ? `，${row['物品状况']}` : ''}` }); ops.push(...upsertRowOps(book, TABLES.items, '实例ID', row['实例ID'], row));
    }
    const oldConfig = tableRows(resolveTable(book, TABLES.settings)).find(r => r['角色键'] === record.actorKey);
    const config = oldConfig || setting(book, record.actorKey, record.name);
    const legacyProfile = args.profile ? { ...args.profile, visualFullyManaged: true } : null;
    if (legacyProfile) delete legacyProfile.currentOutfit;
    ops.push(...upsertRowOps(book, TABLES.settings, '角色键', record.actorKey, { ...config, ...(oldConfig ? {} : { 启用: record.enabled ? '是' : '否', 设计风格: record.style === 'avs' ? 'AVS' : '通用', ...(legacyProfile ? { 衣柜接管: '是', 衣柜配置: JSON.stringify(legacyProfile) } : {}) }), 旧档案导入: '已补缺导入，原档案保留' }));
    return { ops, conflicts, additions };
  }
  return { protocol: 1, status, read, writeActor, writeItem, writeWardrobe,
    previewImport(args: any) { const plan = importPlan(args); return { token: args.token, changes: plan.ops.length, conflicts: plan.conflicts, additions: plan.additions }; },
    async importLegacy(args: any) { const plan = importPlan(args); const result = await commit(runtime.book()!, plan.ops); return { ...result, conflicts: plan.conflicts }; },
  };
}
