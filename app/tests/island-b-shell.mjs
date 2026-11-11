// 日期：2026-11-11。B 外壳浏览器验收；浏览器结果不代表原生后台、DPI或系统持久化。
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const recordDir = path.resolve(appDir, '../docs/03_轻量路线工作台/06_执行记录/island-workbench-20261111');
const output = path.join(recordDir, 'assets/B/browser');
const base = process.env.ISLAND_B_BASE_URL || 'http://localhost:1420';
const executablePath = process.env.ISLAND_B_BROWSER_EXE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const report = { date: '2026-11-11', native: false, base, executablePath, checks: [], failures: [], pageErrors: [], consoleErrors: [], failedResponses: [], styles: [], settings: {} };
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath });
const check = async (name, task) => { try { const details = await task(); report.checks.push({ name, result: 'passed', details }); } catch (e) { report.failures.push({ name, error: e.stack || String(e) }); } };
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN', recordVideo: { dir: output, size: { width: 1280, height: 800 } } });
const page = await context.newPage();
page.setDefaultTimeout(5000);
page.on('pageerror', e => report.pageErrors.push(e.message));
page.on('console', m => { if (m.type() === 'error') report.consoleErrors.push(m.text()); });
page.on('response', r => { if (r.status() >= 400) report.failedResponses.push({ status: r.status(), url: r.url() }); });
const snap = name => page.screenshot({ path: path.join(output, `${name}.png`) });
async function stored() {
  return page.evaluate(() => Object.fromEntries(Object.entries(localStorage).map(([k, v]) => { try { return [k, JSON.parse(v)]; } catch { return [k, v]; } })));
}
async function values() {
  const all = await stored();
  const entry = Object.entries(all).find(([k, v]) => k === 'island-workbench-settings-v1' && v && typeof v === 'object' && !Array.isArray(v));
  assert.ok(entry, '新的独立浏览器偏好存储必须存在');
  return { key: entry[0], values: entry[1], all };
}
const labelRow = label => page.locator('label').filter({ has: page.getByText(label, { exact: true }) });
async function toggle(label, key) {
  const control = labelRow(label).getByRole('switch');
  const before = await control.getAttribute('aria-checked');
  await control.click();
  const next = before !== 'true';
  assert.equal(await control.getAttribute('aria-checked'), String(next));
  assert.equal((await values()).values[key], next);
  return next;
}
async function nav(name) {
  await page.locator('nav').getByText(name, { exact: true }).click();
  if (name === '关于') await page.getByText('源代码', { exact: true }).waitFor();
  else await page.getByRole('heading', { level: 1, name, exact: true }).waitFor();
  await page.waitForTimeout(250); // 原设置页面淡入完成后采集证据。
}
async function openWindow(hash = '') { await page.goto(`${base}/${hash}`, { waitUntil: 'networkidle' }); await page.reload({ waitUntil: 'networkidle' }); }
try {
  await context.addInitScript(() => {
    if (!sessionStorage.getItem('b-seeded')) {
      localStorage.setItem('island-settings', JSON.stringify({ 'app.language': 'zh-CN', 'appearance.style': 'windows', 'appearance.border': 'intelligence', 'island.expandOnHover': false, 'island.returnDelay': 9, 'module.clipboard.enabled': true, 'module.music.enabled': true, 'plugin.bad.enabled': true, 'shortcut.module.ask': 'Ctrl+Alt+Space', 'island.order': ['music'], 'appearance.tabsPosition': 'top' }));
      sessionStorage.setItem('b-seeded', '1');
    }
  });
  await page.goto(`${base}/#settings`, { waitUntil: 'networkidle' });
  await check('旧浏览器偏好白名单迁移与原值保留', async () => {
    const s = await values();
    assert.equal(s.values['app.language'], 'zh-CN');
    assert.equal(s.values['appearance.style'], 'windows');
    assert.equal(s.values['island.returnDelay'], 9);
    for (const key of Object.keys(s.values)) assert.ok(!/^(module\.|plugin\.|shortcut\.|island\.(order|pinned)|appearance\.tabsPosition)/.test(key), key);
    assert.ok(s.all['island-settings'], '原浏览器偏好必须保留或备份');
    report.settings.storageKey = s.key;
    return s;
  });
  await check('仅四类设置导航且被删页面路由不可达', async () => {
    assert.deepEqual(await page.locator('nav a').allTextContents(), ['常规', '外观', '行为', '关于']);
    assert.equal(await page.locator('nav').getByText(/^(模块|插件|快捷键)$/).count(), 0);
    const source = await readFile('G:/rust/windows-dynamic-island/src/settings/SettingsApp.tsx', 'utf8');
    assert.ok(!/path=["']\/?(?:modules|plugins|shortcuts)/.test(source));
    assert.equal(await page.locator('iframe').count(), 0);
    return { routeCheck: '源码无被删路由注册；浏览器无导航或iframe', source: 'src/settings/SettingsApp.tsx' };
  });
  await check('G-01语言选项与保存', async () => {
    const language = labelRow('语言').locator('select');
    assert.ok((await language.locator('option').count()) >= 3);
    await language.selectOption('en');
    assert.equal((await values()).values['app.language'], 'en');
    await page.locator('select').first().selectOption('zh-CN');
    assert.equal((await values()).values['app.language'], 'zh-CN');
  });
  await check('G-02开机自启动只查看未启用系统项', async () => {
    assert.equal(await labelRow('开机自启动').getByRole('switch').getAttribute('aria-checked'), 'false');
    assert.ok(await page.getByText('仅在完整应用版中可用。', { exact: true }).isVisible());
    return { scope: '浏览器不可验证系统启动项；未切换开关' };
  });
  await check('G-03显示器主屏选项', async () => {
    await labelRow('显示器').locator('select').selectOption('primary');
    assert.equal((await values()).values['island.monitor'], 'primary');
    return { scope: '浏览器只有主屏；真实枚举和失联回退归原生' };
  });
  await snap('general');
  await nav('外观');
  await check('P-01两种形态设置可切换并持久', async () => {
    await page.getByRole('button', { name: /刘海模式 \(Notch\)/ }).click();
    assert.equal((await values()).values['appearance.style'], 'dynamic');
    await page.getByRole('button', { name: /Windows 灵动岛 \(Windows Island\)/ }).click();
    assert.equal((await values()).values['appearance.style'], 'windows');
  });
  await check('P-02所有原边框预设可选', async () => {
    const presets = [['经典黑', 'none'], ['Apple 智能', 'intelligence'], ['极光', 'aurora'], ['落日', 'sunset'], ['海洋', 'ocean'], ['Claude', 'claude'], ['霓虹', 'neon'], ['银灰', 'mono']];
    for (const [title, id] of presets) { await page.getByTitle(title, { exact: true }).click(); assert.equal((await values()).values['appearance.border'], id); }
  });
  await check('P-03自定义两端颜色', async () => {
    await page.getByTitle('自定义', { exact: true }).click();
    await page.getByTitle('#FF453A', { exact: true }).nth(0).click();
    await page.getByTitle('#64D2FF', { exact: true }).nth(1).click();
    assert.deepEqual((await values()).values['appearance.customColors'], ['#FF453A', '#64D2FF']);
  });
  await check('P-04边框粗细可选', async () => {
    for (const [text, value] of [['细', 1], ['中', 2], ['粗', 3]]) { await page.getByRole('button', { name: text, exact: true }).click(); assert.equal((await values()).values['appearance.borderThickness'], value); }
  });
  await check('P-05渐变流光保存', () => toggle('动态渐变流光', 'appearance.animateBorder'));
  await check('P-06光晕保存', () => toggle('光晕效果', 'appearance.glow'));
  await check('P-07毛玻璃四档保存（浏览器预览）', async () => {
    assert.ok(await page.getByText('毛玻璃', { exact: true }).isVisible());
    const glass = page.locator('[data-row]').filter({ has: page.getByText('毛玻璃', { exact: true }) });
    for (const [text, value] of [['关闭', 'off'], ['轻微', 'subtle'], ['适中', 'moderate'], ['强烈', 'strong']]) { await glass.getByRole('button', { name: text, exact: true }).click(); assert.equal((await values()).values['appearance.glass'], value); }
    return { scope: '浏览器预览支持毛玻璃；真实系统支持由原生检查' };
  });
  await check('P-08静止时钟保存', () => toggle('静止时钟', 'appearance.idleClock'));
  await check('P-09模块图标位置已移除', async () => { assert.equal(await page.getByText('模块切换图标位置', { exact: true }).count(), 0); });
  await check('P-10隐藏偏好保存与恢复', async () => { await toggle('隐藏灵动岛', 'island.hidden'); await toggle('隐藏灵动岛', 'island.hidden'); });
  await snap('appearance');
  await nav('行为');
  await check('B-01旧悬停偏好兼容及新展开选项', async () => {
    const select = labelRow('展开灵动岛').locator('select');
    assert.equal(await select.inputValue(), 'click');
    await select.selectOption('hover');
    assert.equal((await values()).values['island.openOn'], 'hover');
  });
  await check('B-02收起选项', async () => {
    const select = labelRow('收起灵动岛').locator('select');
    await select.selectOption('clickOutside'); assert.equal((await values()).values['island.closeOn'], 'clickOutside');
    await select.selectOption('leave'); assert.equal((await values()).values['island.closeOn'], 'leave');
  });
  await check('B-03全屏隐藏偏好', () => toggle('全屏时隐藏', 'island.hideInFullscreen'));
  await check('B-04避让偏好', () => toggle('避开全屏应用', 'island.avoidMaximized'));
  await check('B-05回中禁用联动', async () => {
    const control = labelRow('返回屏幕居中').getByRole('switch');
    if (await control.getAttribute('aria-checked') === 'true') await control.click();
    assert.ok(await page.getByRole('spinbutton').isDisabled());
    await control.click(); assert.ok(await page.getByRole('spinbutton').isEnabled());
  });
  await check('B-06延迟校验、输入焦点、Enter与失焦提交', async () => {
    const number = page.getByRole('spinbutton');
    await number.fill('12'); assert.ok(await number.evaluate(e => e === document.activeElement)); await number.press('Enter');
    assert.equal((await values()).values['island.returnDelay'], 12);
    await number.fill('0'); await number.press('Tab'); assert.equal(await number.inputValue(), '12');
    await number.fill('3601'); await number.press('Tab'); assert.equal(await number.inputValue(), '12');
    await number.fill('6'); await number.press('Tab'); assert.equal((await values()).values['island.returnDelay'], 6);
  });
  await snap('behavior');
  await nav('关于');
  await check('I-01—05产品、版本、来源、更新降级、许可证', async () => {
    const text = await page.locator('main').innerText();
    assert.match(text, /Island Workbench|灵动岛工作台/);
    assert.match(text, /版本/); assert.match(text, /WuwuZhang0019/); assert.match(text, /GPL/); assert.match(text, /HeyyCzer|Vorssaint/); assert.match(text, /2026-11-11/); assert.match(text, /暂不可用|未配置/);
    assert.equal(await page.getByRole('button', { name: '重启并更新', exact: true }).count(), 0);
    return { noUpdateRequestSent: true };
  });
  await snap('about');
  await check('浏览器重载保留新命名空间偏好', async () => {
    await page.reload({ waitUntil: 'networkidle' }); await nav('行为');
    assert.equal(await page.getByRole('spinbutton').inputValue(), '6');
    return { scope: '仅浏览器localStorage重载，不冒充原生冷重开' };
  });
  for (const style of ['dynamic', 'windows']) {
    await check(`${style}形态动画、固定、快速进出和Esc`, async () => {
      await openWindow('#settings');
      await nav('外观'); await page.getByRole('button', { name: style === 'dynamic' ? /刘海模式 \(Notch\)/ : /Windows 灵动岛 \(Windows Island\)/ }).click();
      await openWindow(); await page.mouse.move(20, 700); await page.waitForTimeout(1400);
      const shell = page.locator('div[data-hit="true"]').first();
      const entry = { style, states: [] }; report.styles.push(entry);
      const capture = async name => { const geometry = await shell.boundingBox(); await snap(`${style}-${name}`); entry.states.push({ name, geometry }); return geometry; };
      const collapsed = await capture('collapsed'); assert.ok(collapsed);
      await page.mouse.move(collapsed.x + collapsed.width / 2, collapsed.y + collapsed.height / 2); await page.waitForTimeout(180); await capture('hover-transition'); await page.waitForTimeout(1000);
      const expanded = await capture('expanded'); assert.ok(expanded.height > collapsed.height + 50);
      assert.ok(await page.locator('[data-workbench-placeholder]').isVisible());
      await page.getByTitle('固定展开', { exact: true }).click(); await page.mouse.move(20, 700); await page.waitForTimeout(1300);
      assert.ok((await capture('pinned-outside')).height > collapsed.height + 50);
      await page.getByTitle('取消固定', { exact: true }).click(); await page.mouse.move(20, 700); await page.waitForTimeout(1600);
      assert.ok((await capture('collapsed-after-unpin')).height < expanded.height - 30);
      for (let i = 0; i < 6; i++) { const b = await shell.boundingBox(); await page.mouse.move(b.x+b.width/2,b.y+b.height/2); await page.waitForTimeout(55); await page.mouse.move(20,700); await page.waitForTimeout(55); }
      await page.waitForTimeout(1600); assert.ok((await capture('rapid-exit-final')).height < expanded.height - 30);
      const b = await shell.boundingBox(); await page.mouse.move(b.x+b.width/2,b.y+b.height/2); await page.waitForTimeout(1200);
      await page.getByTitle('固定展开', { exact: true }).focus(); await page.keyboard.press('Enter'); assert.equal(await page.getByTitle('取消固定', { exact: true }).getAttribute('aria-pressed'), 'true');
      await page.keyboard.press('Shift+Tab'); assert.ok(await page.evaluate(() => document.activeElement?.tagName === 'BUTTON'));
      await page.keyboard.press('Tab'); assert.ok(await page.evaluate(() => document.activeElement?.tagName === 'BUTTON'));
      await page.keyboard.press('Escape'); await page.mouse.move(20, 700); await page.waitForTimeout(1200); assert.ok((await capture('escape-collapsed')).height < expanded.height - 30);
      assert.equal(await page.locator('iframe').count(), 0); assert.equal(await page.getByTitle('全部模块', { exact: true }).count(), 0);
      await openWindow('#settings');
      return entry;
    });
  }
} finally {
  report.settings.final = await stored().catch(() => ({}));
  report.passed = report.failures.length === 0 && report.pageErrors.length === 0;
  await context.close();
  report.video = path.relative(recordDir, await page.video().path()).replaceAll('\\', '/');
  await browser.close();
  await writeFile(path.join(recordDir, 'B_浏览器证据.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, failures: report.failures, pageErrors: report.pageErrors, consoleErrors: report.consoleErrors }, null, 2));
}
if (!report.passed) process.exitCode = 1;
