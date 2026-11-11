// Date: 2026-11-12. Isolated data only; never reads the user's desktop sessions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { startService, stopService } from './service.mjs';
import { connectOwner, discoverOwner } from './client.mjs';
import { acquireDataLease } from '../server/data-lease.mjs';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('standalone owner survives launching client exit, attaches without a second writer and explicitly restarts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'island-owner-'));
  try {
    const first = await startService(root);
    assert.equal(first.lifetime, 'standalone');
    await pause(400);
    const second = await startService(root);
    assert.equal(second.attached, true);
    assert.equal(second.ownerGeneration, first.ownerGeneration);
    assert.equal(second.pid, first.pid);
    assert.throws(() => acquireDataLease(root), /DATA_ROOT_BUSY/);
    const credentials = await connectOwner(root);
    assert.equal(credentials.record.pid, first.pid);
    const discovery = await readFile(path.join(root, 'owner.json'), 'utf8');
    assert.equal(discovery.includes(credentials.token), false);
    await stopService(root);
    await assert.rejects(discoverOwner(root), /STOPPED/);
    const release = acquireDataLease(root); release();
    const next = await startService(root);
    assert.notEqual(next.ownerGeneration, first.ownerGeneration);
    await stopService(root);
  } finally {
    await stopService(root).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('panel credential permits only exact snapshot and preference routes and rotates with generation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'island-panel-session-'));
  try {
    const record = await startService(root);
    const panel = JSON.parse(await readFile(path.join(root, 'runtime-private/panel-session.json'), 'utf8'));
    const manager = await connectOwner(root);
    assert.notEqual(panel.token, manager.token);
    assert.equal(panel.ownerGeneration, record.ownerGeneration);
    const request = (route, method = 'GET', extra = {}) => fetch(`${record.endpoint}${route}`, {
      method, headers: { Authorization: `Bearer ${panel.token}`, ...extra },
      ...(method === 'PUT' ? { body: JSON.stringify({ collapsed: [], selected: '', focus: [], scroll: {}, y: {} }) } : {}),
    });
    assert.equal((await request('/api/light-panel')).status, 200);
    assert.equal((await request('/api/light-panel/preferences', 'PUT', { 'Content-Type': 'application/json' })).status, 200);
    for (const route of ['/api/health', '/api/projects', '/api/light-access/grants', '/api/light-mcp', '/api/light-panel?other=1']) {
      assert.equal((await request(route)).status, 403, route);
    }
    assert.equal((await request('/api/light-panel', 'POST')).status, 403);
    assert.equal((await request('/api/light-panel', 'GET', { Origin: 'http://localhost' })).status, 403);
    // A stale or wrong control message cannot terminate the service.
    await writeFile(path.join(root, 'runtime-private/control.json'), JSON.stringify({ action: 'stop', ownerGeneration: 'old', token: manager.token }));
    await pause(400);
    assert.equal((await connectOwner(root)).record.ownerGeneration, record.ownerGeneration);
    await stopService(root);
    const next = await startService(root);
    assert.notEqual(next.ownerGeneration, record.ownerGeneration);
    assert.equal((await fetch(`${next.endpoint}/api/light-panel`, { headers: { Authorization: `Bearer ${panel.token}` } })).status, 403);
    await stopService(root);
  } finally {
    await stopService(root).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});


test('standalone start refuses a live desktop-owned service without changing its sessions or discovery', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'island-desktop-owner-'));
  const child = spawn(process.execPath, [fileURLToPath(new URL('./owner.mjs', import.meta.url))], {
    env: { ...process.env, WORKBENCH_DATA_DIR: root, WORKBENCH_SESSION_TOKEN: randomBytes(32).toString('hex'), WORKBENCH_OWNER_MODE: 'desktop' },
    stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true,
  });
  try {
    let current;
    for (let i = 0; i < 100; i++) {
      try { current = await connectOwner(root); break; } catch {}
      await pause(50);
    }
    assert.equal(current.record.lifetime, 'desktop');
    const originalDiscovery = await readFile(path.join(root, 'owner.json'), 'utf8');
    const originalSession = await readFile(path.join(root, 'runtime-private/owner-session.json'), 'utf8');
    await assert.rejects(startService(root), /DESKTOP_OWNER_ACTIVE/);
    assert.equal(await readFile(path.join(root, 'owner.json'), 'utf8'), originalDiscovery);
    assert.equal(await readFile(path.join(root, 'runtime-private/owner-session.json'), 'utf8'), originalSession);
    assert.equal(child.exitCode, null);
    child.stdin.end('stop\n');
    await new Promise(resolve => child.once('exit', resolve));
    const standalone = await startService(root);
    assert.equal(standalone.lifetime, 'standalone');
    await stopService(root);
  } finally {
    if (child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
    await stopService(root).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
