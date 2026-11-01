export const VISUAL_KEY = 'visual.archive';
export const VISUAL_GROUPS = {
  overview: ['姓名', '种族', '实际年龄', '外貌年龄', '肤色与肌肤质感', '所属势力', '身份背景', '性格与喜好', '风格与气质', '与User的关系', '当前具体位置', '整体打扮与当前概况'],
  beauty: ['脸型轮廓', '眉形与眉妆', '眼型与眼神', '虹膜与瞳孔', '鼻型', '唇型与唇妆', '眼妆', '发色发质', '发长刘海与鬓发', '具体发型', '头面妆饰与花钿', '美甲'],
  body: ['身高与头身比', '整体身形体态', '肩颈与锁骨', '胸型与大小', '背部手臂与手部', '腰腹', '胯臀与双腿'],
  clothing: ['整体穿搭风格', '外罩与披搭', '上身外衣', '连体外衣', '中衣', '连体中衣', '下装', '胸罩', '内裤', '连体内衣', '丝袜', '鞋履'],
  accessories: ['发饰', '额饰', '面饰', '耳饰', '颈饰', '胸饰', '肩饰', '臂饰', '手饰', '指饰', '腰饰', '腿饰', '足饰'],
  scene: ['当前活动', '身体动作姿势与表情目光', '具体场景及环境互动'],
} as const;
export type VisualGroup = keyof typeof VISUAL_GROUPS;
export const GROUP_LABELS: Record<VisualGroup, string> = { overview: '人物概况', beauty: '面容与发妆', body: '身体特征', clothing: '衣着细节', accessories: '配饰细节', scene: '姿态与场景' };
export const ITEM_STATES = { worn: '正在穿戴', held: '拿在手里', stored: '已经收起', placed: '放在别处', lost: '已经遗失' } as const;
export type ItemState = keyof typeof ITEM_STATES;
export type VisualStyle = 'universal' | 'avs';
export type VisualSource = 'manual' | 'story' | 'design';
export interface VisualCell { value: string; source: VisualSource; evidence: string; floor: number; }
export type VisualFields = Partial<Record<VisualGroup, Record<string, VisualCell>>>;
export interface VisualItem { itemId: string; state: ItemState; location: string; condition: string; instanceId?: string; name?: string; category?: string; description?: string; catalogItemId?: string; }
export interface VisualRecord {
  actorKey: string; name: string; style: VisualStyle; enabled: boolean; revision: number;
  fields: VisualFields; items: Record<string, VisualItem>;
  origin?: { length: number; signature: string };
  managedItems?: boolean;
}
export interface VisualArchive { schema: 1; records: Record<string, VisualRecord>; }
export interface VisualEdit { group: VisualGroup; field: string; value: string; source: VisualSource; evidence: string; }

const CURRENT = new Set(['风格与气质', '与User的关系', '当前具体位置', '整体打扮与当前概况', '眉形与眉妆', '眼型与眼神', '唇型与唇妆', '眼妆', '具体发型', '头面妆饰与花钿', '美甲']);
export function isCurrentField(group: VisualGroup, field: string): boolean {
  return group === 'clothing' || group === 'accessories' || group === 'scene' || CURRENT.has(field);
}
export function isEphemeralVisualField(group: VisualGroup, field: string): boolean { return group === 'scene' || field === '当前具体位置' || field === '整体打扮与当前概况'; }

export const VISUAL_LEDGER_EVENT = "ub-visual-ledger-ready";

export interface VisualContextOptions { omitAppearance?: boolean; omitClothing?: boolean; omitScene?: boolean; }
