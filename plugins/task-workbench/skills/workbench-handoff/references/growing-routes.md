# 在标题后逐步扩展路线
日期：2026-11-16
状态：可执行规则；需要支持 historicalSteps 的工作台服务与展开子步骤的任务岛版本

## 展示与身份

每条开发线的标题是固定左侧起点。仅明确标题时先登记标题，不估计将来要做多少步；明确一项实际工作后添加子步骤并向右延伸。原方案已有明确步骤时保留它们；未知步骤不预造。首次登记时在 registration-request.mjs 的 options 中设置 growing: true（或向 registrationSnapshot 传同名选项），默认给每个标题生成独立路线；已有明确 routes 时优先保留它们，不能把并行标题串成虚假的先后。界面按原路线及子步骤 order 展开；显式属于其他路线的子步骤保留原归属。图上相邻表示展示顺序，不自动增加 dependsOn；跨线依赖来自方案或实际已确认的前置。

每项工作使用一个稳定 taskKey，建议为原文位置或台账中固定事项键。不得使用每次尝试的随机数、聊天轮数、当天日期或重试次数作为身份。调试、局部修复、失败重跑更新同一 stepId、原 binding 和有效 executionId，不新增路线节点。拆分任务必须有真实语义及授权依据。

## 开始新一步

1. 回读项目服务快照，找到 planId 与标题 headingKey。先查当前事项的既有映射；原来已登记的步骤传 existingStepKey，不能因为键格式较旧就另造节点。
2. 在真实执行目录生成 UTF-8 options：planId、headingKey、taskKey（或 existingStepKey）、新项 title/acceptance/sourceLocator、明确依赖的 dependsOn、稳定 eventId、reason、occurredAt。dependsOn 使用服务步骤 key，来源没有明确前置时留空，不用前一个显示节点自动代填；标题本身不是要求已完成的前置。
3. 运行 `node <Skill目录>/scripts/growing-route.mjs <service-snapshot.json> <options.json> <revise.json>`。新项生成 pending 修订；已有事项且没有 history 时返回 reused 和 stepId，不生成结构修订。文件已存在先读取原请求并核对结果，禁止覆盖未知请求。
4. 对生成请求运行 `runtime/validate.mjs workbench_revise_plan <revise.json>`，valid 后调用实际 MCP。成功后回读新 stepId、路线及 revision，再进行责任绑定、父标题实际开始和前置检查，取得 running 回执后才实施。标题绑定通常覆盖后加子步骤，复用有效绑定；若标题已结束，按原 reopen/复核门禁处理，不为了加节点直接取消历史完成。
5. 完成、阻塞、取消、恢复和重试沿用现有 update 流程及证据规则。未开始只表示已登记，不能声称已实施；未来事项尚不明确时不要补占位节点。

## 补充已经做过的工作

先保证标题路线已登记并显示，再读取现有回执和原件，逐项确认事项边界、实际结果及适用证据。找到既有步骤时用 existingStepKey 补证；确实未登记才使用稳定 taskKey 添加。

在 options 中附 history：

- status: completed：仅限已核验的必要验收和交付证据全部 passed。evidence 每项须有 evidenceId、location、method、deliveryVersion、result，checks 必须匹配原有条件。脚本可按单一条件生成 checks，但执行者必须实际核验证据后才选择 completed。
- status: pending：历史内容或证据尚不能确认时使用，保留证据位置及实际 pending/failed 结果，服务保留 pending 状态及 recheck 验收，界面显示“待核验”。不能因为回执写“已完成”就自动通过。
- occurredAt：已知的实际历史时间；未知为 null。服务使用本次补录时间记录事件并保留原 null，不制造 startedAt/endedAt 或 executionId。

history 通过 revise 的可选 historicalSteps 原子写入；先离线校验，成功后回读。现有工具 schema 不支持此字段时明确报告版本缺项，保留精确候选，不能省略字段、直接写数据文件或模拟重新执行。

历史补录只用于无执行记录、无阻塞的待核验叶步骤；有真实执行或仍在运行的步骤继续原更新/接手流程。已完成历史的必要前置也须已验收，按真实依赖顺序补录；依赖未知时保留待核验，不能清掉前置换取通过。跨应用的责任绑定不能由补录覆盖。

## 恢复与冲突

修订和补录共用原 eventId 查询 operation=revise。结果未知先查原请求，不能换键重复追加。并行版本冲突后回读新快照并查固定 taskKey/stepKey，保留已登记节点、状态、证据和执行身份，再生成新修订。已成功步骤不得删除重建或重新编号。
