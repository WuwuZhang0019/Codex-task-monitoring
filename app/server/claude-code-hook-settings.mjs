import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { CLAUDE_CODE_HOOK_URL } from './claude-cli-monitor.mjs';
import { HttpError } from './validation.mjs';

const events = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'StopFailure', 'SessionEnd', 'Notification'];
const notifications = ['permission_prompt', 'idle_prompt'];
const allMatchers = new Set([undefined, '', '*', '.*', '^.*$']);
const matcherless = new Set(['UserPromptSubmit', 'Stop']);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

async function readSettings(file) {
  try { return await readFile(file, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

function parseSettings(raw) {
  let settings;
  try { settings = raw === null ? {} : JSON.parse(raw.replace(/^\uFEFF/, '')); }
  catch { throw new HttpError(409, 'Claude Code 用户设置不是有效的 JSON'); }
  if (!isObject(settings) || (settings.hooks !== undefined && !isObject(settings.hooks))) {
    throw new HttpError(409, 'Claude Code 用户设置或 hooks 的格式无效');
  }
  return settings;
}

function matchesNotification(matcher, value) {
  if (allMatchers.has(matcher)) return true;
  if (typeof matcher !== 'string') return false;
  if (/^[\w ,|-]+$/.test(matcher)) return matcher.split(/[|,]/).some(item => item.trim() === value);
  try { return new RegExp(matcher).test(value); } catch { return false; }
}

function missingHooks(settings) {
  const missing = [];
  for (const event of events) {
    const groups = settings.hooks?.[event] ?? [];
    if (!Array.isArray(groups)) throw new HttpError(409, `Claude Code 用户设置中的 ${event} Hooks 格式无效`);
    const receivers = groups.filter(group => Array.isArray(group?.hooks)
      && group.hooks.some(hook => hook?.type === 'http' && hook.url === CLAUDE_CODE_HOOK_URL && !hook.if));
    if (event === 'Notification') {
      const uncovered = notifications.filter(value => !receivers.some(group => matchesNotification(group.matcher, value)));
      if (uncovered.length) missing.push({ event, matcher: uncovered.join('|') });
    } else if (!receivers.some(group => matcherless.has(event) || allMatchers.has(group.matcher))) {
      missing.push({ event });
    }
  }
  return missing;
}

function policyBlock(settings) {
  if (settings.disableAllHooks === true) return 'Claude Code 用户设置已停用 Hooks';
  const allowlist = settings.allowedHttpHookUrls;
  if (allowlist === undefined) return null;
  const allowsCallback = Array.isArray(allowlist) && allowlist.some(pattern => {
    if (typeof pattern !== 'string') return false;
    const glob = pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    return new RegExp(`^${glob}$`).test(CLAUDE_CODE_HOOK_URL);
  });
  return allowsCallback ? null : 'Claude Code 用户设置的 HTTP Hook 白名单未允许任务岛回调';
}

export function createClaudeCodeHookSettings({ configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), receiverStatus }) {
  const settingsFile = path.resolve(configDir, 'settings.json');
  let installations = Promise.resolve();

  function status(settings, changed = false) {
    const receiver = receiverStatus();
    const missingEvents = missingHooks(settings).map(({ event }) => event);
    const blockedReason = policyBlock(settings);
    return {
      configured: !blockedReason && missingEvents.length === 0,
      listening: receiver.listening,
      changed,
      hookUrl: CLAUDE_CODE_HOOK_URL,
      registeredEvents: events.filter(event => !missingEvents.includes(event)),
      missingEvents,
      receiver,
      blockedReason,
    };
  }

  async function install() {
    const receiver = receiverStatus();
    if (!receiver.listening) throw new HttpError(409, '任务岛的 Claude Code CLI 回调端口未监听');
    const file = await realpath(settingsFile).catch(error => { if (error.code !== 'ENOENT') throw error; return settingsFile; });
    const raw = await readSettings(file);
    const settings = parseSettings(raw);
    const blockedReason = policyBlock(settings);
    if (blockedReason) throw new HttpError(409, blockedReason);
    const missing = missingHooks(settings);
    if (!missing.length) return status(settings);
    settings.hooks ??= {};
    for (const { event, matcher } of missing) {
      settings.hooks[event] ??= [];
      settings.hooks[event].push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'http', url: CLAUDE_CODE_HOOK_URL, timeout: 3 }] });
    }

    const mode = raw === null ? 0o600 : (await stat(file)).mode & 0o777;
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode });
      if (await readSettings(settingsFile) !== raw) throw new HttpError(409, 'Claude Code 用户设置正在被修改，请重试');
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
    return status(settings, true);
  }

  return {
    async read() { return status(parseSettings(await readSettings(settingsFile))); },
    install() {
      const pending = installations.then(install);
      installations = pending.catch(() => {});
      return pending;
    },
  };
}
