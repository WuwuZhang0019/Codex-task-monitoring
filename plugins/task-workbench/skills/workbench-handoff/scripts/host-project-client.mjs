// 日期：2026-11-13。公开 experimental app-server 项目协议；不操作 UI、聊天或私有数据库。
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const text = value => typeof value === 'string' && !!value.trim();
const fail = (code, extra = {}) => Object.assign(Error(code), { code, ...extra });
const check = (condition, code) => { if (!condition) throw fail(code); };
export function projectEnvironment(environment = process.env) {
  const value = { ...environment };
  for (const key of ['CODEX_WINDOWS_REGISTERED_CORE', 'CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY', 'CODEX_APP_RUNTIME_CLI_PATH',
    'CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_TOOL_CALL_ID', 'CODEX_APP_TOOLS_PIPE_PATH', 'CODEX_APP_TOOLS_CALLER_HOST_ID',
    'CODEX_INTERNAL_ORIGINATOR_OVERRIDE']) delete value[key];
  return value;
}
export function projectExecutable(environment = process.env) {
  if (text(environment.WORKBENCH_CODEX_BIN)) return environment.WORKBENCH_CODEX_BIN;
  if (text(environment.CODEX_APP_RUNTIME_CLI_PATH) && existsSync(environment.CODEX_APP_RUNTIME_CLI_PATH)) return environment.CODEX_APP_RUNTIME_CLI_PATH;
  if (process.platform === 'win32') {
    const candidate = path.join(environment.APPDATA ?? path.join(os.homedir(), 'AppData/Roaming'),
      'npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe');
    if (existsSync(candidate)) return candidate;
  }
  return 'codex';
}
function object(value, allowed) {
  check(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => allowed.includes(key)), 'HOST_PROJECT_PARAMS_INVALID');
}
function createParams(value) {
  object(value, ['idempotencyKey', 'name', 'roots', 'metadata']);
  check(text(value.idempotencyKey) && text(value.name), 'HOST_PROJECT_IDEMPOTENCY_AND_NAME_REQUIRED');
  check(Array.isArray(value.roots) && value.roots.length > 0, 'HOST_PROJECT_ROOTS_REQUIRED');
  const keys = value.roots.map(root => {
    object(root, ['path']); check(text(root.path), 'HOST_PROJECT_ABSOLUTE_ROOT_REQUIRED');
    const windows = /^[a-z]:[\\/]|^\\\\/i.test(root.path), dialect = windows ? path.win32 : path.posix;
    check(dialect.isAbsolute(root.path), 'HOST_PROJECT_ABSOLUTE_ROOT_REQUIRED');
    return windows ? dialect.normalize(root.path).replace(/[\\/]+$/, '').toLowerCase() : dialect.normalize(root.path);
  });
  check(new Set(keys).size === keys.length, 'HOST_PROJECT_DUPLICATE_ROOT');
  if (value.metadata !== undefined && value.metadata !== null) {
    check(typeof value.metadata === 'object' && !Array.isArray(value.metadata)
      && Object.values(value.metadata).every(item => typeof item === 'string'), 'HOST_PROJECT_METADATA_INVALID');
  }
  return structuredClone(value);
}

export class HostProjectClient {
  constructor({ environment = process.env, executable = projectExecutable(environment), spawnImpl = spawn, timeoutMs = 30000 } = {}) {
    this.environment = projectEnvironment(environment); this.executable = executable; this.spawnImpl = spawnImpl;
    this.timeoutMs = timeoutMs; this.pending = new Map(); this.sequence = 0; this.closed = false;
  }
  async connect() {
    if (this.connecting) return this.connecting;
    check(!this.closed, 'HOST_PROJECT_CLIENT_CLOSED');
    this.connecting = this.open();
    return this.connecting;
  }
  async open() {
    this.child = this.spawnImpl(this.executable, ['app-server', '--stdio'], {
      windowsHide: true, shell: false, env: this.environment, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stderr?.resume();
    this.child.stdin.on('error', () => this.disconnect('HOST_PROJECT_DISCONNECTED'));
    this.child.stdout.on('error', () => this.disconnect('HOST_PROJECT_DISCONNECTED'));
    this.child.on('error', () => this.disconnect('HOST_PROJECT_EXECUTOR_UNAVAILABLE'));
    this.child.on('exit', () => this.disconnect('HOST_PROJECT_DISCONNECTED'));
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => { try { this.receive(JSON.parse(line)); } catch { this.disconnect('HOST_PROJECT_PROTOCOL_INVALID'); } });
    await this.request('initialize', { clientInfo: { name: 'workbench_host_projects', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    this.child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  }
  request(method, params) {
    check(!this.closed, 'HOST_PROJECT_CLIENT_CLOSED');
    const id = ++this.sequence, mutation = method === 'project/create';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(fail(mutation ? 'HOST_PROJECT_RESULT_UNKNOWN' : 'HOST_PROJECT_REQUEST_TIMEOUT', { resultUnknown: mutation })); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, mutation });
      try { this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n'); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(fail(mutation ? 'HOST_PROJECT_RESULT_UNKNOWN' : 'HOST_PROJECT_DISCONNECTED', { resultUnknown: mutation })); }
    });
  }
  receive(message) {
    const item = this.pending.get(message.id);
    if (item) {
      clearTimeout(item.timer); this.pending.delete(message.id);
      if (message.error) item.reject(fail('HOST_PROJECT_REQUEST_REJECTED', { rpcCode: message.error.code, detail: message.error.message, resultUnknown: false }));
      else item.resolve(message.result);
    } else if (message.id !== undefined && message.method) {
      this.child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32000, message: 'USER_INTERACTION_REQUIRED' } }) + '\n');
    }
  }
  disconnect(code) {
    this.closed = true;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(fail(item.mutation ? 'HOST_PROJECT_RESULT_UNKNOWN' : code, { resultUnknown: item.mutation })); }
    this.pending.clear();
  }
  async list(params = {}) {
    object(params, ['cursor', 'limit', 'sortKey', 'sortDirection']);
    check(params.limit == null || Number.isSafeInteger(params.limit) && params.limit >= 0, 'HOST_PROJECT_LIMIT_INVALID');
    check(params.cursor == null || typeof params.cursor === 'string', 'HOST_PROJECT_CURSOR_INVALID');
    check(params.sortKey == null || ['position', 'recencyAt'].includes(params.sortKey), 'HOST_PROJECT_SORT_INVALID');
    check(params.sortDirection == null || params.sortKey && ['asc', 'desc'].includes(params.sortDirection), 'HOST_PROJECT_SORT_INVALID');
    await this.connect(); return this.request('project/list', params);
  }
  async create(params) { const input = createParams(params); await this.connect(); return this.request('project/create', input); }
  async read(params) { object(params, ['projectId']); check(text(params.projectId), 'HOST_PROJECT_ID_REQUIRED'); await this.connect(); return this.request('project/read', params); }
  close() { this.disconnect('HOST_PROJECT_CLIENT_CLOSED'); this.lines?.close(); this.child?.stdin.end(); this.child?.kill(); }
}

export async function hostProjectCli(argv = process.argv.slice(2)) {
  const [command, inputFile] = argv;
  if (command === 'describe') return { date: '2026-11-13', transport: 'public app-server stdio', experimentalApi: true,
    methods: ['project/list', 'project/create', 'project/read'], createRequired: ['idempotencyKey', 'name', 'roots'],
    limitation: 'Protocol availability must be checked against the installed executable; desktop sidebar visibility requires independent list_projects verification.' };
  check(['list', 'create', 'read'].includes(command), 'USAGE: node host-project-client.mjs <describe|list|create|read> [input.json]');
  const input = inputFile ? JSON.parse(await readFile(inputFile, 'utf8')) : {};
  const client = new HostProjectClient();
  try { return await client[command](input); } finally { client.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await hostProjectCli(), null, 2)); }
  catch (error) { console.error(JSON.stringify({ error: { code: error.code ?? 'HOST_PROJECT_CLIENT_FAILED', resultUnknown: error.resultUnknown ?? false,
    ...(error.rpcCode !== undefined ? { rpcCode: error.rpcCode } : {}), ...(error.detail ? { detail: error.detail } : {}) } })); process.exitCode = 1; }
}
