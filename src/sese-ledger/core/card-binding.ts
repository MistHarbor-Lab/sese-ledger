// ===== 模板绑定（跟随角色卡）=====
//
// 模型（用户定案）：**结构真源 = 一份预设模板**，绑定存在**角色卡变量**里——
//   · 同一张角色卡的所有聊天共用一份绑定 → 一处改结构，该卡所有聊天跟着变；
//   · 删角色卡 = 绑定随卡消失，不产生全局孤儿数据（对比：全局索引/项目存储会留孤儿）；
//   · 群聊 / 欢迎页无角色卡上下文 → 回落全局默认预设（settings.defaultTemplatePreset）。
//
// 复用主项目角色卡变量统一读写口（card-variable-store：读失败一律 {}、写失败必须回报，不假装成功）。

import { assignCardVariables, hasCharacterCardContext, readCardVariables } from '../../unified-statusbar/core/card-variable-store';

/** 角色卡变量键：本卡使用的模板预设名（'' = 未设置，回落全局默认；内置标准模板用 STANDARD_PRESET_NAME）。 */
export const CARD_TEMPLATE_KEY = 'seseLedgerTemplate';

/** 该角色卡绑定的模板名（无卡上下文/未设置 → ''）。 */
export function readBoundTemplateName(): string {
  const vars = readCardVariables();
  const value = vars?.[CARD_TEMPLATE_KEY];
  return typeof value === 'string' ? value.trim() : '';
}

/** 当前上下文能否写角色卡变量（群聊/欢迎页 → false：绑定回落全局默认预设）。 */
export function canBindToCard(): boolean {
  return hasCharacterCardContext();
}

/** 写绑定（返回是否成功；调用方失败必须回报用户）。群聊/无卡上下文不写（回落全局默认预设）。 */
export function writeBoundTemplateName(name: string): boolean {
  if (!canBindToCard()) return false;
  return assignCardVariables({ [CARD_TEMPLATE_KEY]: String(name || '') });
}
