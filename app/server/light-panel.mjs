// 日期 2026-11-11。仅由已认证桌面所有者入口调用，不接受客户端文件路径或主体。
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { HttpError } from './validation.mjs';
import { validAppId } from './light-apps.mjs';

export function createLightPanel(persistence, { connections = () => [] } = {}) {
  const cache = new Map();
  function preferences(value) {
    const arrays = ['collapsed', 'focus'];
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'collapsed,focus,scroll,selected,y'
      || typeof value.selected !== 'string' || value.selected.length > 2000
      || arrays.some(key => !Array.isArray(value[key]) || value[key].length > 2000 || value[key].some(x => typeof x !== 'string' || x.length > 2000))
      || ['scroll', 'y'].some(key => !value[key] || typeof value[key] !== 'object' || Array.isArray(value[key])
        || Object.entries(value[key]).length > 4000 || Object.entries(value[key]).some(([k, v]) => k.length > 4000 || !Number.isFinite(v) || v < 0 || v > 1e8))) {
      throw new HttpError(400, '阅读偏好格式无效');
    }
    return structuredClone(value);
  }
  return {
    async read() {
      const snapshot = persistence.read('light')?.snapshot ?? { schemaVersion: 'light-1.0', date: new Date().toISOString().slice(0, 10), mode: 'service', revision: 0,
        generatedAt: new Date().toISOString(), projects: [], plans: [], steps: [], routes: [], bindings: [], executions: [], supplements: [], events: [] };
      const sources = {};
      for (const plan of snapshot.plans) {
        const key = `${plan.source.path}/${plan.source.sha256}`;
        if (!cache.has(key)) {
          try {
            if ((await stat(plan.source.path)).size > 2 * 1024 * 1024) throw Error('SOURCE_TOO_LARGE');
            const bytes = await readFile(plan.source.path);
            if (createHash('sha256').update(bytes).digest('hex') !== plan.source.sha256) throw Error('SOURCE_CHANGED');
            cache.set(key, bytes.toString('utf8'));
          } catch { /* 来源不可验证时仅返回定位信息，不冒充原文。 */ }
        }
        sources[plan.key] = cache.get(key) ?? null;
      }
      const grants = persistence.read('grants');
      const owners = persistence.read('light')?.metadata.bindingOwners ?? {};
      const bindingApps = {};
      for (const binding of snapshot.bindings) {
        const principal = owners[binding.key] ?? binding.confirmationRef?.match(/^automatic:(.+)$/)?.[1];
        const grant = grants[principal];
        const app = grant?.kind === 'lightAccess' ? grant.appId ?? 'codex' : null;
        if (validAppId(app)) bindingApps[binding.key] = app;
      }
      return { date: '2026-11-12', snapshot, sources, preferences: persistence.read('lightPanelPreferences') ?? null,
        agentApps: connections(), bindingApps,
        library: persistence.read('lightLibrary') ?? { version: 1, archived: [] }, librarySupported: true,
        capabilities: { threadJump: false, reason: '当前宿主未提供聊天跳转；可复制固定 ID，在 Codex 中查找' } };
    },
    save(value) { const checked = preferences(value); return persistence.run(() => { persistence.write('lightPanelPreferences', checked); return { saved: true }; }); },
  };
}
