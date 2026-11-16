// 日期：2026-11-16。从语义已确认的候选生成完整首次登记请求；不读取凭据或绕过 MCP。
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {registrationSnapshot, sha256} from './normalize-plan.mjs';

export function registrationRequest(result, options) {
  const {sourcePath, projectPath, projectKey, planKey, occurredAt, ...rest} = options;
  if (!path.isAbsolute(sourcePath ?? '') || !path.isAbsolute(projectPath ?? '')) throw Error('ABSOLUTE_SOURCE_AND_PROJECT_PATH_REQUIRED');
  // 同一来源项目的分支工作树必须传相同 projectPath；已有台账键始终优先。
  const canonical = value => {
    const normalized = path.normalize(value).replaceAll('\\', '/');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  const project = projectKey || 'project/' + sha256(canonical(projectPath)).slice(0, 24);
  const plan = planKey || project + '/plan/' + sha256(canonical(path.relative(projectPath, sourcePath))).slice(0, 24);
  const snapshot = registrationSnapshot(result, {...rest, sourcePath, projectKey: project, planKey: plan});
  const {trust, ...source} = snapshot.plans[0].source;
  // 发生时间来自候选或保存请求，重跑同一候选不会改变幂等请求。
  return {schemaVersion:'light-1.0', expectedRevision:0,
    eventId:'register/' + sha256(JSON.stringify(snapshot)),
    occurredAt:occurredAt ?? snapshot.generatedAt, source, snapshot, confirmationGrant:null};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [candidateFile, optionsFile, output] = process.argv.slice(2);
  if (!candidateFile || !optionsFile || !output) throw Error('Usage: node registration-request.mjs <candidate.json> <options.json> <request.json>');
  const request = registrationRequest(JSON.parse(await readFile(candidateFile, 'utf8')), JSON.parse(await readFile(optionsFile, 'utf8')));
  // 不覆盖已有精确请求，未知结果时应查询它而不是重新生成。
  await writeFile(output, JSON.stringify(request, null, 2) + '\n', {encoding:'utf8', flag:'wx'});
  console.log(JSON.stringify({projectKey:request.snapshot.projects[0].key, planKey:request.snapshot.plans[0].key, eventId:request.eventId, output}));
}
