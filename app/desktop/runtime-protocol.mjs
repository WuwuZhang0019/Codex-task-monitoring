// 日期：2026-11-18。兼容版本共用业务数据格式、执行会话和后台交接协议。
export const liveUpdateProtocol = 1;

// Keep the original host connection when the upgrade command runs in another shell.
const codexEnvironmentKeys = ['CODEX_HOME', 'CODEX_APP_TOOLS_PIPE_PATH', 'CODEX_APP_TOOLS_CALLER_HOST_ID',
  'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'WORKBENCH_CODEX_APP_TOOLS_SERVER', 'WORKBENCH_CODEX_BIN'];
export function captureCodexEnvironment(environment) {
  return Object.fromEntries(codexEnvironmentKeys.filter(key => typeof environment[key] === 'string')
    .map(key => [key, environment[key]]));
}
export function restoreCodexEnvironment(environment, saved) {
  for (const key of codexEnvironmentKeys) delete environment[key];
  Object.assign(environment, captureCodexEnvironment(saved));
}
