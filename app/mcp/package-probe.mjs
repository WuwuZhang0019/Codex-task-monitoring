import { bundledLicenses } from './licenses.mjs';
import { build } from 'esbuild';
import { cp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const appDir = fileURLToPath(new URL('../', import.meta.url));
const repository = path.dirname(appDir);
// 日期：2026-11-11。每个包记录明确源码提交、脏文件和全部发布文件指纹。
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {cwd:repository,encoding:'utf8',windowsHide:true}).trim();
const dirtySource = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', 'plugins/task-workbench', 'app/mcp', 'app/server', 'app/desktop/prepare-resources.mjs'], {cwd:repository,encoding:'utf8',windowsHide:true}).trim();
if (process.argv.includes('--require-clean') && dirtySource) throw new Error('RELEASE_SOURCE_NOT_COMMITTED');
const generatedDate = new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Shanghai'}).format(new Date());
const destination = process.argv[2];
if (!destination || !path.isAbsolute(destination)) throw new Error('Pass an absolute isolated output directory');
const pluginDir = path.join(destination, 'plugins', 'task-workbench');
if (path.relative(path.resolve(destination), path.resolve(pluginDir)) !== path.join('plugins','task-workbench')) throw new Error('Invalid generated plugin directory');
await rm(pluginDir, { recursive:true, force:true });
await mkdir(pluginDir, { recursive: true });
await cp(path.join(repository, 'plugins/task-workbench'), pluginDir, { recursive: true });
const runtime = path.resolve(pluginDir, 'runtime');
if (path.relative(pluginDir, runtime) !== 'runtime') throw new Error('Invalid generated runtime directory');
await rm(runtime, { recursive: true, force: true });
await mkdir(runtime, { recursive: true });
const buildResult = await build({
  entryPoints: [path.join(appDir, 'mcp/light-stdio.mjs')],
  outfile: path.join(pluginDir, 'runtime/light.mjs'), bundle: true,
  format: 'esm', platform: 'node', target: 'node22', metafile: true,
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
const { licenses, count: packageCount } = await bundledLicenses(buildResult.metafile);
await writeFile(path.join(pluginDir, 'THIRD-PARTY-NOTICES.txt'), `日期：${generatedDate}\n\n${licenses.join('\n\n---\n\n')}\n`, 'utf8');
await mkdir(path.join(destination, '.agents/plugins'), { recursive: true });
await writeFile(path.join(destination, '.agents/plugins/marketplace.json'), JSON.stringify({
  name: 'task-workbench-u01-local', interface: { displayName: '任务工作台本地连接' },
  plugins: [{ name: 'task-workbench', source: { source: 'local', path: './plugins/task-workbench' },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } }],
}, null, 2));
const manifest = JSON.parse(await readFile(path.join(pluginDir, 'plugin.json'), 'utf8'));
const fingerprints = {};
async function inventory(directory) {
  for (const entry of await readdir(directory, {withFileTypes:true})) {
    const file=path.join(directory,entry.name);
    if (entry.isDirectory()) await inventory(file);
    else if (entry.name !== 'release-manifest.json') fingerprints[path.relative(pluginDir,file).replaceAll('\\','/')]=createHash('sha256').update(await readFile(file)).digest('hex');
  }
}
await inventory(pluginDir);
await writeFile(path.join(pluginDir,'release-manifest.json'),JSON.stringify({date:generatedDate,version:manifest.version,sourceCommit,releaseReady:!dirtySource,dirtySource,fingerprints},null,2)+'\n','utf8');
await writeFile(path.join(destination, 'build-meta.json'), JSON.stringify({ date: generatedDate,
  sourceCommit, releaseReady:!dirtySource, pluginName: manifest.name, pluginVersion: manifest.version, runtimeEntry: 'runtime/light.mjs', ...buildResult.metafile }, null, 2));
console.log(JSON.stringify({ pluginDir, marketplaceRoot: destination, bundledPackages: packageCount }));
