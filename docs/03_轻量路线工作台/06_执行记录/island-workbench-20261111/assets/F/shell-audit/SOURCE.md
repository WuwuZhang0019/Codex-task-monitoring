# 任务岛来源与修改声明

日期：2026-11-12

状态：本地交付来源记录；实际发行提交与产物SHA256以交付清单为准

本项目Fork为 https://github.com/WuwuZhang0019/windows-dynamic-island ，基于 https://github.com/HeyyCzer/windows-dynamic-island 的固定提交 `e286d9045746837bf1960e0d13b7ed572b8d9e50`。原项目README明确“Copyright © HeyyCzer”，采用GPL v3或以后版本，并致谢Vorssaint。本项目保留原作者及原贡献者的版权、GPL正文和上游致谢；Vorssaint是上游所列致谢对象，本记录不对其另作版权归属推断。原始README和历史功能截图作为上游历史资料保留，不代表当前任务岛功能。

Fork开始基线为上述上游提交，F审计开始版本为 `c02fb6ae882946770327297949049b794d09f947`。E安装版验收固定 `77574bfe7f0b561b092165ed824da0d56cc3e66f`；后续侧栏分类、托盘图标及命名提交不在E原安装二进制内。F补充来源、依赖许可和自有产品图标后，应记录最终提交与二进制对应，不能将旧验收哈希用于新包。

## 保留的上游实现

保留窗口、动画、设置、透明区域及毛玻璃实现；对应原路径包括 `src/components/island/Surface.tsx`、`geometry.ts`、`Rim.tsx`、`Bubbles.tsx`，`src/core/useIslandController.ts`、`useIslandHover.ts`、`useIslandDrag.ts`、`useHitRects.ts`、`useGlass.ts`，`src/styles.css`，`src-tauri/src/window.rs`、`glass.rs`、`settings.rs`。它们均源于上述固定上游；裁剪或适配处属于本Fork修改，不能改标为个人独占版权。完整逐文件差异可用 `git diff e286d9045746837bf1960e0d13b7ed572b8d9e50 <发行提交> -- src src-tauri` 复核。

## 本Fork修改

修改日期：2026-11-11—2026-11-12。

- 删除模块、插件及全局热键产品入口和对应采集/执行后台；保留Tab、Enter、Esc等基本键盘访问。
- 增加固定工作台路线和详情视图、显式模拟数据、真实本机服务适配、连接授权和聊天绑定本人确认；独立服务继续拥有业务数据和业务状态机，外壳不直接读数据库。
- 采用独立identifier `com.wuwuzhang0019.islandworkbench` 和独立配置目录，禁用上游更新端点；自有源和签名尚未配置时显示更新暂不可用。
- 修改显示名为“任务岛”，新增胶囊及任务节点托盘图标；F交付将同一自绘几何语言应用于安装图标和关于页AppLogo，保留上游图标历史而不作为本产品身份。自绘SVG在源码中有修改日期，不取自第三方图标素材。
- 增加原生玻璃诊断及验收证据；诊断关闭后的正常安装版和可用性以对应验收/发布清单为准。

新增适配器原路径为 `src/workbench/*`、`src-tauri/src/workbench.rs`、`workbench_connection.rs`。其中契约副本来自业务仓库 `Codex-task-monitoring` 的 `app/contracts/island-workbench-v1`，`src/workbench/contract/source.json` 固定来源提交 `f3229d49c5b76fc47878d13fb145dd35cd2a785f`；初始契约工作对应业务提交 `4b80fb1ae275786e8b0b364955ae2305ed1a3778`，具体全哈希与每个文件指纹以来源清单及Git历史核对。协议为 `island-workbench/1`，快照为 `light-1.0`。契约来源与上游外壳来源分别记录，不借解耦承诺闭源例外。

本项目修改由WuwuZhang0019维护，使用Codex辅助开发。新增原创改动按GPL-3.0-or-later交付；第三方依赖保留各自许可证，详见 `THIRD-PARTY-NOTICES.txt`。根 `LICENSE` 保留完整GPLv3正文。

## 资源与构建依赖边界

前端用Lucide ISC许可图标，相关许可原文已纳入第三方声明。CSS使用系统字体栈（Inter若本机存在、Segoe UI/Segoe Fluent Icons等），源码与产物不捆绑字体文件。历史截图、原图标、网站资料保留上游出处，不把历史截图中的第三方品牌改称本项目原创资产；它们不嵌入任务岛运行界面。随包声明覆盖锁定Windows Cargo解析依赖及前端运行依赖；其他平台可选构建工具和未随产品分发的开发工具本体不在Windows安装包内。

对应源码交付必须携带锁文件、构建配置及必要脚本；禁止携带用户令牌、签名私钥、个人配置、私有项目数据和数据库。本记录不表示已经公开发布。
