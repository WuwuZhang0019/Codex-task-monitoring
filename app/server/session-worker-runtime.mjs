// 日期：2026-11-18。独立进程持有 Codex app-server 的标准输入输出。
import http from 'node:http';
import path from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { acquireDataLease } from './data-lease.mjs';
import { CodexSessionClient } from './codex-session-client.mjs';
import { preparePrivateDirectory, writePrivateJson } from '../desktop/private-runtime.mjs';
import { liveUpdateProtocol } from '../desktop/runtime-protocol.mjs';

export async function runSessionWorker(directory, client = new CodexSessionClient()) {
  if (!path.isAbsolute(directory) || !/^[a-f0-9-]{36}$/i.test(path.basename(directory))) throw Error('INVALID_SESSION_DIRECTORY');
  await preparePrivateDirectory(directory);
  const release = acquireDataLease(directory);
  const file = path.join(directory, 'worker.json');
  const token = randomBytes(32).toString('hex');
  const workerId = randomUUID();
  const authorization = Buffer.from(`Bearer ${token}`);
  let lastRequest = Date.now(), stopping = false, inFlight = 0, uncertain = false, live;
  const turnActive = () => live && !client.finished.has(live.threadId + '/' + live.turnId);
  async function stop() {
    if (stopping) return;
    stopping = true;
    clearInterval(reaper);
    await new Promise(resolve => server.close(resolve));
    client.close();
    await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    release();
  }
  const methods = {
    probe: () => ({ workerId }),
    create: (cwd, title) => client.create(cwd, title),
    resume: async threadId => client.owned.has(threadId)
      ? { thread: await client.readThread(threadId) } : client.resume(threadId),
    attach: threadId => client.attach(threadId),
    readThread: threadId => client.readThread(threadId),
    async notify(threadId, text, options) {
      const { turnId, delivery } = await client.notify(threadId, text, options);
      live = { threadId, turnId };
      return { turnId, delivery };
    },
    async startTurn(threadId, text) {
      if (uncertain || turnActive()) throw Error('CODEX_THREAD_BUSY');
      client.finished.clear();
      uncertain = true;
      try {
        const turnId = await client.startTurn(threadId, text);
        live = { threadId, turnId };
        uncertain = false;
        return turnId;
      } catch (error) {
        if (error.code === 'CODEX_REQUEST_REJECTED') uncertain = false;
        throw error;
      }
    },
    async turnState(threadId, turnId) {
      const turn = client.finished.get(threadId + '/' + turnId)
        ?? (await client.readThread(threadId)).turns.find(item => item.id === turnId);
      if (!turn) throw Error('CODEX_ACTIVE_TURN_UNKNOWN');
      if (turn.status !== 'inProgress' && live?.threadId === threadId && live.turnId === turnId) live = null;
      return { turn, interactionRequired: !!client.interactionRequired };
    },
    close: () => null,
  };
  const server = http.createServer({ requestTimeout: 10000, headersTimeout: 5000 }, async (req, res) => {
    const supplied = Buffer.from(req.headers.authorization ?? '');
    if (req.method !== 'POST' || req.url !== '/session' || req.headers.origin !== undefined
      || supplied.length !== authorization.length || !timingSafeEqual(supplied, authorization) || stopping) {
      res.writeHead(403).end();
      return;
    }
    inFlight++;
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) throw Error('INVALID_SESSION_REQUEST');
        chunks.push(chunk);
      }
      const { method, args } = JSON.parse(Buffer.concat(chunks));
      if (!Object.hasOwn(methods, method) || !Array.isArray(args) || stopping) throw Error('INVALID_SESSION_REQUEST');
      const value = await methods[method](...args);
      if (method === 'close') res.once('finish', () => void stop().catch(() => process.exit(1)));
      res.end(JSON.stringify({ value }));
    } catch (error) {
      res.end(JSON.stringify({ error: { message: error.message, code: error.code, rpcCode: error.rpcCode, rpcMessage: error.rpcMessage } }));
    } finally {
      lastRequest = Date.now();
      inFlight--;
    }
  });
  const reaper = setInterval(() => {
    // Retain live and uncertain turns even when their backend is temporarily gone.
    if (!inFlight && !uncertain && !turnActive() && Date.now() - lastRequest > 5 * 60 * 1000) {
      void stop().catch(() => process.exit(1));
    }
  }, 10000);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  await writePrivateJson(file, { protocol: liveUpdateProtocol, workerId, pid: process.pid, token, endpoint: `http://127.0.0.1:${server.address().port}` });
}
