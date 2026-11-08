import {useEffect,useState} from 'react';
import {api} from './domain';
type Entity={id:string;[key:string]:unknown};
type Model={stations:Entity[];tasks:Entity[];chats:Entity[];plans:Entity[];acceptance:string[]};
type Receipt={stationId:string;deliveryVersion:string;raw:string;actual:string;next:{stationId:string;goal:string;scope:string;delivery:string}[]};
type Entry={id:string;time:string;identityIssue:string;receipt:Receipt};
type Check={criterion:string;result:string;reason:string;evidenceIds:string[]};
type Evidence={id:string;location:string;deliveryVersion:string;method:string;reason:string;result:string};
type Handoff={stationId:string;result:string;reason:string};
type Review={reviewer:string;method:string;checks:Check[];taskChecks:Check[];projectChecks:Check[];evidence:Evidence[];handoffs:Handoff[]};
type Inspection={revision:number;results:Record<string,{conclusion:string;reason:string;acceptance:unknown;handoffs:unknown;waiting:string[]}>;log:{receipts:Entry[];reviews:{id:string;receiptId:string;time:string;review:Review}[];events:unknown[];invalidations:unknown[]};quarantined:{id:string;reason:string}[]};
const strings=(v:unknown):string[]=>Array.isArray(v)?v.map(String):[];
export function ReceiptPanel({projectId}:{projectId:string}){
 const [model,setModel]=useState<Model>(),[data,setData]=useState<Inspection>(),[stationId,setStationId]=useState(''),[selected,setSelected]=useState('');
 const [input,setInput]=useState(''),[review,setReview]=useState<Review>(),[error,setError]=useState(''),[busy,setBusy]=useState(false),[note,setNote]=useState(''),[invalidReason,setInvalidReason]=useState('');
 async function load(){setBusy(true);try{const [m,d]=await Promise.all([api<{model:Model}>(`/projects/${projectId}/model`),api<Inspection>(`/projects/${projectId}/receipts`)]);setModel(m.model);setData(d);setError('');}catch(e){setError(String(e));}finally{setBusy(false);}}
 useEffect(()=>{void load();},[projectId]);
 const station=model?.stations.find(s=>s.id===stationId),entry=data?.log.receipts.find(e=>e.id===selected);
 function template(id:string){
  setStationId(id);const s=model?.stations.find(s=>s.id===id),t=model?.tasks.find(t=>t.id===s?.taskId),c=model?.chats.find(c=>c.taskId===t?.id);
  setInput(JSON.stringify({projectId,folderId:t?.folderId??'',taskId:t?.id??'',stationId:id,planId:s?.planId??'',sourceId:c?.id??'',deliveryVersion:'',raw:'',actual:'',blockers:[],checks:strings(s?.acceptance).map(criterion=>({criterion,result:'pending'})),next:strings(s?.successors).map(stationId=>({stationId,goal:'',scope:'',delivery:''}))},null,2));
 }
 function selectReceipt(id:string){
  setSelected(id);const e=data?.log.receipts.find(e=>e.id===id),s=model?.stations.find(s=>s.id===e?.receipt.stationId),t=model?.tasks.find(t=>t.id===s?.taskId);let count=0;const evidence:Evidence[]=[];
  function checks(criteria:string[]){return criteria.map(criterion=>{const id=`e${++count}`;evidence.push({id,location:'',deliveryVersion:e?.receipt.deliveryVersion??'',method:'',reason:'',result:'pending'});return {criterion,result:'pending',reason:'',evidenceIds:[id]};});}
  const projectModel=model as Model&{initialPlanId?:string;currentPlanId?:string};const initial=model?.plans.find(p=>p.id===projectModel.initialPlanId),current=model?.plans.find(p=>p.id===projectModel.currentPlanId);
  const projectCriteria=[...new Set([...(model?.acceptance??[]),...strings(initial?.acceptance),...strings(current?.acceptance),...(typeof initial?.goal==='string'&&initial.goal.trim()?[`原始目标：${initial.goal}`]:[])])];
  const checks1=checks(strings(s?.acceptance)),taskChecks=checks([...strings(t?.acceptance),...(typeof t?.initialGoal==='string'&&t.initialGoal.trim()?[`原始任务目标：${t.initialGoal}`]:[])]),projectChecks=checks(projectCriteria);
  setReview({reviewer:'',method:'',checks:checks1,taskChecks,projectChecks,evidence,handoffs:strings(s?.successors).map(stationId=>({stationId,result:'pending',reason:''}))});
 }
 async function command(action:Record<string,unknown>){if(!data)return;setBusy(true);setError('');setNote('');try{const d=await api<Inspection>(`/projects/${projectId}/receipts`,'POST',{revision:data.revision,...action});setData(d);setNote('记录已保存。重复的相同导入或核验不会新增历史事件。');}catch(e){setError(String(e));}finally{setBusy(false);}}
 function patchCheck(group:'checks'|'taskChecks'|'projectChecks',index:number,key:'result'|'reason',value:string){setReview(r=>r?{...r,[group]:r[group].map((c,i)=>i===index?{...c,[key]:value}:c)}:r);}
 function patchEvidence(id:string,key:string,value:string){setReview(r=>r?{...r,evidence:r.evidence.map(e=>e.id===id?{...e,[key]:value}:e)}:r);}
 if(!data||!model)return <div role="status">{error||'正在读取回执…'}<button onClick={()=>void load()}>重新读取</button></div>;
 return <div className="model-editor">
 <p>先在“管理任务与方案版本”绑定任务、文件夹、聊天和站点方案。导入只登记来源自述；以下独立人工核验才登记证据判断，不会自动读取文件、访问证据链接或调用模型。</p>
 {error&&<p role="alert" className="error-box">{error}</p>}{note&&<p role="status">{note}</p>}
 <button className="button" disabled={busy} onClick={()=>void load()}>刷新回执与判断</button>
 <h3>导入完成回执</h3><label className="field"><span>本站</span><select aria-label="回执站点" value={stationId} onChange={e=>template(e.target.value)}><option value="">选择站点</option>{model.stations.map(s=><option key={s.id} value={s.id}>{String(s.code)} · {String(s.title)}</option>)}</select></label>
 {station&&<p>本站头：{String(station.title)}；范围：{String(station.scope||'待核实')}；验收：{strings(station.acceptance).join('；')}</p>}
 <label className="field"><span>结构化回执 JSON（raw 保留完整原文，actual 填实际交付；空字段须核实后填写）</span><textarea aria-label="待导入回执" rows={16} value={input} onChange={e=>setInput(e.target.value)}/></label>
 <label className="button">读取回执文件<input aria-label="回执文件" type="file" accept=".json,application/json" onChange={async e=>{const f=e.target.files?.[0];if(f){if(f.size>1000000){setError('回执文件超过 1MB');return;}setInput(await f.text());}}}/></label>
 <button className="button primary" disabled={busy||!input.trim()} onClick={()=>{try{void command({action:'import',receipt:JSON.parse(input)});}catch(e){setError(String(e));}}}>导入回执</button>
 <h3>归属待核对</h3>{data.quarantined.length?data.quarantined.map(q=><p key={q.id}>{q.id}：{q.reason}；未归入当前站点，不可核验推进。</p>):<p>无隔离回执</p>}
 <h3>回执历史与独立核验</h3><select aria-label="选择历史回执" value={selected} onChange={e=>selectReceipt(e.target.value)}><option value="">选择回执</option>{data.log.receipts.map(e=><option key={e.id} value={e.id}>{e.time} · {e.receipt.stationId} · {e.id}</option>)}</select>
 {entry&&review&&<>
 <details open><summary>原回执与本站交付版本</summary><pre>{JSON.stringify(entry.receipt,null,2)}</pre></details>
 <label className="field"><span>核验人</span><input aria-label="核验人" value={review.reviewer} onChange={e=>setReview({...review,reviewer:e.target.value})}/></label>
 <label className="field"><span>核验方法与适用范围</span><textarea aria-label="核验方法" value={review.method} onChange={e=>setReview({...review,method:e.target.value})}/></label>
 {(['checks','taskChecks','projectChecks'] as const).map(group=><section key={group}><h3>{{checks:'本站验收',taskChecks:'任务终点验收',projectChecks:'项目最终验收'}[group]}</h3>{review[group].map((c,i)=>{const evidence=review.evidence.find(e=>e.id===c.evidenceIds[0])!;return <fieldset key={c.criterion}><legend>{c.criterion}</legend><label className="field"><span>核验结果</span><select aria-label={`${group}-${i}-结果`} value={c.result} onChange={e=>patchCheck(group,i,'result',e.target.value)}><option value="pending">待核验</option><option value="passed">通过</option><option value="failed">未通过</option></select></label><label className="field"><span>逐项判断依据</span><input aria-label={`${group}-${i}-依据`} value={c.reason} onChange={e=>patchCheck(group,i,'reason',e.target.value)}/></label>{(['location','deliveryVersion','method','reason'] as const).map((key,k)=><label className="field" key={key}><span>{['证据位置','适用交付版本','实际检查方法','证据可用性依据'][k]}</span><input aria-label={`${group}-${i}-${key}`} value={evidence[key]} onChange={e=>patchEvidence(evidence.id,key,e.target.value)}/></label>)}<label className="field"><span>证据核验（登记引用本身不代表已核验）</span><select aria-label={`${group}-${i}-证据状态`} value={evidence.result} onChange={e=>patchEvidence(evidence.id,'result',e.target.value)}><option value="pending">待核验</option><option value="valid">我已按记录的方法检查，证据有效</option><option value="invalid">无效</option></select></label></fieldset>;})}</section>)}
 <h3>尾部与后继头部对照</h3>{review.handoffs.map((h,i)=>{const target=model.stations.find(s=>s.id===h.stationId);return <fieldset key={h.stationId}><legend>{String(target?.code)}</legend><pre>后继头：{JSON.stringify(target,null,2)}{'\n'}本站尾：{JSON.stringify(entry.receipt.next.find(n=>n.stationId===h.stationId)??'缺失',null,2)}</pre><select aria-label={`交接-${i}-结果`} value={h.result} onChange={e=>setReview({...review,handoffs:review.handoffs.map((x,j)=>j===i?{...x,result:e.target.value}:x)})}><option value="pending">待核验</option><option value="matched">目标、范围及交付一致（允许措辞不同）</option><option value="mismatch">不匹配</option></select><input aria-label={`交接-${i}-依据`} placeholder="具体比较目标、范围、交付，不能只看编号" value={h.reason} onChange={e=>setReview({...review,handoffs:review.handoffs.map((x,j)=>j===i?{...x,reason:e.target.value}:x)})}/></fieldset>;})}
 <button className="button primary" disabled={busy} onClick={()=>void command({action:'review',receiptId:entry.id,review})}>保存独立核验</button>
 </>}
 <h3>当前核验判断（关闭状态见核验监测）</h3>{Object.values(data.results).map(r=><div key={r===undefined?'':JSON.stringify(r)}><strong>{r.conclusion} · {r.reason}</strong><pre>{JSON.stringify(r,null,2)}</pre></div>)}
 <h3>核验历史与失效记录</h3><label className="field"><span>失效原因</span><input aria-label="失效原因" value={invalidReason} onChange={e=>setInvalidReason(e.target.value)}/></label>{data.log.reviews.map(v=><details key={v.id}><summary>{v.time} · {v.id}</summary><pre>{JSON.stringify(v,null,2)}</pre><button className="button" disabled={busy||!invalidReason.trim()} onClick={()=>void command({action:'invalidate',reviewId:v.id,reason:invalidReason})}>标记本核验失效</button></details>)}<details><summary>历史事件与失效记录</summary><pre>{JSON.stringify({events:data.log.events,invalidations:data.log.invalidations},null,2)}</pre></details>
 </div>;
}
