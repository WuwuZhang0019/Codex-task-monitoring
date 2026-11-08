import {useEffect,useRef,useState} from 'react';
import {api} from './domain';

type TextOutput={kind:string;text:string;stationId?:string};
type Plan={id:string;version:string;date?:string;sourcePath?:string;chapter?:string;goal?:string;source:string;acceptance?:string[]};
type Data={projectId:string;stationId:string;revision:number;fingerprint:string;date:string;conclusion:string;reason:string;warnings:string[];audit:TextOutput;instructions:TextOutput[];report:TextOutput|null;branches:{stationId:string;station:string;status:string}[];canSelectEdge:boolean;choices:{id:string;label:string}[];sources:{id:string;label:string}[];diff:{initial:Plan|null;current:Plan|null;fields:{field:string;before:unknown;after:unknown;changed:boolean}[];stationChanges:unknown;initialSnapshot:unknown;taskGoals:unknown;currentConformance:string;initialConformance:string;impact:string;declaredImpact:string;rechecks:unknown;history:unknown}};
const labels:Record<string,string>={source:'方案原文',sourcePath:'来源路径',chapter:'方案章节',goal:'项目目标',acceptance:'项目验收条件'};
const show=(v:unknown)=>typeof v==='string'?v:JSON.stringify(v,null,2)??'待核实';
export function OutputPanel({projectId}:{projectId:string}){
 const [data,setData]=useState<Data>(),[stationId,setStationId]=useState(''),[sourceId,setSourceId]=useState(''),[successorId,setSuccessorId]=useState(''),[error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[copying,setCopying]=useState(false),[refresh,setRefresh]=useState(0);
 const sequence=useRef(0),alive=useRef(true);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;sequence.current++;};},[]);
 useEffect(()=>{let active=true;const seq=++sequence.current;setData(undefined);setBusy(true);setError('');setMessage('');
  api<Data>(`/projects/${projectId}/outputs`,'POST',{stationId,sourceId,successorId}).then(v=>{if(active&&seq===sequence.current)setData(v);}).catch(e=>{if(active)setError(String(e));}).finally(()=>{if(active)setBusy(false);});
  return()=>{active=false;};
 },[projectId,stationId,sourceId,successorId,refresh]);
 async function copy(output:TextOutput){
  if(!data||copying)return;const current=data,seq=sequence.current;setCopying(true);setMessage('');setError('');
  try{
   await api<Data>(`/projects/${projectId}/outputs`,'POST',{stationId:current.stationId,sourceId,successorId,expectedFingerprint:current.fingerprint});
   if(!alive.current||seq!==sequence.current)return;
   if(!navigator.clipboard?.writeText)throw new Error('浏览器不支持剪贴板，请手动选择当前预览');
   await navigator.clipboard.writeText(output.text);
   if(alive.current&&seq===sequence.current)setMessage('已复制当前预览；尚未发送到任何聊天。');
  }catch(e){if(alive.current&&seq===sequence.current){setError(`复制失败：${String(e)}`);if(String(e).includes('状态或方案已变化'))setData(undefined);}}
  finally{if(alive.current)setCopying(false);}
 }
 function preview(o:TextOutput,title:string,key:string){return <article className="output-card" key={key}><div className="section-top"><h3>{title}</h3><button className="button" disabled={copying||busy} onClick={()=>void copy(o)}>复制{title}</button></div><pre data-testid={key} tabIndex={0}>{o.text}</pre></article>;}
 const d=data?.diff;
 return <section className="route-section outputs" aria-label="指令与方案差异"><div className="section-top"><h2>指令、回执与方案差异</h2><button className="button" disabled={busy||copying} onClick={()=>setRefresh(n=>n+1)}>重新生成输出</button></div>
 <p>核对提示词用于检查路线并生成指令；实际执行指令用于本站工作。全部内容仅供预览和复制，尚未发送；每次复制前重新检查当前状态。</p>
 {error&&<p className="error-box" role="alert">{error}</p>}{message&&<p role="status">{message}</p>}{busy&&<p role="status">正在生成当前对象输出…</p>}
 {data&&<><div className="output-selectors"><label className="field"><span>输出站点</span><select aria-label="输出站点" disabled={copying} value={stationId||data.stationId} onChange={e=>{setData(undefined);setStationId(e.target.value);setSourceId('');setSuccessorId('');}}>{data.choices.map(s=><option key={s.id} value={s.id}>{s.label}</option>)}</select></label><label className="field"><span>输出来源快照</span><select aria-label="输出来源快照" disabled={copying} value={sourceId} onChange={e=>{setData(undefined);setSourceId(e.target.value);}}><option value="">采用有效回执来源或唯一已登记来源</option>{data.sources.map(s=><option key={s.id} value={s.id}>{s.label}</option>)}</select></label></div>
 {data.canSelectEdge&&<label className="field"><span>逐边输出</span><select aria-label="逐边输出" disabled={copying} value={successorId} onChange={e=>{setData(undefined);setSuccessorId(e.target.value);}}><option value="">汇总全部后继</option>{data.branches.map(b=><option key={b.stationId} value={b.stationId}>{b.station} · {b.status}</option>)}</select></label>}
 <p data-testid="output-conclusion">当前结论：{data.conclusion}；{data.reason}；关系版本 {data.revision}；日期 {data.date}</p>
 {!!data.warnings.length&&<div role="status" className="output-warning">{data.warnings.map(w=><p key={w}>{w}</p>)}</div>}
 <details><summary>逐边交接及全部依赖</summary><pre>{show(data.branches)}</pre></details>
 {preview(data.audit,'核对提示词','output-audit')}
 {data.instructions.map((o,i)=>preview(o,`执行指令 ${i+1}`,'output-execution-'+i))}
 {data.report&&preview(data.report,'等待或结束回执','output-report')}
 {d&&<div className="plan-comparison"><h3>初始方案与当前方案</h3><p>符合当前方案：{d.currentConformance}；符合最初方案：{d.initialConformance}</p><p>{d.impact}</p><p>登记的变更影响（待核验）：{d.declaredImpact}</p><p>这里只展示差异，不批准或应用范围变更。</p>
 <div className="plan-columns">{[['初始',d.initial],['当前',d.current]].map(([label,p])=>{const plan=p as Plan|null;return <article key={String(label)}><h4>{String(label)}方案：{plan?.version||'待核实'}</h4><p>{plan?.sourcePath||'来源路径待核实'}；{plan?.date||'日期待核实'}；{plan?.chapter||'章节待核实'}</p><p>目标：{plan?.goal||'待核实'}</p><p>验收：{plan?.acceptance?.join('；')||'待核实'}</p><details><summary>{String(label)}方案原文</summary><pre data-testid={label==='初始'?'plan-initial-source':'plan-current-source'}>{plan?.source||'待核实'}</pre></details></article>;})}</div>
 <table><thead><tr><th>对照项</th><th>初始</th><th>当前</th><th>差异</th></tr></thead><tbody>{d.fields.map(f=><tr key={f.field}><th>{labels[f.field]}</th><td>{f.field==='source'?'见初始原文':show(f.before)}</td><td>{f.field==='source'?'见当前原文':show(f.after)}</td><td>{f.changed?'有变化':'无文字差异'}</td></tr>)}</tbody></table>
 <details><summary>关联站点目标、范围、验收与依赖差异</summary><pre data-testid="plan-station-diff">{d.stationChanges===null?'待核验：没有历史站点快照，无法重建旧站点':show(d.stationChanges)}</pre><p>快照为登记时观察到的站点头部，不等于原方案首次写入时的状态。</p><pre>{show(d.initialSnapshot)}</pre></details>
 <details><summary>保留的任务初始目标与当前目标</summary><pre>{show(d.taskGoals)}</pre></details>
 <details><summary>证据失效或待复核影响</summary><pre>{show(d.rechecks)}</pre></details><p>保留的历史数量：{show(d.history)}</p></div>}
 </>}
 </section>;
}
