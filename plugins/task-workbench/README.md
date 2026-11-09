# U01 本地插件探测包

日期：2026-11-09

状态：开发期最小只读切片，真实聊天调用和发行矩阵待核验

源码包含 portable 清单和现有单一 Skill。先在仓库安装 app 的锁定依赖，再构建自包含协议脚本。打包结果包含第三方许可，凭据单独保存在本机私有目录。

```powershell
node 'G:\rust\Codex-task-monitoring\app\mcp\package-probe.mjs' 'G:\rust\Codex-task-monitoring\app\test-results\manual-trial\U01-EX01\local-package'
codex plugin marketplace add 'G:\rust\Codex-task-monitoring\app\test-results\manual-trial\U01-EX01\local-package' --json
codex plugin add 'task-workbench@task-workbench-u01-local' --json
```

runtime/probe.mjs 在打包阶段生成，安装对象为生成后的目录。最小包仍使用本机 Node，正式运行组件由 U02/U07 交付。当前工具仅为 workbench_get_project，参数仅接受隔离项目 projectId。九工具完整 schema 在 app/mcp/contracts/v1.json，正式写入能力交接 U03/U04。

桥读取 WORKBENCH_PROBE_CONFIG 指定的私有配置文件，缺省位置为用户目录下 `.codex/task-workbench-u01/probe-config.json`。文件包含隔离 owner 端点、授权项目和凭据，由本地运行步骤生成，单独受控保存。缺配置或服务不可达会明确报错。

隔离服务的首次运行和重开入口如下。已有服务运行时继续复用。重开会产生新端点及凭据，随后更新本机私有配置并刷新桥。

```powershell
node 'G:\rust\Codex-task-monitoring\app\mcp\run-probe.mjs' 'G:\rust\Codex-task-monitoring\app\test-results\manual-trial\U01-EX01\host-probe'
```

诊断时分别记录安装、工具发现、Skill 可见和真实调用。hooks 的当前实收数为零，宿主编排位置及事件支持逐项待验。正式核验继续通过授权入口处理。
