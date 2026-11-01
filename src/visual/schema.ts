import { normalizeTemplateAny } from '../sese-ledger/core/blueprint';
import { VISUAL_GROUPS, isCurrentField } from './contract';

export const TABLES = { settings: '视觉档案设置表', fixed: '固定视觉档案表', current: '当前视觉状态表', items: '视觉物品实例表' } as const;
export const IDS = { settings: 'sheet_visual_settings', fixed: 'sheet_visual_fixed', current: 'sheet_visual_current', items: 'sheet_visual_items' } as const;
export const FIELD_COLUMNS = ['字段键', '角色键', '姓名', '分组', '字段', '内容', '来源', '依据', '锁定', '记录楼层'];
export const ITEM_COLUMNS = ['实例ID', '角色键', '姓名', '衣柜单品ID', '物品名称', '类别', '穿戴状态', '具体位置', '物品状况', '设计描述', '来源', '依据', '记录楼层'];
export const SETTINGS_COLUMNS = ['角色键', '姓名', '启用', '设计风格', '衣柜接管', '衣柜配置', '旧档案导入'];
const COMMON = '所有性别、年龄、种族、体型的人物都可记录。只记录当前正文明确支持的事实；首次建档可引用【已有角色视觉资料】中的既有事实。不按AVS审美改造人物，不编造补全。省略不代表删除，回忆/梦境/假设不能覆盖当前主线。已有内容未变化时不输出SQL，禁止每轮重写整表。角色键：主角用 protagonist；其他人物用 character: 加姓名小写，之后保持不变。姓名必须对应已有主角/角色表或当前正文具名人物。来源只填 剧情；依据必须逐字引用当前正文或已有角色视觉资料。';
function fields(current: boolean): string {
  return Object.entries(VISUAL_GROUPS).map(([g, fs]) => `${g}：${fs.filter(f => isCurrentField(g as keyof typeof VISUAL_GROUPS, f) === current).join('、')}`).filter(s => !s.endsWith('：')).join('\n');
}
export function visualDefinitions(groupId: number, manualGroup: number, startOrder = 100): any[] {
  const make = (id: string, name: string, columns: string[], note: string, manual = false) => ({
    tableId: id, name, orderNo: startOrder++, groupId: manual ? manualGroup : groupId,
    columns: columns.map((header, i) => ({ header, type: 'text', unique: i === 0, notNull: false })),
    note, triggerNotes: {
      insert: manual ? '仅状态栏人工设置，填表AI禁止写入。' : '仅本轮有明确依据且该唯一键尚不存在时新增，不写row_id。',
      update: manual ? '仅用户操作更新。' : '只更新本轮确有变化的列；锁定=是的字段禁止AI修改。保留唯一键与角色键。',
      delete: '禁止自动删除；离场人物保留，物品离身改状态，不删记录。',
    },
    readMode: 'all', worldbook: { enabled: false, mode: 'keyword', keywordsColumn: '姓名', placement: { position: 'before_character_definition', order: 8127 } },
  });
  return [
    make(IDS.fixed, TABLES.fixed, FIELD_COLUMNS, `${COMMON}\n固定视觉特征，一人可有多行，每行只记录一个字段。字段键固定为 角色键|分组|字段，不得重复。分组/字段只准使用下列清单：\n${fields(false)}\n记录楼层填本轮AI楼序号；锁定默认否。禁止把临时发型、妆容、姿势、衣着写到固定表。`),
    make(IDS.current, TABLES.current, FIELD_COLUMNS, `${COMMON}\n当前视觉状态，一人一字段一行，字段键固定为 角色键|分组|字段。位置、活动、姿态随新场景更新，未发生变化的衣着发型不要重设。\n合法清单：\n${fields(true)}\n记录楼层填本轮AI楼序号，锁定默认否。已存在对应物品实例时，穿戴与物品位置以实例表为准，衣着描述必须一致。`),
    make(IDS.items, TABLES.items, ITEM_COLUMNS, `${COMMON}\n记录故事里的具体物品，物品实例与衣柜设计模板分开。实例ID首次建立后不得改动，同一人物同一件物品沿用既有ID。衣柜单品ID只允许照抄已有记录，未知留空，禁止编造；未知衣柜单品ID也能用稳定实例ID记录。\n类别使用 上装/下装/连体服/外套/文胸/内裤/袜类/鞋靴/头饰/配饰/其他。穿戴状态只准 正在穿戴/拿在手里/已经收起/放在别处/已经遗失。物品状况单独记录完好/淋湿/破损等事实。脱下不等于丢失，放在椅背不等于正在穿戴；离场不删除其物品。正文实际换装才更新，备用造型不算已经穿上。`),
    make(IDS.settings, TABLES.settings, SETTINGS_COLUMNS, '视觉功能人工设置，AI禁止更改。启用：是/否；设计风格：通用/AVS；衣柜接管：是/否；衣柜配置保存状态栏生成的JSON。', true),
  ];
}
export function withVisualTemplateV2(raw: any): any {
  if (!raw || raw.schemaVersion !== 2) return raw;
  const out = structuredClone(raw), presence = out.tables.find((t: any) => t.name === '在场角色表');
  if (presence && !String(presence.note || '').includes('【视觉联动】')) presence.note = String(presence.note || '') + '\n【视觉联动】同组视觉物品实例变化时，同步核对本表的当前穿搭、上装、下装、内衣、鞋袜和饰品。具体物品状态以实例表为准，已脱下或遗失的物品不得仍写成穿着。只改确有变化部分，不得因记录一件道具而清空其余穿搭。';
  const groupId = Number(presence?.groupId ?? out.groups.find((g: any) => g.frequency > 0)?.id ?? 1);
  let manual = out.groups.find((g: any) => Number(g.frequency) === 0)?.id;
  if (manual == null) { manual = Math.max(0, ...out.groups.map((g: any) => Number(g.id) || 0)) + 1; out.groups.push({ id: manual, name: '视觉设置（手动）', frequency: 0 }); }
  const defs = visualDefinitions(groupId, manual, Math.max(0, ...out.tables.map((t: any) => Number(t.orderNo) || 0)) + 1);
  for (const def of defs) {
    const existing = out.tables.find((t: any) => t.tableId === def.tableId || t.name === def.name);
    // 不覆盖自定义同名表；API会报告缺失列，要求修复，保留原数据。
    if (!existing) out.tables.push(def);
  }
  return out;
}
export function withVisualWorkbook(raw: any): any {
  const out = structuredClone(raw), groups = out.mate?.ledgerGroups || [{ id: 1, name: '角色组', frequency: 1 }];
  const sheets = Object.entries(out).filter(([key]) => key.startsWith('sheet_'));
  const defs = sheets.map(([id, s]: any) => s.ledgerV2 || { tableId: id, name: s.name, orderNo: s.orderNo, groupId: s.updateConfig?.groupId || 1 });
  const enriched = withVisualTemplateV2({ schemaVersion: 2, groups, tables: defs });
  for (const [key, sheet] of sheets as any) if (sheet.name === '在场角色表' && sheet.ledgerV2) {
    const enrichedDef = enriched.tables.find((d: any) => d.tableId === key);
    if (enrichedDef) { sheet.ledgerV2.note = enrichedDef.note; if (sheet.sourceData) sheet.sourceData.note = enrichedDef.note; }
  }
  const additions = enriched.tables.filter((d: any) => !defs.some((x: any) => x.tableId === d.tableId || x.name === d.name));
  if (!additions.length) return out;
  const normalized = normalizeTemplateAny({ schemaVersion: 2, name: '视觉扩展', groups: enriched.groups, tables: additions });
  if (!normalized.ok || !normalized.workbook) throw new Error('视觉表定义无效：' + normalized.errors.join('；'));
  out.mate = { ...out.mate, ledgerGroups: enriched.groups };
  for (const [key, sheet] of Object.entries(normalized.workbook)) if (key.startsWith('sheet_')) out[key] = sheet;
  return out;
}
