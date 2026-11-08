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
