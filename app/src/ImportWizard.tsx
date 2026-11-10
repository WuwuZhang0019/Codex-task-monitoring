import { useEffect, useState } from 'react';
import { api, ApiError } from './domain';

type Provenance = { fieldPath: string; origin: string; locator: string; excerpt: string | null; startUtf16: number | null; endUtf16: number | null };
type Condition = { conditionId: string; originalText: string };
type Candidate = { goal: string | null; initialGoal: string | null; endCondition: string | null; provenance: Provenance[];
  declaredStepCount: number | null; tasks: { taskId: string; name: string; goal: string | null }[];
  stations: { stationId: string; code: string; title: string; scope: string; dependsOn: string[]; acceptance: Condition[] }[];
  requirements: { requirementId: string; originalText: string; stationIds: string[]; conditionIds: string[] }[] };
type Draft = { draftId: string; revision: number; name: string; status: string; source: { originalText: string; sourceHash: string; locator: string };
  targetProjectId: string | null; candidate: Candidate; issues: { code: string; path: string; message: string; blocking: boolean }[]; publication?: { projectId: string } };
type Validation = { basisRevision: number; diff: unknown; issues: Draft['issues'] };
type Confirmation = { confirmationGrantId: string; confirmationDigest: string };

export function ImportWizard({ onPublished }: { onPublished: (projectId: string) => void }) {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [draft, setDraft] = useState<Draft>();
  const [bundle, setBundle] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [validation, setValidation] = useState<Validation>();
  const [acknowledged, setAcknowledged] = useState(false);
  const [publicationInput, setPublicationInput] = useState<(Confirmation & { sourceHash: string; idempotencyKey: string })>();
  const [dirty, setDirty] = useState(false);
  const [pendingSave, setPendingSave] = useState<Record<string, unknown>>();
  async function load() { const result = await api<{ drafts: Draft[] }>('/import-drafts'); setDrafts(result.drafts); }
  useEffect(() => { void load().catch(e => setError(String(e))); }, []);
  async function run(action: () => Promise<void>) {
    setBusy(true); setError('');
    try { await action(); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  function select(value: Draft) { setDraft(value); setValidation(undefined); setAcknowledged(false); setPublicationInput(undefined); setBundle(''); setDirty(false); setPendingSave(undefined); }
  function change(path: string, value: string) {
    if (!draft) return;
    const candidate = structuredClone(draft.candidate);
    const keys = path.slice(1).split('/');
    let parent = candidate as unknown as Record<string, unknown>;
    for (const key of keys.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
    parent[keys.at(-1)!] = value || null;
    candidate.provenance = [...candidate.provenance.filter(p => p.fieldPath !== path), { fieldPath: path, origin: 'user', locator: `工作台人工修订 ${new Date().toISOString()}`, excerpt: null, startUtf16: null, endUtf16: null }];
    setDraft({ ...draft, candidate }); setDirty(true); setValidation(undefined); setAcknowledged(false); setPublicationInput(undefined);
  }
  async function save() {
    const input = bundle.trim() ? JSON.parse(bundle) : draft && { name: draft.name, source: draft.source, candidate: draft.candidate, targetProjectId: draft.targetProjectId };
    if (!input) throw new Error('请粘贴 Codex 整理的 source/candidate 草稿 JSON');
    const body = pendingSave ?? { ...input, expectedRevision: draft?.revision ?? 0, idempotencyKey: crypto.randomUUID() };
    setPendingSave(body);
    try {
      const saved = await api<Draft>(draft ? `/import-drafts/${draft.draftId}` : '/import-drafts', draft ? 'PUT' : 'POST', body);
      select(saved); await load();
    } catch (e) { if (e instanceof ApiError && e.status < 500) setPendingSave(undefined); throw e; }
  }
  async function validate() {
    if (!draft) return;
    setValidation(await api<Validation>(`/import-drafts/${draft.draftId}/validate`, 'POST', {}));
    setAcknowledged(false);
  }
  async function publish() {
    if (!draft || !validation) return;
    let input = publicationInput;
    if (!input) {
      const confirmation = await api<Confirmation>(`/import-drafts/${draft.draftId}/confirm`, 'POST', { revision: draft.revision, expectedRevision: validation.basisRevision, acknowledged });
      input = { ...confirmation, sourceHash: draft.source.sourceHash, idempotencyKey: crypto.randomUUID() };
      setPublicationInput(input);
    }
    let result;
    try { result = await api<{ projectId: string }>(`/import-drafts/${draft.draftId}/publish`, 'POST', input); }
    catch (e) { if (e instanceof ApiError && e.status < 500) { setPublicationInput(undefined); setValidation(undefined); setAcknowledged(false); } throw e; }
    await load(); onPublished(result.projectId);
  }
  return <section aria-label="方案草稿集中确认" className="model-editor">
    <h2>方案草稿与集中确认</h2>
    <p>接收 Codex 整理的原文与完整模型。固定输入业务验证已开放，真实会话连接由 U04 接入。</p>
    {error && <p role="alert" className="error-box">{error}</p>}
    <label className="field"><span>已保存草稿</span><select aria-label="已保存草稿" value={draft?.draftId ?? ''} disabled={busy || !!pendingSave} onChange={e => { const value = drafts.find(d => d.draftId === e.target.value); if (value) select(value); else { setDraft(undefined); setValidation(undefined); setBundle(''); setPublicationInput(undefined); setDirty(false); } }}><option value="">新建草稿</option>{drafts.map(d => <option key={d.draftId} value={d.draftId}>{d.name} · r{d.revision} · {d.status}</option>)}</select></label>
    <details open={!draft}><summary>接收结构化草稿及高级修订</summary><label className="field"><span>草稿 JSON</span><textarea aria-label="草稿 JSON" rows={10} value={bundle} disabled={busy || !!pendingSave || draft?.status === 'committed'} onChange={e => { setBundle(e.target.value); setDirty(true); setValidation(undefined); }} placeholder="粘贴包含 name、source、candidate 的 JSON" /></label><label className="button file-button">选择草稿 JSON<input type="file" accept=".json,application/json" disabled={busy || !!pendingSave} onChange={e => { const file = e.target.files?.[0]; if (file) void file.text().then(value => { setBundle(value); setDirty(true); setValidation(undefined); }); }} /></label></details>
    {draft && <>
      <p>草稿 r{draft.revision} · {draft.status} · 来源 {draft.source.locator}</p>
      <details><summary>原文、出处及 SHA256</summary><code>{draft.source.sourceHash}</code><pre className="source-text">{draft.source.originalText}</pre><pre className="source-text">{JSON.stringify(draft.candidate.provenance, null, 2)}</pre></details>
      <fieldset disabled={busy || !!pendingSave || draft.status === 'committed'}><legend>集中补缺</legend>
        {(['initialGoal', 'goal', 'endCondition'] as const).map((key, i) => <label className="field" key={key}><span>{['初始目标', '当前目标', '项目结束条件'][i]}</span><textarea aria-label={['草稿初始目标', '草稿当前目标', '草稿项目结束条件'][i]} rows={2} value={draft.candidate[key] ?? ''} onChange={e => change(`/${key}`, e.target.value)} /></label>)}
        {draft.candidate.tasks.map((task, i) => <label className="field" key={task.taskId}><span>{task.name} 的目标</span><input value={task.goal ?? ''} onChange={e => change(`/tasks/${i}/goal`, e.target.value)} /></label>)}
        <h3>原文完整路线声明 · {draft.candidate.declaredStepCount ?? '待确认'} 站</h3>
        {draft.candidate.stations.map((s, i) => <fieldset key={s.stationId}><legend>{s.code} {s.title}</legend><label className="field"><span>本站范围</span><textarea value={s.scope} rows={2} onChange={e => change(`/stations/${i}/scope`, e.target.value)} /></label><p>全部前置 {s.dependsOn.join('、') || '无'} </p>{s.acceptance.map((c, j) => <label className="field" key={c.conditionId}><span>条件 {c.conditionId}</span><input value={c.originalText} onChange={e => change(`/stations/${i}/acceptance/${j}/originalText`, e.target.value)} /></label>)}</fieldset>)}
      </fieldset>
      <h3>需求覆盖候选</h3><p>逐项核对原始需求、站点及条件的语义对应。</p><table><thead><tr><th>需求</th><th>站点</th><th>条件</th></tr></thead><tbody>{draft.candidate.requirements.map(r => <tr key={r.requirementId}><td>{r.requirementId} {r.originalText}</td><td>{r.stationIds.join('、')}</td><td>{r.conditionIds.join('、')}</td></tr>)}</tbody></table>
      <h3>集中问题</h3><ul>{(validation?.issues ?? draft.issues).map(issue => <li key={issue.code}>{issue.blocking ? '阻塞' : '待绑定'} · {issue.path} · {issue.message}</li>)}</ul>
      {validation && <><h3>发布差异</h3><pre className="source-text">{JSON.stringify(validation.diff, null, 2)}</pre><label className="confirm-check"><input type="checkbox" aria-label="确认草稿覆盖与差异" checked={acknowledged} onChange={e => setAcknowledged(e.target.checked)} />我已核对完整步骤、需求覆盖、初始目标及全部方案差异</label></>}
      {draft.publication && <button className="button primary" onClick={() => onPublished(draft.publication!.projectId)}>打开已发布路线</button>}
    </>}
    {dirty && <p role="status">草稿有未保存修订，请先保存再校验。</p>}
    <div className="save-bar"><button className="button" disabled={busy || draft?.status === 'committed'} onClick={() => void run(save)}>{pendingSave ? '重试原草稿保存' : '保存草稿与修订'}</button><button className="button" disabled={busy || dirty || !draft || draft.status === 'committed'} onClick={() => void run(validate)}>校验与查看差异</button><button className="button primary" disabled={busy || dirty || !validation || !acknowledged || validation.issues.some(i => i.blocking) || draft?.status === 'committed'} onClick={() => void run(publish)}>{publicationInput ? '回查并重试原发布' : '确认发布完整路线'}</button></div>
  </section>;
}
