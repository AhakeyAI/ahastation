# AhaStudio 与 Orca、Paseo、Multica：定位和首发策略

日期：2026-10-03。用户所说“mutica”已确认为 [Multica](https://github.com/multica-ai/multica)。本文以 [Orca v1.4.218 源码研究](./orca-ade-v1.4.218-comparison.md)、[Paseo/Multica 源码研究](./paseo-multica-comparison-2026-10.md) 与 [AhaStudio 已确认产品语言](../../CONTEXT.md) 为依据。竞品的“已有”是官方文档与源码可见，不等于独立完成端到端质量验证；AhaStudio 的“应做”是产品策略，不等于已经交付。

## 1. 竞争地图

| 产品 | 用户先打开什么 | 稳定的工作对象 | 已经解决的核心问题 | 对 AhaStudio 的直接压力 |
| --- | --- | --- | --- | --- |
| [Orca](https://github.com/stablyai/orca) | Agent IDE、项目和 worktree | Repo / worktree / Agent session；实验性编排有 Run / Task / Dispatch | 多 CLI 并行、终端/浏览器/Diff、历史会话、手机远控、远程主机、额度；Orchestration 可监督 Worker 和 gate | “跨 CLI、并行、多设备、额度”已是成熟开发者工作台能力。|
| [Paseo](https://github.com/getpaseo/paseo) | 跨设备的 Agent 客户端和 Workspace | Workspace / Agent session；Hub 有项目工作流 | 本地 daemon、原生 Harness 与 ACP、现有会话导入、语音对话、本地 STT/TTS、手机与加密中继、Worker/Verifier loop、Hub 事件工作流 | “语音说话、手机发消息、跨 Harness、循环验证”都已有功能对应。|
| [Multica](https://github.com/multica-ai/multica) | 人与 Agent 共用的工作看板 | Issue / Run / Squad / Agent | 给 Agent 分派 Issue，汇报进度与阻塞，Squad leader 协调，Inbox、Autopilot、IM 与人类验收 | “任务一级对象、Host/Worker、异步 Inbox、IM 派活”也不能单独构成差异。|
| **AhaStudio** | 最需要用户注意的真实任务、AhaBar；自然语音/会议也能直接进入 | **Task Charter → Run → Decision → Evidence → Accepted Delivery**，Project 沉淀上下文 | 目标是让用户少管理 Agent，同时清楚知道什么已被授权、何时必须决定、结果凭什么算完成 | 必须以一条可运行、可验收的跨客户端闭环证明，而不能只叠加功能列表。|

这张表的用户心智可以简化为：Orca 管 **工作在哪里执行**，Paseo 管 **从哪里控制执行**，Multica 管 **谁负责哪件事**；AhaStudio 应主攻 **这件事是否被正确理解、何时需要我、交付是否可信**。后三者均可扩展，所以这只是当前竞争位置，不是永久边界。[Orca worktree](https://github.com/stablyai/orca/blob/v1.4.218/docs/site/content/docs/model/worktrees.mdx) · [Paseo voice/loop](https://paseo.sh/docs/voice) · [Multica Issues](https://multica.ai/docs/issues)

## 2. 应明确的产品承诺

> **AhaStudio 是个人 AI 任务中枢：用户说出目标或开会形成决定，它从已有项目和会话中理解上下文，确认任务边界，让合适的原生 Agent 开工，只在关键决策时找用户，最后用证据交付结果。**

首发演示只展示一条完整动线：

1. 打开 AhaStudio，首启只读发现 Codex / Claude 的真实历史任务与正在运行的会话，并说明归并依据。
2. 用户说一句目标；系统先只读调查，再形成简短 Task Charter（结果、范围、费用/时间上限、停止条件与可计算验收项）。必要澄清通常不超过三个阻塞问题。
3. 用户确认后，Host 在原生 Harness 中启动 Run；已在其他 IDE 中的工作仍能被观察和纳入同一 Task。
4. Worker 的问题经 Host 合并进入 Decision Inbox；AhaBar 只提醒最值得处理的一项，IM/日历深链打开对应确认界面，风险动作按等级确认。
5. 达到可接受标准即停止，返回产物、Diff、独立验证证据和遗留风险；用户决定接受或继续优化。

这一承诺要求 AhaStudio **能实际启动与推进任务**。只有观察看板会被 Orca/Paseo 的现成运行能力压过；只有语音输入会被 Paseo 的 Voice Mode 压过；只有 Issue/Inbox 会被 Multica 压过。[Paseo Voice](https://paseo.sh/docs/voice) · [Paseo Loop](https://github.com/getpaseo/paseo/blob/main/skills/paseo-loop/SKILL.md) · [Multica 工作机制](https://multica.ai/docs/how-multica-works)

## 3. 真正值得投入的四个产品资产

1. **跨客户端任务事实。** 以高置信度把不同 CLI/IDE 的 Session/Run 与同一 Task 关联；中置信度只建议，跨项目必确认。历史会话导入本身已有竞品，关键是用户任务、决策和验收在客户端之间保持一致。[Paseo 会话导入](https://paseo.sh/changelog) · [Orca 历史扫描](https://github.com/stablyai/orca/blob/v1.4.218/docs/site/content/docs/agents/session-history.mdx)
2. **AhaTalk + AhaMeet 的任务表达层。** 中文和专业词库、口语整理、会前任务简报、会中约束/决定识别、会后变更 Task Charter 并保留依据。ASR 字错率重要，但更要量化“说完是否产生正确任务”和“会议决定是否推进已存在的工作”。Paseo 已有本地语音对话与隐藏的 Agent 调度会话，因此“能用语音启动 Agent”不是专属卖点。[Paseo 语音架构](https://paseo.sh/docs/voice)
3. **可信自治与验收。** Paseo 已有 Worker/Verifier loop，Multica 有验收项与 Autopilot。AhaStudio 的主张须落实为平台执行约束：任务级授权与预算；可靠 Evaluation Contract 才能开 Autonomous Loop；合同冻结、版本化；独立证据；验证冲突必须升级；达标即停。用户可见的是“为什么说完成”，不需要先理解术语。[Paseo Loop Skill](https://github.com/getpaseo/paseo/blob/main/skills/paseo-loop/SKILL.md) · [Multica Autopilot](https://multica.ai/docs/autopilots)
4. **一套跨表面的注意力与批准语义。** AhaBar、桌面、IM、手机、AhaKey 和 AhaStation 都投影同一 Decision，只有 Host 占用用户注意力；低风险单按、中风险按住、高风险详情二次确认。硬件提供即时、可感知的批准与任务状态体验，但不是软件能力的门槛。[AhaStudio 领域定义](../../CONTEXT.md)

## 4. 首发取舍与路线重排

**先完成一个纵向闭环，再增加覆盖面。** 现有策略将“只读观察”与“说话就开工”分成两个发布阶段；竞品现状使单独观察版很难形成传播点。建议将其合并成一个首发体验：macOS 上稳定支持 Codex + Claude；已有 Kimi 观察能力可标注为较浅等级。每个连接器公开 `discover / observe / start / resume / steer / permission / usage / evidence` 的实测能力，不以“支持 N 个 Agent”掩盖差异。现有 AhaStation 代码已包含观察层、会议编排、批准和 AhaBar，可作为纵切起点；需以当前构建验证，不能据文档推断全部完成。[当前技术计划](../ahastudio/05-technical-architecture.md)

**紧接着补可验证交付。** 优先选有确定检查的代码任务（测试、构建、PR 检查、可复现 UI 回归），让 Task Charter 自动提出验收项并由用户轻量确认。将“完成后询问是否验证”作为普通任务默认，把自动验证留给明确指定的重要任务。随后引入跨模型 Verifier、冻结合同、失败证据与成本/时间上限。

**会议、移动与设备按同一任务事实扩展。** AhaMeet 首先展示“一次会议改变了哪些现有任务、创造了哪些新任务、还欠谁一个决定”；移动端优先处理 Decision Link、语音补充、停止与低风险批准，早期可用可信网页/IM 承载，不急于复制完整远程终端。AhaKey X1 及 AhaBar 应在首发中共同演示物理/屏幕注意力闭环；AhaStation 与 Sync Vault 待单机交付证据稳定后推进。

**人群从高频场景扩展。** 首批聚焦同时使用多个 AI IDE/CLI、经常并行推进两项以上工作的个人开发者和小型产品团队：他们有可发现的会话、明确的任务产物和可计算的部分验收项。设计师、编辑、律师等知识工作者不被排除，但应通过经过实测的行业 Work Recipe 和对应证据类型逐步进入；不能把代码测试等同于所有行业的验收。

**明确开放性承诺。** Orca 为 MIT，Paseo 与 AhaStudio 计划为 Apache-2.0；Multica 的 [自定义许可](https://github.com/multica-ai/multica/blob/main/LICENSE) 对商业托管/嵌入和品牌施加附加条件。AhaStudio 完整本地工作闭环保持 Apache-2.0、无设备/订阅锁本地核心；Pro 通过 AhaTalk Cloud、加密中继、跨设备便利与持续服务收费。许可有利于建立信任，但不能代替体验与社区贡献机制。[Orca License](https://github.com/stablyai/orca/blob/v1.4.218/LICENSE) · [Paseo License](https://github.com/getpaseo/paseo/blob/main/LICENSE) · [AhaStudio 定义](../../CONTEXT.md)

**开源增长围绕可复现结果。** 发布页和仓库首页展示一条可在普通电脑上复现的三分钟任务闭环、清楚标注各客户端的观察/控制能力、Hook 安装前后的准确 Diff 和撤销路径。社区先贡献 Adapter、Work Recipe、Verifier 及公开样例任务；榜单比较“被用户接受的一次交付”的质量、耗时和成本，并由用户按项目选择是否贡献匿名证据。AhaBar 形成日常触点，AhaTalk Cloud 和 AhaKey X1 分别承接持续服务与硬件转化，任何转化都不截断免费本地闭环。

## 5. 衡量是否真有差异

北极星维持：**每周从自然表达或会议开始、最终被用户接受的有效交付数**。发布前用五个可复现指标检验，而不是看接入 Agent 数量：

| 指标 | 验证的承诺 |
| --- | --- |
| 首次打开到看见真实任务的时间；归并误判率 | 跨客户端任务事实是否可信 |
| 语音/会议输入到 Charter 被确认的比例；必要澄清轮数 | 自然表达能否变成可授权工作 |
| 每个已接受任务的用户打断次数；阻塞 Decision 的响应时间 | Host 是否真正节省注意力 |
| 已接受交付率、验证漏检与返工率、每次有效交付的 Token/时间 | 证据交付是否优于普通多 Agent 使用 |
| 无硬件用户留存、AhaKey 转化、Pro 付费与续费 | 免费软件触达、硬件和订阅是否形成健康漏斗 |

## 6. 产品话术

- 面向新用户：**“说出目标，AI 开工；该你决定时提醒你，完成后给你看证据。”**
- 面向现有多 Agent 用户：**“把散落在 Codex、Claude 等客户端的工作收拢成可追踪、可批准、可验收的任务。”**
- 面向社区贡献者：**“为一个 Harness、任务类型或 Verifier 贡献可复现的能力与交付证据。”**
- 面向 AhaKey 购买者：**“语音开工、按键批准、随手看到任务状态。”**

## 资料边界

三款产品公开资料更新频繁。此文档对代码与文档存在性的判断固定在研究日期；对性能、留存、真实误批准率和市场转化没有可比公开证据。AhaStudio 要验证的是完整动线是否比现有工具减少管理时间并提高用户接受率，而非证明其他产品永远不会实现其中某个功能。
