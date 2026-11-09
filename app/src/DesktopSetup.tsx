import { useEffect, useState, type ReactNode } from 'react';
import { desktopInvoke, isDesktop } from './desktop';
import './desktop-setup.css';

type RuntimeStatus = {
  needsSetup: boolean;
  dataPath: string;
  running: boolean;
  migrationPending: boolean;
};

export function DesktopSetup({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<RuntimeStatus>();
  const [source, setSource] = useState('');
  const [stopped, setStopped] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (isDesktop()) {
      desktopInvoke<RuntimeStatus>('runtime_status')
        .then(setStatus).catch(error => setError(String(error)));
    }
  }, []);

  async function initialize(importOld: boolean) {
    setBusy(true);
    setError('');
    try {
      await desktopInvoke('initialize_workspace', {
        source: importOld ? source : null,
        sourceStopped: stopped,
      });
      setStatus(await desktopInvoke<RuntimeStatus>('runtime_status'));
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function recoverMigration() {
    setBusy(true);
    try {
      await desktopInvoke('recover_workspace');
      setStatus(await desktopInvoke<RuntimeStatus>('runtime_status'));
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function action(action: string) {
    try {
      await desktopInvoke('runtime_action', { action });
    } catch (error) {
      setError(String(error));
    }
  }

  if (!isDesktop()) return children;
  if (!status) return <main className="desktop-setup">正在连接桌面宿主…{error}</main>;
  if (status.migrationPending) {
    return <main className="desktop-setup">
      <h1>迁移需要恢复</h1>
      <p>旧数据与备份已保留，恢复后重新选择初始化方式。</p>
      <button className="button" disabled={busy} onClick={() => void recoverMigration()}>恢复迁移前状态</button>
      {error && <p role="alert">{error}</p>}
    </main>;
  }
  if (!status.needsSetup && !status.running) {
    return <main className="desktop-setup">
      <h1>领域服务需要恢复</h1>
      <p>数据目录 {status.dataPath}</p>
      <p>数据已保留。请检查上级目录 runtime.log 及备份，处理后重试。</p>
      <button className="button" disabled={busy} onClick={() => void initialize(false)}>恢复领域服务</button>
      {error && <p role="alert">{error}</p>}
    </main>;
  }
  if (status.needsSetup) {
    return <main className="desktop-setup">
      <h1>初始化桌面工作区</h1>
      <p>日期：2026-11-10</p>
      <p>数据目录 {status.dataPath}</p>
      <button className="button primary" disabled={busy} onClick={() => void initialize(false)}>新建空工作区</button>
      <h2>从旧工作区导入</h2>
      <p>提供旧 app/data 的绝对路径。迁移会保留完整备份并验证副本。</p>
      <input aria-label="旧数据目录" value={source} onChange={event => setSource(event.target.value)} />
      <label>
        <input type="checkbox" checked={stopped} onChange={event => setStopped(event.target.checked)} />
        我已停止旧工作台服务的写入
      </label>
      <button className="button" disabled={busy || !stopped || !source.trim()} onClick={() => void initialize(true)}>备份并迁移旧数据</button>
      {error && <p className="error-box" role="alert">{error}</p>}
    </main>;
  }
  return <>
    <div className="desktop-runtime">
      <span>桌面数据目录 {status.dataPath}</span>
      <button onClick={() => void action('panel')}>浮窗宿主</button>
      <button disabled={busy} onClick={() => void initialize(false)}>恢复服务</button>
      <button onClick={() => void action('exit')}>退出工作台</button>
      {error && <span role="alert">{error}</span>}
    </div>
    {children}
  </>;
}
