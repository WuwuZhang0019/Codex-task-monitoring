import http from 'node:http';
import path from 'node:path';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { createStore } from '../server/store.mjs';
import { createModelStore } from '../server/model-store.mjs';
import { inspectMonitor } from '../server/monitor.mjs';

// U01 read-only facade. The fixture creator and this owner share the existing stores.
export async function createProbeOwner({ dataDir, projectId, token, audit = () => {} }) {
  if (!path.isAbsolute(dataDir) || !token || token.length < 32) throw new Error('Invalid probe owner configuration');
  const projects = await createStore(dataDir);
  const models = await createModelStore(path.join(dataDir, 'models'), projects);
  projects.get(projectId);
  const expected = Buffer.from(`Bearer ${token}`);
  return http.createServer(async (req, res) => {
    const requestId = randomUUID();
    const reply = (status, value) => {
      audit({ requestId, status, time: new Date().toISOString() });
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    const supplied = Buffer.from(req.headers.authorization ?? '');
    const duplicated = ['authorization', 'host'].some(name => req.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === name).length !== 1);
    if (duplicated || req.headers.origin !== undefined || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return reply(403, { error: 'FORBIDDEN' });
    }
    if (!/^127\.0\.0\.1:\d+$/.test(req.headers.host ?? '') || req.method !== 'GET' || req.url !== `/probe/projects/${projectId}`) {
      return reply(404, { error: 'OUT_OF_SCOPE' });
    }
    try {
      const project = projects.get(projectId);
      const { revision, model } = await models.get(projectId);
      const monitor = inspectMonitor(projectId, model);
      return reply(200, {
        schemaVersion: '1.0.0', ruleVersion: 'u01-probe-v1', requestId,
        status: 'accepted', basisRevision: revision,
        supportedCapabilities: ['project.read.probe'], disposition: 'wait_verification',
        sourceTrust: 'declared', sourceTrustReason: 'U01 read probe has no authenticated chat binding',
        result: { project: {
          projectId: project.id, name: project.name, goal: project.goal,
          currentPlanId: model.currentPlanId,
          stations: monitor.stations.map(station => ({
            stationId: station.id, code: station.code, title: station.title,
            dependsOn: station.dependsOn, state: station.state, label: station.label,
          })),
        } },
      });
    } catch {
      return reply(500, { error: 'OWNER_READ_FAILED' });
    }
  });
}
