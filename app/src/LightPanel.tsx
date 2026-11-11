// 更新日期 2026-11-11。模拟与真实面板复用布局，真实模式只读取持久服务。
import { useEffect, useRef, useState } from 'react';
import fixture from './light-simulation.json';
import sourceText from './light-source.json';
import './light-panel.css';
import { blankSnapshot, readPanel, savePanelPreferences, type Snapshot, type Preferences } from './light-live';
import { desktopInvoke } from './desktop';
import { useIslandMotion } from './useIslandMotion';

type Route = Snapshot['routes'][number];
const names: Record<string, string> = { pending: '待执行', running: '执行中', blocked: '已阻塞', completed: '已完成', cancelled: '已取消' };
const symbols: Record<string, string> = { pending: '○', running: '●', blocked: '!', completed: '✓', cancelled: '×' };
const preferenceKey = 'workbench/C/simulation/preferences/v1';

function loadPreferences(live = false): Preferences {
  const empty: Preferences = { collapsed: matchMedia('(max-width: 640px)').matches ? fixture.projects.slice(1).map(project => project.key) : [], selected: '', focus: [], scroll: {}, y: {} };
  if (live) return { ...empty, collapsed: [] };
  try {
    const value = JSON.parse(localStorage.getItem(preferenceKey) || 'null');
    if (!value || !Array.isArray(value.collapsed) || !Array.isArray(value.focus) || typeof value.selected !== 'string' || typeof value.scroll !== 'object' || !value.y || typeof value.y !== 'object') return empty;
    return value;
  } catch { return empty; }
}

export function LightPanel({ live = false, floating = false }: { live?: boolean; floating?: boolean }) {
  const [snapshot, setSnapshot] = useState<Snapshot>(() => structuredClone(live ? blankSnapshot : fixture));
  const [preferences, setPreferences] = useState(() => loadPreferences(live));
  const [expanded, setExpanded] = useState(!floating);
  const [detail, setDetail] = useState(false);
  const [fullDetail, setFullDetail] = useState(false);
  const [onlyTodo, setOnlyTodo] = useState(false);
  const [connected, setConnected] = useState(!live);
  const [sources, setSources] = useState<Record<string, string | null>>({});
  const [hydrated, setHydrated] = useState(!live);
  const [refreshKey, setRefreshKey] = useState(0);
  const [association, setAssociation] = useState('');
  const latestRevision = useRef<number | null>(null);
  const preferencesChanged = useRef(false);
  const [empty, setEmpty] = useState(false);
  const [pinned, setPinned] = useState(!floating);
  const [message, setMessage] = useState(live ? '正在读取已保存路线…' : '模拟快照 · 所有身份仅用于演示');
  const [candidates, setCandidates] = useState<string[]>([]);
  const body = useRef<HTMLDivElement>(null);
  const shell = useRef<HTMLElement>(null);
  const viewKey = preferences.focus.at(-1) || 'all';
  const selected = snapshot.steps.find(step => step.key === preferences.selected);
  const compactRoute = snapshot.routes.find(route => route.stepKeys.includes(preferences.selected)) || snapshot.routes.find(route => route.stepKeys.some(key => snapshot.steps.some(step => step.key === key && step.status === 'running'))) || snapshot.routes[0];
  const compactSteps = compactRoute?.stepKeys.slice(0, 7).map(key => snapshot.steps.find(step => step.key === key)).filter(step => !!step) || [];
  const focused = snapshot.routes.find(route => route.key === preferences.focus.at(-1));
  const stepByKey = new Map(snapshot.steps.map(step => [step.key, step]));
  const routeOf = (key: string) => snapshot.routes.find(route => route.stepKeys.includes(key));
  const sourceOf = (route: Route) => route.sourceStepKey || snapshot.supplements.find(item => item.linkedPlanKey === route.planKey)?.sourceStepKey || null;
  const children = (route: Route) => snapshot.routes.filter(item => sourceOf(item) && route.stepKeys.includes(sourceOf(item)!));
  const ended = (route: Route) => route.stepKeys.every(key => ['completed', 'cancelled'].includes(stepByKey.get(key)?.status || ''));
  const count = (projectKey: string, status: string) => snapshot.steps.filter(step => step.projectKey === projectKey && step.status === status).length;
  const openCount = (projectKey: string) => snapshot.supplements.filter(item => stepByKey.get(item.sourceStepKey)?.projectKey === projectKey && ['unconfirmed', 'unplanned'].includes(item.status)).length;
  const hidden = (key: string) => preferences.collapsed.includes(key);
  const motion = useIslandMotion(floating, expanded, pinned, setMessage);
  const hovered = useRef(false);
  const holds = useRef({ pinned, detail });
  holds.current = { pinned, detail };
  const enterTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  function scheduleCollapse() {
    clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(() => {
      if (!hovered.current && !holds.current.pinned && !holds.current.detail) setExpanded(false);
    }, 350);
  }
  function enterIsland() {
    hovered.current = true;
    clearTimeout(leaveTimer.current);
    clearTimeout(enterTimer.current);
    if (motion.progress.current > 0) { setExpanded(true); motion.retry(); }
    else enterTimer.current = setTimeout(() => { setExpanded(true); motion.retry(); }, floating ? 180 : 0);
  }
  function leaveIsland() {
    hovered.current = false;
    clearTimeout(enterTimer.current);
    scheduleCollapse();
  }
  function collapseIsland() {
    clearTimeout(enterTimer.current); clearTimeout(leaveTimer.current);
    setPinned(false); setDetail(false); setFullDetail(false); setAssociation('');
    setExpanded(false);
  }
  useEffect(() => {
    if (floating && !pinned && !detail && !hovered.current) scheduleCollapse();
    return () => clearTimeout(leaveTimer.current);
  }, [floating, pinned, detail]);
  useEffect(() => () => { clearTimeout(enterTimer.current); clearTimeout(leaveTimer.current); }, []);

  useEffect(() => {
    if (live) return;
    try { localStorage.setItem(preferenceKey, JSON.stringify(preferences)); }
    catch { setMessage('模拟阅读偏好保存失败，当前阅读仍可继续'); }
  }, [preferences, live]);
  useEffect(() => { if (body.current) body.current.scrollTop = preferences.y[viewKey] || 0; }, [expanded, viewKey]);
  useEffect(() => {
    if (document.activeElement === document.body) shell.current?.focus({ preventScroll: true });
  }, [viewKey, detail, fullDetail]);

  useEffect(() => {
    if (!live) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const result = await readPanel();
        if (stopped) return;
        if (result.snapshot.mode !== 'service' || !Array.isArray(result.snapshot.steps) || typeof result.snapshot.revision !== 'number') throw Error('持久快照格式无效');
        const revision = result.snapshot.revision;
        if (latestRevision.current === null) {
          if (!preferencesChanged.current && result.preferences) setPreferences(result.preferences);
          setHydrated(true);
          setMessage('已读取持久路线');
        } else if (revision !== latestRevision.current) {
          const completed = result.snapshot.events.at(-1);
          setMessage(completed ? `已保存更新 · ${completed.reason} · 阅读位置已保留` : '已保存更新 · 阅读位置已保留');
        }
        if (latestRevision.current === null || revision >= latestRevision.current) {
          setSnapshot(result.snapshot); setSources(result.sources);
          latestRevision.current = revision;
        }
        setConnected(true);
      } catch (error) {
        if (!stopped) { setConnected(false); setMessage(`连接中断 · ${error instanceof Error ? error.message : String(error)} · 保留最后成功快照`); }
      } finally { if (!stopped) timer = setTimeout(() => void poll(), 1500); }
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [live, refreshKey]);
  useEffect(() => {
    if (!live || !hydrated || !preferencesChanged.current) return;
    const timer = setTimeout(() => { void savePanelPreferences(preferences).catch(() => setMessage('阅读偏好保存失败 · 当前阅读仍可继续')); }, 400);
    return () => clearTimeout(timer);
  }, [live, hydrated, preferences]);
  async function associationEntry() {
    if (!selected) return;
    if (!live) { setMessage(selected.bindingKey ? '模拟跳转失败 · 宿主适配待 F 接线，阅读位置已保留' : '未绑定会话 · 模拟跳转失败，阅读位置已保留'); return; }
    const binding = snapshot.bindings.find(item => item.key === selected.bindingKey);
    if (!binding) { setMessage('未绑定会话 · 阅读位置已保留'); return; }
    setAssociation(`聊天固定 ID：${binding.context.threadId || '未声明'}\n工作树：${binding.context.worktreePath || '未声明'}\n分支：${binding.context.branch || '未声明'}\n绑定状态：${binding.state}\n当前宿主未提供聊天跳转；复制固定 ID 后在 Codex 中查找。`);
    setMessage('无法自动跳转 · 已显示关联信息，阅读位置已保留');
  }
  function toggle(key: string) {
    setPreferences(value => ({ ...value, collapsed: value.collapsed.includes(key) ? value.collapsed.filter(item => item !== key) : [...value.collapsed, key] }));
  }
  function choose(key: string) {
    setPreferences(value => ({ ...value, selected: key }));
    setDetail(true);
    setFullDetail(false);
    setCandidates([]);
    setAssociation('');
  }
  function locate(key: string) {
    const step = stepByKey.get(key);
    if (!step) return;
    const route = routeOf(key);
    const ancestors: string[] = [];
    const visited = new Set<string>();
    let parent = route && sourceOf(route) ? routeOf(sourceOf(route)!) : undefined;
    while (parent && !visited.has(parent.key)) {
      visited.add(parent.key);
      ancestors.unshift(parent.key);
      parent = sourceOf(parent) ? routeOf(sourceOf(parent)!) : undefined;
    }
    setPreferences(value => ({ ...value, focus: ancestors, selected: key, collapsed: value.collapsed.filter(item => item !== step.projectKey && item !== route?.key) }));
    setExpanded(true);
    choose(key);
    requestAnimationFrame(() => {
      document.getElementById(key)?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'instant' });
      document.getElementById(key)?.focus({ preventScroll: true });
    });
  }
  function locateCurrent() {
    const keys = snapshot.steps.filter(step => ['running', 'blocked'].includes(step.status) && (!focused || focused.stepKeys.includes(step.key))).map(step => step.key);
    if (keys.length === 1) locate(keys[0]);
    else { setCandidates(keys); setMessage(keys.length ? '请选择需要定位的当前站' : '当前范围没有执行中或阻塞站点'); }
  }
  function simulateUpdate() {
    setSnapshot(value => ({ ...value, generatedAt: new Date().toISOString(), steps: value.steps.map((step, index) => index === 2 ? { ...step, status: 'running', updatedAt: new Date().toISOString(), acceptance: 'recheck' } : step) }));
    setMessage('模拟更新已到达 · A-03 返工待复核，原完成证据保留');
  }
  function renderRoute(route: Route, branch = false) {
    const source = sourceOf(route) ? stepByKey.get(sourceOf(route)!) : undefined;
    const nested = children(route);
    const supplements = snapshot.supplements.filter(item => route.stepKeys.includes(item.sourceStepKey));
    return <div className={`lp-route ${branch ? 'lp-branch' : ''}`} key={route.key} data-route={route.key}>
      <div className="lp-route-label">
        <button aria-expanded={!hidden(route.key)} onClick={() => toggle(route.key)}>{hidden(route.key) ? '▸' : '▾'} {route.label}</button>
        {source && <small>└ 来源 {source.code} · {supplements.some(item => item.blocksSource) || snapshot.supplements.some(item => item.linkedPlanKey === route.planKey && item.blocksSource) ? '阻塞来源站' : '补充路线'}</small>}
        <small>{route.stepKeys.length} 站 · {route.context.branch}</small>
      </div>
      <div className={`lp-track ${branch ? 'lp-branch-track' : ''}`} style={{ minWidth: hidden(route.key) ? 300 : route.stepKeys.length * 124 + (branch ? 148 : 24) }}>
        {branch && <svg className="lp-source-link" width="190" height="30" aria-hidden="true"><path d="M 62 0 V 20 Q 62 26 68 26 H 186" fill="none" stroke="#60606d" strokeWidth="2"/></svg>}
        {hidden(route.key) ? <span className="lp-folded">路线已折叠 · {route.stepKeys.length} 站</span> : route.stepKeys.map(key => {
          const step = stepByKey.get(key);
          if (!step) return null;
          const waiting = step.dependsOn.filter(dep => stepByKey.get(dep)?.status !== 'completed');
          return <button id={key} key={key} className={`lp-station lp-${step.status}`} aria-pressed={preferences.selected === key} aria-label={`${route.label} ${step.code} ${step.title} ${names[step.status]}`} onClick={() => choose(key)}>
            <span className="lp-dot">{symbols[step.status]}</span><strong>{step.code}</strong><span className="lp-title">{step.title}</span><small>{names[step.status]}{step.acceptance === 'recheck' ? ' · 待复核' : ''}</small>
            {waiting.length > 0 && <small className="lp-warning">等待 {waiting.length} 项前置</small>}
          </button>;
        })}
      </div>
      {(nested.length > 0 || supplements.some(item => !item.linkedPlanKey)) && <div className="lp-route-extra">
        {nested.length > 0 && <button onClick={() => { setPreferences(value => ({ ...value, focus: [...value.focus, route.key] })); setDetail(false); }}>子分支 {nested.length} · 阻塞 {nested.filter(item => snapshot.supplements.some(s => s.linkedPlanKey === item.planKey && s.blocksSource)).length} · 聚焦</button>}
        {supplements.filter(item => !item.linkedPlanKey).map(item => <button className="lp-open-end" key={item.key} onClick={() => setMessage(`${item.title} · ${item.goal} · 来源 ${stepByKey.get(item.sourceStepKey)?.code}`)}>┄ {item.title} · {item.status === 'unconfirmed' ? '待确认' : '待规划'}</button>)}
        {route.returnStepKey && <button onClick={() => locate(route.returnStepKey!)}>回到 {stepByKey.get(route.returnStepKey)?.code}</button>}
      </div>}
    </div>;
  }
  const projects = empty ? [] : snapshot.projects.filter(project => (!focused || project.key === focused.projectKey) && (!onlyTodo || count(project.key, 'running') + count(project.key, 'blocked') + count(project.key, 'pending') + openCount(project.key) > 0));
  return <main ref={shell} tabIndex={-1} className={`lp-shell ${floating ? 'lp-floating' : ''}`} onPointerDown={() => { preferencesChanged.current = true; }} onKeyDownCapture={() => { preferencesChanged.current = true; }} onKeyDown={event => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    if (fullDetail) setFullDetail(false);
    else if (detail) setDetail(false);
    else if (preferences.focus.length) setPreferences(value => ({ ...value, focus: value.focus.slice(0, -1) }));
    else collapseIsland();
  }}>
    <div className="lp-island" ref={motion.surface} onMouseEnter={enterIsland} onMouseLeave={leaveIsland}>
    <button className="lp-compact" aria-expanded={expanded} title={floating ? (message.startsWith('动效同步失败') ? message : '悬停预览 · 点击固定展开') : undefined} onClick={() => { if (floating) { setPinned(value => !value); setExpanded(true); motion.retry(); } else setExpanded(value => !value); }}><span className="lp-brand">⌁</span><strong>任务航线</strong><span className="lp-mini">{live ? compactSteps.map((step, index) => <span key={step.key} className={`lp-mini-${step.status}`} title={`${step.code} ${names[step.status]}`}>{index > 0 ? ' ━ ' : ''}{symbols[step.status]}</span>) : '● ━ ● ━ ◉ ━ ○ ━ ○'}</span><span>{snapshot.projects.length} 项目 · {live ? '已保存' : '模拟'}</span><span>{expanded ? '⌃' : '⌄'}</span></button>
    {(expanded || floating) && <section className="lp-panel" aria-label="项目路线面板" aria-hidden={!expanded} inert={!expanded}>
      <header className="lp-toolbar"><strong>项目路线</strong><label><input type="checkbox" checked={onlyTodo} onChange={e => setOnlyTodo(e.target.checked)} />只看有待办</label><button onClick={locateCurrent}>定位当前</button><button aria-pressed={pinned} onClick={() => setPinned(value => !value)}>{pinned ? '已固定' : '固定'}</button><button onClick={collapseIsland}>收起</button></header>
      <div className="lp-sync">{connected ? (live ? '已连接' : '模拟已连接') : '连接中断'} · 最后更新 {new Date(snapshot.generatedAt).toLocaleTimeString('zh-CN', { hour12: false })} · {snapshot.mode}{live && <> · 版本 {snapshot.revision ?? '待连接'} <button onClick={() => setRefreshKey(value => value + 1)}>刷新</button>{floating && <button onClick={() => void desktopInvoke('panel_show_main').catch(error => setMessage(String(error)))}>打开工作台</button>}</>}</div>
      <div className="lp-event" role="status">{message}</div>
      {preferences.focus.length > 0 && <nav className="lp-breadcrumb" aria-label="路线层级"><button onClick={() => setPreferences(value => ({ ...value, focus: [] }))}>全部项目</button>{preferences.focus.map((key, index) => <button key={key} onClick={() => setPreferences(value => ({ ...value, focus: value.focus.slice(0, index + 1) }))}>→ {snapshot.routes.find(route => route.key === key)?.label}</button>)}</nav>}
      {candidates.length > 0 && <div className="lp-candidates" aria-label="当前站候选">{candidates.map(key => <button key={key} onClick={() => locate(key)}>{snapshot.projects.find(p => p.key === stepByKey.get(key)?.projectKey)?.name} · {stepByKey.get(key)?.code} · {stepByKey.get(key)?.title}</button>)}</div>}
      <div className="lp-body" ref={body} onScroll={event => { const y = event.currentTarget.scrollTop; setPreferences(value => ({ ...value, y: { ...value.y, [viewKey]: y } })); }}>
        {projects.length === 0 && <div className="lp-empty">{onlyTodo ? '当前条件下没有路线' : '尚未收到路线'}<button onClick={() => { setEmpty(false); setOnlyTodo(false); }}>{live ? '清除筛选' : '清除筛选并恢复样例'}</button></div>}
        {projects.map(project => {
          const roots = snapshot.routes.filter(route => route.projectKey === project.key && !sourceOf(route));
          const parentRoutes = focused ? [focused] : roots;
          return <article className="lp-project" key={project.key}>
            <header><button aria-expanded={!hidden(project.key)} onClick={() => toggle(project.key)}>{hidden(project.key) ? '▸' : '▾'} {project.name}</button><small>{count(project.key, 'running')} 执行中 · {count(project.key, 'blocked')} 阻塞 · {openCount(project.key)} 待处理事项</small></header>
            {!hidden(project.key) && <div className="lp-project-scroll" ref={element => { if (element) element.scrollLeft = preferences.scroll[`${viewKey}/${project.key}`] || 0; }} onScroll={event => { const x = event.currentTarget.scrollLeft; setPreferences(value => ({ ...value, scroll: { ...value.scroll, [`${viewKey}/${project.key}`]: x } })); }}>
              {parentRoutes.map(route => {
                const branches = children(route);
                const active = branches.filter(item => !ended(item));
                const completed = branches.filter(ended);
                const all = hidden(`${route.key}/more`);
                const showEnded = hidden(`${route.key}/ended`);
                return <section className="lp-group" key={route.key} aria-label={`方案 ${snapshot.plans.find(plan => plan.key === route.planKey)?.name}`}>
                  {parentRoutes.find(item => item.planKey === route.planKey)?.key === route.key && <h2>{snapshot.plans.find(plan => plan.key === route.planKey)?.name}<small>按路线顺序阅读 · 横向可滚动 →</small></h2>}
                  {renderRoute(route)}
                  {(all ? active : active.slice(0, 3)).map(item => renderRoute(item, true))}
                  {active.length > 3 && <button className="lp-more" onClick={() => toggle(`${route.key}/more`)}>{all ? '收起额外分支' : `另有 ${active.length - 3} 条分支 · 阻塞 ${active.slice(3).filter(item => item.stepKeys.some(key => stepByKey.get(key)?.status === 'blocked')).length} · 待确认 ${openCount(project.key)} · 查看`}</button>}
                  {completed.length > 0 && <button className="lp-more" onClick={() => toggle(`${route.key}/ended`)}>已结束分支 {completed.length} 条 · {showEnded ? '收起' : '展开'}</button>}
                  {showEnded && completed.map(item => renderRoute(item, true))}
                </section>;
              })}
            </div>}
          </article>;
        })}
      </div>
      {detail && selected && <aside className={`lp-detail ${fullDetail ? 'lp-full-detail' : ''}`} aria-label="站点详情">
        <header><strong>{selected.code} · {selected.title}</strong><button onClick={() => { setDetail(false); setFullDetail(false); }}>关闭详情</button></header>
        <p>{symbols[selected.status]} {names[selected.status]} · 验收 {selected.acceptance} · 同步 {selected.sync} · {new Date(selected.updatedAt).toLocaleString('zh-CN')}</p>
        <p>前置全部完成后可执行 · {selected.dependsOn.map(key => stepByKey.get(key)?.code).join('、') || '无前置'} · 原编号 {selected.originalCode}</p>
        <div className="lp-detail-actions"><button onClick={() => setFullDetail(value => !value)}>{fullDetail ? '返回简要详情' : '查看完整详情'}</button><button onClick={() => void associationEntry()}>打开关联会话</button><button onClick={() => setMessage(`方案来源 ${snapshot.plans.find(plan => plan.key === selected.planKey)?.source.path}`)}>查看方案</button></div>
        {association && <div className="lp-association"><pre>{association}</pre><button onClick={() => { void navigator.clipboard.writeText(association).then(() => setMessage('关联信息已复制')).catch(() => setMessage('复制失败，请选择上方文字手动复制')); }}>复制关联信息</button><button onClick={() => setAssociation('')}>关闭关联信息</button></div>}{fullDetail && <div className="lp-full-content"><h3>原文与验收</h3><p className="lp-excerpt">{live ? sources[selected.planKey] || '原文当前不可验证，请按来源路径、版本及定位核对原文。' : sourceText[selected.key as keyof typeof sourceText] || '独立模拟样例。按模拟检查通过且证据可回读验收。'}</p><p>{selected.sourceLocator} · {snapshot.plans.find(plan => plan.key === selected.planKey)?.source.locator}</p><ul>{selected.conditions.map(condition => <li key={condition.conditionId}>{condition.text} · {condition.result}</li>)}</ul><h3>证据与历史</h3>{selected.evidence.map(evidence => <p key={evidence.evidenceId}>{evidence.location} · {evidence.method} · {evidence.deliveryVersion}</p>)}{!selected.evidence.length && <p>尚无完成证据</p>}<p>进展以快照状态及更新时间为准 · {selected.acceptance === 'recheck' ? '返工待复核，历史完成证据保留' : live ? snapshot.events.filter(event => event.stepKey === selected.key).slice(-5).map(event => `${event.receivedAt} ${event.reason}`).join('；') || '尚无进展事件' : '模拟进展'}</p><h3>阻塞与关联</h3>{selected.blockers.map((blocker, index) => <p key={index}>{JSON.stringify(blocker)}</p>)}<p>{routeOf(selected.key)?.context.worktreePath} · {routeOf(selected.key)?.context.branch} · {selected.bindingKey || '未绑定会话'}</p></div>}
      </aside>}
      {!live && <footer className="lp-demo" aria-label="模拟场景控制"><span>C 模拟场景</span><button onClick={simulateUpdate}>模拟更新与返工</button><button onClick={() => setConnected(value => !value)}>切换连接</button><button onClick={() => setEmpty(value => !value)}>切换空态</button></footer>}
    </section>}
    </div>
  </main>;
}
