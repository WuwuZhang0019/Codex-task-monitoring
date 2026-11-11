// 日期：2026-11-11。回归 E 遗留并发 2MiB 请求连接重置观察，使用独立服务与数据目录。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createServer } from './index.mjs';

test('concurrent oversized length and chunked JSON return 413 without writes or connection reset', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'delivery-body-'));
  const server = await createServer({ dataDir: root, env: {} });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const oversized = JSON.stringify({ name: 'must not commit', source: 'x'.repeat(2 * 1024 * 1024) });
  for (let round = 0; round < 3; round++) {
    await Promise.all(Array.from({ length: 8 }, async (_, index) => {
      const chunked = index % 2 === 1;
      async function* chunks() {
        for (let offset = 0; offset < oversized.length; offset += 65536) yield oversized.slice(offset, offset + 65536);
      }
      const response = await fetch(endpoint + '/api/projects', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: chunked ? chunks() : oversized, ...(chunked ? { duplex: 'half' } : {}),
        signal: AbortSignal.timeout(15000),
      });
      assert.equal(response.status, 413, `round ${round}, chunked ${chunked}`);
      assert.match((await response.json()).error, /2MB/);
    }));
    assert.equal((await fetch(endpoint + '/api/health')).status, 200);
    const projects = await (await fetch(endpoint + '/api/projects')).json();
    assert.equal(projects.projects.length, 0, 'oversized requests must never commit');
  }
});
