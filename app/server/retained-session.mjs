// 日期：2026-11-18。通过本机私有会话接回仍在执行的 Codex 回合。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { processAlive } from '../desktop/island-launcher.mjs';
import { liveUpdateProtocol } from '../desktop/runtime-protocol.mjs';

export class RetainedSessionClient {
  constructor(root, runId) {
    if (!/^[a-f0-9-]{36}$/i.test(runId)) throw Error('INVALID_RUN_ID');
    this.directory = path.join(root, 'runtime-private', 'sessions', runId);
    this.abort = new AbortController();
  }
  async discover() {
    try {
      const worker = JSON.parse(await readFile(path.join(this.directory, 'worker.json'), 'utf8'));
      if (worker.protocol !== liveUpdateProtocol || !/^http:\/\/127\.0\.0\.1:\d+$/.test(worker.endpoint)
        || !/^[a-f0-9]{64}$/.test(worker.token) || !worker.workerId) throw Error('INCOMPATIBLE_SESSION_WORKER');
      return processAlive(worker.pid) ? worker : null;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }
  async request(worker, method, args, signal = this.abort.signal) {
    const response = await fetch(worker.endpoint + '/session', {
      method: 'POST', headers: { Authorization: `Bearer ${worker.token}` }, body: JSON.stringify({ method, args }),
      redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(70000)]),
    });
    if (!response.ok) throw Error('SESSION_WORKER_UNAVAILABLE');
    const result = await response.json();
    if (result.error) {
      const { message, ...fields } = result.error;
      throw Object.assign(Error(message), fields);
    }
    return result.value;
  }
  async connect(expectedWorker) {
    this.abort.signal.throwIfAborted();
    if (!this.connecting) this.connecting = this.open(expectedWorker).catch(error => { this.connecting = null; throw error; });
    const worker = await this.connecting;
    if (expectedWorker && expectedWorker !== worker.workerId) throw Error('SESSION_WORKER_CHANGED');
    return worker;
  }
  async open(expectedWorker) {
    let worker = await this.discover();
    if (!worker && expectedWorker) throw Error('SESSION_WORKER_LOST');
    if (!worker) {
      const env = { ...process.env };
      delete env.WORKBENCH_SESSION_TOKEN;
      delete env.NODE_OPTIONS;
      const child = spawn(process.execPath, [fileURLToPath(new URL('./session-worker.mjs', import.meta.url)), this.directory], {
        detached: true, stdio: 'ignore', windowsHide: true, env,
      });
      let failed = false;
      child.once('error', () => { failed = true; });
      child.unref();
      const deadline = Date.now() + 15000;
      do {
        worker = await this.discover();
        if (worker || failed || child.exitCode !== null) break;
        await delay(50);
      } while (Date.now() < deadline);
    }
    if (!worker || (expectedWorker && worker.workerId !== expectedWorker)) throw Error('SESSION_WORKER_UNAVAILABLE');
    // A concurrent local connection may reuse a worker. Verify its instance before issuing any mutable request.
    const { workerId } = await this.request(worker, 'probe', [], AbortSignal.timeout(3000));
    if (workerId !== worker.workerId) throw Error('SESSION_WORKER_CHANGED');
    this.worker = worker;
    return worker;
  }
  get workerId() { return this.worker?.workerId; }
  async call(method, ...args) { return this.request(await this.connect(), method, args); }
  create(cwd, title) { return this.call('create', cwd, title); }
  async resume(threadId, expectedWorker) {
    return this.request(await this.connect(expectedWorker), 'resume', [threadId]);
  }
  attach(threadId) { return this.call('attach', threadId); }
  readThread(threadId) { return this.call('readThread', threadId); }
  notify(threadId, text, options) { return this.call('notify', threadId, text, options ?? {}); }
  async run(threadId, text, onStarted) {
    const turnId = await this.call('startTurn', threadId, text);
    await onStarted?.(turnId);
    return this.waitForTurn(threadId, turnId);
  }
  async waitForTurn(threadId, turnId) {
    for (;;) {
      const { turn, interactionRequired } = await this.call('turnState', threadId, turnId);
      this.interactionRequired = interactionRequired;
      if (turn.status !== 'inProgress') return turn;
      await delay(500, undefined, { signal: this.abort.signal });
    }
  }
  detach() { this.abort.abort(); }
  async close() {
    if (this.abort.signal.aborted) return;
    this.detach();
    const worker = await this.connecting?.catch(() => null);
    if (!worker) return;
    try {
      await this.request(worker, 'close', [], AbortSignal.timeout(2000));
      const deadline = Date.now() + 2000;
      // A resumed run can reuse this directory as soon as its prior worker relinquishes it.
      while (Date.now() < deadline && (await this.discover())?.workerId === worker.workerId) await delay(25);
    } catch { /* The worker may have already exited. */ }
  }
}
