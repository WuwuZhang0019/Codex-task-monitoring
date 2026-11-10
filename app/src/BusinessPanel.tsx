import { useState } from 'react';
import { api } from './domain';

type Context = { basisRevision: number; stationCode: string; originalGoal: string; originalConditions: { conditionId: string; originalText: string }[];
  mainStationCount: number; repairRounds: number; waitingFor: string[]; disposition: string; coverageGaps: unknown[];
  repairs: { repairId: string; problem: string; status: string; rounds: number; failed: number; interrupted: number; pending: number;
    returnAnchor: { stationId: string; conditionIds: string[] }; reassessmentSuggested: boolean;
    attempts: { attemptId: string; executionId: string; method: string; outcome: string; deliveryVersion: string | null; unresolved: string[] }[] }[] };

export function BusinessPanel({ projectId, revision, context, onSaved }: { projectId: string; revision: number; context: unknown; onSaved: () => void }) {
  const snapshot = context as Context | undefined;
  const labels: Record<string, string> = { inProgress: '处理中', pendingReview: '待核验', resolved: '已解决', recheck: '待复核', running: '执行中', failed: '失败', interrupted: '中断', continue_repair: '继续原站修复', continue_station: '继续本站', wait_dependency: '等待依赖', wait_verification: '等待核验', handoff_successor: '交接合法后继', end_task: '任务线结束', end_project: '项目结束' };
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<unknown>();
  const [pending, setPending] = useState<Record<string, unknown>>();
  async function save() {
    setBusy(true); setError('');
    try {
      const body = pending ?? { ...JSON.parse(input), expectedRevision: revision, idempotencyKey: crypto.randomUUID() };
      setPending(body);
      const value = await api(`/projects/${projectId}/business`, 'POST', body);
      setResult(value); setPending(undefined); setInput(''); onSaved();
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  return <section aria-label="业务上下文与修复回归">
    <h3>原目标、修复与回归</h3>
    {snapshot && <>
      <p>依据 revision {snapshot.basisRevision} · 主路线 {snapshot.mainStationCount} 站 · 当前站修复 {snapshot.repairRounds} 轮</p>
      <table><tbody><tr><th>原定目标</th><td>{snapshot.originalGoal}</td></tr><tr><th>原验收条件</th><td>{snapshot.originalConditions?.map(c => `${c.conditionId} ${c.originalText}`).join('、')}</td></tr><tr><th>等待对象</th><td>{snapshot.waitingFor?.join('、') || '无'}</td></tr><tr><th>全局判定</th><td>{labels[snapshot.disposition] || snapshot.disposition}</td></tr></tbody></table>
      {snapshot.repairs?.map(repair => <article className="closure-card" key={repair.repairId}>
        <h4>{repair.problem} · {labels[repair.status] || repair.status}</h4><p>已执行 {repair.rounds} 轮 · 失败 {repair.failed} · 中断 {repair.interrupted} · 待核验 {repair.pending}</p>
        <p>回归位置 {snapshot.stationCode} · 原条件 {repair.returnAnchor.conditionIds.join('、')}</p>
        <p>剩余差距 {repair.attempts.length ? repair.attempts.at(-1)?.unresolved.join('、') || '待按原条件核验' : repair.problem}</p>
        {repair.reassessmentSuggested && <p className="inline-notice">连续两轮差距未缩小，建议重新评估方法。阈值与继续方式等待用户决定。</p>}
        {repair.attempts.map((attempt, i) => <details key={attempt.attemptId}><summary>第 {i + 1} 轮 · {labels[attempt.outcome] || attempt.outcome} · {attempt.method}</summary><p>执行 {attempt.executionId} · 交付 {attempt.deliveryVersion || '待交付'}</p><p>{attempt.unresolved.join('、')}</p></details>)}
      </article>)}
    </>}
    <details><summary>完整续接上下文与证据</summary><pre className="source-text">{JSON.stringify(context, null, 2)}</pre></details>
    <details><summary>人工业务登记</summary>
      <p>服务按当前 revision 核对来源绑定、原条件与认领。支持 bind、claim、takeover、start、repair、receipt、blocker、refine、scopeCandidate、reopen、release、revoke。输入使用已冻结契约，操作回执包含实际 ID。原请求失败后可保留幂等键回查。</p>
      <label className="field"><span>业务登记 JSON</span><textarea aria-label="业务登记 JSON" rows={8} value={input} disabled={busy || !!pending} onChange={e => setInput(e.target.value)} /></label>
      <button className="button" disabled={busy || (!input.trim() && !pending)} onClick={() => void save()}>{pending ? '重放原请求并查询结果' : '保存业务登记'}</button>
      {pending && <button className="button" disabled={busy} onClick={async () => {
        try {
          const value = await api<{ state: string }>('/requests', 'POST', { projectId, operation: `business.${pending.operation}`, idempotencyKey: pending.idempotencyKey });
          setResult(value);
          if (value.state === 'committed') { setPending(undefined); onSaved(); }
        } catch (e) { setError(String(e)); }
      }}>查询原请求</button>}
      {error && <p role="alert" className="error-box">{error}</p>}
      {!!result && <pre className="source-text">{JSON.stringify(result, null, 2)}</pre>}
    </details>
  </section>;
}
