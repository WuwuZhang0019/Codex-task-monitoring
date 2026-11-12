# 轻量路线工作台本地插件

日期：2026-11-12

状态：0.1.10 多项目授权协调改造；源码、安装及原生验收分别记录

本版新增授权协调模式、分线映射、两段原生工具调用、可恢复派发日志及服务检查点。协调者复用既有绑定、executionId 和开始门禁，按真实依赖选择本批开发线。仅生成模式不创建或派发。当前宿主直接创建不支持任意已有工作树路径，不能把提示词换目录当作原生归属成功；具体流程见 [协调参考](skills/workbench-handoff/references/coordination.md)。

## 运行与授权

插件身份沿用 `task-workbench@task-workbench-u01-local`，MCP 连接键保留 `task-workbench-u01`。0.1.5 的实际入口为 `runtime/light.mjs`，连接已经启动的领域所有者。桥通过所有者返回的工具清单提供路线读取、登记或修订、执行身份预留、步骤状态、补充事项、会话绑定、事件查询及方案验收能力。

领域所有者持有数据根租约。桥读取受控本机配置，所有者由桌面入口启动。配置文件由 `WORKBENCH_LIGHT_CONFIG` 指定，缺省为用户目录 `.codex/task-workbench-light/config.json`。常规配置包含 `dataDir` 和 `token`，`dataDir` 为所有者数据根的绝对路径。桥在每次请求前读取 `owner.json`，跟随端口及 generation 变化，并遵守 `stopped.json`。固定端点试跑也可采用互斥的 `endpoint` 和 `token` 配置，端点仅允许 `http://127.0.0.1:<port>` 根地址。令牌为独立于桌面会话的至少 64 个十六进制字符。凭据由所有者授权入口生成并受控保存，插件包只携带运行代码与 Skill。

认证和项目范围由所有者逐次校验。发布需要可信入口签发的内容确认，绑定确认需要目录、分支及限范围凭据核验。具体开放能力以服务回执中的 `supportedCapabilities` 为准。写请求超时或连接中断返回 `UNKNOWN_RESULT`，调用者保持原 `eventId` 查询提交结果，桥不自动重发写入。

0.1.5 在每次工具发现和请求前重新校验受控连接配置，使原生授权轮换后仍使用当前凭据；配置失效时失败关闭，不沿用旧令牌。新会话责任仍须重新受控绑定，配置轮换本身不表示接手成功。

## 打包

先安装 app 的锁定依赖，再在仓库中运行以下命令。脚本沿用历史文件名，构建对象已经切换为轻量桥。

```powershell
node 'G:\rust\Codex-task-monitoring\app\mcp\package-probe.mjs' 'G:\rust\Codex-task-monitoring\app\test-results\manual-trial\E-EX01\release' --require-clean
```

输出包括自包含运行脚本、第三方许可、插件清单、现有 Skill 及其参考文件、构建元数据和原 marketplace 身份。打包产物保存在独立发布目录，安装结果和独立 Skill 更新分别记录。

提交相关源码后使用 `--require-clean` 发布。`release-manifest.json` 记录源码提交、版本、脏文件状态与发布文件 SHA256；入口、全部 references 及 scripts 均纳入。无此参数的开发包仍记录真实脏状态，不能当成明确源码发布证据。同版本内容变化须提升版本，使用宿主安装流程更新，禁止手改插件缓存。独立安装的同名 Skill 与插件来源分别核对，实际本次加载路径由新聊天报告。

## 安装与核验

所有者、独立令牌及本机配置就绪后，沿用已验证的本地发布流程。

```powershell
codex plugin marketplace add 'G:\rust\Codex-task-monitoring\app\test-results\manual-trial\E-EX01\release' --json
codex plugin add 'task-workbench@task-workbench-u01-local' --json
```

安装后分别核对版本缓存、清单、运行脚本和 Skill 文件指纹，保存真实工具发现、无害读取及业务写入回读证据。当前 CLI 帮助没有插件热重载命令，现有聊天刷新能力需实际验证，新聊天的发现结果单独记录。文件一致、Skill 可见及实际流程通过分别验收，Skill 安装和新会话流程按 E 阶段推进。

历史 U01 只读探测源码与证据继续保存在 `app/mcp/probe*.mjs` 及历史目录，0.1.3 已安装缓存按原安装结果保留。真实面板接线与原生观感验收按 F 阶段执行。
