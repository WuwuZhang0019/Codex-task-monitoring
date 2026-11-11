// 日期：2026-11-11。主窗口仅展示轻量路线，浮窗与模拟入口沿用同一面板。
import React from 'react';
import { createRoot } from 'react-dom/client';
import { DesktopSetup } from './DesktopSetup';
import { LightPanel } from './LightPanel';
import './styles.css';

const params = new URLSearchParams(location.search);
const view = params.get('view');
const content = view === 'light-simulation'
  ? <LightPanel/>
  : view === 'light-live' && params.get('floating') === '1'
    ? <LightPanel live floating/>
    : <DesktopSetup><LightPanel live/></DesktopSetup>;

createRoot(document.getElementById('root')!).render(<React.StrictMode>{content}</React.StrictMode>);
