import path from 'node:path';
import { readFile } from 'node:fs/promises';

export async function bundledLicenses(metafile, workingDirectory = process.cwd()) {
  const directories = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const absolute = path.resolve(workingDirectory, input);
    const separator = `${path.sep}node_modules${path.sep}`;
    const index = absolute.lastIndexOf(separator);
    if (index < 0) continue;
    const parts = absolute.slice(index + separator.length).split(path.sep);
    const name = parts[0].startsWith('@') ? parts.slice(0, 2).join(path.sep) : parts[0];
    directories.add(path.join(absolute.slice(0, index), 'node_modules', name));
  }
  const licenses = [];
  for (const directory of [...directories].sort()) {
    const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
    let licenseText = '';
    for (const name of ['LICENSE', 'LICENSE.txt', 'LICENSE.md', 'license', 'LICENSE-MIT']) {
      try { licenseText = await readFile(path.join(directory, name), 'utf8'); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!licenseText) throw Error(`Missing license text for ${metadata.name}`);
    licenses.push(`${metadata.name}@${metadata.version} (${metadata.license})\n${licenseText}`);
  }
  return { licenses, count: directories.size };
}
