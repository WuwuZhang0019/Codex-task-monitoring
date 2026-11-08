import { HttpError } from './validation.mjs';

// M02 relationship contract. No report or manual status grants acceptance.
export function validateRelationships(model) {
  const fail = message => { throw new HttpError(400, message); };
  if (!model || typeof model !== 'object') fail('关系模型必须是对象');
  const maps = {};
  for (const key of ['folders', 'tasks', 'chats', 'stations', 'plans']) {
    if (!Array.isArray(model[key])) fail(`${key} 必须是数组`);
    maps[key] = new Map();
    for (const item of model[key]) {
      if (!item || typeof item.id !== 'string' || !item.id.trim() || maps[key].has(item.id)) fail(`${key} 标识缺失或重复`);
      maps[key].set(item.id, item);
    }
  }
  for(const key of ['initialPlanId','currentPlanId'])if(model[key]!==undefined&&model[key]!==null&&!maps.plans.has(model[key]))fail('项目方案版本不存在');
  const externalFolders=new Set();
  for(const folder of model.folders){if(folder.externalId){if(externalFolders.has(folder.externalId))fail('文件夹外部标识重复');externalFolders.add(folder.externalId);}}
  for (const task of model.tasks) {
    if (Object.hasOwn(task,'folderIds')) fail('任务只能有一个文件夹归属');
    if (task.folderId !== null && !maps.folders.has(task.folderId)) fail('任务文件夹不存在');
    if (!Array.isArray(task.acceptance)) fail('任务缺少终点验收条件');
  }
  for (const chat of model.chats) {
    const task = maps.tasks.get(chat.taskId);
    if (!task || task.folderId === null || chat.folderId !== task.folderId) fail('聊天与任务文件夹归属不一致');
  }
  const codes = new Set();
  for (const station of model.stations) {
    if (!maps.tasks.has(station.taskId)) fail('站点任务不存在');
    if (typeof station.code !== 'string' || !station.code.trim()) fail('站点编号缺失');
    const code = JSON.stringify([station.taskId, station.code]);
    if (codes.has(code)) fail('任务内站点编号重复');
    codes.add(code);
    if (station.planId !== null && !maps.plans.has(station.planId)) fail('站点方案版本不存在');
    if (!Array.isArray(station.dependsOn) || new Set(station.dependsOn).size !== station.dependsOn.length) fail('站点依赖非法或重复');
    if (!Array.isArray(station.successors)) fail('站点缺少合法后继');
    if(new Set(station.successors).size!==station.successors.length)fail('合法后继重复');
    if(station.verification !== undefined && station.verification !== 'pending')fail('M02 不能写入验收通过状态');
    for (const id of [...station.dependsOn, ...station.successors]) if (id === station.id || !maps.stations.has(id)) fail('站点引用缺失或自环');
  }
  const visited = new Set(), visiting = new Set();
  function visit(id) {
    if (visiting.has(id)) fail('跨任务站点依赖存在循环');
    if (visited.has(id)) return;
    visiting.add(id);
    maps.stations.get(id).dependsOn.forEach(visit);
    visiting.delete(id); visited.add(id);
  }
  model.stations.forEach(s => visit(s.id));
  for (const plan of model.plans) {
    if (typeof plan.source !== 'string' || typeof plan.version !== 'string') fail('方案原文或版本缺失');
    if (plan.previousId !== null && !maps.plans.has(plan.previousId)) fail('前版方案不存在');
    const seen=new Set([plan.id]);let previous=plan.previousId;
    while(previous!==null){if(seen.has(previous))fail('方案版本存在循环');seen.add(previous);previous=maps.plans.get(previous)?.previousId??null;}
  }
  return structuredClone(model);
}
