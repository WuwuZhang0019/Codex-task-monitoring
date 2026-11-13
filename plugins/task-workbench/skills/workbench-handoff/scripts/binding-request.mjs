// Date: 2026-11-13. Build a complete proposal from saved service identities and observed local context.
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {inspectWorkspace} from './context-ledger.mjs';
export function bindingProposal(snapshot,context,{eventId,planId,occurredAt=new Date().toISOString(),reason='Bind the authorized execution scope'}){
 if(snapshot.mode!=='service'||!eventId?.trim()||!context.threadId?.trim()||!context.hostId?.trim())throw Error('SERVICE_IDENTITY_CONTEXT_AND_EVENT_REQUIRED');
 const plan=planId?snapshot.plans.find(p=>p.id===planId):snapshot.plans.length===1?snapshot.plans[0]:null;
 const project=snapshot.projects.find(p=>p.key===plan?.projectKey);
 if(!plan?.id||!project?.id||!Number.isSafeInteger(project.revision))throw Error('EXACT_SERVICE_PLAN_REQUIRED');
 const steps=snapshot.steps.filter(s=>s.planKey===plan.key);
 if(!steps.length||steps.some(s=>!s.id))throw Error('SERVICE_STEP_IDS_REQUIRED');
 const {trust,...source}=plan.source;
 return {schemaVersion:'light-1.0',projectId:project.id,planId:plan.id,expectedRevision:project.revision,eventId,source,occurredAt,reason,
 action:'propose',stepIds:steps.map(s=>s.id),context:{...context,trust:'declared'},bindingId:null,expectedBindingRevision:null,confirmationGrant:null};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [snapshotFile,eventId,output,planId]=process.argv.slice(2);
 if(!snapshotFile||!eventId||!output)throw Error('Usage: node binding-request.mjs <snapshot.json> <eventId> <output.json> [planId]');
 const snapshot=JSON.parse(await readFile(snapshotFile,'utf8'));
 const workspace=await inspectWorkspace(process.cwd());
 const context={sessionGroup:'execution',threadId:process.env.CODEX_THREAD_ID,hostId:'local',folderId:null,worktreeOrdinal:1,worktreePath:workspace.worktreePath,branch:workspace.branch,head:workspace.head,trust:'declared'};
 const request=bindingProposal(snapshot,context,{eventId,planId});
 await writeFile(output,JSON.stringify(request,null,2)+'\n','utf8');
 console.log(JSON.stringify({date:'2026-11-13',eventId,stepCount:request.stepIds.length,output}));
}
