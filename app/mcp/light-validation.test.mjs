// 日期：2026-11-13。重放真实失败请求，校验逐字段反馈及脚本生成候选。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {validateLightToolArguments,createLightHandler} from './light.mjs';
import {registrationSnapshot} from '../../plugins/task-workbench/skills/workbench-handoff/scripts/normalize-plan.mjs';
const failed=JSON.parse(await readFile(new URL('../tests/fixtures/invalid-registration-20261113.json',import.meta.url),'utf8'));
test('real failed registration reports all invalid field paths without echoing supplied values or executing a write',async()=>{
 const issues=validateLightToolArguments('workbench_register_plan',failed);
 const paths=issues.map(i=>i.path);
 for(const path of ['/source/sha256','/snapshot/plans/0/endConditions/0','/snapshot/steps/0/acceptance','/snapshot/routes/0/id','/snapshot/routes/0/context'])assert.ok(paths.includes(path),path);
 let authenticated=0;
 const handler=createLightHandler({service:{},authenticate:()=>{authenticated++;return 'fixture';}});
 await assert.rejects(handler.callTool({params:{name:'workbench_register_plan',arguments:failed}}),error=>error.data.validationErrors.length===issues.length);
 assert.equal(authenticated,0);
 assert.ok(!JSON.stringify(issues).includes(failed.source.sha256));
});
test('registrationSnapshot produces valid enums, structured contexts, conditions, routes and lowercase hash for the same three-step case',()=>{
 const projectKey='test-g-rust-test',planKey='test-plan-01';
 const mapping=['A','B','C'].map((code,i)=>({key:code,code,originalCode:code,parentKey:null,title:code,locator:'步骤/'+code,order:i+1,dependsOn:i?[['A','B'][i-1]]:[],acceptance:i===1?'实际等待至少10秒后返回成功':'返回成功'}));
 const snapshot=registrationSnapshot({date:'2026-11-13',mapping,afterSha256:failed.source.sha256.toLowerCase()},{projectKey,planKey,name:'测试方案01',sourcePath:failed.source.path,version:'2026-11-13',context:{sessionGroup:'A',threadId:null,hostId:null,folderId:null,worktreeOrdinal:1,worktreePath:'G:\\rust\\test',branch:null,head:null,trust:'declared'}});
 assert.deepEqual(validateLightToolArguments('workbench_register_plan',{...failed,source:{...failed.source,sha256:failed.source.sha256.toLowerCase()},snapshot}),[]);
});
