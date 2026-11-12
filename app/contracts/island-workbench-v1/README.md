# 灵动岛工作台客户端契约 v1

日期：2026-11-11

状态：C 模拟契约与验证已实现；真实传输及服务映射由 D 实施

契约所有者为 Codex-task-monitoring。`protocol.ts` 和 `fixtures.ts` 为无服务依赖、无网络访问、无数据库访问的独立 TypeScript 源码；外壳可复制到自己的 `src/workbench/contract/`，保留本说明和来源版本。`PROTOCOL_VERSION` 为 `island-workbench/1`，承载的轻量快照语义版本为 `light-1.0`。兼容新增字段可保留；改变必需字段、语义或身份边界需升级协议并显式协商，不能以类型断言假装兼容。

`WorkbenchClient` 提供 `mode`、`read()` 和 `queryEvent(eventId)`。C 仅实现 `MockWorkbenchClient`，默认且始终为 simulation，不发送请求，不写业务状态，不自动切换模式。UI 使用 `scenarios`、`ScenarioId` 和 `selectScenario()` 选择明确标识的样例。样例包括三个项目、二十阶段六路线、六十阶段长路线、四层关联方案、细分步骤、五状态、绑定、执行和补充事项，以及空数据、离线、拒绝授权、过期、不兼容和操作结果未知。

`WorkbenchEnvelope` 将连接状态、健康、最后成功同步时间和未知操作分别保存。未知操作可与健康且 ready 的连接同时存在；它不意味着操作失败，也不能据此重发新事件。模拟 `queryEvent` 对固定键返回同一 committed 结果，后续 read 清除 pending；未知键为 notFound。此为协议演示，不构成正式服务提交证据。

`validateEnvelope` 对展示所消费的类型、身份、引用与树形关系进行防御验证，不决定依赖是否合法、不重新计算完成资格、不产生业务门禁。`acceptEnvelope` 拒绝隐式模式切换，忽略低 revision 的旧读结果。离线、拒绝和不兼容响应不含新快照，客户端保留最后成功快照和成功时间；UI 必须按连接状态将其明确显示为过期。首次读取失败仍无快照，不能以空数据、全部完成或模拟回退替代失败。无效协议抛错后调用方应保留上次快照并呈现不兼容/错误，不将未验证对象送入 React。

## 与已有面板接口的关系

当前 `app/server/light-panel.mjs` 返回 `{snapshot,sources,preferences,capabilities}`，`app/src/light-live.ts` 描述既有 UI 类型。本契约保留快照固定 key/id、五状态、dependsOn、parentKey、bindingKey、executionKey、route 上下文、sourceStepKey、returnStepKey、补充事项和 revision 的语义；它是客户端边界，并非宣称既有 HTTP 响应已经直接符合本 envelope。正式服务可含额外字段，未由本协议消费的字段由 D 的映射保留或解释。

D 必须在受控原生连接边界适配：

- 明确协议握手及授权，把已有 GET `/api/light-panel` 成功结果包装为 envelope，失败转成明确连接状态；本机端口不代表授权。
- 核实完整持久快照形状：既有 `light-live.ts` 的 execution 简化类型含 `stepKey`，服务契约实际 execution 使用 `stepKeys`。本协议采用后者，不能直接照搬前端简化类型。
- 将现有 threadJump 与宿主能力映射为 capabilities；不支持的 worktreeOpen 和 businessWrite 继续 false。复制路径与固定标识只作为降级信息，不能声称已打开或执行 shell。
- 服务模式必须具有真实 id 和非负整数 revision；模拟 key/id、声明上下文及查询结果不得登记为正式服务身份或回执。
- 面板阅读偏好沿用 `Preferences` 和现有 `/api/light-panel/preferences`，与外壳主题及窗口偏好隔离；本阶段不提供真实偏好传输。
- 正式 queryEvent 实现仍使用真实 eventId、授权、绑定及幂等语义，冲突重读；不得把 Mock 的固定 committed 结果用于生产。

## 验证

在业务仓库根目录执行：

```powershell
node --test app/contracts/island-workbench-v1/protocol.test.mjs
app/node_modules/.bin/tsc.cmd --noEmit --moduleResolution Bundler --module ESNext --target ES2022 --skipLibCheck --strict app/contracts/island-workbench-v1/protocol.ts app/contracts/island-workbench-v1/fixtures.ts
```

测试使用项目已锁定的 esbuild 仅将独立 TS 打包到内存，不启动业务服务。覆盖样例与能力边界、错误字段和引用、保留最后快照、拒绝乱序 revision、未知结果同键查询、空数据、返回对象隔离以及服务身份与模式边界。Fork 的复制文件应与协议所有者进行 SHA256 对照，记录源提交；格式调整可单独记录规范化后指纹，不隐瞒实际字节差异。

## 多应用展示元数据

更新日期：2026-11-12

Envelope 可包含 agentApps（每个固定应用的开启、连接和最后通信状态）及 bindingApps（绑定 key 到应用标识的映射）。字段由受控面板适配器提供，不写入 light-1.0 业务快照。未提供时保持旧版兼容；不得根据任务标题或路径猜测历史归属。
