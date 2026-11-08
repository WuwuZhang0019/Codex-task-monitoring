import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRelationships } from './relationships.mjs';
const sample = () => ({folders:[{id:'F'}],tasks:[{id:'T',folderId:'F',acceptance:['完成']}],chats:[{id:'C1',taskId:'T',folderId:'F'},{id:'C2',taskId:'T',folderId:'F'}],stations:[{id:'S',taskId:'T',code:'M01',planId:null,dependsOn:[],successors:[]}],plans:[]});
test('换聊天保留任务和站点身份，返回隔离副本', () => {
  const model=sample(), result=validateRelationships(model);
  assert.equal(result.chats.length,2); assert.equal(result.stations[0].id,'S');
  result.tasks[0].id='changed'; assert.equal(model.tasks[0].id,'T');
});
test('拒绝跨文件夹聊天及缺失身份', () => {
  const model=sample();model.chats[1].folderId='OTHER';assert.throws(()=>validateRelationships(model),/归属/);
  model.chats=[];model.tasks[0].folderId='missing';assert.throws(()=>validateRelationships(model),/不存在/);
});
test('跨任务依赖仍须无环，编号仅在任务内唯一', () => {
  const model=sample();model.tasks.push({id:'U',folderId:null,acceptance:[]});
  model.stations.push({id:'R',taskId:'U',code:'M01',planId:null,dependsOn:['S'],successors:[]});
  validateRelationships(model);model.stations[0].dependsOn=['R'];assert.throws(()=>validateRelationships(model),/循环/);
});

test('候选和暂停记录与主路线分开，不接受执行中状态或重复身份',()=>{
 const m=sample();m.candidates=[{id:'extra',title:'额外优化',reason:'非本期目标',date:'2026-11-08',status:'paused'}];
 assert.equal(validateRelationships(m).candidates[0].status,'paused');
 m.candidates[0].status='active';assert.throws(()=>validateRelationships(m),/候选/);
 m.candidates[0].status='candidate';m.candidates.push({...m.candidates[0]});assert.throws(()=>validateRelationships(m),/候选标识/);
});
