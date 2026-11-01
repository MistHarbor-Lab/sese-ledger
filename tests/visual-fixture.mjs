import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
export async function modules() {
  const result=await build({stdin:{contents:`export * from './src/visual/schema';export * from './src/visual/domain';export * from './src/visual/api';export * from './src/sese-ledger/core/blueprint';export * from './src/sese-ledger/core/book';export * from './src/sese-ledger/core/runtime';export * from './src/sese-ledger/core/scribe';`,resolveDir:root,loader:'ts'},bundle:true,write:false,format:'esm',platform:'node',logLevel:'silent'});
  return import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
}
export const m=await modules(), original=JSON.parse(await readFile(new URL('../src/sese-ledger/assets/standard-template.json',import.meta.url),'utf8'));
export const key='character:rin';
export async function fixture() {
  const files=new Map(),ctx={chatId:'chat-one',characterId:0,groupId:null,characters:[{avatar:'Rin.png'}],chatMetadata:{},chat:[{id:'ai0',send_date:'2026-11-01T00:00:00',mes:'Rin 是黑发，穿灰色外套。',is_user:false}]};
  const template=m.normalizeTemplateAny(m.withVisualTemplateV2(original)).workbook;
  const runtime=m.createLedgerRuntime({host:{context:()=>({chat:ctx.chat,host:{chat:ctx.chat,chatMetadata:ctx.chatMetadata,saveChatMetadata:async()=>{},chatKey:ctx.chatId},characterId:'Rin.png',chatKey:ctx.chatId})},files:{readJson:async name=>files.has(name)?{found:true,value:structuredClone(files.get(name))}:{found:false},uploadJson:async(name,value)=>{files.set(name,structuredClone(value));return{ok:true}}},index:{readIndex:async()=>({chats:{}}),writeIndex:async()=>{}},standardTemplate:template,resolveSeedTemplate:()=>template,resolveConvergeTemplate:()=>template});
  await runtime.onChatChanged();assert(await runtime.ensureSeeded());
  assert(runtime.commitOps('bridge',[{kind:'row_insert',table:'重要角色表',row:{姓名:'Rin',性别:'男',生日:'2001-01-01'}},{kind:'row_insert',table:'主角信息表',row:{姓名:'玩家',性别:'男',生日:'2000-01-01'}},{kind:'row_insert',table:'在场角色表',row:{姓名:'Rin',当前穿搭:'灰色外套'}}]).ok);
  const api=m.createVisualLedgerApi(runtime,()=>ctx);assert.equal(api.read().ready,true);
  return{ctx,runtime,api,files,template,close:()=>runtime.__store()?.destroy()};
}
