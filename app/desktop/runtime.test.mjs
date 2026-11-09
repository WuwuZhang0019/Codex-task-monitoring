import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { createServer } from '../server/index.mjs';
import { createStore } from '../server/store.mjs';
import { createModelStore } from '../server/model-store.mjs';
import { acquireDataLease } from '../server/data-lease.mjs';
import { migrate, recoverMigration } from './migrate.mjs';
import { discoverOwner } from './client.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function start(root) {
  const token = randomBytes(32).toString('hex');
  const child = spawn(process.execPath, [new URL('./owner.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')], {
    env: { ...process.env, WORKBENCH_DATA_DIR: root, WORKBENCH_SESSION_TOKEN: token }, stdio: ['pipe','pipe','pipe'], windowsHide: true,
  });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  child.stdout.resume();
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw Error(errors);
    try { const record = await discoverOwner(root); return {child, token, record}; } catch {}
    await pause(50);
  }
  child.kill(); throw Error(`Owner startup timed out ${errors}`);
}
async function stop(child) {
  // Rust Child::wait closes stdin, so command and EOF can arrive together.
  child.stdin.end('stop\n');
  await new Promise(resolve => child.once('exit', resolve));
}

test('private owner, duplicate writer rejection, drain, stop marker and explicit restart', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workbench-runtime-'));
  let runtime;
  try {
    runtime = await start(root);
    const { endpoint } = runtime.record;
    assert.equal((await fetch(`${endpoint}/api/health`)).status, 403);
    const headers = {Authorization:`Bearer ${runtime.token}`};
    assert.equal((await fetch(`${endpoint}/api/health`,{headers})).status,200);
    assert.equal((await fetch(`${endpoint}/api/health`,{headers:{...headers,Origin:'http://localhost'}})).status,403);
    await assert.rejects(createServer({dataDir:root,env:{}}), /DATA_ROOT_BUSY/);
    const projects=await (await fetch(`${endpoint}/api/projects`,{headers})).json();
    assert.deepEqual(projects.projects,[]);
    await stop(runtime.child);
    await assert.rejects(discoverOwner(root),/STOPPED/);
    runtime=await start(root);
    assert.notEqual(runtime.record.ownerGeneration, JSON.parse(await readFile(path.join(root,'stopped.json'),'utf8').catch(()=>'{"ownerGeneration":"old"}')).ownerGeneration);
    await stop(runtime.child);
    const release=acquireDataLease(root);release();
  } finally { if(runtime?.child.exitCode===null)runtime.child.kill();await rm(root,{recursive:true,force:true}); }
});

test('OS owner lease released after forced crash', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'workbench-crash-'));
  const runtime=await start(root);
  runtime.child.kill(); await new Promise(resolve=>runtime.child.once('exit',resolve));
  const release=acquireDataLease(root);release();
  await rm(root,{recursive:true,force:true});
});

test('explicit exit waits for an already accepted write before releasing the lease', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workbench-drain-'));
  const runtime = await start(root);
  try {
    let request;
    const response = new Promise((resolve, reject) => {
      request = http.request(`${runtime.record.endpoint}/api/projects`, {
        method: 'POST', headers: { Authorization: `Bearer ${runtime.token}`, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' },
      }, res => { res.resume(); res.once('end', () => resolve(res.statusCode)); });
      request.on('error', reject);
      request.write('{"name":"');
    });
    await pause(100);
    const exited = new Promise(resolve => runtime.child.once('exit', resolve));
    runtime.child.stdin.write('stop\n');
    await pause(100);
    assert.equal(runtime.child.exitCode, null);
    request.end('退出前已接收的写入"}');
    assert.equal(await response, 201);
    await exited;
    const database = JSON.parse(await readFile(path.join(root, 'projects.json'), 'utf8'));
    assert.equal(database.projects[0].name, '退出前已接收的写入');
  } finally {
    if (runtime.child.exitCode === null) runtime.child.kill();
    await rm(root, {recursive:true,force:true});
  }
});

test('legacy directory migration preserves all business files, backup and source', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'workbench-migration-'));
  const source=path.join(root,'source'),target=path.join(root,'target');
  try {
    const projects = await createStore(source);
    const project = await projects.create({name:'旧工作区样例',goal:'保留初始目标与历史'});
    const models = await createModelStore(path.join(source,'models'),projects);
    const draft = await models.get(project.id);
    draft.model.plans=[{id:'original-plan',version:'1.0',source:'原始方案',previousId:null}];
    draft.model.initialPlanId='original-plan';draft.model.currentPlanId='original-plan';
    const saved=await models.update(project.id,draft);
    await mkdir(path.join(source,'transactions'),{recursive:true});
    await writeFile(path.join(source,'transactions','historical.json'),'{"sourceTrust":"unknown","reviews":["legacyManual"]}');
    const original=await readFile(path.join(source,'projects.json'));
    const result=await migrate(source,target);
    assert.equal(result.sourceUnchanged,true);
    assert.deepEqual(await readFile(path.join(target,'projects.json')),original);
    assert.deepEqual(await readFile(path.join(result.backup,'projects.json')),original);
    const migratedModels=await createModelStore(path.join(target,'models'),await createStore(target));
    assert.deepEqual(await migratedModels.get(project.id),saved);
    assert.equal(await readFile(path.join(target,'models',`${project.id}.json.legacy.json`),'utf8'),await readFile(path.join(source,'models',`${project.id}.json.legacy.json`),'utf8'));
    assert.equal(await readFile(path.join(target,'transactions/historical.json'),'utf8'),'{"sourceTrust":"unknown","reviews":["legacyManual"]}');
    await assert.rejects(migrate(source,target),/目标目录已有数据/);
  } finally {await rm(root,{recursive:true,force:true});}
});

test('interrupted migration denies startup and supports rollback/retry', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'workbench-recovery-'));
  const source=path.join(root,'source'),target=path.join(root,'target');
  try {
    await createStore(source);
    await assert.rejects(migrate(source,target,{failAfterCopy:true}),/Injected/);
    await assert.rejects(createServer({dataDir:target,env:{}}),/MIGRATION_PENDING/);
    await recoverMigration(target);
    assert.equal((await migrate(source,target)).sourceUnchanged,true);
  } finally {await rm(root,{recursive:true,force:true});}
});
