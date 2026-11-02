# AhaStation 同账号多设备协作：需求、方案、分工与代码交接

文档版本：0.1
整理日期：2026-10-20
面向对象：项目维护者、新成员，以及协助开发的 Agent
目标：让新成员理解整个产品、自己的交付范围、公共基础 PR 和当前实现边界。

后续上传分支的源码整合、当前启动方法和实际验证结果见
[BASELINE.md](BASELINE.md)。本文第 12、15 节保留整合前的工作树盘点与有日期证据，
不代替新分支的验证记录。必要 Hub 源码现已纳入 services/remote；设计中的新增业务仍待实现。

> 本文包含两种内容：当前工作树中已经存在的实现，以及下一阶段要开发的设计。接口草案、目录建议和验收清单均不表示功能已经实现。本文编写过程中只新增交接文档并运行类型检查，没有改动业务源码、提交代码、创建 PR 或操作云端。

## 1. 先读这一页

### 1.1 最终要做什么

两台不在同一局域网的电脑都安装 Station，登录同一个协作账号，在设置中启用本机、配置 Agent 并授权项目，然后进入同一个会议。已有 Host 负责拆分任务；用户可以手动选择设备和 Agent，也可以启用自动分配。任务在目标电脑本地执行，会议同步进度和结果。

共同开发一个项目时，每台电脑都有同一个 GitHub 仓库的本地副本，通过任务分支、提交和 PR 汇总代码。Hub 负责账号、设备和协作消息，不承担模型计算，也不替代 GitHub 存储仓库。

### 1.2 最终分工

| 人员 | 完整负责的功能 | 一句话说明 |
| --- | --- | --- |
| 新成员 | 设备接入与管理；项目绑定与授权 | 让电脑和项目准备好，可以被会议安全地使用 |
| 维护者／老成员 | 共享会议；跨设备任务执行 | 把这些电脑组织起来，拆分、执行、跟踪和交付任务 |
| 双方 | 公共契约、联调和端到端验收 | 使用同一套身份、连接、消息和授权规则 |

新成员同时负责自己模块的界面、Electron 服务、Hub 接口、持久化／迁移代码和测试。云端部署权限与开发归属分开：新成员通过 PR 交付，维护者审查并实际部署。

### 1.3 当前到哪一步

已经有本地会议、Host、WorkerScheduler、任务工作区、交付审查，以及一套“Station → Hub → 独立 Bridge → 已有原生会话”的远端控制代码。

尚未完成的是“Station 自身接收任务、逻辑项目跨设备绑定、多个 Station 共享一场会议、按设备调度 Worker”的完整产品闭环。不能把已有 Bridge 能力直接等同于新架构完成，也不能把历史测试记录当作这套新需求已经通过。

### 1.4 新成员先做什么

1. 阅读本文第 2、3、7、8、9、13 节，明确目标、边界和自己的模块。
2. 在维护者交付的完整基线上安装依赖、运行 Station 和相关测试。
3. 参与公共基础 PR，确认四项契约，补齐字段、错误样例、模拟实现和契约测试。
4. 先做最小设备注册、状态展示和项目绑定／核验，再逐步完善界面与异常处理。
5. 不需要等共享会议和自动调度全部完成；可以用模拟会议／任务调用自己的模块。

## 2. 术语与已有基础

| 术语 | 本项目中的含义 |
| --- | --- |
| Station | 对外的软件名称 AhaStation；现有部分页面显示 AhaStudio，不能据此认为是两个通信产品 |
| 协作账号 | Hub 中的远端身份，用于同账号设备隔离；与 Codex／Claude 模型账号不同 |
| 设备 | 一个 Station 安装及当前 OS 用户配置对应的稳定设备身份；重启、改名后保持编号 |
| Agent | 当前设备可以调用的编程后端，例如 Codex、Claude；设备和 Agent 不是同一个编号 |
| Host／Coordinator | 已有会议中的对话／协调角色，负责理解需求、计划和分派；沿用现有能力门禁 |
| Worker | 接收明确任务并在本地执行的 Agent；新功能允许它位于其他设备 |
| 共享会议 | 多台 Station 订阅同一个逻辑 meetingId，看到一致的成员、聊天、计划和任务投影 |
| 原生会话 | Codex／Claude 自己的对话，具有原生 thread／session ID；不是 Station 的 meetingId |
| 逻辑项目 | 用 projectId 标识的共享项目，关联仓库身份和可选仓库子目录 |
| 本机绑定 | 某个 projectId 在当前设备对应的仓库副本、任务工作区和授权设置 |
| Hub | 公网协调服务，当前采用 Python／FastAPI，部署目标是微信云托管 |
| Bridge | 当前独立电脑端接入程序；接收任务、核验本地权限并驱动原生会话 |
| Navicat | MySQL 管理工具，用于运维查看和维护数据库；不参与 Station 间通信 |

已有代码中，Host 可以通过 delegate_task 等会议工具驱动 WorkerScheduler。原版不是完全没有任务分配，也不是完全没有远端后端；本次要扩展的是跨设备身份、共享会议、项目绑定和远端执行闭环，不重做一套 Host 和调度器。

## 3. 功能需求与第一版边界

### 3.1 必须满足的功能

| 编号 | 功能 | 用户应看到的行为 | 主要负责人 |
| --- | --- | --- | --- |
| F01 | 单软件接入 | 每台电脑安装 Station 即可配置本机接入，不要求单独安装／打开 Bridge | 双方 |
| F02 | 同账号多设备 | 同一协作账号下查看、命名、注册和移除设备，不显示其他账号的设备 | 新成员 |
| F03 | Agent 与接收设置 | 选择可用 Agent、启停接收新任务、配置最大并发并持久化 | 新成员 |
| F04 | 跨网络通信 | 两台电脑主动连接公网 Hub，无需互填公网 IP、端口映射或安装 VPN | 双方 |
| F05 | 逻辑项目 | 创建／选择项目并关联 GitHub 仓库；不同设备目录可以不同 | 新成员 |
| F06 | 本机授权 | 每台电脑独立确认仓库副本、任务工作区与执行权限；远端不能扩大授权 | 新成员 |
| F07 | 同一共享会议 | 创建／加入同一 meetingId，同步成员、聊天、计划、任务和结果 | 维护者 |
| F08 | 手动分配 | Host 拆分后，由用户选择设备和 Agent，再明确派发 | 维护者 |
| F09 | 自动分配执行 | 在本机已启用接收且项目已授权的前提下，按能力、容量和依赖自动分配 | 维护者 |
| F10 | 本机执行与回传 | 目标电脑核验授权、准备工作区、调用本机 Agent，回传进度、结果和错误 | 维护者 |
| F11 | 精确停止 | 停止对应任务并核实退出；未确认时显示“停止中／退出未确认” | 维护者 |
| F12 | 重连和恢复 | 断网、重载、进程重启后核对原任务，不盲目重跑、不串会议或项目 | 维护者 |
| F13 | GitHub 交付 | 各自克隆、任务分支／worktree、提交、推送和 PR，结果中展示证据 | 维护者 |
| F14 | 已有会话兼容 | 保留选择已有 Codex／Claude 会话，以及 Codex 桌面完成／停止后接续 | 维护者 |
| F15 | 保留本地流程 | 本地会议、语音文本、参与者、聊天、任务与交付功能保持可用 | 双方 |
| F16 | 平台支持 | Windows、Linux 小电脑与 macOS；平台和 CPU 架构分别验收 | 双方 |

F14 中，同一个原生会话可以接受桌面和 Station 的输入，但原生执行回合必须排队／互斥，不能有两个执行者同时写同一会话。停止只影响自己拥有的任务，不得误停桌面上的其他工作。

### 3.2 第一版不扩大的范围

- 先支持同账号设备，不增加不同账号邀请、组织角色和复杂团队权限。
- 保留公网 Hub，不同时增加 P2P、内网穿透和 VPN 产品流程。
- 首版由一台明确的协调 Station 负责一场会议，不增加自动主机选举和接管。
- GitHub 交付先使用本机 Git／GitHub CLI 或既有接口，不建设完整 OAuth、仓库管理和 PR 管理中心。
- 不通过 Hub 同步整个本地文件夹，也不上传模型登录信息、Git 凭证或完整原生会话数据库。
- 不要求将 Python 代码全部重写成 TypeScript；需要的原生兼容／监管辅助进程可以保留，但用户使用流程统一在 Station。
- 不在本次修改中顺带修复全部既有测试失败；影响新链路的失败必须定位并明确处理。

## 4. 正常使用流程

### 4.1 两端准备

1. A、B 都安装 Station，登录同一个协作账号。
2. 各自在设置中启用本机、注册设备、设置名称，选择已在本机配置的 Agent。
3. 各自设置是否接收任务及最大并发；暂停接收只阻止新任务，不自动杀死已运行任务。
4. A 创建逻辑项目或选择已有项目，关联 GitHub 仓库。
5. B 选择同一个项目，将自己的本地仓库副本和任务工作区绑定并确认授权。
6. 两端显示项目准备状态；缺副本、仓库身份不符或权限不足时显示原因。

Git 克隆可以通过已有终端／Agent 流程完成。项目绑定负责识别和授权，不需要第一版额外建设完整图形化 Git 客户端。

### 4.2 会议与派发

1. A 创建共享会议，B 在同账号会议列表中加入。
2. 一场会议只有一个当前协调者；B 显示同一会议并启动本机任务接收能力，不再为同一共享会议独立启动第二套规划与调度。
3. 用户向 Host 提需求，Host 使用已有计划／任务能力拆分。
4. 手动模式由用户指定设备和 Agent；自动模式由调度器选择满足条件的目标。
5. B 接单时再次检查身份、项目绑定、权限、容量和任务版本，持久化接收记录后确认。
6. B 准备任务工作区并在真正启动 Agent 前复核实际路径，随后执行和回传事件。
7. A、B 都看到任务状态；重复消息不会重复启动任务，迟到结果仍归属原任务。

### 4.3 GitHub 汇总

1. 各设备从指定 baseCommit 准备独立任务分支／worktree。
2. Agent 完成修改和相应检查，提交、推送并创建 PR，或清楚报告失败原因。
3. 结果包含摘要、检查结果、提交 SHA、分支和 PR URL。
4. 人工审查／合并后，协调者核对合并结果和新基线，再释放依赖代码变更的后续任务。
5. 纯文本分析结果可按任务验收规则供后续任务使用；需要代码的依赖不能仅因 Agent 回复“完成”就释放。

PR 创建、检查通过、人工合并、任务验收是不同状态。沿用现有本地交付审查能力；远端 GitHub 交付通过适配接入，不能把 PR 已创建直接标成本地 Integration Queue 已接受。

## 5. 整体实现方案

### 5.1 架构

~~~mermaid
flowchart LR
  subgraph A["Station A"]
    AU["设置／共享会议界面"]
    AM["Electron 主进程：身份、连接、项目服务"]
    AC["既有 Host／WorkerScheduler"]
    AU --> AM
    AM <--> AC
  end
  subgraph B["Station B"]
    BU["设置／共享会议界面"]
    BM["Electron 主进程：身份、连接、项目服务"]
    BR["接收运行时／本地 Agent／任务工作区"]
    BU --> BM
    BM <--> BR
  end
  AM <-->|HTTPS／WSS| H["公网 Hub"]
  BM <-->|HTTPS／WSS| H
  H <--> DB["MySQL：身份、设备、项目、会议、任务与事件"]
  AC <--> GA["A 的 Git 副本"]
  BR <--> GB["B 的 Git 副本"]
  GA <-->|提交／推送／PR| GH["同一 GitHub 仓库"]
  GB <-->|提交／推送／PR| GH
~~~

Linux、Windows、macOS 使用同一套逻辑协议，不按操作系统分别设计“一个长连接、一个轮询取 Prompt”的业务流程。HTTP 处理请求与快照，WSS 承载实时推送；重连时可以通过 HTTP 查询补齐状态。

### 5.2 各层职责

| 层 | 负责 | 不应承担 |
| --- | --- | --- |
| React 界面 | 设置、设备／项目状态、会议、任务操作与错误提示 | 长期凭证保存、直接启动任意命令 |
| Electron 主进程 | 可信凭证存储、连接、IPC、项目核验、调度与 Agent 管理 | 信任远端传入的任意本机 cwd |
| Hub | 身份隔离、设备路由、共享元数据、事件顺序、任务投递及恢复依据 | 保存模型密钥、访问本机目录、执行模型 |
| 本地接收运行时 | 持久化接单、幂等、工作区、实际执行、停止和结果 | 未核对旧任务就重新执行 |
| MySQL | Hub 的持久化状态 | 作为客户端直接访问的消息总线 |
| GitHub | 版本、提交和 PR 交付 | 代替本机目录授权 |

### 5.3 状态的权威来源

- Hub 从认证凭证派生 ownerId／deviceId，不能信任请求体自报的账号归属。
- Hub 根据连接和心跳维护在线状态；设备上报本机 Agent 能力、接收设置和执行占用。
- 当前设备持有本地路径与授权事实；Hub 的“已绑定”状态只是调度参考。
- 协调 Station 负责计划和调度；Hub 为已接受的共享事件提供持久化顺序。
- 执行设备提供真实任务状态和退出证据；网络断开不能代替执行失败／停止证据。
- UI 从快照与事件建立投影，不自行猜测完成、空闲或任务可重跑。

## 6. 如何处理现有 Bridge

目标是 Station 内置接入能力，不是简单把独立 Bridge 窗口放进 Station。

| 现有内容 | 处理方式 |
| --- | --- |
| 独立 Bridge 设置窗口、托盘、独立安装／升级／自启流程 | 从普通用户新流程中移出；兼容过渡期可保留源码 |
| 公网身份、设备凭证、心跳与重连规则 | 提取和复用，接入 Station 的可信主进程 |
| 幂等接收、任务日志、取消确认、结果补交 | 保留语义与回归测试，接入新接收运行时 |
| 项目真实路径检查和权限上限 | 归入统一项目服务，由执行模块调用 |
| 原生会话发现、Codex 共享执行与进程监管 | 作为兼容适配器保留；有必要时打包辅助进程 |
| 旧 LAN／独立 CLI 兼容 | 明确标注兼容模式，避免成为新产品默认路径 |

不能按文件名直接删除“旧 UI”相关文件。目前实际存在这些依赖：

- public_hub.py 引用 device_hub.py，后者引用 qwen_router.py 并挂载 web 静态资源。
- desktop_agent.py 和 task_process.py 仍引用 desktop_control_panel.py 中的会话发现功能。
- codex_shared.py 仍使用 bridge_settings.py 中的本机凭证保护功能。
- idle_probe.py 被 macos_task.py 使用，不是可随意删除的诊断废文件。

先抽取需要的能力、调整导入与打包清单、通过兼容测试，再决定哪些独立界面和脚本归档。

## 7. 按完整功能模块分工

### 7.1 新成员：设备接入与管理

完整交付范围：

- Station 设置中启用／禁用本机，注册、重命名和移除设备。
- 稳定 deviceId、同账号本机注册、设备范围凭证和安全存储。
- Agent 发现／选择、能力上报、登录可用状态展示。
- 接收任务开关、最大并发设置，保存并通知调度模块。
- 设备连接服务的生命周期、心跳、断线退避和重新同步；使用共同基础中的认证与消息规则。
- 同账号设备列表、在线状态、不可用原因和操作反馈。
- 对应 Hub 路由、存储／迁移代码、IPC、界面和测试。

边界：

- 设置最大并发不等于管理全局任务队列；实际名额预留与接单由执行／调度模块处理。
- 不负责判断旧任务是否真实退出；连接恢复后将消息交给任务模块核对。
- 不负责共享会议计划和自动分配算法。
- 禁用／移除设备时，应区分停止接收新任务与仍需反馈的既有任务，不能直接清除执行记录。

验收：设备重启／改名后身份稳定，重复注册不会产生多台假设备；A 能看到 B 的正确状态；拒绝其他账号访问；暂停接收会影响新任务可用性。

### 7.2 新成员：项目绑定与授权

完整交付范围：

- 创建／选择逻辑项目，关联仓库身份与可选子目录。
- 本机选择 Git 副本，识别仓库并校验与共享项目的关系。
- 配置允许的任务工作区、权限和 Agent 范围，保存本地绑定及版本。
- 展示当前设备绑定状态，发布变化通知。
- 实现供任务运行时调用的项目解析与真实路径／权限核验接口。
- 对应 Hub 项目元数据和绑定状态接口、迁移代码、IPC、界面和测试。

边界：

- 本机路径保存在本机；Hub 不通过项目接口下发任意可执行 cwd。
- 仓库 URL 匹配不等于获得目录权限；目录及 worktree 仍需本机确认。
- 工作区分配、任务分支和 Agent 启动由执行模块负责；项目模块负责核验是否在许可范围及是否属于正确仓库。
- 不负责做完整 GitHub 登录、PR 管理产品或仓库内容同步服务。

验收：同一 projectId 能绑定 A、B 不同路径；换目录、仓库不符、符号链接越界、未授权 worktree、权限不足均给出明确结果。

### 7.3 维护者：共享会议

- 创建／列出／加入同账号会议，维护唯一协调设备及成员。
- 同步聊天、计划、任务、进度和结果，沿用现有界面结构。
- 将参与设备的操作转成发给协调者的明确命令，避免各端重复执行。
- Hub 会议元数据、持久化事件、快照／补齐接口与相应迁移。
- 断线／重载恢复、顺序与去重、迟到事件归属、协调设备不可用提示。
- 首版协调设备不可用时暂停新调度；执行端保留已接任务和补交能力，不自动选举新协调者。

### 7.4 维护者：跨设备任务执行

- 复用 Host、delegate_task 和 WorkerScheduler，增加设备／项目执行目标。
- 实现手动分配、自动选择、容量预留、依赖和任务版本检查。
- 接收端持久化接单，调用新成员的项目核验服务，准备工作区并启动本地 Agent。
- 进度、错误、结果、精确取消、退出核对、幂等、重启和重连恢复。
- 区分新任务 Worker 与已有原生会话接续，保留原生单会话写入互斥。
- Git 分支／worktree、基线提交、结果和 PR 交付接入及相关验收。

### 7.5 公共部分的责任

| 公共部分 | 牵头 | 协作方式 |
| --- | --- | --- |
| 共同源码基线、来源记录和现有通信整理 | 维护者 | 新成员在干净环境复现 |
| 四项契约与共享协议 | 维护者提供初稿，双方确认 | 变更先修改契约与样例，再修改生产者／消费者 |
| 设备／项目接口实现和迁移文件 | 新成员 | 维护者审查并部署 |
| 会议／任务接口实现和迁移文件 | 维护者 | 新成员审查与自己模块的接口边界 |
| 主进程入口、preload、公共类型和依赖文件 | 每个 PR 指定修改人 | 使用小型注册入口，避免两人同时大改公共文件 |
| 云端配置、迁移执行、发布和回滚 | 维护者 | 新成员交付代码与执行说明，不直接操作现有环境 |

## 8. 四项公共契约草案

本节保留需求讨论时的草案，帮助理解边界。2026-10-21 已落实可调用的 Schema、类型、双语言校验、模拟和测试；正式字段与调用以 [CONTRACTS.md](CONTRACTS.md) 及其引用源码为准。以下历史命名不改变已有 v1／v2 API 的含义；新接口尚未接入现有生产 Hub。

### 8.1 设备契约

建议结构：

~~~ts
interface CollaborationDevice {
  schemaVersion: 1;
  deviceId: string;
  name: string;
  platform: "windows" | "linux" | "macos";
  acceptingTasks: boolean;
  maxConcurrency: number;
  agents: Array<{
    agentId: string;
    backendId: string;
    available: boolean;
    executionModes: Array<"worker" | "native-session">;
    unavailableReason?: string;
  }>;
  revision: number;
}
~~~

Hub 视图额外提供 online、lastSeen；执行模块提供任务占用。数字范围和长度上限写进 Schema，maxConcurrency 至少为 1，是否接收由 acceptingTasks 表达。

关键规则：

- ownerId 由凭证派生；相同名称不表示相同设备。
- 新连接要处理旧连接代次，避免旧断线回调把新连接误标为离线。
- 协作登录与模型／Git 登录分开，界面不应显示模型密钥。
- 设备快照不是容量锁；真正接单必须原子核对／预留名额。
- 仅支持原生会话接续的 Agent，不能被当成通用 Worker 自动分配。

### 8.2 项目契约

~~~ts
interface CollaborationProject {
  schemaVersion: 1;
  projectId: string;
  name: string;
  repository: {
    provider: "github";
    canonicalUrl: string;
    repositoryId?: string;
  };
  repoSubdirectory?: string;
  revision: number;
}

// 只在对应设备本地保存；不作为跨设备任务的路径来源。
interface LocalProjectBinding {
  projectId: string;
  localRepoRoot: string;
  taskWorkspaceRoot: string;
  permissionCeiling: string;
  allowedAgentIds: string[];
  confirmed: boolean;
  revision: number;
}
~~~

Hub 另保存每台设备的绑定摘要，如 projectId、deviceId、ready／unbound／invalid、绑定版本和可公开的错误码。不要将真实路径或秘密字段直接扩散到所有共享事件中。

关键规则：

- 将 SSH／HTTPS、尾部 .git 等等价地址正规化；不盲目把不同仓库当同一个。
- repositoryId 可选，未登录 GitHub 时仍可按仓库地址完成第一版识别。
- 相同 repo 的多个业务子项目可以有不同 projectId／子目录，不能只靠仓库名称识别。
- 仓库身份变化使绑定失效，需重新核对；普通任务分支变化不需要重复授权。
- projectId 不能自动获得本机权限；权限上限采用本机实际支持的后端策略，不由远端字符串决定。

### 8.3 本机授权核验契约

建议分成两步，方法名最终以公共基础 PR 为准：

~~~ts
resolveAuthorizedWorkspace({
  projectId,
  taskId,
  attemptId,
  agentId,
  baseCommit,
  requiredPermission
})
// 返回本机 repoRoot、允许的 taskWorkspaceRoot、
// 实际权限上限、bindingRevision，以及本地核验引用；失败返回明确错误。

validateWorkspaceForExecution({
  authorizationRef,
  bindingRevision,
  preparedWorkspacePath,
  baseCommit,
  effectiveAgentPermission
})
// 工作区准备后、Agent 真正启动前，再核对当前授权和真实工作区。
~~~

第一步不替执行模块创建任务或 worktree；第二步不能仅相信传入对象声称“已授权”，必须读取当前本机配置并验证实际目录。

必须覆盖：

- 项目是否绑定、用户是否确认、Agent 是否在许可范围。
- repoRoot 真实路径与仓库身份；可选子目录不能逃出仓库。
- worktree 的真实路径、Git common dir／所属仓库及允许的任务工作区。
- 符号链接／Windows junction、路径大小写与分隔符差异。
- baseCommit 能否解析为真实提交，不能盲目使用发送端 HEAD。
- 当前绑定是否撤销或变更；检查后到启动前变更时拒绝或重新核验。
- 任务要求、桌面原生会话有效权限、Agent 实际权限不能高于本机授权上限。

建议错误码：

| 错误码 | 用户可理解的处理 |
| --- | --- |
| PROJECT_UNBOUND | 在这台电脑为项目选择并授权副本 |
| REPOSITORY_MISMATCH | 检查绑定是否指向正确仓库 |
| PATH_NOT_AUTHORIZED | 检查副本和任务工作区的真实路径 |
| PERMISSION_EXCEEDED | 调整任务／原生会话权限，或由本机用户明确修改授权 |
| BASE_COMMIT_UNAVAILABLE | 获取指定提交，不能静默使用其他基线 |
| BINDING_CHANGED | 重新读取授权并核验 |
| AGENT_UNAVAILABLE | 检查本机 Agent 安装、登录或执行方式 |

本机目录授权与已有 task-authority 的计划／命令授权互补：项目允许这个目录，不表示所有命令和网络操作都自动允许。最终有效能力不能超过两者及 Agent 原生限制的交集。

### 8.4 状态变更通知契约

建议事件包含 schemaVersion、eventId、type、streamId、revision、deviceId／projectId、occurredAt 和 payload。

第一版事件类型至少包括：

- device.online、device.offline、device.updated、device.capabilities_changed。
- project.created、project.updated、project.binding_changed。
- 本机 IPC 的 project.authorization_changed；共享事件仅发布脱敏状态。

规则：

- 设备／项目流按各自 revision 去旧，会议流另有 Hub 分配的单调 seq。
- 时间戳用于展示，不用不同电脑的时钟判断事件先后。
- eventId 去重，旧 revision 不覆盖新快照，断档要补齐或重新获取快照。
- 本机配置写成功后才发布成功事件；配置窗口与主窗口都能收到变更。
- 任务事件必须保留 meetingId、projectId、taskId、attemptId；切换当前页面不改变其归属。
- 不将“消息已接收”事件当作“任务执行完成”。

### 8.5 与任务模块的最小对接

任务模块另外定义分派结构，至少包含：

~~~json
{
  "schemaVersion": 1,
  "meetingId": "meeting-fixture",
  "projectId": "project-fixture",
  "taskId": "task-fixture",
  "attemptId": "attempt-fixture",
  "planVersion": 1,
  "targetDeviceId": "device-fixture-b",
  "agentId": "agent-fixture",
  "idempotencyKey": "submission-fixture",
  "baseCommit": "0123456789012345678901234567890123456789",
  "objective": "在授权项目中完成指定修改"
}
~~~

实际还要接入已有执行配置、上下文、依赖、相对写入范围和验收标准。不要无校验地把本机 TaskAuthorityGrant.workspaceRoot 等绝对路径字段原样跨设备传输；接收端解析项目后构造自己的本地有效授权。

taskId 标识逻辑任务，attemptId 标识一次执行尝试，idempotencyKey 标识可去重的提交。重传沿用原键；创建新尝试必须先完成旧尝试核对。旧 attempt 的迟到结果保留记录，不能覆盖当前 attempt。

## 9. 公共基础 PR：具体做到什么

### 9.1 目标

让两个人从同一份完整代码出发，按同一契约开发，并能验证身份和基础消息往返。公共基础 PR 不要求提前实现完整会议、任务调度或全部设备／项目界面。

### 9.2 维护者先准备

| 材料 | 具体要求 |
| --- | --- |
| 完整源码基线 | 清点两个仓库的 tracked／untracked 必要源码，明确来源及保留内容；保护原有用户修改 |
| 固定版本 | 给出实际分支和提交；两个 HEAD 不能代替尚未提交的完整工作树 |
| 启动与测试说明 | Node／Python 版本、安装、Station／本地 Hub 启动、类型检查、测试命令 |
| 现有协议 | 登录、设备凭证、HTTP、WebSocket、消息封装、确认、取消与恢复样例 |
| 服务配置 | 已核实的测试 HTTPS 地址、WSS 入口及限制、部署版本；不能只给一个旧截图网址 |
| 测试身份与仓库 | 独立协作测试账号／注册方式、测试设备和测试项目，凭证私下交接 |
| 当前问题基线 | 有日期的实际结果、失败名称、平台跳过和未验收事项 |

### 9.3 新成员参与准备

| 工作 | 输出 |
| --- | --- |
| 跑通维护者基线 | 记录操作系统、运行版本、命令、成功及失败；缺失依赖直接反馈 |
| 检查设备流程 | 注册、重命名、退出、重复连接、暂停接收的状态与字段建议 |
| 检查项目流程 | 仓库识别、子目录、worktree、权限变更、绑定失效的样例 |
| 确认调用边界 | 授权核验入参／返回值、设备与项目查询、事件订阅和错误码 |
| 编写模拟实现 | 模拟在线／离线／暂停／容量不足设备，以及有效／未绑定／越界项目 |
| 完成契约测试 | 同一组样例可被 TS 和 Hub 侧校验；无真实模型、无生产数据库依赖 |

### 9.4 建议产物

以下是计划结构，目前本文并未创建这些生产目录或功能模块：

~~~text
contracts/collaboration/
  device.schema.json
  project.schema.json
  event.schema.json
  examples/
docs/collaboration/
  BASELINE.md
  PROTOCOL.md
  IMPLEMENTATION_DECISIONS.md
electron/collaboration/
  公共接口、连接适配入口和测试用实现
services/remote/
  迁入后的 Hub 及必需兼容源码（保留原有内部布局）
tests/
  契约校验、模拟设备和消息往返测试
~~~

以 JSON Schema／明确类型和共享样例表达规则，TS 与 Python 不各自手写一份不同的协议。已有远端协议保持原样，新能力协商明确版本，不能把原 v2 握手随意改成另一种含义。

### 9.5 公共基础 PR 的完成条件

- 干净克隆可以按说明安装、类型检查、构建及启动；已有失败有明确记录。
- 没有依赖维护者电脑上未提交的隐形文件。
- 四项契约、错误码、正常／失败样例和模拟实现已合入并可测试。
- 有统一的登录／设备范围凭证调用入口，不引入第二套身份管理。
- Station 通用通道的握手、版本和错误规则已确定，并有本地可运行的最小消息往返实现；旧通道保持兼容。
- 对方能拿模拟设备和绑定直接开发，不需要等待完整产品界面。
- 明确哪些接口已部署、哪些仅本地实现、哪些仍是设计。

如果协议范围过大，可以把源码基线和公共契约分别作为两个小 PR；两者一起构成公共基础。不能只合入本说明文档就宣称公共基础已完成。

## 10. 登录与通信基础的实现

### 10.1 当前链路

~~~text
Station --HTTP--> Hub --WSS--> 独立 Bridge --本机适配--> 原生会话
Station <--HTTP 轮询结果-- Hub <--WSS 反馈-- Bridge
~~~

当前 Station 是控制端；公网任务必须选择明确已有原生会话。当前 /ws/desktop?provider=codex 或 claude 绑定设备与 provider，不能直接塞入新的会议／项目任意消息。

### 10.2 目标链路

~~~text
Station A 的主进程 <== HTTPS／WSS ==> Hub
Station B 的主进程 <== HTTPS／WSS ==> Hub
Station B 接收运行时 ==> 本机 Agent／必要的原生兼容辅助进程
~~~

建议增加独立命名空间的 Station 设备通道，或通过明确版本与能力协商扩展；具体 URL 在公共协议 PR 固定。旧 /ws/desktop 和 v1／v2 原生会话 API 不改为新业务含义。

同账号登录后由本机注册设备并取得设备范围凭证，日常不要求另一台电脑提供十分钟配对码；旧配对用于兼容。设备注册接口归新成员模块，底层身份校验与凭证规则使用统一基础。

### 10.3 必须一致的消息语义

| 阶段 | 可以证明什么 | 不能证明什么 |
| --- | --- | --- |
| 网络发送／接收 | 消息通过了当前连接 | 任务已被接收端可靠保存 |
| 持久化接单确认 | 接收运行时已保存原 task／attempt 并完成去重判断 | Agent 已启动或任务已完成 |
| running | 当前尝试已启动执行 | 最后一定成功 |
| 执行结果 | 当前尝试有完成／失败报告及证据 | 代码已通过审查／PR 已合并 |
| 停止确认 | 对应任务执行已退出且证据充分 | 其他原生会话也被停止 |
| 结果确认 | Hub 已可靠保存该结果，接收端可以结束重传 | 业务交付已经验收 |

接单必须先由任务运行时可靠保存，再发送相应确认，连接层不能收到字节就替业务接单。网络采用可重传和幂等去重，不承诺无条件的“恰好一次执行”。

### 10.4 重连、异常与容量

- 网络故障按退避策略重连，鉴权失效提示重新登录／注册，不无限重试登录接口。
- 重连后获取快照、补事件、核对未确认提交和执行记录。
- 状态未知显示待核对，不能立即重派到另一台设备。
- 接收端持久化账本与执行所有权属于任务模块；连接服务只负责恢复通道和可靠传递。
- 限制消息大小、请求速率、队列长度和日志内容，避免忙循环。
- 同一原生会话输入串行；不同任务并发遵守设备、Agent、工作区和原生会话限制。
- 只有业务状态机可以释放名额；断线本身不能释放可能仍在执行的任务。

## 11. 项目、工作区与 Git 规则

### 11.1 “同一个文件夹”的定义

不比较两台电脑的路径字符串，而比较 projectId、仓库身份和可选仓库子目录。A 的 C:\projects\demo 与 B 的 D:\working\demo 可以属于同一个项目。

同一仓库也不代表当前代码相同：分支、提交、未提交修改都可能不同。派发时固定 baseCommit，接收端核对并准备独立工作区；缺提交时按已授权的 Git 流程获取，失败则等待／报错，不能换用本机 HEAD。

### 11.2 worktree 授权必须单独考虑

当前 TaskWorkspaceManager 默认将 worktree 建在 Electron userData 下的 worktrees 目录，不一定在用户原仓库目录里面。因此只授权原仓库根目录，可能使有效任务工作区被拒绝。

新项目绑定需要明确许可 taskWorkspaceRoot，并核验生成 worktree 属于该项目仓库。不能为了兼容直接授权整块磁盘或把所有 userData 目录一概视为可信。

本地有未提交内容时沿用现有脏基线处理规则，不清理、不自动丢弃。仓库没有可用提交时显示可操作的原因，不自动 git add 全目录／创建包含私人文件的提交。

### 11.3 最小 GitHub 交付

- 使用本机现有 Git／GitHub 凭证，Hub 和其他设备不获取凭证。
- 每个任务固定基线、独立分支／worktree；新开发分支建议使用 codex/ 前缀，不强行重命名现有产品分支规则。
- Agent 可以运行已授权的 Git／gh 命令，无需第一版专门建设 GitHub 管理中心。
- 无权限推送／创建 PR 时报告当前提交和阻塞原因，不假报交付成功。
- 用户审查合并后，协调者核对实际提交与检查结果，再更新依赖任务的基线。

## 12. 当前代码进展：已存在与尚未实现

### 12.1 本次检查的版本

检查日期为 2026-10-20；未 fetch 或核对远端最新分支，以下只代表本地。

| 仓库 | 分支与 HEAD | 新增本文前的工作树 |
| --- | --- | --- |
| station-ctrl | main；8f1506e4d22c51b07805cfc5f49c1fb25d634cdd | 28 个已跟踪文件有修改；29 个未跟踪文件 |
| pocket-vibe-agent | main；21beb9e7618290035ae328020ed8f5dad3929262 | 6 个已跟踪文件有修改；57 个未跟踪文件 |

这两个 HEAD 都不包含全部现有远端功能。不要从 HEAD 编译后误认为拿到了当前工作树；也不要直接 git add 全部文件而跳过源码／凭证清点。

### 12.2 功能状态矩阵

“已有代码”表示能定位到实现，不代表在所有平台或公网 GUI 中验收通过。

| 能力 | 当前代码状态 | 下一步缺口 |
| --- | --- | --- |
| 本地会议、Host、计划与 Worker 调度 | 已有主干实现和大量测试 | 增加共享会议和远端目标，保留既有能力 |
| 本地工作区、权限、任务日志、审查与集成 | 已有 | 增加逻辑项目映射、远端交付适配 |
| Station 远端账号登录、配对和设备列表 | 当前工作树已有 | 整理为共同基础，增加 Station 本机注册与管理 |
| Station 选择已有原生会话并点名发送 | 当前工作树已有，文本模式 | 保持兼容，不能充当通用分布式 Worker 完成证明 |
| Hub MySQL 身份、设备、任务、幂等和取消 | 相邻仓库当前工作树已有 | 导入共享源码基线；增加项目／会议／任务新业务 |
| Bridge WSS 接收、日志、取消和恢复 | 相邻仓库已有 | 提取为 Station 内部能力并完成打包／生命周期接入 |
| Codex 桌面共享服务接续 | 有实现、协议测试及历史部分原生 RPC 证据 | 完整 Desktop GUI ↔ Station GUI、跨网及平台验收未完成 |
| 已结束会议恢复与多项目迟到结果 | 已有修复和回归记录 | 保留回归；共享会议新增类似场景 |
| Station 自身作为接收设备 | 尚无完整产品实现 | 新设备模块＋任务运行时接入 |
| projectId 与本地仓库／worktree 绑定 | 尚无本方案完整实现 | 新成员负责 |
| 多 Station 共享同一会议 | 尚无本方案完整实现 | 维护者负责 |
| 按设备手动／自动派发 Worker | 现有调度器可复用，但新链路未闭环 | 维护者负责 |
| 远端 GitHub PR 交付闭环 | 存在本地 Git 交付基础，新远端流程未闭环 | 维护者适配，双方验收 |
| Windows／Linux／macOS 新架构安装包 | 原有打包配置可复用 | 新能力逐平台、逐架构验收 |

### 12.3 主要 Station 代码入口

以下链接相对于当前文档，均为已有文件。

| 文件 | 用途 |
| --- | --- |
| [CODEBASE_GUIDE.md](../CODEBASE_GUIDE.md) | 目录和源码职责总索引 |
| [remote-control.ts](../../electron/remote-control.ts) | 远端身份、HTTP 调用、配对及 IPC |
| [remote-control-types.ts](../../electron/remote-control-types.ts) | 现有设备／任务／设置类型，尚非新契约全集 |
| [store.ts](../../electron/store.ts) | 原子设置保存、凭证保护与远端身份 |
| [RemoteControlSettings.tsx](../../src/components/RemoteControlSettings.tsx) | 现有远端设置界面 |
| [RemoteSessionPicker.tsx](../../src/components/RemoteSessionPicker.tsx) | 已有原生会话选择器 |
| [pocket-vibe-adapter.ts](../../electron/backends/pocket-vibe-adapter.ts) | HTTP 任务提交、轮询、结果、恢复和取消 |
| [pocket-vibe-target.ts](../../electron/backends/pocket-vibe-target.ts) | 稳定远端目标、点名、身份和目录核验 |
| [cli-backend.ts](../../electron/backends/cli-backend.ts) | Backend／Session 接口 |
| [orchestrator.ts](../../electron/orchestrator.ts) | 会议编排及命令入口 |
| [worker-scheduler.ts](../../electron/worker-scheduler.ts) | 既有任务调度器 |
| [task-collaboration.ts](../../electron/task-collaboration.ts) | 既有任务／执行／授权 Schema |
| [task-authority.ts](../../electron/task-authority.ts) | 计划与具体操作的授权 |
| [task-workspace.ts](../../electron/task-workspace.ts) | 工作区、基线和锁 |
| [meeting-repository.ts](../../electron/meeting-repository.ts) | 当前本地会议事件与快照 |
| [task-mailbox.ts](../../electron/task-mailbox.ts) | 当前本地任务消息及确认语义 |
| [meeting-store.ts](../../src/lib/meeting-store.ts) | renderer 会议恢复与投影 |
| [sessions.ts](../../electron/ipc/sessions.ts) | 多项目会议 IPC |
| [Start-AhaStation.cmd](../../Start-AhaStation.cmd) | 当前 Windows 源码启动入口，开发辅助工具 |

相邻 pocket-vibe-agent 仓库的重点文件，迁入公共基线前不能只依赖本文链接获取：

| 路径（相对于 pocket-vibe-agent） | 用途 |
| --- | --- |
| device/public_hub.py、device/hub_store.py | 公网 API、WSS、身份与 MySQL |
| device/protocol.py | 旧消息封装 |
| device/public_bridge.py、device/desktop_agent.py | Bridge 连接、反馈与会话目录 |
| device/project_policy.py | 已有目录授权边界 |
| device/task_journal.py、task_process.py、task_ownership.py | 持久化、进程执行及所有权 |
| device/codex_desktop.py、codex_shared*.py | Codex 发现、共享原生服务及接续 |
| device/session_runtime.py、runtime_entry.py、macos_task.py | 本机锁、入口与平台监管 |
| deploy/、requirements-public.txt | 当前 Hub 构建、配置和 schema v1 |
| scripts/package_hub.py | 白名单源码包导出和清单 |
| tests/ | 公网、会话、监管、恢复和平台测试 |

### 12.4 当前已有 API，及其限制

本表依据本地源码；本次没有验证部署实例与源码一致。

| API／入口 | 已有作用 | 新方案注意事项 |
| --- | --- | --- |
| GET /health、GET /ready | 服务存活、数据库就绪 | 不是共享会议通过验收的证据 |
| POST /v2/auth/register、login、recover；GET /v2/me | 协作身份 | 可复用；不等于设备已注册 |
| POST /v2/pairings、/v2/pairings/claim | 十分钟配对与设备凭证 | 旧兼容保留；增加登录后本机注册 |
| GET /v2/devices；设备删除／退出配对 | 设备清单和撤销 | 增加 Agent、接收和容量设置等元数据 |
| GET /v1/remote-sessions、/v1/agents | 已有原生会话与 Agent 目录 | 不是逻辑项目或共享会议目录 |
| POST /v1/turns | 向明确已有原生会话发送文本 | 要求 remote_target，不能直接承担新 Worker 分派 |
| GET /v1/turns/{id}、/v2/tasks、/v2/submissions/{key} | 任务与幂等查询 | 可复用语义，新的任务领域需要明确版本适配 |
| 任务／提交 cancel 接口 | 请求取消并跟踪退出 | 不可把请求成功等同于真实退出 |
| WSS /ws/desktop?provider=codex 或 claude | 每设备／provider 的 Bridge 连接 | 不接受任意新的 Station 会议消息 |
| GET /v2/version | 旧 protocol／Bridge 版本 | 当前不能准确证明线上是哪一个源码提交 |

旧消息封装包含 v、type、msg_id、task_id、seq、ack_of、ts、payload；v 是 pocket-vibe/0.1，而旧业务握手另检查 protocol=2。这是两个不同字段，不能混为一个数字随意升级。

新方案至少需要新增或明确扩展：Station 本机注册、设备配置／能力、项目与绑定摘要、会议创建／加入／快照／事件、通用设备通道，以及按 projectId 分派任务。API 路径和兼容规则由公共基础 PR 固定。

## 13. 代码、资料和环境怎样共享

### 13.1 建议统一到 Station 仓库

维护者将必要 Hub／兼容源码有来源记录地迁入，例如 services/remote/，初期保留原 Python 内部目录布局、部署脚本和测试，调整引用及打包路径。

这是后续工作，本文没有移动相邻仓库。不能只复制 public_hub.py 单文件，也不要把嵌套 .git、运行目录和安装包一起带入。

应保留：

- 现有本地会议、调度、权限、交付与 UI 的正确修改。
- 公网身份、设备隔离、任务幂等／取消／恢复和原生兼容的必要源码。
- 相关测试、脱敏 fixture、依赖锁定、部署与打包源配置。
- 有日期的测试摘要、失败名称、来源提交和必要文件哈希。

不应提交：

- 真实 .env、HUB_SECRET、MySQL／账号密码、访问令牌、恢复码、模型与 Git 凭证。
- 原生 auth.json、个人聊天／会话数据库、用户项目内容和数据库导出。
- runtime、原始私人日志、诊断包、依赖、缓存、dist／dist-electron 和发布安装包。
- 无关个人修改；不能为“整理”而覆盖／回滚原有用户代码。

目前 Station .gitignore 没有完整的通用 .env／私有配置保护。交付基线前需要补齐并检查已跟踪内容；忽略规则不能消除已经进 Git 的秘密。build/ 中有图标和权限声明等源素材，不能整目录误删或忽略。

### 13.2 新成员需要的资料

| 可共享 | 交接方式 |
| --- | --- |
| 仓库权限、基线分支／commit、启动测试说明 | GitHub |
| 本文、协议、Schema、样例和模拟实现 | GitHub |
| 已核实测试服务域名、协议及部署版本 | 文档／测试配置；地址本身不是密钥 |
| 测试协作账号或自注册方式、测试设备／仓库 | 凭证私下交接，仓库只放占位模板 |
| 本地 Hub 的隔离测试数据库使用说明 | 文档；实际本地配置不提交 |
| 微信云托管管理权限、生产 DB 密码、HUB_SECRET | 不需要交给新成员 |

测试账号与日常账号分开。账号隔离不能限制独占资源消耗；大多数开发使用本地 Hub／模拟服务，共用云端只做受控联调。

### 13.3 GitHub 协作节奏

1. 共同基线与公共契约先合入一个集成分支。
2. 新成员使用设备／项目功能分支，维护者使用会议／执行功能分支。
3. 以可审查的小 PR 依次合入，不等待两个巨型分支最后一次性合并。
4. 每个 PR 写明需求、接口／迁移、验证结果和未完成项。
5. Schema 变更先补共享样例与兼容测试；迁移文件按版本追加，不重写已部署 schema。
6. 集成分支完成最小闭环、异常和平台验收后，再合入 main。

建议分支名称为 codex/multi-device-integration、codex/device-management、codex/project-bindings、codex/shared-meetings、codex/remote-execution。它们只是命名建议，本次没有创建分支。

## 14. 微信云托管与数据库

### 14.1 已知信息与待核实信息

- 平台是微信云托管，服务名称为 ahastation-hub；不是需要 Station 使用微信 callContainer 的小程序通信方案。
- 用户此前已创建 station_hub，并反馈部署后的 health／ready 返回 ok:true。
- 当前资源配置 resources/remote-service.json 的 serviceUrl 仍为空；已有个人设置或环境变量可以覆盖，不代表历史上从未连接成功。
- 真实测试入口、线上源码版本、WSS 持续连接与发布重连条件，需要维护者从现有控制台重新核实。
- hub.ahastation.com 是期望的正式域名，尚无本次核实其已绑定的证据，不能作为默认可用地址。
- 数据库实际版本、权限和配额须按面板核对。旧文档／测试所用 MySQL 版本不等于实际部署版本，不能直接据此要求新建实例或升级。

### 14.2 是否需要重新配置

无需仅因“Bridge 集成到 Station”就重建云环境或现有数据库。需要部署支持新设备／项目／会议／任务协议的 Hub 代码，并执行经过审查的增量迁移。

新成员提交设备／项目的迁移和接口；维护者统一审查、备份、在测试环境应用、部署并验证。Navicat 仍只是管理数据库，Station 不直接连接它或 MySQL。

### 14.3 保留的重要运行条件

| 配置 | 当前源码／建议 |
| --- | --- |
| 容器监听 | 0.0.0.0:8787；平台端口必须匹配 |
| 客户端入口 | HTTPS／WSS 域名，通常由平台 443 入口转发，不在网址后随意添加 :8787 |
| 实例／worker | 当前连接路由在内存中，保持单实例、单 worker、单版本入口 |
| 数据库 | Hub 使用现有 MySQL，生产不退回 SQLite／容器本地文件 |
| 密钥 | 保持既有 HUB_SECRET，普通功能发布不轮换 |
| 环境变量 | MYSQL_HOST、MYSQL_PORT、MYSQL_DATABASE、MYSQL_USER、MYSQL_PASSWORD、HUB_SECRET；按平台配置保密 |
| 客户端默认地址 | 通过资源配置／构建配置提供，保留高级自托管覆盖能力 |
| 构建 | 可继续上传源码由云端 Docker 构建；新成员日常无需本机 Docker 才能做界面和契约 |

未来若要横向扩容，需要另做跨实例设备连接路由，不能仅把实例数调大。更换服务器时尽量保持固定域名、数据库和密钥，按维护／恢复流程迁移；本次不扩大到多活架构。

发布顺序：备份与迁移检查 → 部署兼容 Hub → health／ready → 客户端连接和重连 → 最小任务 → 再开放新功能。保留旧接口到兼容验收完成，不让新旧不兼容实例随机分流。

## 15. 当前验证结果与未解决事项

### 15.1 本文整理时新运行的检查

2026-10-20 在当前 Station 工作树执行：

~~~powershell
npm.cmd run typecheck
~~~

结果：renderer 和 Electron 两套 TypeScript 检查均通过，退出码 0。

本次还检查了两个仓库的 status／HEAD、相关源码和历史测试记录。没有重新运行全量 Node／Python 测试、构建安装包、启动模型或连接线上 Hub；仅凭类型检查不能确认运行时功能完整。

### 15.2 有日期的历史证据

| 记录 | 结果 | 能说明的范围 |
| --- | --- | --- |
| Station 2026-10-13 恢复后续复核 | 定向 27 项通过；全量 937：892 通过、40 失败、5 跳过 | 恢复相关回归和当时全量失败基线；不是全部通过 |
| 同轮构建／类型检查 | renderer／Electron 类型与构建通过 | 当时源码可编译，不能证明 GUI 全链路 |
| Python Windows 最新同日复核 | 110：91 通过、1 失败、18 跳过 | 当前历史基线仍有状态优先级失败 |
| Python WSL Ubuntu 同日记录 | 110：93 通过、17 跳过、0 失败 | Linux／WSL 测试范围，不能替代 macOS 或桌面 GUI |
| Codex 共享执行历史证据 | 协议测试和部分 Windows 原生 RPC／模型／停止证据 | 不能等同于 Desktop GUI ↔ Station GUI 全面验收 |

Station 全量历史运行使用 --test-force-exit；这不证明已解决全部测试资源退出问题。40 个失败包含观察／平台解析、部分后端、权限与会议流程，具体名称见原 JSON。

本次核对该复核记录中的六个文件哈希均与当前文件一致：host-group.ts、orchestrator.ts、src/types.ts、meeting-store.ts、meeting-restore.test.mjs、meeting-host-lifecycle.test.mjs。这个结果只证明这些文件未变化，不代表整个依赖与执行环境完全相同。

相关原始说明：

- [会议恢复与独立启动](../MEETING_RESTORE_AND_WINDOWS_LAUNCH.md)
- [恢复后续验证 JSON](../MEETING_RESTORE_FOLLOWUP_2026-10-13.json)
- [首轮恢复基线 JSON](../MEETING_RESTORE_LAUNCH_BASELINE_2026-10-13.json)
- 相邻仓库 docs/SHARED_DESKTOP_ACCEPTANCE.md

### 15.3 必须带入交接的问题

- Station 既有 40 项失败需要在新成员环境复现／分类；不能默认全部可忽略。
- Windows Python 的 test_other_bridge_live_lock_and_current_task_state_priority 历史记录失败，cleanup-unconfirmed 与 waiting 不符，未在本次解决。
- 用户跨电脑测试曾出现原生桌面“完全访问”高于 Bridge workspace-write 上限；正确处理是明确核验／授权，不能自动提升。
- 用户还遇到项目在授权根目录之外。目录显示相同不代表全部实际工作路径／额外可写目录／符号链接都已授权，具体根因未收到充分新证据。
- 真正桌面完成／停止后的 GUI 接续、GUI 两端同时提交、断联恢复和原生服务换代仍需验收。
- 新 Station 接收链路、共享项目、共享会议、远端 Worker 和 PR 闭环尚未完成。
- 云端部署版本与本地源码对应关系、当前 WSS 路径／心跳／重启限制未在本次验证。

## 16. 新成员本地开发起步

维护者先完成完整源码基线，不能要求新成员靠当前 HEAD 猜测缺失文件。

### 16.1 Station

CI 使用 Node.js 22；现有启动脚本要求 22 或更新版本。本次检查环境 Node 为 v24.22.0。建议团队先统一到与 CI 一致的受支持版本，版本差异记录在基线。

在 Station 仓库根目录：

~~~powershell
npm.cmd ci
npm.cmd run typecheck
npm.cmd run build
~~~

Windows 日常启动可使用 Start-AhaStation.cmd；它会构建并打开 GUI，不把“启动脚本退出”当作应用关闭。已有运行实例和单实例锁需要按启动文档处理，不能为排查而任意终止用户任务。

开发热更新需要两个终端：第一个运行 npm.cmd run dev，启动 Vite；第二个运行 npm.cmd run dev:electron，构建并启动连接该 Vite 的 Electron。dev:electron 本身不会启动 Vite；仅运行 dev 也不代表完整 Electron 主进程已经启动。macOS／Linux 使用 npm 而非 Windows 的 npm.cmd。

### 16.2 Hub 与测试

目前 Hub 位于相邻 pocket-vibe-agent。迁入后保持说明中的相对路径一致，避免把本机 C:\aha 路径写成所有人的要求。

可按 requirements-public.txt 建立隔离 Python 环境；当前 Dockerfile 使用 Python 3.13.5。生产入口 device/public_hub.py 要求有效 MySQL 配置和 HUB_SECRET，不能空配置运行后把报错当网络问题。

界面／契约开发先用 MockHub；API 和迁移开发要用本地／CI 隔离测试数据库，不向新成员提供生产库密码。旧注入式 SQLite fixture 可做逻辑测试，但不能替代真实 MySQL 验收。

当前 Python 测试命令：

~~~powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
~~~

可选原生 MySQL 测试读取 HUB_TEST_MYSQL_URL，只允许专用、初始为空的 station_hub_test* 库及非 root 账号；测试会删除自己创建的表。不得指向 station_hub 或其他业务库，未配置时跳过也不能宣称 MySQL 已验收。

Station 全量测试：

~~~powershell
npm.cmd test
~~~

涉及本地 Bridge fixture 时按测试说明配置 POCKET_VIBE_TEST_PYTHON，指向自己的隔离环境。记录真实执行、跳过和失败；不要只复制历史数字。

本文不是新的启动脚本；公共基础 PR 还应补一个新成员可直接运行的 MockHub 和最小消息往返命令，并验证干净环境可用。

## 17. 分阶段交付与每阶段验收

| 阶段 | 新成员 | 维护者 | 共同通过条件 |
| --- | --- | --- | --- |
| P0 公共基础 | 跑基线、确认契约、模拟设备／项目和契约测试 | 整理源码、通信、测试配置和版本 | 干净克隆可运行；协议样例一致；最小消息往返 |
| P1 设备 | 注册、设置、Agent 能力、在线状态与设备 API | 用模拟设备开发共享会议／调度；审查设备迁移 | A 能识别 B；暂停／离线／重连状态正确 |
| P2 项目 | 共享项目、本地绑定、权限核验与项目 API | 接入核验并准备任务工作区；继续会议逻辑 | 两个不同目录绑定同项目，拒绝越界／错仓库 |
| P3 最小闭环 | 提供真实设备／绑定与 UI 接入 | 一场会议＋手动分配＋一个真实远端任务 | B 执行测试文件修改，A 收到真实结果 |
| P4 完整执行 | 设置变更、状态提示、边界回归 | 自动分配、并发、依赖、停止／恢复与原生兼容 | 不重复运行、不误停、不跨会议回传 |
| P5 交付验收 | 安装包接入、平台和体验修复 | GitHub PR／依赖交付、部署和集成 | 跨网络／平台流程与 GitHub 人工合并通过 |

这些阶段是验收顺序，不是人员等待顺序。P1／P2 期间，维护者可以用契约模拟实现开发 P3／P4。

## 18. 回归与端到端验收清单

### 18.1 设备与项目

- [ ] 注册、重启、改名后 deviceId 稳定；重复连接不会造成在线状态倒退。
- [ ] 同账号可见，跨账号不可查询／控制；凭证撤销后拒绝新任务。
- [ ] Agent 不可用、暂停接收、容量已满均显示明确原因。
- [ ] 相同项目支持不同 Windows／Linux／macOS 路径；SSH／HTTPS 仓库地址正规化。
- [ ] 错仓库、子目录越界、符号链接／junction 越界、未授权 worktree 被拒绝。
- [ ] 授权修改后，已缓存的 Hub 可用状态不能绕过本机新限制。
- [ ] 原生会话权限高于本机上限时拒绝，不能静默放宽。

### 18.2 会议与任务

- [ ] 两台 Station 显示同一会议；聊天、计划、任务和结果一致。
- [ ] 参与设备不会重复启动 Host 或独立调度相同任务。
- [ ] 手动指定目标准确；自动分配只使用具备项目与能力的设备。
- [ ] 接收端原子检查容量；重复消息、重连和进程重启不重复执行。
- [ ] 旧任务结果按原 meetingId／projectId／attemptId 归档，不覆盖当前页面。
- [ ] 停止后有实际退出证据；未确认不标取消成功、不释放为可重派。
- [ ] 断网不等于取消，重连先核对；协调设备离线不会自动产生第二个调度者。
- [ ] 已结束会议恢复不永久卡“启动中”；多项目迟到回复不切错会议。

### 18.3 原生会话与 GitHub

- [ ] Codex 桌面完成／停止后，Station 能在同一原生会话继续。
- [ ] 两端接近同时发送会排队，不能出现 active writer 冲突后偷偷另开会话。
- [ ] 只停止 Station 自己拥有的 turn，不误停其他桌面任务。
- [ ] 指定 baseCommit、独立任务分支、提交／检查／PR 信息准确。
- [ ] PR 未合并不会被当作代码已集成；依赖任务使用已核实的新提交。
- [ ] Git 凭证、模型登录和本地路径不会出现在不必要的共享数据中。

### 18.4 运行与平台

- [ ] 不同局域网／移动热点真实连通，不只测试同机。
- [ ] Hub 发布断连、电脑睡眠／恢复、网络切换、应用重启后可核对状态。
- [ ] Windows、Linux 和 macOS 分别做原生验证；Linux ARM64 另验安装包与所需辅助组件。
- [ ] 本地会议、语音转文本、设置刷新、邀请、目录选择和关闭／停止生命周期回归。
- [ ] 核对 CPU、内存、流量、数据库连接和重试速率；测试账号没有造成无限请求。

## 19. 当前还要确认的实现决策

产品方向和分工已经确定，以下属于公共基础 PR 的技术收口，维护者牵头、新成员共同确认：

| 项目 | 建议第一版做法 |
| --- | --- |
| 共享仓库 | Station 仓库内纳入必要 Hub／兼容源码，记录来源，不夹带嵌套 Git |
| 新通道 | 为 Station 设备增加明确版本的通道，旧 Bridge 接口保留 |
| 注册流程 | 同账号登录后注册本机并取得设备范围凭证，不强制日常跨端配对 |
| 权限模型 | 项目本机上限与任务／Agent 原生限制取交集，兼容旧策略但不扩权 |
| 协调者 | 创建会议时确定唯一设备，首版不可用时暂停新调度 |
| 自动模式 | 已确认项目和接收设置后可自动接单，不要求每个任务再点一次接受 |
| GitHub 验收 | 人工审查／合并，协调者核实提交后放行代码依赖 |
| 正式地址 | 维护者验证并配置固定入口；不把空值／期望域名写成已连通 |
| 测试门禁 | 新增功能测试必须通过；既有失败逐项记录，不用大范围豁免隐藏回归 |

完成这个技术收口后，就可以分别实现设备／项目和会议／执行。新成员不必先获得微信云托管权限，也不必等所有会议功能落地。

## 20. 文档交付状态

本文和 NEW_MEMBER_MESSAGE.md 是本次新增的交接材料，可供双方沟通和后续公共基础 PR 使用。

本次已完成：源码与 Git 状态核对、历史证据区分、当前两端类型检查、需求／方案／责任／契约草案／验收整理。

本次未执行：源码迁移、契约生产实现、业务修改、全量回归、实际云端核验／部署、创建分支／提交／PR／推送。公共基础 PR 及新产品功能仍需按上述清单实现和验证。
