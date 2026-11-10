import { buildBusinessSchema } from '../mcp/build-business-schema.mjs';
import { bundledLicenses } from '../mcp/licenses.mjs';
import { build } from 'esbuild';
import { cp, mkdir, readFile, writeFile, copyFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { builtinModules } from 'node:module';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.join(app, 'desktop/resources');
const generatedDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
await mkdir(path.join(root, 'app/desktop'), { recursive: true });
const nodeVersion = '25.5.0';
const archiveName = `node-v${nodeVersion}-win-x64.zip`;
const cache = path.join(app, 'test-results/runtime-download');
await mkdir(cache, { recursive: true });
async function cachedDownload(name) {
  const file = path.join(cache, name);
  try { return await readFile(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const response = await fetch(`https://nodejs.org/dist/v${nodeVersion}/${name}`);
  if (!response.ok) throw Error(`Node distribution unavailable ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(file, bytes);
  return bytes;
}
const sums = (await cachedDownload('SHASUMS256.txt')).toString('utf8');
const archive = await cachedDownload(archiveName);
const expected = sums.split(/\r?\n/).find(line => line.endsWith(`  ${archiveName}`))?.split(' ')[0];
if (!expected || createHash('sha256').update(archive).digest('hex') !== expected) throw Error('Node distribution checksum mismatch');
execFileSync('tar.exe', ['-xf', path.join(cache, archiveName), '-C', cache], { windowsHide: true });
const distribution = path.join(cache, `node-v${nodeVersion}-win-x64`);
await copyFile(path.join(distribution, 'node.exe'), path.join(root, 'node.exe'));
await copyFile(path.join(distribution, 'LICENSE'), path.join(root, 'NODE-LICENSE'));
await buildBusinessSchema();
for (const directory of ['server', 'mcp', 'dist']) {
  const destination = path.resolve(root, 'app', directory);
  const relative = path.relative(root, destination);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw Error('Resource destination escapes generated root');
  await rm(destination, { recursive: true, force: true });
  await cp(path.join(app, directory), destination, { recursive: true });
}
for (const name of ['owner.mjs', 'migrate.mjs', 'client.mjs']) {
  await copyFile(path.join(app, 'desktop', name), path.join(root, 'app/desktop', name));
}
// 日期 2026-11-11。保持 server/index 的相对位置，随发行物携带运行依赖。
const serverBuild = await build({
  absWorkingDir: app, entryPoints: ['server/index.mjs'], outfile: path.join(root, 'app/server/index.mjs'),
  bundle: true, format: 'esm', platform: 'node', target: 'node22', metafile: true,
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
const serverLicenses = await bundledLicenses(serverBuild.metafile, app);
const serverExternalImports = [...new Set(Object.values(serverBuild.metafile.outputs)
  .flatMap(output => output.imports).filter(input => input.external).map(input => input.path))];
const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
if (serverExternalImports.some(name => !builtins.has(name))) throw Error('Server bundle has unresolved runtime dependencies');
await writeFile(path.join(root, 'SERVER-THIRD-PARTY-NOTICES.txt'),
  `日期：${generatedDate}\n\n${serverLicenses.licenses.join('\n\n---\n\n')}\n`, 'utf8');
const probePackage = path.join(cache, 'probe-package');
execFileSync(process.execPath, [path.join(app, 'mcp/package-probe.mjs'), probePackage], { windowsHide: true });
await copyFile(path.join(probePackage, 'plugins/task-workbench/runtime/light.mjs'), path.join(root, 'app/mcp/light-bundled.mjs'));
await copyFile(path.join(probePackage, 'plugins/task-workbench/THIRD-PARTY-NOTICES.txt'), path.join(root, 'MCP-THIRD-PARTY-NOTICES.txt'));
const template = 'docs/03_轻量路线工作台/05_使用与指令模板/02_任务收敛与交接指令_原文_2026-11-08.md';
await mkdir(path.dirname(path.join(root, template)), { recursive: true });
await copyFile(path.join(app, '..', template), path.join(root, template));
const sampleDir = path.join(app, '../docs/99_归档');
const sample = (await readdir(sampleDir)).find(n => /^01_.*\.md$/.test(n));
await mkdir(path.join(root, 'docs/99_归档'), { recursive: true });
await copyFile(path.join(sampleDir, sample), path.join(root, 'docs/99_归档', sample));
// Node's license includes the notices for its bundled third-party components.
await writeFile(path.join(root, 'NODE-SHASUMS256.txt'), sums);
const manifest = { date: generatedDate, nodeVersion, nodeExeSha256: createHash('sha256').update(await readFile(path.join(root,'node.exe'))).digest('hex'), distribution: archiveName, distributionSha256: expected,
  serverEntrypoint: 'app/server/index.mjs', serverBundledPackages: serverLicenses.count, serverExternalImports, resources: {} };
async function inventory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await inventory(file);
    else if (file !== path.join(root, 'manifest.json')) manifest.resources[path.relative(root, file).replaceAll('\\', '/')] = createHash('sha256').update(await readFile(file)).digest('hex');
  }
}
await inventory(root);
await writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`Runtime resources prepared, Node ${manifest.nodeVersion}`);
