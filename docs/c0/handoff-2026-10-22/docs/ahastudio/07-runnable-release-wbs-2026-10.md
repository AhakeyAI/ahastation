# AhaStudio 可运行版本 WBS

日期：2026-10-04。配套 [开发计划](./06-runnable-release-plan-2026-10.md)。本表是建议排期，所有条目为待开发或核验；代码已有资产不等于整项已验收。可导入表格或任务系统的 [CSV](./07-runnable-release-wbs-2026-10.csv) 与本表内容一致。

2026-10-19 复核：51 项、226 基准人日、依赖无环、Markdown/CSV 内容逐项一致。工作包估算和状态保持不变。R1 的 3 名开发加半职 QA 排程示例为 88 工作日，含 25% 预留约 22 周；参见 [开工安排与验收证据](./08-r1-execution-readiness-2026-10-19.md) 及 [机器可读校验记录](./evidence/2026-10-19-wbs-audit.json)。

每项人日包含设计、实现、必要测试、评审与说明，按有效工程人日估算，不按 Agent 工作时长计价。需求不变且可复用现有资产的基准估算；预算建议另加 25% 预留。角色是责任分工，尚未分配到具体人员。Core 负责任务与持久化，Runtime 负责 Harness、授权和语音，Desktop 负责交互，QA 负责构建与验收，Device 负责设备服务。前置依赖全部满足后工作包才能验收。

## R1 完整本地软件

35 个工作包，基准 132 人日，含 25% 预留约 165 人日。

| ID | 门 | 工作包和接入点 | 责任 | 人日 | 前置 | 完成标准 |
| --- | --- | --- | --- | ---: | --- | --- |
| B01 | G0 | **确认主程序基线和保留未提交资产**<br>package.json / git worktrees | Core | 2 | 无 | 记录源 SHA 和锁文件；在干净检出可重复安装；不丢失用户改动 |
| B02 | G0 | **修复能力门与计划路由回归**<br>registry / plan-validation / backend-capability-gates | Runtime | 3 | B01 | 未知或不满足能力的 backend 被拒绝；不静默改派；相关失败按已确认规格修复 |
| B03 | G0 | **修复调度授权与多后端纵切回归**<br>worker-scheduler / task-authority / collaboration-vertical-slice | Runtime | 5 | B02 | profile 和授权先持久化后 spawn；多后端流程通过；禁止仅删断言或跳过测试 |
| B04 | G0 | **补齐测试样本和可复现 CI**<br>tests/fixtures / build-matrix | QA | 2 | B01 | Kimi 两份日志入版本管理或运行时生成；干净检出与本地测试结果一致 |
| T01 | G1 | **定义全局任务身份和版本契约**<br>task-collaboration / task-projection | Core | 3 | B01 | Task 独立于 meeting；Session Run 与 Task 可多对一关联；Charter 和合同有版本与 hash |
| T02 | G1 | **建立任务索引与兼容迁移**<br>meeting-repository / task-recovery | Core | 4 | T01,B03 | 迁移可回滚；旧 journal 保留；重启可恢复任务及关联；重复事件不重复创建任务 |
| T03 | G1 | **会话归并规则与可撤销关联**<br>observe/correlate / observed-store | Core | 4 | T02 | 高置信度关联保留依据；同 cwd 不等于同任务；中置信度建议；跨项目确认；可拆分撤销 |
| T04 | G1 | **加固发现引导和连接器能力矩阵**<br>observe-service / Onboarding / BackendSettings | Desktop | 3 | T01,B04 | 有样本时首屏 P95 不超过 5 秒；无会话有明确空态；每项能力显示版本和证据等级 |
| T05 | G1 | **统一任务详情和全局任务板**<br>TasksView / TaskInspector / meeting-store | Desktop | 4 | T02,T03,T04 | 观察与受控任务可区分；历史完成不伪装 accepted；项目仅作筛选；多表面版本一致 |
| C01 | G2 | **只读调查服务与结构化输入**<br>task-intent / task-context / backends | Core | 3 | T01,B02 | 未确认 Charter 不启动写 Worker；调查仅使用可执行只读边界；引用可追溯 |
| C02 | G2 | **Charter 草拟澄清与确认界面**<br>PlanMeetingModal / plan-validation | Desktop | 4 | C01,T05 | 结果范围非目标预算停止条件验收项齐全；通常逐个询问且不超过三个阻塞问题；确认精确版本 |
| C03 | G2 | **Charter 编译为计划与任务授权**<br>task-authority / task-profile / permission-broker | Runtime | 4 | C02,T02,B03 | 确认记录先落盘；绑定 task charterHash grantHash attempt；旧版本确认被拒；新范围重新授权 |
| C04 | G2 | **全局 Host 与注意力所有权**<br>host-group / orchestrator / cross-host-bus | Core | 5 | T02,C03 | 一个用户注意力入口可协调两项目；专家保留内部角色；Worker 无直接发布用户决策权限 |
| R01 | G2 | **Codex 原生执行路径验收**<br>codex-adapter / app-server transport | Runtime | 4 | C03,B03 | 固定实测版本通过 start steer interrupt resume permission usage evidence；不支持项明确降级 |
| R02 | G2 | **Claude 原生执行路径验收**<br>claude-code-adapter / claude-cli | Runtime | 4 | C03,B03 | 与 Codex 相同契约和错误语义；真实烟测证据绑定版本；不以 mocked tests 标 stable |
| R03 | G2 | **外部会话接续与 Connector 安装撤销**<br>observe/session-actions / preload / connectors 新模块 | Runtime | 5 | T03,R01,R02 | 装前可看配置 Diff；卸载恢复原配置；外部不可 resume 时创建 Continuation Run；TTY 输入不当权限证明 |
| R04 | G2 | **运行中停止恢复与并发工作区**<br>task-workspace / task-recovery / worker-scheduler | Runtime | 3 | R01,R02,T02 | 两个任务隔离执行；脏目录变更不丢失；停止进程树；重启不擅自继续写入 |
| D01 | G3 | **持久化决策与 Concern 审计**<br>task-mailbox / decisions / decision-repository 新模块 | Core | 4 | T02,C04 | 问题例外批准验收进入统一 Decision；Concern 原文不可变；去重可追溯；重启待决策不丢失 |
| D02 | G3 | **统一主进程授权和风险判定**<br>permission-broker / approval-gesture / risk-classify | Runtime | 4 | D01,C03 | 主进程判定权威；UI 与 AhaBar 同结果；中高风险快捷 IPC 不能绕过；超时不批准 |
| D03 | G3 | **Decision Inbox 和 AhaBar 排序交互**<br>TaskMailboxPanel / AhaBar / companion-feed | Desktop | 4 | D01,D02,T05 | 全局待决策列表；只突出最高优先项；低风险单按中风险按住高风险详情；完成后所有表面撤卡 |
| D04 | G3 | **Attention Policy 与升级调度**<br>decisions / attention-policy 新模块 | Core | 3 | D03 | 工作时段静默期合并限频生效；仅用户启用的日历提醒可创建；到期不改变批准状态 |
| D05 | G3 | **任务级预算与运行时熔断**<br>task-budget / worker-scheduler | Runtime | 4 | C03,R04,D01 | 有限默认值；时间含执行验证排队及重试；Token 未知显示预留；达到任一上限停新派发并处理活动进程 |
| V01 | G4 | **版本化验收合同与检查权限**<br>worker-protocol / delivery-harness | Core | 4 | C03,D02 | 检查 argv 环境权限来源可信；合同冻结绑定 candidate；改验收项必须新版本新 loop；Worker 不能改判分规则 |
| V02 | G4 | **独立证据和确定性验证执行**<br>delivery-verifier / delivery-snapshot | Runtime | 4 | V01,R04 | 在冻结 revision 上检查；命令退出超时日志 hash 可复现；manual pending 与 pass 分开；测试脚本变化可见 |
| V03 | G4 | **有界自治与验证冲突升级**<br>delivery-harness / coordinator-review-driver | Runtime | 4 | V02,D05,D01 | 普通任务默认先交付再询问验证；明确授权才自动循环；达标停；非收敛和实质冲突进入 Decision |
| V04 | G4 | **用户验收返工与安全集成**<br>DeliveryViewer / delivery-integrator / meeting-delivery | Desktop | 4 | V02,D03 | 产物 Diff 证据遗留风险可读；接受不暗含 push；返工保留历史；集成失败不标 accepted |
| A01 | G5 | **语音 provider 和本地识别路径**<br>ipc/asr / asr/xfyun-iat / useAsr | Runtime | 5 | B01 | 本地中文可用；保留讯飞自有凭据；模型下载校验可重试；离线不静默送云；撤销麦克风有文字回退 |
| A02 | G5 | **语音整理词库与任务确认**<br>asr-polish / speech-session / task-intent | Desktop | 3 | A01,C02 | 原文整理文可对照；否定和预算不被改写；专业词库；语音目标进入同一 Charter 确认流程 |
| A03 | G5 | **会议决定形成任务变更**<br>meeting-tools / task-context / orchestrator | Core | 4 | A02,C04,D01 | 输出新增任务既有任务变更未决问题；依据带时间片段；变更 Charter 需确认；会议断线保留结果 |
| U01 | G6 | **用量展示与有效交付指标**<br>backend events / usage-ledger 新模块 | Core | 3 | D05,V04 | 实测估算未知分开；不把 Token 当订阅额度余额；本地记录交付数打断数耗时；私有数据分享显式 opt-in |
| U02 | G6 | **凭据诊断和日志导出**<br>store / format-error / diagnostic-logger | Runtime | 3 | R01,R02,A01 | Key 使用 OS 安全存储及迁移；导出脱敏；错误有恢复指引；历史敏感日志清理有策略 |
| P01 | G6 | **统一 AhaStudio 安装和升级迁移**<br>electron-builder / update-check / preload | Desktop | 3 | B01,T02 | 一个软件安装入口；旧 appId 和数据迁移经验证；设置占位与真实能力一致；离线本地核心无订阅锁 |
| P02 | G6 | **安装包依赖闭包签名与公证**<br>build-matrix / verify-macos-signing / packaging | QA | 4 | P01,A01,U02 | DMG 在非开发机正常启动；签名公证权限通过；无绝对开发路径；第三方 NOTICE 完整 |
| P03 | G6 | **真实端到端和故障注入验收**<br>tests / real-worker-stability-smoke / 新 E2E | QA | 5 | T05,R03,R04,D04,V03,V04,A03,U01,P02 | Codex Claude 各十个样例含两项目并行；断网退出重启旧批准重放等场景通过；保存可复现实测证据 |
| P04 | G6 | **外测修复和可复现发布样例**<br>README / release notes / sample recipes | Desktop | 5 | P03 | 5 至 10 名外测用户；阻塞缺陷清零；三分钟动线；能独立安装复现；开源发布前资产权属逐项确认 |

## R1H AhaKey 首发联动

3 个工作包，基准 11 人日，含 25% 预留约 14 人日。

| ID | 门 | 工作包和接入点 | 责任 | 人日 | 前置 | 完成标准 |
| --- | --- | --- | --- | ---: | --- | --- |
| H01 | GH | **冻结设备服务 IPC 和设备能力**<br>Swift BLE / AhaKeyProtocol / 新本地设备服务 | Device | 3 | T01,D02 | 协议版本协商；一个进程拥有 BLE；硬件事件关联 Decision 及版本；模拟设备可回放 |
| H02 | GH | **统一安装中的硬件配置界面**<br>Swift Views / Electron Settings | Desktop | 4 | H01,P01 | 配对键位宏 OLED 灯效可配置；原用户配置可迁移；无设备不阻断任务闭环 |
| H03 | GH | **物理批准状态反馈与断连恢复**<br>BLE manager / companion-feed | Device | 4 | H01,D03,H02 | 旧灯效不能批准新动作；高风险按键只打开详情；断连降级 AhaBar；语音开工批准验收现场实测 |

## R2 移动与 IM

4 个工作包，基准 17 人日，含 25% 预留约 22 人日。

| ID | 门 | 工作包和接入点 | 责任 | 人日 | 前置 | 完成标准 |
| --- | --- | --- | --- | ---: | --- | --- |
| M01 | GM | **可信 Decision Link 与身份配对**<br>新 decision-link / trusted-surface 模块 | Core | 5 | D01,D02,P04 | 打开不批准；过期撤销防重放；动作绑定身份设备 task requestHash；不在 URL 放凭据 |
| M02 | GM | **移动网页决策语音和停止**<br>新 mobile surface / 本地主机 API | Desktop | 5 | M01 | 展示证据；语音补充和停止返回确认结果；只允许配对身份批准低风险单一动作；断网不伪装成功 |
| M03 | GM | **IM 适配和通知投递**<br>新 IM connector | Runtime | 4 | M01,D04 | 第一家 IM 深链收件可验证；幂等限频；文本收到不等于批准；中高风险回可信桌面 |
| M04 | GM | **跨表面竞争决策故障验收**<br>新 mobile/IM E2E | QA | 3 | M02,M03 | 两端同时回复一次生效；超时撤销重启 token 泄露场景通过；批准来源审计完整 |

## R3 同步交接与平台扩展

5 个工作包，基准 32 人日，含 25% 预留约 40 人日。

| ID | 门 | 工作包和接入点 | 责任 | 人日 | 前置 | 完成标准 |
| --- | --- | --- | --- | ---: | --- | --- |
| S01 | GS | **加密检查点与 Handoff Bundle**<br>新 sync-vault / handoff 模块 | Core | 6 | T02,V02,P04 | 只写 managed checkpoint；不推用户分支；Bundle 无 Key；冲突先展示 Diff |
| S02 | GS | **Trusted Device 和 Recovery Kit**<br>新 pairing / encryption 模块 | Runtime | 6 | S01 | 配对要现有可信设备确认；撤销与恢复实测；加密格式版本化；密钥不进入 Git |
| S03 | GS | **Execution Lease 与授权交接**<br>新 lease / handoff 模块 | Core | 6 | S02,R04 | 网络分区不双写；接收方继续前验证 lease 源 revision Charter；迁移不了原会话标 Continuation Run |
| S04 | GS | **双机同步恢复验收**<br>新 sync E2E | QA | 4 | S03 | 两台真机手动交接；丢设备恢复；冲突断网重复交接不丢数据；社区版可自托管 |
| S05 | GS | **Windows Linux 核心闭环适配**<br>observe/process / packaging / credential store | Runtime | 10 | P04,T04 | 按 OS 实测能力矩阵；原生安装包走 R1 同套闭环；未实测平台不标正式支持 |

## R4 生态托管服务与 AhaStation

4 个工作包，基准 34 人日，含 25% 预留约 43 人日。

| ID | 门 | 工作包和接入点 | 责任 | 人日 | 前置 | 完成标准 |
| --- | --- | --- | --- | ---: | --- | --- |
| E01 | GE | **Work Recipe Verifier 和贡献规范**<br>新 catalog / recipe schemas | Core | 5 | V01,U01,P04 | Recipe 含验收和证据；Verifier 无执行所有权；安装权限可见；公共样例不携带私有数据 |
| E02 | GE | **AhaTalk Cloud 中继和计费界面**<br>新 hosted APIs / billing / relay | Runtime | 12 | A02,M04,S04 | 本地和 BYOK 始终可用；服务失败明确降级；充值不自动扣款；收入服务与开源本地能力边界清楚 |
| E03 | GE | **托管服务运营与安全验收**<br>service monitoring / account recovery | QA | 5 | E02 | 超额断流可控；隐私删除及数据保留策略落地；告警成本响应有负责人；付费路径端到端 |
| E04 | GE | **AhaStation 主机验证和设备发布**<br>RK3588 docs / platform devices | Device | 12 | S04,H03,S05 | 选定硬件 BOM 后单独验证麦克风电源热管理按键屏幕交接；不以现有掌机 UI 宣称硬件完成 |

## 任务执行和变更规则

1. 开工时把工作包展开为实施卡，写明实际 owner、基线 SHA、输入输出、依赖、验收命令和风险；每项可分成 0.5 至 2 人日的实施子任务，但验收仍按整项闭环进行。
2. 每个工作包交付一个可运行切片、证据及必要文档；需要设计评审的契约先冻结。已有模块修复优先，目录抽取和命名扫尾不得先于可运行结果。
3. 只在新行为、回归或明确未覆盖的风险上补有意义测试；fixture 或快照与断言改变必须有行为依据。真实模型烟测使用显式预算，不进入每次 PR 的付费默认路径。
4. 每周复核实际人日、阻塞和验收结果；超过基准 30% 的条目拆解原因并更新依赖。调整首发范围需同步修改开发计划和演示承诺。
5. R1 的 P04 不依赖硬件和托管服务；首发若宣传 AhaKey 联动，H03 必须同时验收。R4 不是 R1 的发布前置条件，也不意味着可在本轮一次交付所有硬件和商业服务。
