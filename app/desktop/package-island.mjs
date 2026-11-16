// 日期：2026-11-16。唯一桌面打包入口为任务岛外壳。
import { spawnSync } from 'node:child_process';
import { access, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = fileURLToPath(new URL('../', import.meta.url));
const shell = path.resolve(process.env.WORKBENCH_ISLAND_SOURCE || path.join(app, '../../windows-dynamic-island'));
await access(path.join(shell, 'src-tauri/tauri.conf.json'));
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
run(process.execPath, ['desktop/prepare-resources.mjs'], app);
// 清除旧发布缓存，防止外壳复制资源时继续携带已删除的网页。
await rm(path.join(shell, 'runtime/workbench/app/dist'), { recursive: true, force: true });
run(process.env.BUN_EXECUTABLE || 'bun', ['run', 'app:build:local', '--bundles', 'nsis'], shell);
