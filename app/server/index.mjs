import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile, realpath, stat, readdir } from 'node:fs/promises';
import { createStore } from './store.mjs';
import { createModelStore } from './model-store.mjs';
import { createAI } from './ai.mjs';
import { HttpError, UUID } from './validation.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BODY_LIMIT = 2 * 1024 * 1024;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };

export function loadEnvironment(file = path.join(APP_DIR, '.env')) {
  const existing = { ...process.env };
  try { process.loadEnvFile(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  finally { for (const [key, value] of Object.entries(existing)) process.env[key] = value; }
}
function localAuthority(authority) {
  return typeof authority === 'string' && /^(?:localhost|127\.0\.0\.1|\[::1\])(?::(?:[1-9]\d{0,4}))?$/i.test(authority)
    && (!authority.match(/\]:(\d+)$|^[^:]+:(\d+)$/) || Number(authority.split(':').at(-1)) <= 65535);
}
function checkLocalRequest(req) {
  if (!localAuthority(req.headers.host)) throw new HttpError(403, '只允许 localhost Host 访问');
  // Reject duplicate security-sensitive headers, including differently cased ones.
  for (const name of ['host', 'origin']) {
    if (req.rawHeaders.filter((_, index) => index % 2 === 0 && req.rawHeaders[index].toLowerCase() === name).length > 1) throw new HttpError(403, '重复的 Host/Origin');
  }
  const origin = req.headers.origin;
  if (origin !== undefined) {
    let url;
    try { url = new URL(origin); } catch { throw new HttpError(403, '非法 Origin'); }
    if (!['http:', 'https:'].includes(url.protocol) || !localAuthority(url.host) || url.origin !== origin || url.username || url.password) {
      throw new HttpError(403, '拒绝非 localhost Origin');
    }
  }
}
function safePath(rawURL) {
  if (!rawURL.startsWith('/') || rawURL.startsWith('//')) throw new HttpError(400, '非法请求路径');
  let decoded;
  try { decoded = decodeURIComponent(rawURL.split('?')[0]); }
  catch { throw new HttpError(400, '路径编码非法'); }
  // Also reject Win32 alternate streams and dot/space aliases (the production host is Windows).
  if (decoded.includes('\\') || decoded.includes(':') || /[\x00-\x1f\x7f]/.test(decoded)
    || decoded.split('/').some(part => part && /^[. ]+$/.test(part))) {
    throw new HttpError(403, '拒绝目录越界');
  }
  return decoded;
}
async function jsonBody(req) {
  if (!(req.headers['content-type'] ?? '').toLowerCase().match(/^application\/json(?:\s*;|$)/)) throw new HttpError(415, 'Content-Type 必须为 application/json');
  if (Number(req.headers['content-length']) > BODY_LIMIT) throw new HttpError(413, '请求体超过 2MB');
  let size = 0; const chunks = [];
  // Keep the socket alive until our JSON 413 is flushed when rejecting a chunked body.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new HttpError(413, '请求体超过 2MB');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, '请求体不是有效 JSON'); }
}
function sendJSON(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
function contained(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
async function staticFile(res, pathname, distDir, head) {
  try {
    const root = await realpath(distDir);
    let target = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!contained(root, target)) throw new HttpError(403, '拒绝目录越界');
    try {
      target = await realpath(target);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (path.extname(pathname)) throw new HttpError(404, '文件不存在');
      target = await realpath(path.join(root, 'index.html'));
    }
    if (!contained(root, target)) throw new HttpError(403, '拒绝符号链接越界');
    if (!(await stat(target)).isFile()) throw new HttpError(404, '文件不存在');
    const content = await readFile(target);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream', 'Content-Length': content.length, 'Cache-Control': 'no-cache' });
    res.end(head ? undefined : content);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new HttpError(404, '生产 dist 不存在，请先构建前端');
    throw error;
  }
}
async function readSample(sampleFile) {
  if (sampleFile) return readFile(sampleFile, 'utf8');
  const root = path.dirname(APP_DIR);
  const names = (await readdir(root)).filter(name => /^01_.*\.md$/i.test(name)).sort();
  if (names.length !== 1) throw new HttpError(500, '项目根目录必须存在唯一的 01_*.md 样例文档');
  return readFile(path.join(root, names[0]), 'utf8');
}

// Does not listen on import. Tests call server.listen(0, '127.0.0.1').
// Configuration paths / fetchImpl are trusted caller options, never request data.
export async function createServer(options = {}) {
  if (!options.env) loadEnvironment();
  const env = options.env ?? process.env;
  const store = await createStore(options.dataDir ?? env.WORKBENCH_DATA_DIR ?? path.join(APP_DIR, 'data'));
  const models = await createModelStore(path.join(options.dataDir ?? env.WORKBENCH_DATA_DIR ?? path.join(APP_DIR, 'data'), 'models'),store);
  const ai = createAI({ env, fetchImpl: options.fetchImpl, timeoutMs: options.aiTimeoutMs });
  const distDir = options.distDir ?? path.join(APP_DIR, 'dist');
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      checkLocalRequest(req);
      const pathname = safePath(req.url);
      const method = req.method;
      if (pathname === '/api/health' && method === 'GET') return sendJSON(res, 200, { ok: true, ai: ai.health });
      if (pathname === '/api/sample' && method === 'GET') return sendJSON(res, 200, { text: await readSample(options.sampleFile) });
      if (pathname === '/api/projects') {
        if (method === 'GET') return sendJSON(res, 200, { projects: store.list() });
        if (method === 'POST') return sendJSON(res, 201, { project: await store.create(await jsonBody(req)) });
        throw new HttpError(405, '不支持的请求方法');
      }
      const modelMatch = pathname.match(/^\/api\/projects\/([^/]+)\/model$/);
      if(modelMatch){
        if(!UUID.test(modelMatch[1]))throw new HttpError(400,'项目 ID 必须是 UUID');
        if(method==='GET')return sendJSON(res,200,await models.get(modelMatch[1]));
        if(method==='PUT')return sendJSON(res,200,await models.update(modelMatch[1],await jsonBody(req)));
        throw new HttpError(405,'不支持的请求方法');
      }
      const match = pathname.match(/^\/api\/projects\/([^/]+)$/);
      if (match) {
        if (!UUID.test(match[1])) throw new HttpError(400, '项目 ID 必须是 UUID');
        if (method === 'GET') return sendJSON(res, 200, { project: store.get(match[1]) });
        if (method === 'PUT') return sendJSON(res, 200, { project: await store.update(match[1], await jsonBody(req)) });
        throw new HttpError(405, '不支持的请求方法');
      }
      if (pathname === '/api/ai/extract' || pathname === '/api/ai/summarize') {
        if (method !== 'POST') throw new HttpError(405, '不支持的请求方法');
        const body = await jsonBody(req);
        return sendJSON(res, 200, await ai[pathname.endsWith('/extract') ? 'extract' : 'summarize'](body));
      }
      if (pathname === '/api/health' || pathname === '/api/sample') throw new HttpError(405, '不支持的请求方法');
      if (pathname === '/api' || pathname.startsWith('/api/')) throw new HttpError(404, 'API 不存在');
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, '不支持的请求方法');
      await staticFile(res, pathname, distDir, method === 'HEAD');
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error('Local workbench request failed:', error.message);
      if (status === 413) { res.setHeader('Connection', 'close'); req.resume(); }
      sendJSON(res, status, { error: status === 500 ? '本地服务错误，请检查服务日志；数据未被清空' : error.message });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const server = await createServer();
    server.on('error', error => { console.error(`本地服务启动失败: ${error.message}`); process.exitCode = 1; });
    server.listen(4318, '127.0.0.1', () => console.log('任务工作台后端 http://127.0.0.1:4318'));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => { process.exitCode = 0; }));
  } catch (error) { console.error(`本地服务启动失败: ${error.message}`); process.exitCode = 1; }
}
