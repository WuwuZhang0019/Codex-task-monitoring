// 日期：2026-11-13。真实 detached Git 工作树的绑定、执行、提交与冷重开；无 Git 语义仍独立。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fixture } from '../tests/helpers/light-e-fixture.mjs';
import { inspectWorkspace } from '../../plugins/task-workbench/skills/workbench-handoff/scripts/context-ledger.mjs';

test('原生 detached 工作树使用 branch=null 和真实 HEAD 绑定，提交后继续沿用执行身份', async t => {
  const f = await fixture(t), before = await f.read(), step = before.steps[0];
  const git = args => execFileSync('git', ['-C', f.second, ...args], { windowsHide: true, stdio: 'pipe', encoding: 'utf8' }).trim();
  git(['checkout', '--detach']);
  const actual = await inspectWorkspace(f.second);
  assert.equal(actual.branch, null); assert.match(actual.head, /^[a-f0-9]{40}$/);
  const input = { ...await f.base('managed-propose'), action: 'propose', stepIds: [step.id],
    context: { ...f.context(f.old, 'codex/second'), branch: actual.branch, head: actual.head },
    bindingId: null, expectedBindingRevision: null, confirmationGrant: null };
  const proposed = f.accepted(await f.call(f.old, 'workbench_bind_context', input));
  const confirmation = { ...input, ...await f.base('managed-confirm'), action: 'confirm',
    bindingId: proposed.bindingId, expectedBindingRevision: proposed.bindingRevision };
  const binding = f.accepted(await f.confirm(f.old, confirmation));
  const started = f.accepted((await f.start(f.old, step, binding)).result);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'managed worktree result']);
  const continued = f.accepted((await f.update(f.old, step, binding, started.executionId)).result);
  assert.equal(continued.executionId, started.executionId);
  assert.equal((await inspectWorkspace(f.second)).branch, null);
  await f.reopen();
  const restored = await f.read();
  assert.equal(restored.bindings.find(item => item.id === binding.bindingId).context.head, actual.head);
  assert.equal(restored.bindings.find(item => item.id === binding.bindingId).context.branch, null);
  assert.equal(restored.executions[0].id, started.executionId);
});

test('detached 工作树不能用 null HEAD 冒充非 Git 或使用错误提交确认', async t => {
  const f = await fixture(t), snapshot = await f.read();
  execFileSync('git', ['-C', f.second, 'checkout', '--detach'], { windowsHide: true, stdio: 'pipe' });
  for (const [index, head] of [null, 'f'.repeat(40)].entries()) {
    const input = { ...await f.base('invalid-propose-' + index), action: 'propose', stepIds: [snapshot.steps[0].id],
      context: { ...f.context(f.old, 'codex/second'), branch: null, head }, bindingId: null, expectedBindingRevision: null, confirmationGrant: null };
    const proposed = f.accepted(await f.call(f.old, 'workbench_bind_context', input));
    const confirmation = { ...input, ...await f.base('invalid-confirm-' + index), action: 'confirm',
      bindingId: proposed.bindingId, expectedBindingRevision: proposed.bindingRevision };
    const response = await f.ui('confirm-binding', { principal: f.old.principal, input: confirmation, acknowledged: true });
    assert.equal(response.status, 409); assert.match(response.value.error, /Git|核验/);
  }
  assert.equal((await f.read()).bindings.filter(item => item.state === 'confirmed').length, 0);
});
