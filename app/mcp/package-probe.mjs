import { build } from 'esbuild';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = fileURLToPath(new URL('../', import.meta.url));
const repository = path.dirname(appDir);
const destination = process.argv[2];
if (!destination || !path.isAbsolute(destination)) throw new Error('Pass an absolute isolated output directory');
const pluginDir = path.join(destination, 'plugins', 'task-workbench');
await mkdir(pluginDir, { recursive: true });
await cp(path.join(repository, 'plugins/task-workbench'), pluginDir, { recursive: true });
await mkdir(path.join(pluginDir, 'runtime'), { recursive: true });
const buildResult = await build({
  entryPoints: [path.join(appDir, 'mcp/plugin-entry.mjs')],
  outfile: path.join(pluginDir, 'runtime/probe.mjs'), bundle: true,
  format: 'esm', platform: 'node', target: 'node22', metafile: true,
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
const packageDirectories = new Set();
for (const input of Object.keys(buildResult.metafile.inputs)) {
  const absolute = path.resolve(input);
  const parts = absolute.split(`${path.sep}node_modules${path.sep}`);
  if (parts.length < 2) continue;
  const packageParts = parts.at(-1).split(path.sep);
  const name = packageParts[0].startsWith('@') ? packageParts.slice(0, 2).join(path.sep) : packageParts[0];
  const prefix = absolute.slice(0, absolute.lastIndexOf(`${path.sep}node_modules${path.sep}`));
  packageDirectories.add(path.join(prefix, 'node_modules', name));
}
const licenses = [];
for (const directory of [...packageDirectories].sort()) {
  const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  let licenseText = '';
  for (const filename of ['LICENSE', 'LICENSE.txt', 'LICENSE.md', 'license', 'LICENSE-MIT']) {
    try { licenseText = await readFile(path.join(directory, filename), 'utf8'); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!licenseText) throw new Error(`Missing license text for ${metadata.name}`);
  licenses.push(`${metadata.name}@${metadata.version} (${metadata.license})\n${licenseText}`);
}
await writeFile(path.join(pluginDir, 'THIRD-PARTY-NOTICES.txt'), `日期：2026-11-09\n\n${licenses.join('\n\n---\n\n')}\n`, 'utf8');
await mkdir(path.join(destination, '.agents/plugins'), { recursive: true });
await writeFile(path.join(destination, '.agents/plugins/marketplace.json'), JSON.stringify({
  name: 'task-workbench-u01-local', interface: { displayName: 'U01 本地探测' },
  plugins: [{ name: 'task-workbench', source: { source: 'local', path: './plugins/task-workbench' },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } }],
}, null, 2));
await writeFile(path.join(destination, 'build-meta.json'), JSON.stringify({ date: '2026-11-09', ...buildResult.metafile }, null, 2));
console.log(JSON.stringify({ pluginDir, marketplaceRoot: destination, bundledPackages: packageDirectories.size }));
