import {useEffect,useState} from 'react';
import {api,type Project} from './domain';

type Entity={id:string;[key:string]:unknown};
type Model={folders:Entity[];tasks:Entity[];chats:Entity[];stations:Entity[];plans:Entity[];initialPlanId:string|null;currentPlanId:string|null;acceptance:string[]};
type Saved={revision:number;model:Model};
const lines=(value:unknown)=>Array.isArray(value)?value.join('\n'):String(value??'');
export function ModelEditor({project}:{project:Project}){
 const [saved,setSaved]=useState<Saved>(),[draft,setDraft]=useState<Model>(),[error,setError]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 async function load(){setBusy(true);setError('');try{const s=await api<Saved>(`/projects/${project.id}/model`);setSaved(s);setDraft(structuredClone(s.model));}catch(e){setError(String(e));}finally{setBusy(false);}}
 useEffect(()=>{void load();},[project.id]);
 function change(group:'folders'|'tasks'|'chats'|'stations'|'plans',id:string,key:string,value:unknown){setDraft(d=>d?{...d,[group]:d[group].map(x=>x.id===id?{...x,[key]:value}:x)}:d);setMessage('');}
 function add(group:'folders'|'tasks'|'chats'|'stations'|'plans'){
  const id=crypto.randomUUID(),base={id};let entity:Entity;
  if(group==='folders')entity={...base,name:'新文件夹',externalId:null};
  else if(group==='tasks')entity={...base,name:'新任务线',goal:'',initialGoal:'',folderId:null,acceptance:[],handoff:''};
  else if(group==='chats')entity={...base,taskId:draft?.tasks[0]?.id||'',folderId:draft?.tasks[0]?.folderId??null,externalId:null,repository:'',worktree:'',branch:'',head:'',location:'',time:new Date().toISOString()};
  else if(group==='stations')entity={...base,taskId:draft?.tasks[0]?.id||'',code:'',title:'',scope:'',planId:draft?.currentPlanId??null,chapter:'',acceptance:[],dependsOn:[],successors:[],verification:'pending'};
  else entity={...base,version:'',date:new Date().toLocaleDateString('sv-SE'),source:project.source,sourcePath:'',chapter:'',summary:'',goal:project.goal,acceptance:[],previousId:draft?.currentPlanId??null,impact:''};
  setDraft(d=>d?{...d,[group]:[...d[group],entity]}:d);
 }
 async function save(){if(!saved||!draft)return;setBusy(true);setError('');try{const result=await api<Saved>(`/projects/${project.id}/model`,'PUT',{revision:saved.revision,model:draft});setSaved(result);setDraft(structuredClone(result.model));setMessage('关系与方案版本已保存，验收结果请查看核验监测。');}catch(e){setError(String(e));}finally{setBusy(false);}}
 if(!draft||!saved)return <p role="status">{error||'正在读取关系…'}</p>;
 const dirty=JSON.stringify(draft)!==JSON.stringify(saved.model);
 function field(group:'folders'|'tasks'|'chats'|'stations'|'plans',e:Entity,key:string,label:string,multiline=false,locked=false){return <label className="field" key={key}><span>{label}</span>{multiline?<textarea aria-label={`${e.id} ${label}`} value={lines(e[key])} disabled={busy||locked} rows={3} onChange={v=>change(group,e.id,key,Array.isArray(e[key])?v.target.value.split('\n').filter(Boolean):v.target.value)}/>:<input aria-label={`${e.id} ${label}`} value={lines(e[key])} disabled={busy||locked} onChange={v=>change(group,e.id,key,v.target.value||null)}/>}</label>;}
 function select(group:'tasks'|'chats'|'stations',e:Entity,key:string,label:string,choices:Entity[],locked=false){return <label className="field"><span>{label}</span><select aria-label={`${e.id} ${label}`} value={String(e[key]??'')} disabled={busy||locked} onChange={v=>{
  change(group,e.id,key,v.target.value||null);
  if(group==='chats'&&key==='taskId')change(group,e.id,'folderId',draft!.tasks.find(t=>t.id===v.target.value)?.folderId??null);
 }}><option value="">待绑定</option>{choices.map(x=><option key={x.id} value={x.id}>{String(x.name||x.code||x.version||x.externalId||x.id)}</option>)}</select></label>;}
 return <div className="model-editor">
 <p>项目：{project.name}。任务固定归属一个文件夹，可关联多个聊天。旧记录只作报告保留，验收结果请查看核验监测。</p>
 <p>关系版本：{saved.revision}；保存版本与方案版本分别记录。离开前请保存修改。</p>
 {error&&<p role="alert" className="error-box">{error}</p>}{message&&<p role="status">{message}</p>}
 <h3>文件夹</h3>{draft.folders.map(e=><fieldset key={e.id}><legend>{e.id}</legend>{field('folders',e,'name','文件夹名称')}{field('folders',e,'externalId','Codex 项目标识（可待绑定）')}</fieldset>)}<button className="button" disabled={busy} onClick={()=>add('folders')}>添加文件夹</button>
 <h3>任务线</h3>{draft.tasks.map(e=><fieldset key={e.id}><legend>{String(e.name||e.id)}</legend>{field('tasks',e,'name','任务名称')}{field('tasks',e,'goal','任务目标',true)}{field('tasks',e,'initialGoal','原始任务目标（按初始方案确认，保存后不可覆盖）',true,!!saved.model.tasks.find(t=>t.id===e.id&&t.initialGoal))}{select('tasks',e,'folderId','唯一所属文件夹',draft.folders,!!saved.model.tasks.find(t=>t.id===e.id&&t.folderId!==null))}{field('tasks',e,'acceptance','终点验收条件（每行一项）',true)}{field('tasks',e,'handoff','交接对象')}</fieldset>)}<button className="button" disabled={busy} onClick={()=>add('tasks')}>添加任务线</button>
 <h3>聊天来源</h3>{draft.chats.map(e=><fieldset key={e.id}><legend>{e.id}</legend>{select('chats',e,'taskId','关联任务',draft.tasks)}{field('chats',e,'externalId','聊天标识（可待绑定）')}{['repository','worktree','branch','head','location','time'].map((k,i)=>field('chats',e,k,['仓库','工作树','分支','HEAD 快照（执行前复核）','消息或回执位置','记录时间'][i]))}</fieldset>)}<button className="button" disabled={busy} onClick={()=>add('chats')}>添加聊天来源</button>
 <h3>方案版本</h3>{draft.plans.map(e=>{const locked=saved.model.plans.some(p=>p.id===e.id);return <fieldset key={e.id}><legend>{String(e.version||'新版本')} {locked?'（已保存，原文不可覆盖）':''}</legend>{['version','date','sourcePath','chapter','summary','goal','impact'].map((k,i)=>field('plans',e,k,['版本号','方案日期','来源路径','章节','摘要','初始目标','变更影响'][i],false,locked))}{field('plans',e,'source','方案原文',true,locked)}{field('plans',e,'acceptance','项目验收条件（每行一项）',true,locked)}</fieldset>;})}<button className="button" disabled={busy} onClick={()=>add('plans')}>添加方案版本</button>
 {(['initialPlanId','currentPlanId'] as const).map(key=><label className="field" key={key}><span>{key==='initialPlanId'?'初始方案':'当前方案'}</span><select aria-label={key==='initialPlanId'?'初始方案':'当前方案'} disabled={busy||(key==='initialPlanId'&&saved.model.initialPlanId!==null)} value={draft[key]??''} onChange={e=>setDraft({...draft,[key]:e.target.value||null})}><option value="">待绑定</option>{draft.plans.map(p=><option key={p.id} value={p.id}>{String(p.version||p.id)}</option>)}</select></label>)}
 <h3>站点</h3>{draft.stations.map(e=>{const locked=saved.model.stations.some(s=>s.id===e.id);return <fieldset key={e.id}><legend>{String(e.code||e.id)} · 方案头部</legend>{select('stations',e,'taskId','所属任务',draft.tasks,locked)}{field('stations',e,'code','稳定编号',false,locked)}{field('stations',e,'title','站点名称')}{field('stations',e,'scope','目标及范围',true)}{select('stations',e,'planId','方案版本',draft.plans)}{field('stations',e,'chapter','方案章节')}{field('stations',e,'acceptance','站点验收条件（每行一项）',true)}<small>依赖及后继使用下列站点的稳定标识，每行一个：{draft.stations.map(s=>`${s.code}=${s.id}`).join('；')}</small>{field('stations',e,'dependsOn','全部前置站点标识',true)}{field('stations',e,'successors','合法后继站点标识',true)}{!!e.report&&<details><summary>原始报告（不作为验收通过）</summary><pre>{JSON.stringify(e.report,null,2)}</pre></details>}</fieldset>;})}<button className="button" disabled={busy} onClick={()=>add('stations')}>添加站点</button>
 <div className="save-bar"><span>{dirty?'有未保存修改':'已读取保存版本'}</span><button className="button primary" disabled={busy||!dirty} onClick={()=>void save()}>保存任务关系</button><button className="button" disabled={busy} onClick={()=>{if(!dirty||confirm('放弃修改并重新读取？'))void load();}}>重新读取关系</button></div>
 </div>;
}
