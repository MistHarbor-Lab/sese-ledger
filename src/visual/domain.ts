import { applyOp, createBook, projectWorkbook, resolveTable, type BookModel, type TableModel } from '../sese-ledger/core/book';
import { VISUAL_GROUPS, ITEM_STATES, isCurrentField, type VisualGroup } from './contract';
import { TABLES, FIELD_COLUMNS, ITEM_COLUMNS, SETTINGS_COLUMNS } from './schema';

export function tableRows(table: TableModel | null): Array<Record<string, string>> {
  return table ? [...table.rows.values()].map(cells => Object.fromEntries(table.headers.map((h, i) => [h, String(cells[i] ?? '')]))) : [];
}
export function visualSchemaErrors(book: BookModel): string[] {
  const errors: string[] = [];
  for (const [name, columns] of [[TABLES.settings, SETTINGS_COLUMNS], [TABLES.fixed, FIELD_COLUMNS], [TABLES.current, FIELD_COLUMNS], [TABLES.items, ITEM_COLUMNS]] as const) {
    const table = resolveTable(book, name);
    if (!table) errors.push(`缺少${name}`);
    else for (const column of columns) if (!table.headers.includes(column)) errors.push(`${name}缺少列「${column}」`);
  }
  return errors;
}
export function actorKeyForName(book: BookModel, name: string): string {
  const normalized = String(name || '').trim().replace(/\s+/g, ' ');
  const protagonist = tableRows(resolveTable(book, '主角信息表'))[0]?.['姓名'];
  if (protagonist && normalized === protagonist) return 'protagonist';
  return normalized ? `character:${normalized.toLocaleLowerCase()}` : '';
}
export function fieldKey(actorKey: string, group: string, field: string): string { return `${actorKey}|${group}|${field}`; }
export function visualOp(book: BookModel, op: any): boolean { return Object.values(TABLES).includes(resolveTable(book, op.table)?.name as any); }
export function upsertRowOps(book: BookModel, tableName: string, keyColumn: string, key: string, row: Record<string, string>): any[] {
  const table = resolveTable(book, tableName);
  if (!table) throw new Error(`缺少${tableName}`);
  const existing = tableRows(table).find(r => r[keyColumn] === key);
  if (!existing) return [{ kind: 'row_insert', table: table.tableId, row }];
  return Object.entries(row).filter(([column, value]) => existing[column] !== value).map(([column, value]) => ({ kind: 'cell', table: table.tableId, rowId: Number(existing.row_id), column, value }));
}
const trim = (v: unknown): string => typeof v === 'string' ? v.trim() : '';
const WEAR_CATEGORIES = new Set(['上装','下装','连体服','外套','文胸','内裤','袜类','鞋靴','头饰','配饰','其他']);
export function validateVisualChanges(book: BookModel, ops: any[], source: string, evidenceText?: string, aiFloor?: number): { ops: any[]; errors: string[] } {
  if (!ops.some(op => visualOp(book, op))) return { ops, errors: [] };
  const errors = visualSchemaErrors(book);
  if (errors.length) return { ops: [], errors };
  const trial = createBook(projectWorkbook(book)), normalized = structuredClone(ops);
  for (const op of normalized) {
    if (source === 'ai' && visualOp(book, op) && (!['cell','row_insert'].includes(op.kind) || resolveTable(book, op.table)?.name === TABLES.settings)) errors.push('填表AI只能新增/更新视觉事实，禁止修改人工设置、删除或替换视觉表');
    const result = applyOp(trial, op);
    if (!result.ok) errors.push(result.error || '操作无效');
  }
  for (const [name, current] of [[TABLES.fixed, false], [TABLES.current, true]] as const) {
    const table = resolveTable(trial, name)!, before = new Map(tableRows(resolveTable(book, name)).map(r => [r.row_id, r]));
    const seen = new Set<string>();
    for (const row of tableRows(table)) {
      const group = row['分组'] as VisualGroup, field = row['字段'], key = row['字段键'];
      if (!Object.hasOwn(VISUAL_GROUPS, group) || !(VISUAL_GROUPS[group] as readonly string[]).includes(field) || isCurrentField(group, field) !== current) errors.push(`${name}：分组或字段不属于本表`);
      if (!row['姓名'] || row['角色键'] !== actorKeyForName(trial, row['姓名']) || key !== fieldKey(row['角色键'], group, field)) errors.push(`${name}：人物或字段键不一致`);
      if (seen.has(key)) errors.push(`${name}：字段键重复`); seen.add(key);
      if (!trim(row['内容']) || row['内容'].length > 1600) errors.push(`${name}：内容必须为1～1600字`);
      if (!['剧情','手动','设计'].includes(row['来源']) || !['是','否',''].includes(row['锁定'])) errors.push(`${name}：来源或锁定值无效`);
      if (group === 'overview' && field === '姓名' && row['内容'] !== row['姓名']) errors.push('视觉档案不能改名');
      const old = before.get(row.row_id), changed = !old || Object.keys(row).some(k => row[k] !== old[k]);
      if (source === 'ai' && changed) {
        if (old?.['锁定'] === '是' && (!current || (aiFloor != null && aiFloor <= Number(old['记录楼层'] || 0)))) errors.push(`${name}：${row['姓名']}的${field}已由用户锁定`);
        if (old && (old['字段键'] !== key || old['角色键'] !== row['角色键'])) errors.push('不得修改已有字段的唯一键与人物身份');
        if (row['来源'] !== '剧情' || (row['锁定'] === '是' && old?.['锁定'] !== '是') || !trim(row['依据'])) errors.push('填表只能写有依据的剧情事实，不能生成设计或人工锁定');
        if (evidenceText != null && !evidenceText.includes(row['依据'])) errors.push(`${name}：依据不是本批正文的逐字引文`);
        if (aiFloor != null && row['记录楼层'] !== String(aiFloor)) {
          normalized.push({ kind: 'cell', table: table.tableId, rowId: Number(row.row_id), column: '记录楼层', value: String(aiFloor) });
        }
        if (current && old?.['锁定'] === '是' && aiFloor != null && aiFloor > Number(old['记录楼层'] || 0)) normalized.push({ kind: 'cell', table: table.tableId, rowId: Number(row.row_id), column: '锁定', value: '否' });
      }
    }
  }
  const items = tableRows(resolveTable(trial, TABLES.items)), oldItems = new Map(tableRows(resolveTable(book, TABLES.items)).map(r => [r.row_id, r]));
  const seenIds = new Set<string>(), slots = new Set<string>();
  for (const row of items) {
    const id = row['实例ID'];
    if (!id || id.length > 200 || ['__proto__','constructor','prototype'].includes(id) || seenIds.has(id)) errors.push('物品实例ID为空、无效或重复'); seenIds.add(id);
    if (!row['姓名'] || row['角色键'] !== actorKeyForName(trial, row['姓名'])) errors.push('物品人物身份不一致');
    if (!row['物品名称'] || !WEAR_CATEGORIES.has(row['类别']) || !Object.values(ITEM_STATES).includes(row['穿戴状态'] as any)) errors.push('物品名称、类别或穿戴状态无效');
    const old = oldItems.get(row.row_id), changed = !old || Object.keys(row).some(k => row[k] !== old[k]);
    if (old && (old['实例ID'] !== id || old['角色键'] !== row['角色键'])) errors.push('已有物品不能更换实例ID或归属人物');
    if (source === 'ai' && changed) {
      if (old?.['来源'] === '手动' && aiFloor != null && aiFloor <= Number(old['记录楼层'] || 0)) errors.push('本轮物品状态已经由用户纠正，不能被迟到填表覆盖');
      if (row['来源'] !== '剧情' || !trim(row['依据']) || (evidenceText != null && !evidenceText.includes(row['依据']))) errors.push('物品变化必须引用本批正文依据');
      if ((old && row['衣柜单品ID'] !== old['衣柜单品ID']) || (!old && row['衣柜单品ID'])) errors.push('填表AI不能编造、替换或清除衣柜单品ID；新物品留空，由用户关联');
    }
    if (changed && aiFloor != null) {
      const table = resolveTable(trial, TABLES.items)!;
      normalized.push({ kind: 'cell', table: table.tableId, rowId: Number(row.row_id), column: '记录楼层', value: String(aiFloor) });
      if (source === 'bridge') normalized.push({ kind: 'cell', table: table.tableId, rowId: Number(row.row_id), column: '来源', value: '手动' });
    }
    if (row['穿戴状态'] === '正在穿戴' && !['配饰','其他'].includes(row['类别'])) {
      const slot = `${row['角色键']}|${row['类别']}`;
      if (slots.has(slot)) errors.push('同一人物同一衣柜槽位不能同时穿戴两件物品'); slots.add(slot);
    }
  }
  for (const row of tableRows(resolveTable(trial, TABLES.settings))) {
    if (row['角色键'] !== actorKeyForName(trial, row['姓名']) || !['是','否'].includes(row['启用']) || !['通用','AVS'].includes(row['设计风格']) || !['是','否'].includes(row['衣柜接管'])) errors.push('视觉人工设置无效');
    if (row['衣柜配置']) { try { const value = JSON.parse(row['衣柜配置']); if (!value || typeof value !== 'object' || Array.isArray(value)) throw 0; } catch { errors.push('衣柜配置不是有效对象'); } }
  }
  // 一组视觉事实必须整体有效；不保留会与人物/穿戴事实矛盾的半组写入。
  return errors.length ? { ops: [], errors: [...new Set(errors)] } : { ops: normalized, errors: [] };
}

export function visualRowInPrompt(table: TableModel, cells: string[], book: BookModel | undefined, story: string): boolean {
  if (![TABLES.fixed, TABLES.current, TABLES.items].includes(table.name as any)) return true;
  const name = cells[table.headers.indexOf('姓名')] || '';
  if (!name) return false;
  const present = book ? tableRows(resolveTable(book, '在场角色表')).some(r => r['姓名'] === name) : false;
  const lead = book ? tableRows(resolveTable(book, '主角信息表'))[0]?.['姓名'] === name : false;
  return present || lead || story.toLocaleLowerCase().includes(name.toLocaleLowerCase());
}

/** 新视觉表沿用在场表水位与请求窗口，避免升级后独立补历史而先触发立绘。 */
export function visualFillCoupling(book: BookModel, schedule: Record<string, number>): { ids: Set<string>; config: any; lastFilled: number } | null {
  const presence = resolveTable(book, '在场角色表');
  const tables = [TABLES.fixed, TABLES.current, TABLES.items].map(name => resolveTable(book, name));
  if (!presence || tables.some(t => !t || Number(t.updateConfig.updateFrequency) === 0 || t.updateConfig.groupId !== presence.updateConfig.groupId) || Number(presence.updateConfig.updateFrequency) === 0) return null;
  const ids = new Set([presence.tableId, ...tables.map(t => t!.tableId)]);
  const base = Number(schedule[presence.tableId] || 0);
  const lastFilled = Math.min(...[...ids].map(id => Object.hasOwn(schedule, id) ? Number(schedule[id]) || 0 : base));
  return { ids, config: presence.updateConfig, lastFilled };
}
export function visualBaseline(book: BookModel, story: string): string {
  const names = new Set(tableRows(resolveTable(book, '在场角色表')).map(r => r['姓名']));
  const lead = tableRows(resolveTable(book, '主角信息表'))[0]?.['姓名']; if (lead) names.add(lead);
  const lines: string[] = [];
  for (const tableName of ['主角信息表','恋爱对象表','重要角色表']) for (const row of tableRows(resolveTable(book, tableName))) {
    if (!row['姓名'] || (!names.has(row['姓名']) && !story.includes(row['姓名']))) continue;
    lines.push(['姓名','性别','外貌特征','身份背景','身份'].filter(k => row[k]).map(k => `${k}：${row[k]}`).join('\n'));
  }
  return lines.join('\n\n');
}
