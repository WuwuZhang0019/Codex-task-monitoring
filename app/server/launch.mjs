import { spawn } from 'node:child_process';
import { createServer } from './index.mjs';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 16)) {
  console.error('Node.js 22.16 or newer is required.');
  process.exit(1);
}
try {
  const server = await createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(4318, '127.0.0.1', resolve);
  });
  const url = 'http://127.0.0.1:4318';
  console.log(`\n任务工作台已启动：${url}\n请保留此窗口；关闭窗口或按 Ctrl+C 停止服务。\n`);
  if (process.platform === 'win32') {
    const browser = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'start', '', url], { stdio: 'ignore', windowsHide: true });
    browser.on('error', () => console.log(`请手动用浏览器打开 ${url}`));
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    server.closeIdleConnections();
    server.close(() => { process.exitCode = 0; });
  });
} catch (error) {
  console.error(error.code === 'EADDRINUSE'
    ? '端口 4318 已被占用。若工作台已经启动，请打开 http://127.0.0.1:4318；否则先关闭占用端口的程序。'
    : `启动失败：${error.message}`);
  process.exitCode = 1;
}
