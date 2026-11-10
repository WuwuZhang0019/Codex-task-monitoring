import { bundledLicenses } from './licenses.mjs';
import { build } from 'esbuild';
import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = fileURLToPath(new URL('../', import.meta.url));
const repository = path.dirname(appDir);
const generatedDate = new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Shanghai'}).format(new Date());
const destination = process.argv[2];
if (!destination || !path.isAbsolute(destination)) throw new Error('Pass an absolute isolated output directory');
const pluginDir = path.join(destination, 'plugins', 'task-workbench');
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
await writeFile(path.join(destination, 'build-meta.json'), JSON.stringify({ date: generatedDate,
  pluginName: manifest.name, pluginVersion: manifest.version, runtimeEntry: 'runtime/light.mjs', ...buildResult.metafile }, null, 2));
console.log(JSON.stringify({ pluginDir, marketplaceRoot: destination, bundledPackages: packageCount }));
