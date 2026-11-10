// 日期 2026-11-11。主窗口通过私有 API 确认连接、方案和绑定。
import { useState } from 'react';
import { api } from './domain';
import { desktopInvoke } from './desktop';
import './light-connection.css';

type GrantResult = { principal: string; token: string };
type ConfirmationResult = { confirmationGrant: string; [key: string]: unknown };
type JsonObject = Record<string, unknown>;

function parseObject(text: string): JsonObject {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请输入 JSON 对象。');
  return value as JsonObject;
}

export function LightConnection({ dataPath }: { dataPath: string }) {
  const [projectKey, setProjectKey] = useState('light-workbench-20261110/project');
  const [threadId, setThreadId] = useState('');
  const [hostId, setHostId] = useState('local');
  const [worktreeRoot, setWorktreeRoot] = useState('');
  const [principal, setPrincipal] = useState('');
  const [authorizationAcknowledged, setAuthorizationAcknowledged] = useState(false);
  const [publicationJson, setPublicationJson] = useState('');
  const [publicationAcknowledged, setPublicationAcknowledged] = useState(false);
  const [bindingJson, setBindingJson] = useState('');
  const [bindingAcknowledged, setBindingAcknowledged] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const [confirmationGrant, setConfirmationGrant] = useState('');
  const [copied, setCopied] = useState(false);

  function begin(action: string) {
    setBusy(action);
    setError('');
    setResult('');
    setConfirmationGrant('');
    setCopied(false);
  }

  async function authorizeConnection() {
    begin('authorize');
    try {
      const grant = await api<GrantResult>('/light-access/grants', 'POST', {
        projectKeys: [projectKey.trim()], threadId: threadId.trim(), hostId: hostId.trim(),
        worktreeRoots: [worktreeRoot.trim()], acknowledged: authorizationAcknowledged,
      });
      try {
        const saved = await desktopInvoke<{ configPath: string }>('save_light_connection', { token: grant.token });
        setPrincipal(grant.principal);
        setResult(JSON.stringify({ principal: grant.principal, configPath: saved.configPath }, null, 2));
      } catch (saveFailure) {
        try {
          await api('/light-access/revoke', 'POST', { principal: grant.principal, acknowledged: true });
        } catch {
          throw new Error(`连接保存失败，授权 ${grant.principal} 的撤销也未确认，请在恢复后核对。`);
        }
        throw saveFailure;
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy('');
    }
  }

  async function confirmPublication() {
    begin('publication');
    try {
      const body = parseObject(publicationJson);
      if (body.operation !== 'register' && body.operation !== 'revise') throw new Error('operation 需要为 register 或 revise。');
      if (!body.input || typeof body.input !== 'object' || Array.isArray(body.input)) throw new Error('请提供 input 对象。');
      const response = await api<ConfirmationResult>('/light-access/confirm-publication', 'POST', {
        principal: body.principal || principal.trim(), operation: body.operation, input: body.input,
        acknowledged: publicationAcknowledged,
      });
      setConfirmationGrant(response.confirmationGrant);
      setResult(JSON.stringify(response, null, 2));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy('');
    }
  }

  async function confirmBinding() {
    begin('binding');
    try {
      const body = parseObject(bindingJson);
      if (!body.input || typeof body.input !== 'object' || Array.isArray(body.input)) throw new Error('请提供 input 对象。');
      const response = await api<ConfirmationResult>('/light-access/confirm-binding', 'POST', {
        principal: body.principal || principal.trim(), input: body.input, acknowledged: bindingAcknowledged,
      });
      setConfirmationGrant(response.confirmationGrant);
      setResult(JSON.stringify(response, null, 2));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy('');
    }
  }

  async function copyConfirmation() {
    try {
      await navigator.clipboard.writeText(confirmationGrant);
      setCopied(true);
    } catch {
      setError('复制失败，请从确认回执中手动选取 confirmationGrant。');
    }
  }

  return <details className="light-connection">
    <summary>Codex 接入</summary>
    <div className="light-connection-content">
      <p>日期：2026-11-11。此处用于确认项目授权、方案内容和聊天绑定。运行数据目录为 {dataPath}</p>
      <section>
        <h2>连接授权</h2>
        <div className="light-connection-fields">
          <label>项目关联键<input aria-label="接入项目关联键" value={projectKey} onChange={event => { setProjectKey(event.target.value); setAuthorizationAcknowledged(false); }} /></label>
          <label>聊天固定 ID<input aria-label="接入聊天固定ID" value={threadId} onChange={event => { setThreadId(event.target.value); setAuthorizationAcknowledged(false); }} /></label>
          <label>宿主 ID<input aria-label="接入宿主ID" value={hostId} onChange={event => { setHostId(event.target.value); setAuthorizationAcknowledged(false); }} /></label>
          <label>工作树绝对路径<input aria-label="接入工作树路径" value={worktreeRoot} onChange={event => { setWorktreeRoot(event.target.value); setAuthorizationAcknowledged(false); }} /></label>
        </div>
        <label className="light-connection-check"><input type="checkbox" checked={authorizationAcknowledged} onChange={event => setAuthorizationAcknowledged(event.target.checked)} />我已核对授权项目、聊天及工作树范围</label>
        <button className="button" disabled={!!busy || !authorizationAcknowledged || !projectKey.trim() || !threadId.trim() || !hostId.trim() || !worktreeRoot.trim()} onClick={() => void authorizeConnection()}>{busy === 'authorize' ? '正在保存连接…' : '授权并保存连接'}</button>
      </section>
      <label className="light-connection-principal">授权主体 ID<input aria-label="接入授权主体ID" value={principal} onChange={event => { setPrincipal(event.target.value); setPublicationAcknowledged(false); setBindingAcknowledged(false); }} /></label>
      <section>
        <h2>确认方案发布或修订</h2>
        <p>填写含 operation、input 和可选 principal 的 JSON。请核对完整步骤、依赖、验收及修订差异。</p>
        <textarea aria-label="方案确认JSON" rows={8} value={publicationJson} onChange={event => { setPublicationJson(event.target.value); setPublicationAcknowledged(false); }} spellCheck={false} />
        <label className="light-connection-check"><input type="checkbox" checked={publicationAcknowledged} onChange={event => setPublicationAcknowledged(event.target.checked)} />我已核对完整方案内容与修订差异</label>
        <button className="button" disabled={!!busy || !publicationAcknowledged || !publicationJson.trim()} onClick={() => void confirmPublication()}>{busy === 'publication' ? '正在确认方案…' : '签发方案确认'}</button>
      </section>
      <section>
        <h2>确认聊天与工作树绑定</h2>
        <p>填写含 input 和可选 principal 的 JSON。服务将核验提案版本、实际 Git 工作树及分支。</p>
        <textarea aria-label="绑定确认JSON" rows={8} value={bindingJson} onChange={event => { setBindingJson(event.target.value); setBindingAcknowledged(false); }} spellCheck={false} />
        <label className="light-connection-check"><input type="checkbox" checked={bindingAcknowledged} onChange={event => setBindingAcknowledged(event.target.checked)} />我已核对绑定步骤、聊天与工作树</label>
        <button className="button" disabled={!!busy || !bindingAcknowledged || !bindingJson.trim()} onClick={() => void confirmBinding()}>{busy === 'binding' ? '正在确认绑定…' : '签发绑定确认'}</button>
      </section>
      {error && <p className="light-connection-error" role="alert">{error}</p>}
      {result && <section className="light-connection-result"><h2>本次回执</h2><textarea aria-label="接入确认回执" rows={6} readOnly value={result} />{confirmationGrant && <><p>确认凭据仅保留在本次页面内存中，请用于对应 MCP 请求。</p><button className="button" onClick={() => void copyConfirmation()}>{copied ? '已复制确认凭据' : '复制确认凭据'}</button></>}</section>}
    </div>
  </details>;
}
