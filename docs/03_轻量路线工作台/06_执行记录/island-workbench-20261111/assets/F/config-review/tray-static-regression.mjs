// 日期：2026-11-12。只读托盘分支与PNG静态核对，不等于原生物理点击验收。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const [root, output] = process.argv.slice(2);
const base = execFileSync('git', ['show', '77574bfe7f0b561b092165ed824da0d56cc3e66f:src-tauri/src/tray.rs'], { cwd: root, encoding: 'utf8', windowsHide: true }).replaceAll('\r\n', '\n');
const current = fs.readFileSync(path.join(root, 'src-tauri/src/tray.rs'), 'utf8').replaceAll('\r\n', '\n');
const section = (text, start, end) => { const a = text.indexOf(start); const b = text.indexOf(end, a + start.length); if (a < 0 || b < 0) throw Error('TRAY_SOURCE_BOUNDARY_MISSING'); return text.slice(a, b); };
const checks = [];
function check(name, value) { assert.ok(value, name); checks.push({ name, result: 'passed' }); }
check('左键与菜单原动作分支与E一致', section(base, '.on_tray_icon_event', '\n        });') === section(current, '.on_tray_icon_event', '\n        });'));
check('显示隐藏配置处理与E一致', section(base, 'pub fn toggle_hidden', '\n///') === section(current, 'pub fn toggle_hidden', '\n///'));
check('灰化及45%透明度算法与E一致', section(base, 'fn dimmed', '\nfn toggle_key') === section(current, 'fn dimmed', '\nfn toggle_key'));
check('托盘初始化明确加载新图标', current.includes('.icon(tray_icon())'));
check('隐藏状态选择同图标灰化分支', current.includes('let icon = if hidden { dimmed(&icon) } else { icon };'));
const png = fs.readFileSync(path.join(root, 'src-tauri/icons/tray.png'));
check('嵌入PNG签名尺寸有效', png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && png.readUInt32BE(16) === 32 && png.readUInt32BE(20) === 32);
fs.writeFileSync(output, JSON.stringify({ date: '2026-11-12', checkedAgainst: '77574bfe7f0b561b092165ed824da0d56cc3e66f', checks, passed: true, limitation: '静态来源及PNG头核对；未声称新包系统托盘物理操作通过' }, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ passed: true, checks: checks.length }));
