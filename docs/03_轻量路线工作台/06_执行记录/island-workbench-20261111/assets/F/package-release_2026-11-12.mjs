// 日期：2026-11-12。只从固定Git对象导出本次运行交付的对应源码，不读取工作区私有文件。
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const [businessRoot, businessCommit, shellRoot, shellCommit, output] = process.argv.slice(2);
if (![businessRoot, shellRoot, output].every(value => value && path.isAbsolute(value))
    || ![businessCommit, shellCommit].every(value => /^[a-f0-9]{40}$/.test(value ?? ''))) {
  throw Error('Usage: node package-release.mjs <business-root> <40-char-commit> <shell-root> <40-char-commit> <absolute-output>');
}
await mkdir(output, { recursive: true });
const businessPaths = ['LICENSE', 'SOURCE.md', 'THIRD-PARTY-NOTICES.txt',
  'app/package.json', 'app/package-lock.json', 'app/tsconfig.json', 'app/vite.config.ts',
  'app/index.html', 'app/public', 'app/src', 'app/server', 'app/mcp',
  'app/desktop', 'app/tests', 'app/contracts', 'plugins/task-workbench',
  'docs/03_轻量路线工作台/05_使用与指令模板',
  'docs/99_归档/01_独立任务进度监测器_可执行方案_2026-11-06.md',
  ':!app/desktop/resources'];
const shellPaths = ['LICENSE', 'SOURCE.md', 'THIRD-PARTY-NOTICES.txt', 'package.json', 'bun.lock',
  'biome.json', 'index.html', 'tsconfig.json', 'vite.config.ts', 'vite-plugin-locales.ts',
  'src', 'src-tauri', 'scripts/sync-cargo-version.ts',
  ':!src-tauri/icons/32x32.png', ':!src-tauri/icons/128x128.png',
  ':!src-tauri/icons/128x128@2x.png', ':!src-tauri/icons/icon.ico', ':!src-tauri/icons/icon.icns',
  ':!src-tauri/icons/Square*', ':!src-tauri/icons/StoreLogo.png'];
const manifests = [];
for (const [name, root, commit, paths] of [
  ['business-source', businessRoot, businessCommit, businessPaths],
  ['task-island-source', shellRoot, shellCommit, shellPaths],
]) {
  const file = path.join(output, `${name}-${commit.slice(0, 8)}.zip`);
  execFileSync('git', ['-C', root, 'archive', '--format=zip', `--prefix=${name}/`, `--output=${file}`, commit, '--', ...paths], { windowsHide: true });
  const entries = execFileSync('tar.exe', ['-tf', file], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/);
  const forbidden = entries.filter(entry => /(^|\/)(node_modules|target|test-results|runtime-private|data|\.git)(\/|$)|(^|\/)\.env($|\.)|\.(pfx|p12|key)$|(^|\/)(owner|aggregate|pending-binding)\.json$/.test(entry));
  if (forbidden.length) throw Error(`Unexpected private/generated entries: ${JSON.stringify(forbidden)}`);
  const bytes = await readFile(file);
  const manifest = { date: '2026-11-12', name, commit, file, bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), selection: paths, entries };
  manifests.push(manifest);
}
await writeFile(path.join(output, 'source-manifest.json'), JSON.stringify({ date: '2026-11-12', protocolVersion: 'island-workbench/1', sources: manifests }, null, 2) + '\n');
console.log(JSON.stringify(manifests.map(({ entries, ...summary }) => ({ ...summary, files: entries.length })), null, 2));
