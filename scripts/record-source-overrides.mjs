import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root=new URL('../',import.meta.url);
const changes={
  'src/sese-ledger/index.ts':'模板补充视觉表、注册视觉读写接口，并在关联表填完后通知立绘',
  'src/sese-ledger/core/runtime.ts':'单写者提交前检查视觉事实完整性与本轮人工纠正，沿现有楼层记录回退',
  'src/sese-ledger/core/scribe.ts':'视觉事实合批填表、已有角色资料初始化和原文依据检查',
};
const files={};
for(const [name,reason]of Object.entries(changes))files[name]={sha256:createHash('sha256').update(await readFile(new URL(name,root))).digest('hex'),reason};
await writeFile(new URL('source-overrides.sha256.json',root),JSON.stringify({feature:'visual-ledger',files},null,2)+'\n');
