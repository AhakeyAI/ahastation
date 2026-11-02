# AhaStudio 冲刺分工与架构

2026-10-29 起草，2026-10-30 更新 · Shawn

> 本文由 Claude 文档「AhaStudio 冲刺分工与架构」转为仓库里的 Markdown，以后以本文为准、随代码评审更新。
> 冲刺看板：[Project 2](https://github.com/orgs/AhakeyAI/projects/2)；项目室和开场流程的详细设计：[docs/design/2026-10-30-project-rooms-and-kickoff.md](../design/2026-10-30-project-rooms-and-kickoff.md)。

冲刺 10-29 – 11-04 按产品架构切成 7 个模块，每个模块、每一项都只有一个负责人；Claude、Codex 等 AI 工具由负责人调用，不单独作为负责人。跨模块只通过接口协作，每个接口由一人定义。B 编号只作参照，不再按 B 包分工。

## 10-29 实测：最小可行版

**本冲刺每个人用 AhaStudio 开发。主流程 10-29 在 Mac 上跑通了一遍，产物是 [PR #134](https://github.com/AhakeyAI/ahastation/pull/134)。** 终端 Worker、接管、看板建卡、扫描会话处置还没做好，按下面的绕行用；修复已并入对应事项。

跑通的主流程（细节见 [#68 上手指南](https://github.com/AhakeyAI/ahastation/issues/68) 第四节）：

1. 大厅把「Worker 执行模式」设为「无头 Worker」，自动批准只开到只读。
2. 打开自己的 ahastation 克隆，对 Host 说一个 Issue 的任务和验收命令。
3. 看计划，点「确认并调度」。
4. Worker 在隔离工作树里改；执行命令前请求批准，对外写操作一律拒绝。
5. 交付后 Host 做独立复核，通过后生成集成分支 `ahastation/integration/<会议 ID>`，本地 main 不动。
6. 本人从集成提交拉分支、push、提 PR（`Closes #<编号>`）。

**10-29 修好并合入 main：** [#120](https://github.com/AhakeyAI/ahastation/pull/120) CI 安装包白屏；[#121](https://github.com/AhakeyAI/ahastation/pull/121) 软件名 AhaStudio 和 aha 图标；[#122](https://github.com/AhakeyAI/ahastation/pull/122) 终端 Worker 没有默认模型；[#133](https://github.com/AhakeyAI/ahastation/pull/133) 开会议弄脏 `.gitignore`、挡住工作树隔离；[#134](https://github.com/AhakeyAI/ahastation/pull/134) Mac 本机一键构建安装。

**方案调整（Shawn 10-29 拍板）：**

| 事项 | 调整 | 负责人 |
| --- | --- | --- |
| [T2 #93](https://github.com/AhakeyAI/ahastation/issues/93)、[T3 #103](https://github.com/AhakeyAI/ahastation/issues/103) | 终端栈随第一次整合（#135）合入；两项改为整合后的 Windows 验证和收尾 | Leo |
| [I4 #78](https://github.com/AhakeyAI/ahastation/issues/78) | #53 随 #135 合入；改为整合后验证 linux-arm64、板端，以及 Electron 45 下的终端（Mac 已验证）；10-31 完成 | Shawn |
| [T2f #124](https://github.com/AhakeyAI/ahastation/issues/124) | 新增：#58 的 Windows 命名管道创建时即带安全描述符，合入后跟进 | Leo |
| [T4 #86](https://github.com/AhakeyAI/ahastation/issues/86) | 加：识别信任框——不贴提示词、请用户接管确认，另设「自动信任自建工作树」开关（默认关）；对外写操作每次单独审批；「只读命令 + 联网」权限档 | Leo |
| [U6 #111](https://github.com/AhakeyAI/ahastation/issues/111)、[IF-4 #79](https://github.com/AhakeyAI/ahastation/issues/79) | 加：Host 派的 Worker 以标签页出现在原生终端工作区，接管、交还从这里发起 | Leo |
| [S2 #72](https://github.com/AhakeyAI/ahastation/issues/72)、[S4 #104](https://github.com/AhakeyAI/ahastation/issues/104) | 加：闲置和已结束的会话不算进行中；每个扫描出的会话可纳入、忽略、关闭 | Dryoung95 |
| [U3b #123](https://github.com/AhakeyAI/ahastation/issues/123) | 新增：看板「待执行」——计划批准后不自动开跑；作废计划释放任务 ID；GitHub Issue 只读导入为卡片 | he-1102 |
| [U5 #113](https://github.com/AhakeyAI/ahastation/issues/113) | 加：任务详情面板在深色界面下的对比度 | Leo |

体验问题记在 [#125–#132](https://github.com/AhakeyAI/ahastation/issues?q=label%3Adogfood)，各自挂在上表对应事项下。事项从 53 项变为 55 项。

**10-29 晚：先整合（Shawn 拍板）。** 所有未合入的分支一次整合进 [PR #135](https://github.com/AhakeyAI/ahastation/pull/135)：终端栈 #57 → #58 → #59、安全基线 #53、协作基线 #55、C0 文档 #50 和 #56。整合由新事项 [I5 #136](https://github.com/AhakeyAI/ahastation/issues/136) 负责；I3、I4、T2、T3、C1 从「合入」改为整合后的验证和修复；C3–C5 不再分批合入。整合版在 Mac 上已实测：PTY 能起、主流程走通、不连公网 Hub。新发现的问题记在 [#137](https://github.com/AhakeyAI/ahastation/issues/137)（启动慢）、[#138](https://github.com/AhakeyAI/ahastation/issues/138)（复核工具要人批）、[#139](https://github.com/AhakeyAI/ahastation/issues/139)（观察层扫到自己的 Worker）。

## 10-30 方案变化

**整合版 [#135](https://github.com/AhakeyAI/ahastation/pull/135) 已合入 main**，包含 10-29 的界面修复和 10-30 的下列改动；10-30 当天在 Mac 上逐项实测，全量测试 1278 项通过、0 失败。

| 方面 | 10-30 起的做法 | 涉及事项 |
| --- | --- | --- |
| 启动台 | 扫描弹窗并入启动台的「项目室」：一个本地 git 仓库一个房间，主目录、子目录和所有工作树归入同一间，另一份克隆单独成间；首次启动引导扫描，之后自动扫描并提醒 | S2、S3、S4 |
| 新建项目 | 「新建项目室」对话框（对标 Orca）：打开本机文件夹、从 Git / GitHub 克隆、新建空项目；可选只开 CLI 工作区 | U1、T3 |
| 开场 | 空项目进入会议时弹窗问「讨论脑暴 / 开始开发」；点「开始」即阶段计划确认（AME-D23），请专家入会，专家派一个子 Agent 在共享区第三个标签用原生 CLI 工作 | U6、T4 |
| 专家与子 Agent | 专家按「职能＋名字」展示（AME-D14），只能给自己名下的子 Agent 任务发消息，计划仍由助理统一（D17）；子 Agent 不进参会者列表 | T4、U6 |
| 接管 | 子 Agent 的 CLI 默认只读，「接管」先列出专家派的待办，再打断并交给用户；交还时专家先读改动。改写 AME-D32、D33、Q20，见 [#143](https://github.com/AhakeyAI/ahastation/pull/143) | U6 |
| 工作区与看板 | 工作区默认是助理整理的会议纪要（结论、决策、待办、TODO），确认后写入看板「待执行 / 待派工」，可选同时建 GitHub Issue；看板默认 4 列（待执行、进行中、待确认、已完成），可按子状态拆泳道，每个项目室默认只看本项目 | U3、U3b、U4 |
| 界面 | 去掉会议 / 任务切换和底部菜单栏；顶栏放自动批准、语音、对话、AhaBar 和分区设置下拉；底部状态栏改为各 AI 剩余额度；项目室可单独开窗口 | U1、U2、U5 |
| 修复 | 会议内部工具不再要审批（#138）；终端 Worker 遇到信任文件夹提示时先不贴提示词（#125）；空闲的外部会话不算进行中 | C6、T4、S2 |

U3b 的「只建卡不派工」先做了最小版本（本机保存），he-1102 在 [#123](https://github.com/AhakeyAI/ahastation/issues/123) 上继续完善。

## 架构与归属

| 模块 | 负责人 | 范围 |
| --- | --- | --- |
| M0 准备与验收 | Shawn | 安装包、上手指南、整合与验收、方案文档 |
| M1 导航·会议·看板 | he-1102 | 首页、会议布局、看板、决定卡片 |
| M2 会话界面 | Leo | 会话详情、远端查看、主题 |
| M3 终端与 Worker | Leo | 终端栈、本地 CLI 工作区、Worker CLI 桥、接管 |
| M4 会话发现 | Dryoung95 | 会话扫描、hooks、项目归类、设备会话清单 |
| M5 跨设备协作 | eternal904 | 协作基线、Hub、Station 与协作面板 |
| M6 设计 | Leonardo Li | 交互稿、视觉规格、视觉走查 |

每个框是一个模块，右上角是唯一的负责人，框里列出这个人独立负责的事项，灰字写明他提供和接入的接口。界面跟着模块走：会话详情、远端查看和主题归 Leo，授权弹窗和设备会话清单归 Dryoung95，导航、会议、看板和决定卡片归 he-1102；所有界面由 Leonardo Li 设计、he-1102 做功能验收。

## 接口

跨模块只通过这 9 个接口协作。定义人在定稿日前把格式写进自己的接口 Issue，使用方在同一个 Issue 里确认后才算定稿；定稿后要改，先在该 Issue 里说。

| 接口 | 内容 | 定义人 | 使用方 | 定稿 |
| --- | --- | --- | --- | --- |
| IF-1 | hook 事件与会话状态上报 | Leo | Dryoung95 | 10-30 |
| IF-2 | 会话归属登记（变更说明 §9.3） | Dryoung95 | Leo、eternal904 | 10-30 |
| IF-3 | 项目身份 projectId（ADR 0013） | Dryoung95 | eternal904、he-1102 | 10-31 |
| IF-4 | 打开会话、接管与交还事件 | Leo | he-1102、eternal904 | 10-30 |
| IF-5 | 终端流与快照（§9.1） | Leo | eternal904 | 10-31 |
| IF-6 | 协作面板组件与数据投影 | eternal904 | he-1102 | 10-31 |
| IF-7 | 设备会话清单格式（§9.4） | Dryoung95 | eternal904 | 10-31 |
| IF-8 | Hub 终端消息与订阅（§5.2） | eternal904 | Leo | 11-01 |
| IF-9 | 主题 token 与图标 | Leo | he-1102、Dryoung95 | 10-31 |

设计交付也按接口对待：G1（导航与会议）交 he-1102，G2（会话详情、授权弹窗、设备会话清单）交 Leo 和 Dryoung95，G3（看板与决定卡片）交 he-1102。

## 每人事项

55 项，每项一个负责人；点编号进 Issue，看交付清单、依赖和完成标准。模块总 Issue：[M0 #60](https://github.com/AhakeyAI/ahastation/issues/60)、[M1 #61](https://github.com/AhakeyAI/ahastation/issues/61)、[M2 #62](https://github.com/AhakeyAI/ahastation/issues/62)、[M3 #63](https://github.com/AhakeyAI/ahastation/issues/63)、[M4 #64](https://github.com/AhakeyAI/ahastation/issues/64)、[M5 #65](https://github.com/AhakeyAI/ahastation/issues/65)、[M6 #66](https://github.com/AhakeyAI/ahastation/issues/66)。上手指南在 [#68](https://github.com/AhakeyAI/ahastation/issues/68)，冲刺看板在 [Project 2](https://github.com/orgs/AhakeyAI/projects/2)。

### Shawn（产品负责人 · M0）

| Issue | 事项 | 日期 | 先完成 | 完成标准 |
| --- | --- | --- | --- | --- |
| [#67](https://github.com/AhakeyAI/ahastation/issues/67) Z1 | 内部安装包：用 main 构建 macOS、Windows、Linux 安装包 | 10-29 | — | 三个平台的安装包都能下载、能启动 |
| [#68](https://github.com/AhakeyAI/ahastation/issues/68) Z2 | 上手指南：安装、拉取自己的 Issue、看板、本地多会话并行、体验问题 | 10-29 | Z1 | 每个人都能看到自己的 Issue 和看板，并在本地开出多个会话 |
| [#69](https://github.com/AhakeyAI/ahastation/issues/69) I3 | 合入 PR #50（C0 交接文档） | 10-29 | — | main 三平台 CI 通过 |
| [#70](https://github.com/AhakeyAI/ahastation/issues/70) D1 | 方案改版：ADR 0019 后续、AME 改版、WBS 按模块重排 | 10-29 – 10-30 | — | 评审通过，写进 docs/ame/ |
| [#77](https://github.com/AhakeyAI/ahastation/issues/77) P2 | 演示脚本、验收清单、每日站会 | 10-29 – 11-03 | — | 11-03 前定稿 |
| [#78](https://github.com/AhakeyAI/ahastation/issues/78) I4 | PR #53 rebase 到终端栈合入后的 main，重跑三平台和 linux-arm64，并合入 | 10-30 – 10-31 | I3、T3 | CI 通过并合入 |
| [#87](https://github.com/AhakeyAI/ahastation/issues/87) Q1 | 体验问题分诊：每天把 `dogfood` Issue 分给模块负责人 | 10-30 – 11-03 | Z2 | 站会时没有未分派的体验问题 |
| [#90](https://github.com/AhakeyAI/ahastation/issues/90) R6 | 三家在线语音实测（讯飞、豆包、Azure），在 N5095 上跑 | 10-31 | — | 总花费不超过 100 元；结果入库 |
| [#109](https://github.com/AhakeyAI/ahastation/issues/109) T5 | CLI 路径独立验证 B04，通过后合入 Worker CLI 桥 | 11-01 – 11-02 | T4 | S4–S6 一票否决；不过就不合入，Worker 继续走 SDK |
| [#118](https://github.com/AhakeyAI/ahastation/issues/118) V2 | 合入冻结；整合版全量测试与打包冒烟；彩排 | 11-03 | T5、C5、U2、U4、U5、U6、U7a、U7b、S5、S6、P3f、P3v | 0 失败；两个安装包都能启动 |
| [#119](https://github.com/AhakeyAI/ahastation/issues/119) V3 | 走演示脚本、对结果、回顾 | 11-04 | V2、P2 | 结果和回顾记录入库 |

### he-1102（产品 · M1）

| Issue | 事项 | 日期 | 先完成 | 完成标准 |
| --- | --- | --- | --- | --- |
| [#71](https://github.com/AhakeyAI/ahastation/issues/71) U1 | 信息架构收拢：首页、会议、任务、设置四个入口 | 10-29 – 10-30 | — | Leonardo Li 按 G1 走查，和 B07 原型一致 |
| [#75](https://github.com/AhakeyAI/ahastation/issues/75) U3 | 看板五阶段列 + 细分状态徽标 + 「需关注」过滤（A-05） | 10-29 – 11-01 | — | 失败、中断不进已完成；旧状态映射单测全覆盖 |
| [#101](https://github.com/AhakeyAI/ahastation/issues/101) U2 | 会议布局 D15，接入协作面板，点参会人打开会话 | 10-31 – 11-01 | U1、G1、IF-6、IF-4 | Mac 与 Windows 截图；Leonardo Li 走查 |
| [#107](https://github.com/AhakeyAI/ahastation/issues/107) P3f | 功能验收：U1–U7、S4–S6 | 10-31 – 11-02 | U2、U4、U6、S4、S6 | 所有界面的功能问题都有 Issue 跟踪 |
| [#110](https://github.com/AhakeyAI/ahastation/issues/110) U4 | 决定卡片三类分开的界面（A-07） | 11-01 – 11-02 | U3、G3 | Leonardo Li 走查 |
| [#123](https://github.com/AhakeyAI/ahastation/issues/123) U3b | 看板待执行：计划批准后不自动开跑；GitHub Issue 导入为卡片 | 11-01 – 11-02 | U3、IF-4 | 导入冲刺 Issue 后看板上只有卡片、没有 Worker 在跑；依赖顺序和 GitHub 一致 |

### Leo（终端线 · M2、M3）

| Issue | 事项 | 日期 | 先完成 | 完成标准 |
| --- | --- | --- | --- | --- |
| [#79](https://github.com/AhakeyAI/ahastation/issues/79) IF-4 | 接口 IF-4：打开会话、接管与交还事件 | 10-30 | — | he-1102、eternal904 在本 Issue 确认 |
| [#80](https://github.com/AhakeyAI/ahastation/issues/80) E-L | 影响评估：终端线（变更说明 §6.4） | 10-30 | — | 在 PR #55 回复 |
| [#81](https://github.com/AhakeyAI/ahastation/issues/81) IF-1 | 接口 IF-1：hook 事件与会话状态上报 | 10-30 | — | Dryoung95 在本 Issue 确认可用 |
| [#85](https://github.com/AhakeyAI/ahastation/issues/85) S1 | 全局 hooks：安装、卸载、按会话类型裁决 | 10-30 – 10-31 | IF-1 | 卸载后配置文件和安装前一致；CLI 没有可感知的延迟 |
| [#86](https://github.com/AhakeyAI/ahastation/issues/86) T4 | Worker CLI 桥改造（③） | 10-30 – 11-01 | IF-2 | 确定性测试通过；Shawn 复核 |
| [#91](https://github.com/AhakeyAI/ahastation/issues/91) IF-9 | 接口 IF-9：主题 token 与图标 | 10-31 | — | he-1102、Dryoung95 在本 Issue 确认 |
| [#92](https://github.com/AhakeyAI/ahastation/issues/92) IF-5 | 接口 IF-5：终端流与快照 | 10-31 | — | eternal904 在本 Issue 确认 |
| [#93](https://github.com/AhakeyAI/ahastation/issues/93) T2 | rebase 并合入守护进程（#58）和图标主题（#57） | 10-30 | — | Shawn 复核后合入 |
| [#103](https://github.com/AhakeyAI/ahastation/issues/103) T3 | rebase 并合入本地 CLI 工作区（#59） | 10-30 | T2 | Shawn 复核后合入 |
| [#111](https://github.com/AhakeyAI/ahastation/issues/111) U6 | 会话详情与接管：界面和机制 | 11-01 – 11-02 | T4、G2、IF-4、T3 | 接管期间宿主不再发指令；超出授权的请求弹给用户 |
| [#113](https://github.com/AhakeyAI/ahastation/issues/113) U5 | 主题和图标全局统一，浅色和深色对比度 | 11-02 | T2、IF-9 | Leonardo Li 走查 |
| [#114](https://github.com/AhakeyAI/ahastation/issues/114) U7a | 远端只读查看：终端侧和查看界面 | 11-02 | IF-5、IF-8、T4 | 本机能实时看到 N5095 上的 Worker |
| [#124](https://github.com/AhakeyAI/ahastation/issues/124) T2f | Windows 命名管道创建时即带安全描述符（#58 跟进） | 11-01 – 11-02 | T2 | Windows CI 和 N5095 冒烟通过；Shawn 复核 |

### Dryoung95（扫描线 · M4）

| Issue | 事项 | 日期 | 先完成 | 完成标准 |
| --- | --- | --- | --- | --- |
| [#72](https://github.com/AhakeyAI/ahastation/issues/72) S2 | 会话扫描：读 Claude、Codex 的历史和运行中会话 | 10-29 – 10-30 | IF-1 | 只读；Station 和 Worker 的会话不算用户会话 |
| [#82](https://github.com/AhakeyAI/ahastation/issues/82) E-D | 影响评估：扫描线（变更说明 §8.3） | 10-30 | — | 在 PR #55 回复 |
| [#83](https://github.com/AhakeyAI/ahastation/issues/83) IF-2 | 接口 IF-2：会话归属登记 | 10-30 | — | Leo、eternal904 在本 Issue 确认 |
| [#94](https://github.com/AhakeyAI/ahastation/issues/94) IF-3 | 接口 IF-3：项目身份 projectId | 10-31 | — | eternal904、he-1102 在本 Issue 确认 |
| [#95](https://github.com/AhakeyAI/ahastation/issues/95) IF-7 | 接口 IF-7：设备会话清单格式 | 10-31 | IF-3 | eternal904 在本 Issue 确认 |
| [#100](https://github.com/AhakeyAI/ahastation/issues/100) S3 | 按项目、工作树、分支归类，实现项目稳定身份（A-02） | 10-31 – 11-01 | S2、IF-3 | 同一仓库的不同路径、工作树归为一个项目 |
| [#104](https://github.com/AhakeyAI/ahastation/issues/104) S4 | 新项目通知与授权，含弹窗界面 | 11-01 | S3、G2、P1 | 不授权时不读该项目的会话内容 |
| [#112](https://github.com/AhakeyAI/ahastation/issues/112) S5 | 收编：备份、复制会话、在 Studio 原生终端续接 | 11-01 – 11-02 | S4、S1、T4 | 原会话文件 hash 不变；权限不超过项目授权 |
| [#115](https://github.com/AhakeyAI/ahastation/issues/115) S6 | 设备会话清单：生成、数据投影、展示界面 | 11-02 | S3、IF-7、C4、G2 | 双机下能看到 N5095 的会话清单，不含内容和本机路径 |

### eternal904（协作线 · M5）

| Issue | 事项 | 日期 | 先完成 | 完成标准 |
| --- | --- | --- | --- | --- |
| [#84](https://github.com/AhakeyAI/ahastation/issues/84) E-E | 影响评估：协作线（变更说明 §5.6） | 10-30 | — | 在 PR #55 回复 |
| [#88](https://github.com/AhakeyAI/ahastation/issues/88) C1 | 协作基线 rebase；Codex 区间；safeStorage 改异步 | 10-30 – 10-31 | I4 | 两侧 typecheck 通过，全量测试不新增失败 |
| [#96](https://github.com/AhakeyAI/ahastation/issues/96) C2 | 修 N3、N6，补 services/remote/ 来源与许可说明 | 10-31 | — | Shawn 复核通过 |
| [#97](https://github.com/AhakeyAI/ahastation/issues/97) C6 | 修 C10：计划批准只认主持设备 | 10-31 | C1 | 非主持设备批准被拒、主持设备批准成功 |
| [#98](https://github.com/AhakeyAI/ahastation/issues/98) IF-6 | 接口 IF-6：协作面板组件与数据投影 | 10-31 | — | he-1102 在本 Issue 确认 |
| [#102](https://github.com/AhakeyAI/ahastation/issues/102) IF-8 | 接口 IF-8：Hub 终端消息与订阅 | 10-31 – 11-01 | IF-5 | Leo 在本 Issue 确认 |
| [#105](https://github.com/AhakeyAI/ahastation/issues/105) C3 | 第 1 批：契约与文档 | 11-01 | C1、C2 | Shawn 复核后合入 |
| [#106](https://github.com/AhakeyAI/ahastation/issues/106) C4 | 第 2 批：Hub（含设备会话清单转发） | 11-01 | C3、IF-7 | Shawn 复核后合入 |
| [#116](https://github.com/AhakeyAI/ahastation/issues/116) C5 | 第 3、4 批：Station 与协作面板 | 11-02 | C4、C6、IF-2、IF-4、IF-6 | 入口关闭时没有任何对外连接；C6 已通过 |
| [#117](https://github.com/AhakeyAI/ahastation/issues/117) U7b | 远端只读查看：Hub 与 Station 侧 | 11-02 | C5、IF-8 | 与 U7a 联调，本机能实时看到 N5095 上的 Worker |

### Leonardo Li（设计 · M6）

| Issue | 事项 | 日期 | 先完成 | 完成标准 |
| --- | --- | --- | --- | --- |
| [#73](https://github.com/AhakeyAI/ahastation/issues/73) P1 | 交互稿：会话详情与接管、新项目通知、授权弹窗、复制会话交接 | 10-29 – 10-30 | — | Shawn 确认 |
| [#74](https://github.com/AhakeyAI/ahastation/issues/74) G1 | 视觉规格：导航与会议（U1、U2） | 10-29 – 10-30 | — | he-1102 可以照着开发 |
| [#76](https://github.com/AhakeyAI/ahastation/issues/76) P4 | 主屏和副屏的对话协同与陪伴感（建议高优） | 10-29 – 11-01 | — | 10-30 方向稿、11-01 完整稿，Shawn 确认；回答 AME Q18 |
| [#89](https://github.com/AhakeyAI/ahastation/issues/89) G3 | 视觉规格：看板与决定卡片（U3、U4） | 10-30 – 10-31 | — | he-1102 可以照着开发 |
| [#99](https://github.com/AhakeyAI/ahastation/issues/99) G2 | 视觉规格：会话详情、授权弹窗、设备会话清单（U6、S4、S6） | 10-31 | P1 | Leo、Dryoung95 可以照着开发 |
| [#108](https://github.com/AhakeyAI/ahastation/issues/108) P3v | 视觉走查：U1–U7、S4–S6 | 10-31 – 11-02 | U2、U4、U6、S4、S6 | 所有界面的视觉问题都有 Issue 跟踪 |

## 实施顺序

一项的依赖没全部完成前不开工；Issue 里的 blocked by 关系和看板的「顺序」字段与下表一致。

| 波次 | 日期 | 内容 |
| --- | --- | --- |
| W0 | 10-29 今晚 | Z1 安装包、Z2 上手指南、I3 合入 #50；各人装好 AhaStudio，拉到自己的 Issue，用 AhaStudio 走完第一个 Issue 的主流程 |
| W1 | 10-29 – 10-30 | 三份影响评估；IF-1、IF-2、IF-4 定稿；D1、P1、P4 方向稿、G1；T2、T3 终端栈合入；U1、U3、S2、S1、T4 开工；I4、P2、Q1 |
| W2 | 10-31 | IF-3、IF-5、IF-6、IF-7、IF-9 定稿；G2、G3；C1、C2、C6、S3、R6 |
| W3 | 11-01 | IF-8；C3、C4、S4、U2、U3b；T4 完成 |
| W4 | 11-01 – 11-02 | T5；U4、U5、U6、U7a、U7b、S5、S6、C5、T2f；P3f、P3v |
| W5 | 11-03 – 11-04 | V2 冻结与打包，V3 对结果 |

## 今晚的上手流程

宣布后每个人照 [#68 上手指南](https://github.com/AhakeyAI/ahastation/issues/68) 走一遍：

1. 装 AhaStudio：Mac 用 `bash scripts/install-local-mac.sh`，Windows / Linux 下载手动触发的 main 构建产物。
2. 拉自己的 Issue：命令行或 [Project 2](https://github.com/orgs/AhakeyAI/projects/2) 筛 `assignee:@me`，按「顺序」排。
3. 大厅把 Worker 执行模式设为「无头 Worker」，自动批准只开只读。
4. 用 AhaStudio 把第一个没被卡住的 Issue 走完主流程，提出 PR。
5. 遇到问题先看 #125–#132，没有就开 `dogfood` Issue。

10-29 已在 Mac 上实测走通第 3–4 步（PR #134）。不要让 Host「在看板上建任务」：现在建任务就等于立刻派 Worker（#128）。
