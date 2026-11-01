import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { m, original, fixture, key } from './visual-fixture.mjs';
const edit=(field,value,group='beauty')=>({group,field,value,source:'manual',evidence:''});
const item={instanceId:'rin-coat',name:'灰色外套',category:'外套',catalogItemId:'wi_coat',state:'worn',location:'身上',condition:'完好',description:'灰色长外套'};
const putItem=(f,state,location='')=>f.api.writeItem({token:f.api.read().token,actorKey:key,name:'Rin',item:{...item,state,location}});

test('视觉扩展保留原模板及分组；四表幂等加入，人工设置不参与AI组',()=>{
  const before=structuredClone(original),v=m.withVisualTemplateV2(original),v2=m.withVisualTemplateV2(v);
  assert.deepEqual(original,before);assert.equal(v.tables.length,original.tables.length+4);assert.deepEqual(v2,v);
  const presence=v.tables.find(t=>t.name==='在场角色表');for(const name of [m.TABLES.fixed,m.TABLES.current,m.TABLES.items])assert.equal(v.tables.find(t=>t.name===name).groupId,presence.groupId);
  const controls=v.tables.find(t=>t.name===m.TABLES.settings);assert.equal(v.groups.find(g=>g.id===controls.groupId).frequency,0);
  const custom=m.normalizeTemplateAny(original).workbook;custom.sheet_custom={name:'用户自定义',content:[['row_id','备注'],['1','保留']],custom:42};
  const enriched=m.withVisualWorkbook(custom);assert.deepEqual(enriched.sheet_custom,custom.sheet_custom);assert.deepEqual(m.withVisualWorkbook(enriched),enriched);
});
test('填表SQL写入固定外观并进入API读取，来源与实际楼层由台账记账',async()=>{
  const f=await fixture();try{
    const raw=`INSERT INTO 固定视觉档案表 (字段键,角色键,姓名,分组,字段,内容,来源,依据,锁定,记录楼层) VALUES ('character:rin|beauty|发色发质','character:rin','Rin','beauty','发色发质','黑发','剧情','Rin 是黑发','否','999');`;
    const plan=m.parseFillOutput(f.runtime.book(),raw,f.ctx.chat[0].mes);assert.deepEqual(plan.errors,[]);
    assert(f.runtime.commitOps('ai',plan.ops).ok);assert.equal(f.api.read().archive.records[key].fields.beauty['发色发质'].value,'黑发');
    const row=m.tableRows(m.resolveTable(f.runtime.book(),m.TABLES.fixed))[0];assert.equal(row['记录楼层'],'1');assert.equal(f.api.read().archive.records[key].fields.beauty['发色发质'].floor,0);
  }finally{f.close()}
});
test('无依据、错字段、错误人物键与试图改设置的填表整批拒绝，不产生半组视觉事实',async()=>{
  const f=await fixture();try{
    const raw=`INSERT INTO 固定视觉档案表 (字段键,角色键,姓名,分组,字段,内容,来源,依据,锁定) VALUES ('character:rin|beauty|发色发质','character:rin','Rin','beauty','发色发质','白发','剧情','不存在的引文','否');`;
    const before=JSON.stringify(m.projectWorkbook(f.runtime.book()));assert(m.parseFillOutput(f.runtime.book(),raw,'黑发').errors.length);assert.equal(JSON.stringify(m.projectWorkbook(f.runtime.book())),before);
    const bad=[{kind:'row_insert',table:m.TABLES.settings,row:{角色键:key,姓名:'Rin',启用:'是',设计风格:'AVS',衣柜接管:'否'}}];assert.equal(f.runtime.commitOps('ai',bad).ok,false);assert.equal(m.tableRows(m.resolveTable(f.runtime.book(),m.TABLES.settings)).length,0);
    const invalid=m.validateVisualChanges(f.runtime.book(),[{kind:'row_insert',table:m.TABLES.fixed,row:{字段键:'bad',角色键:'character:other',姓名:'Rin',分组:'scene',字段:'当前活动',内容:'站立',来源:'剧情',依据:'站立',锁定:'否'}}],'ai','站立');assert(invalid.errors.length);assert.deepEqual(invalid.ops,[]);
  }finally{f.close()}
});
test('手动纠正写回台账并保护固定外貌，不再写状态栏的另一本档案',async()=>{
  const f=await fixture();try{
    await f.api.writeActor({token:f.api.read().token,actorKey:key,name:'Rin',enabled:true,style:'universal',edits:[edit('发色发质','黑发')]});
    const row=m.tableRows(m.resolveTable(f.runtime.book(),m.TABLES.fixed))[0];assert.equal(row['来源'],'手动');assert.equal(row['锁定'],'是');
    const bad=[{kind:'cell',table:m.TABLES.fixed,rowId:Number(row.row_id),column:'内容',value:'白发'},{kind:'cell',table:m.TABLES.fixed,rowId:Number(row.row_id),column:'来源',value:'剧情'},{kind:'cell',table:m.TABLES.fixed,rowId:Number(row.row_id),column:'依据',value:'白发'}];
    assert.equal(f.runtime.commitOps('ai',bad).ok,false);assert.equal(f.api.read().archive.records[key].fields.beauty['发色发质'].value,'黑发');
    assert(f.runtime.visibleEntries().at(-1).changedTables.some(id=>id.includes('visual')));
  }finally{f.close()}
});
test('当前状态的手动纠正保护本轮，下个AI回合有新依据可以更新',async()=>{
  const f=await fixture();try{
    await f.api.writeActor({token:f.api.read().token,actorKey:key,name:'Rin',enabled:true,style:'universal',edits:[edit('当前活动','站立','scene')]});
    const row=m.tableRows(m.resolveTable(f.runtime.book(),m.TABLES.current))[0],ops=[{kind:'cell',table:m.TABLES.current,rowId:Number(row.row_id),column:'内容',value:'坐下'},{kind:'cell',table:m.TABLES.current,rowId:Number(row.row_id),column:'来源',value:'剧情'},{kind:'cell',table:m.TABLES.current,rowId:Number(row.row_id),column:'依据',value:'Rin 坐下'}];
    assert.equal(f.runtime.commitOps('ai',ops).ok,false);f.ctx.chat.push({id:'ai1',mes:'Rin 坐下。',is_user:false});f.runtime.syncFloors();
    assert.equal(f.runtime.commitOps('ai',ops).ok,true);const changed=m.tableRows(m.resolveTable(f.runtime.book(),m.TABLES.current))[0];assert.equal(changed['锁定'],'否');assert.equal(changed['记录楼层'],'2');
  }finally{f.close()}
});
test('物品实体复用衣柜设计ID，AI换装必须同步卸下同槽位旧物',async()=>{
  const f=await fixture();try{
    await putItem(f,'worn','身上');
    const bad=[{kind:'row_insert',table:m.TABLES.items,row:{实例ID:'new-coat',角色键:key,姓名:'Rin',衣柜单品ID:'invented',物品名称:'新外套',类别:'外套',穿戴状态:'正在穿戴',来源:'剧情',依据:'穿上新外套'}}];
    assert.equal(f.runtime.commitOps('ai',bad).ok,false);assert.equal(f.api.read().instances.length,1);
    await f.api.writeItem({token:f.api.read().token,actorKey:key,name:'Rin',item:{...item,instanceId:'new-coat',catalogItemId:'wi_new',name:'新外套'}});
    const rows=f.api.read().instances;assert.equal(rows.find(i=>i.instanceId==='rin-coat').state,'stored');assert.equal(rows.find(i=>i.instanceId==='new-coat').state,'worn');
    assert.equal(f.api.read().profiles[key].config.autoRandomEnabled,false);
  }finally{f.close()}
});
test('删掉AI楼后恢复上一楼外观和物品状态，User消息保留',async()=>{
  const f=await fixture();try{
    await putItem(f,'worn','身上');await f.api.writeActor({token:f.api.read().token,actorKey:key,name:'Rin',enabled:true,style:'universal',edits:[edit('具体发型','束发')]});
    f.ctx.chat.push({id:'user1',mes:'把外套放下',is_user:true},{id:'ai1',mes:'Rin 把外套搭在椅背。',is_user:false});f.runtime.syncFloors();
    await putItem(f,'placed','椅背');await f.api.writeActor({token:f.api.read().token,actorKey:key,name:'Rin',enabled:true,style:'universal',edits:[edit('具体发型','披发')]});
    f.ctx.chat.pop();f.runtime.pruneRemovedAnchors();assert.equal(f.ctx.chat.at(-1).is_user,true);assert.equal(f.api.read().instances[0].state,'worn');assert.equal(f.api.read().archive.records[key].fields.beauty['具体发型'].value,'束发');
  }finally{f.close()}
});
test('切换回复后旧分支物品写入被裁剪，旧token不可再写',async()=>{
  const f=await fixture();try{
    await putItem(f,'worn','身上');f.ctx.chat.push({id:'ai1',mes:'外套放下',is_user:false,swipes:['外套放下','继续穿着'],swipe_id:0,swipe_info:[{send_date:'x'},{send_date:'y'}]});f.runtime.syncFloors();await putItem(f,'placed','椅背');
    const token=f.api.read().token;f.ctx.chat.at(-1).swipe_id=1;f.runtime.pruneRemovedAnchors();assert.equal(f.api.read().instances[0].state,'worn');
    await assert.rejects(f.api.writeItem({token,actorKey:key,name:'Rin',item:{...item,state:'lost'}}),/已经变化/);
    f.ctx.chatId='other';assert.equal(f.api.read().ready,false);
  }finally{f.close()}
});
test('旧手动档案只导入缺失项；冲突保留台账，重复导入不新增重复行',async()=>{
  const f=await fixture();try{
    await f.api.writeActor({token:f.api.read().token,actorKey:key,name:'Rin',enabled:true,style:'universal',edits:[edit('发色发质','黑发')]});
    const record={actorKey:key,name:'Rin',enabled:true,style:'avs',revision:1,fields:{beauty:{发色发质:{value:'白发',source:'manual',evidence:'',floor:0},虹膜与瞳孔:{value:'灰眼',source:'manual',evidence:'',floor:0}}},items:{}};
    const args={token:f.api.read().token,record,items:[item]};const preview=f.api.previewImport(args);assert.equal(preview.conflicts.length,1);
    await f.api.importLegacy(args);const data=f.api.read();assert.equal(data.archive.records[key].fields.beauty['发色发质'].value,'黑发');assert.equal(data.archive.records[key].fields.beauty['虹膜与瞳孔'].value,'灰眼');assert.equal(data.archive.records[key].style,'universal');
    const count=m.tableRows(m.resolveTable(f.runtime.book(),m.TABLES.fixed)).length;await f.api.importLegacy({...args,token:data.token});assert.equal(m.tableRows(m.resolveTable(f.runtime.book(),m.TABLES.fixed)).length,count);
  }finally{f.close()}
});
test('填表提示只读取在场、主角或正文点名的人物视觉行',async()=>{
  const f=await fixture();try{
    const table=m.resolveTable(f.runtime.book(),m.TABLES.fixed),cells=new Array(table.headers.length).fill('');cells[table.headers.indexOf('姓名')]='Rin';assert(m.visualRowInPrompt(table,cells,f.runtime.book(),''));
    cells[table.headers.indexOf('姓名')]='Other';assert.equal(m.visualRowInPrompt(table,cells,f.runtime.book(),''),false);assert(m.visualRowInPrompt(table,cells,f.runtime.book(),'Other 到访'));
  }finally{f.close()}
});
test('新增视觉表沿在场表同批填写，完成后才通知立绘；不单独回填旧历史',async()=>{
  const f=await fixture();try{
    for(let i=1;i<5;i++)f.ctx.chat.push({id:'ai'+i,mes:'Rin 是黑发。',is_user:false});f.runtime.syncFloors();
    const schedule=Object.fromEntries([...f.runtime.book().tables.values()].filter(t=>!Object.values(m.TABLES).includes(t.name)).map(t=>[t.tableId,4]));await f.runtime.patchSchedule(schedule);
    const calls=[],signals=[];
    const result=await m.runScheduledFill({runtime:f.runtime,getChat:()=>f.ctx.chat,readSettings:()=>({autoFillEnabled:true,fillMaxAttempts:1}),requestFill:async spec=>{
      calls.push(spec);if(spec.blocks.dossier.includes('表')&&spec.blocks.dossier.includes('固定视觉档案表'))return `INSERT INTO 固定视觉档案表 (字段键,角色键,姓名,分组,字段,内容,来源,依据,锁定) VALUES ('character:rin|beauty|发色发质','character:rin','Rin','beauty','发色发质','黑发','剧情','Rin 是黑发','否');`;return '';
    },onPresenceTableFilled:p=>{assert.equal(f.api.read().archive.records[key].fields.beauty['发色发质'].value,'黑发');signals.push(p)}});
    assert.deepEqual(result.errors,[]);const visualCalls=calls.filter(s=>s.blocks.dossier.includes('固定视觉档案表'));assert.equal(visualCalls.length,1);for(const name of ['在场角色表',m.TABLES.fixed,m.TABLES.current,m.TABLES.items])assert(visualCalls[0].blocks.dossier.includes(name));
    assert.equal(signals.length,1);assert(signals[0].tableNames.includes(m.TABLES.items));assert.equal(f.api.read().archive.records[key].fields.beauty['发色发质'].floor,4);
  }finally{f.close()}
});
test('首次视觉建档可引用原人物表事实，但不把它当成本轮新事件',async()=>{
  const f=await fixture();try{
    const table=m.resolveTable(f.runtime.book(),'重要角色表'),row=m.tableRows(table)[0];f.runtime.commitOps('bridge',[{kind:'cell',table:table.tableId,rowId:Number(row.row_id),column:'外貌特征',value:'黑色短发，灰色眼睛'}]);
    const raw=`INSERT INTO 固定视觉档案表 (字段键,角色键,姓名,分组,字段,内容,来源,依据,锁定) VALUES ('character:rin|beauty|虹膜与瞳孔','character:rin','Rin','beauty','虹膜与瞳孔','灰色眼睛','剧情','灰色眼睛','否');`;
    assert.deepEqual(m.parseFillOutput(f.runtime.book(),raw,'Rin 喝了杯茶。').errors,[]);
    assert(m.visualBaseline(f.runtime.book(),'Rin 喝茶').includes('灰色眼睛'));
  }finally{f.close()}
});
test('只记录一只杯子不接管整套穿搭，也不会清空其他衣物',async()=>{
  const f=await fixture();try{
    await f.api.writeItem({token:f.api.read().token,actorKey:key,name:'Rin',item:{instanceId:'cup',catalogItemId:'',name:'杯子',category:'其他',description:'玻璃杯',state:'held',location:'右手',condition:'完好'}});
    assert.equal(f.api.read().profiles[key].managed,false);assert.equal(f.api.read().profiles[key].full,false);
  }finally{f.close()}
});
test('手动物品纠正在同轮内不会被迟到填表覆盖，下轮有新剧情时可更新',async()=>{
  const f=await fixture();try{
    await putItem(f,'placed','椅背');const row=m.tableRows(m.resolveTable(f.runtime.book(),m.TABLES.items))[0];
    const ops=[{kind:'cell',table:m.TABLES.items,rowId:Number(row.row_id),column:'穿戴状态',value:'正在穿戴'},{kind:'cell',table:m.TABLES.items,rowId:Number(row.row_id),column:'具体位置',value:'身上'},{kind:'cell',table:m.TABLES.items,rowId:Number(row.row_id),column:'来源',value:'剧情'},{kind:'cell',table:m.TABLES.items,rowId:Number(row.row_id),column:'依据',value:'重新穿上外套'}];
    assert.equal(f.runtime.commitOps('ai',ops).ok,false);assert.equal(f.api.read().instances[0].state,'placed');
    f.ctx.chat.push({id:'ai1',mes:'Rin 重新穿上外套。',is_user:false});f.runtime.syncFloors();assert(f.runtime.commitOps('ai',ops).ok);assert.equal(f.api.read().instances[0].state,'worn');
  }finally{f.close()}
});
test('旧档案的另一件同槽位服饰不挤掉台账当前穿搭，其他缺失字段仍能导入',async()=>{
  const f=await fixture();try{
    await putItem(f,'worn','身上');const record={actorKey:key,name:'Rin',enabled:true,style:'universal',revision:1,fields:{beauty:{鼻型:{value:'鼻梁挺直',source:'manual',evidence:'',floor:0}}},items:{}};
    const args={token:f.api.read().token,record,items:[{...item,instanceId:'old-another',catalogItemId:'wi_other',name:'旧红外套'}]};assert.equal(f.api.previewImport(args).conflicts.length,1);await f.api.importLegacy(args);
    assert.equal(f.api.read().instances.filter(i=>i.state==='worn').length,1);assert.equal(f.api.read().instances[0].instanceId,'rin-coat');assert.equal(f.api.read().archive.records[key].fields.beauty['鼻型'].value,'鼻梁挺直');
  }finally{f.close()}
});
test('原生回退监听尚未完成时，禁止把旧分支当作当前台账读取或写入',async()=>{
  const f=await fixture();try{
    await putItem(f,'worn','身上');f.ctx.chat.push({id:'ai1',mes:'放下',is_user:false,swipes:['放下','继续穿'],swipe_id:0,swipe_info:[{send_date:'x'},{send_date:'y'}]});f.runtime.syncFloors();await putItem(f,'placed','椅背');const token=f.api.read().token;
    f.ctx.chat.at(-1).swipe_id=1;assert.equal(f.api.read().ready,false);assert.deepEqual(f.api.read().instances,[]);await assert.rejects(f.api.writeItem({token,actorKey:key,name:'Rin',item}));
    f.runtime.pruneRemovedAnchors();assert.equal(f.api.read().ready,true);assert.equal(f.api.read().instances[0].state,'worn');
  }finally{f.close()}
});
