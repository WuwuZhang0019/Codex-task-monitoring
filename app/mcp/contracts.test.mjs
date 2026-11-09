import test from 'node:test';
import assert from 'node:assert/strict';
import { contract, validatorFor } from './contracts.mjs';

// Generate structural examples for every branch without assigning business authority.
function example(schema) {
  if (schema.$ref) return example(contract.$defs[schema.$ref.split('/').at(-1)]);
  if (Object.hasOwn(schema, 'const')) return schema.const;
  if (schema.enum) return schema.enum[0];
  if (schema.oneOf) return example(schema.oneOf[0]);
  if (schema.anyOf) return example(schema.anyOf[0]);
  if (schema.type === 'null') return null;
  if (schema.type === 'boolean') return false;
  if (schema.type === 'integer') return schema.minimum ?? 0;
  if (schema.type === 'array') return [];
  if (schema.type === 'object') {
    return Object.fromEntries((schema.required ?? []).map(key => [key, example(schema.properties[key])]));
  }
  if (schema.pattern?.includes('{64}')) return 'a'.repeat(64);
  if (schema.pattern?.includes('\\d{4}')) return '2026-11-09';
  if (schema.pattern?.includes('{40,64}')) return 'a'.repeat(40);
  return 'U01-example';
}

test('九工具合法结构样例与失败响应可校验，修复/阻塞动作互斥', () => {
  const tools = Object.keys(contract.$defs).filter(name => name.endsWith('_input')).map(name => name.slice(0, -6));
  for (const tool of tools) {
    const inputSchema = contract.$defs[`${tool}_input`];
    const input = example(inputSchema);
    if (tool === 'workbench_record_repair') input.case = example(inputSchema.properties.case);
    if (tool === 'workbench_record_blocker') {
      input.reason = '等待 U01 实测';
      input.waitingFor = ['真实宿主调用'];
      input.releaseConditions = ['取得指定聊天工具回执'];
    }
    const validateInput = validatorFor(tool, 'input');
    assert.equal(validateInput(input), true, JSON.stringify(validateInput.errors));
    assert.equal(validateInput({ ...input, sourceTrust: 'hostObserved' }), false);
    if (input.workContext) {
      const forged = structuredClone(input);
      forged.workContext.verification = 'verified';
      assert.equal(validateInput(forged), false, 'Clients cannot claim verified Git context');
    }
    const outputSchema = contract.$defs[`${tool}_output`];
    const validateOutput = validatorFor(tool, 'output');
    assert.equal(validateOutput(example(outputSchema)), true, JSON.stringify(validateOutput.errors));
    assert.equal(validateOutput(example(outputSchema.oneOf[1])), true, JSON.stringify(validateOutput.errors));
  }
  const repair = example(contract.$defs.workbench_record_repair_input);
  const validateRepair = validatorFor('workbench_record_repair', 'input');
  assert.equal(validateRepair(repair), false, 'createCase requires case');
  repair.case = example(contract.$defs.workbench_record_repair_input.properties.case);
  repair.attempt = example(contract.$defs.workbench_record_repair_input.properties.attempt);
  assert.equal(validateRepair(repair), false, 'createCase cannot append an attempt in the same command');
  assert.equal(validatorFor('workbench_get_project', 'input')({ projectId: 'P', query: { requestId: 'R', idempotencyKey: 'K' } }), false);
});
