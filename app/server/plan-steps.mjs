// Read only an explicitly declared complete route from the saved plan source.
// Never infer plan order or completeness from the registered station array.
export function planSteps(plan) {
 const source=plan?.source?.replace(/\r\n/g,'\n')??'';
 const blocks=[...source.matchAll(/^## (?:完整方案步骤|10\. 有限实施路线与交付门槛)\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm)];
 if(blocks.length!==1)return null;
 const body=blocks[0][1],steps=[];
 if(blocks[0][0].startsWith('## 完整方案步骤')){
  const rows=body.trim().split('\n').filter(l=>l.trim());
  for(const [i,row] of rows.entries()){
   const match=row.match(/^(\d+)\. ([A-Za-z][\w.-]*)[：:]\s*(\S.*)$/);
   if(!match||Number(match[1])!==i+1)return null;
   steps.push({code:match[2],title:match[3].trim()});
  }
 }else{
  const tables=body.match(/\| 编号 \| 本站目标与工作 \| 前置 \| 交付与完成条件 \| 下一站 \|\n\|[ -|]+\|\n((?:\|[^\n]+\|\n?)+)/g);
  if(tables?.length!==1)return null;
  for(const row of tables[0].trim().split('\n').slice(2)){
   const cells=row.split('|').slice(1,-1).map(s=>s.trim());
   if(cells.length!==5||!/^M\d+$/.test(cells[0])||!cells[1])return null;
   steps.push({code:cells[0],title:cells[1]});
  }
 }
 return steps.length&&new Set(steps.map(s=>s.code)).size===steps.length?steps:null;
}

export function stepSummary(plan,stations) {
 const steps=planSteps(plan);
 if(steps)return `共 ${steps.length} 步；分别是：\n\n${steps.map((s,i)=>`  ${i+1}. ${s.code}：${s.title}`).join('\n')}\n`;
 const registered=stations.filter(s=>s.planId===plan?.id);
 return `待核实：尚未独立核定所引用方案的完整步骤与总数；已登记的 ${registered.length} 个站点仅作定位，不能当作方案总步数。执行前对照方案原文核定完整清单及顺序\n\n${registered.map((s,i)=>`  ${i+1}. ${s.code}：${s.title}（仅登记定位，非完整方案清单）`).join('\n')}\n`;
}

export function stepCircle(plan,code) {
 const steps=planSteps(plan),index=steps?.findIndex(s=>s.code===code)??-1;
 return index>=0&&index<20?String.fromCodePoint(0x2460+index):'待核实（原方案步骤顺序未核定）';
}
