// Date: 2026-11-12. Native-only credentials never enter a WebView or discovery record.
import { mkdir, chmod, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
const execute = promisify(execFile);
export async function preparePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    if (!process.env.USERNAME) throw Error('PRIVATE_ACCOUNT_UNAVAILABLE');
    await execute('icacls.exe', [directory, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:(OI)(CI)F`, 'SYSTEM:(OI)(CI)F', '/Q'], { windowsHide: true });
  } else await chmod(directory, 0o700);
}
export async function writePrivateJson(file, value) {
  const temporary = path.join(path.dirname(file), `${path.basename(file)}-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  await rename(temporary, file);
}
