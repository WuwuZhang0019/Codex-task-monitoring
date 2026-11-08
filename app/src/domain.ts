export type Status = 'todo' | 'active' | 'blocked' | 'done';
export interface Step { id:string; title:string; line:string; purpose:string; sourceExcerpt:string; dependsOn:string[]; acceptance:string[]; status:Status; summary:string; nextAction:string; blocker:string; evidence:string }
export interface Project { id:string; name:string; goal:string; source:string; steps:Step[]; revision:number; createdAt:string; updatedAt:string }
export interface Extraction { name:string; goal:string; steps:Step[]; warnings:string[] }
export const statusNames:Record<Status,string> = {todo:'未开始',active:'进行中',blocked:'受阻',done:'已记录完成'};
export class ApiError extends Error { constructor(message:string,public status:number){super(message);} }
export async function api<T>(path:string, method='GET',body?:unknown):Promise<T> {
  const controller=new AbortController(); const timeout=setTimeout(()=>controller.abort(),100000);
  try {
    const response=await fetch(`/api${path}`,{method,headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined,signal:controller.signal});
    const data=await response.json(); if(!response.ok)throw new ApiError(data.error||`请求失败 (${response.status})`,response.status);
    return data as T;
  } catch(error) { if(error instanceof DOMException && error.name==='AbortError')throw new Error('请求超时，请检查本地服务或模型连接。'); throw error; }
  finally {clearTimeout(timeout);}
}
export function blankStep(id='M01'):Step {return {id,title:'',line:'主线',purpose:'',sourceExcerpt:'',dependsOn:[],acceptance:[''],status:'todo',summary:'',nextAction:'',blocker:'',evidence:''};}
export function graphError(steps:Step[]):string {
  if(steps.length>60)return '首版最多支持 60 个站点。';
  const ids=new Set<string>();
  for(const s of steps){if(!s.id.trim()||!s.title.trim())return '请填写每个站点的编号与名称。';if(ids.has(s.id))return `站点编号 ${s.id} 重复。`;ids.add(s.id);if(!s.acceptance.some(x=>x.trim()))return `请填写 ${s.id} 的完成条件。`;}
  for(const s of steps){if(new Set(s.dependsOn).size!==s.dependsOn.length)return `${s.id} 的依赖有重复。`;for(const d of s.dependsOn){if(d===s.id)return `${s.id} 不能依赖自己。`;if(!ids.has(d))return `${s.id} 的前置 ${d} 不存在。`;}}
  const visited=new Set<string>(),visiting=new Set<string>(),map=new Map(steps.map(s=>[s.id,s]));
  function visit(id:string):boolean {if(visiting.has(id))return false;if(visited.has(id))return true;visiting.add(id);for(const d of map.get(id)!.dependsOn){if(!visit(d))return false;}visiting.delete(id);visited.add(id);return true;}
  for(const s of steps)if(!visit(s.id))return '依赖中存在循环，请修改后再生成路线。';return '';
}
export function readiness(steps:Step[]) {
  const byId=new Map(steps.map(s=>[s.id,s])), complete=new Map<string,boolean>();
  function valid(id:string, trail=new Set<string>()):boolean {if(complete.has(id))return complete.get(id)!;if(trail.has(id))return false;const s=byId.get(id);if(!s)return false;const next=new Set(trail);next.add(id);const result=s.status==='done'&&s.dependsOn.every(d=>valid(d,next));complete.set(id,result);return result;}
  steps.forEach(s=>valid(s.id));
  return {complete,ready:(s:Step)=>s.dependsOn.every(id=>complete.get(id)===true)};
}
export function routeLayout(steps:Step[]) {
  const baseLanes=[...new Set(steps.map(s=>s.line||'主线'))];
  const ranks=new Map<string,number>(),byId=new Map(steps.map(s=>[s.id,s]));
  function rank(id:string):number {if(ranks.has(id))return ranks.get(id)!;const deps=byId.get(id)?.dependsOn||[];const r=deps.length?Math.max(...deps.map(rank))+1:0;ranks.set(id,r);return r;}
  const allocations=new Map<string,{base:string;track:number;col:number}>(),trackCounts=new Map<string,number>();
  const occupied=new Set<string>();
  for(const s of steps){const base=s.line||'主线',col=rank(s.id);let track=0;while(occupied.has(`${base}:${track}:${col}`))track++;occupied.add(`${base}:${track}:${col}`);allocations.set(s.id,{base,track,col});trackCounts.set(base,Math.max(trackCounts.get(base)||1,track+1));}
  const lanes:string[]=[],offsets=new Map<string,number>();
  for(const base of baseLanes){offsets.set(base,lanes.length);for(let t=0;t<(trackCounts.get(base)||1);t++)lanes.push(t?`${base}分支 ${t+1}`:base);}
  const positions=new Map<string,{x:number,y:number,lane:number}>();
  for(const s of steps){const a=allocations.get(s.id)!,lane=offsets.get(a.base)!+a.track;positions.set(s.id,{x:150+a.col*205,y:80+lane*126,lane});}
  return {lanes,positions,width:Math.max(640,...[...positions.values()].map(p=>p.x+160)),height:Math.max(230,lanes.length*126+35)};
}
export const BRANCH_SOURCE=`# 并行路线验收样例\n目标：验证两条开发线并行后自动合流，及总结的本地保存。\n\n## M01 确认数据契约\n前置：无\n完成条件：步骤编号唯一；依赖关系明确\n\n## S01 实现本地保存\n线路：服务线\n前置：M01\n完成条件：重启后仍能读取已保存记录\n\n## D01 实现圆圈路线\n线路：界面线\n前置：M01\n完成条件：无需拖动，能辨认分叉和合流\n\n## I01 联合验证\n线路：集成线\n前置：S01, D01\n完成条件：路线、详情、保存恢复组成可用闭环\n`;
export function branchSample():Extraction {
  const make=(id:string,title:string,line:string,deps:string[],acceptance:string)=>({...blankStep(id),title,line,dependsOn:deps,acceptance:[acceptance],purpose:title,sourceExcerpt:`## ${id} ${title}`});
  return {name:'并行路线验收样例',goal:'验证两条开发线并行后自动合流，及总结的本地保存。',warnings:['这是固定验收样例，不是 AI 提取结果；所有状态均为未开始。'],steps:[make('M01','确认数据契约','主线',[],'步骤编号唯一；依赖关系明确'),make('S01','实现本地保存','服务线',['M01'],'重启后仍能读取已保存记录'),make('D01','实现圆圈路线','界面线',['M01'],'无需拖动，能辨认分叉和合流'),make('I01','联合验证','集成线',['S01','D01'],'路线、详情、保存恢复组成可用闭环')]};
}
