# AhaStation collaboration.4 稳定性修复交付

版本 **0.19.0-collaboration.4 / Windows x64**，分支 etrnal-dev，基底 b0cd16d1b7c4f9c91f9135ea163a7532ce1f2a1b。增量工作只在 C:/Users/79142/.codex/worktrees/collaboration-baseline-upload/station-ctrl 候选工作树进行；原 C:/aha/ahastation/station-ctrl 和 .3 冻结交付保留。没有 Git 提交／推送、生产部署／迁移或覆盖用户安装。用户 electron/main.ts 与开始时 SHA256 完全相同；.3 清单中的 34 个交付文件重新核对全部未变。

本报告在最终复跑后冻结。完整 Node 最终结果：**1095 项：1056 通过、34 既有失败、5 跳过；新增失败 0，失败名、错误码与规范化测试临时目录后的断言／错误原因均与基线一致**。

## 修改与边界

| 范围 | 最终行为与主要来源 |
| --- | --- |
| F1 / Q105 | station-service.ts 按真实 Host／设备＋Agent 的会议交流上下文判断等待，hostMessages 的旧存储名称不再代表会议互斥；活跃执行拥有独立生命周期标记，finally 释放调度预约，孤立旧标记不能阻止恢复。准备状态先持久化，授权、适配器、目录、输入、状态发布和真实调用边界均在失败处理内；未启动为 failed/notStarted，未知为 reconcile。发送前再检查停止和撤权。失败及待核对在原输入展示，专家重试同步 Hub 校验并保留目标、附件和会议背景，不能退给 Host。恢复专家原线程不再写进 Host 线程；咨询结果、回复和原 Host 控制使用稳定请求身份。普通任务／工具审批继续，原生唯一写入者和实际退出证明保持 |
| F2 / Q102–Q103 | SideDrawer.tsx 在首个 await 前同步防重入，正文、稳定 @、关联任务和附件固定为一次提交。成功仅清理对应输入版本及原附件 ID，新文字／点名／附件保留。UnifiedMeetingFrame.tsx 在异步附件发布前核对目标，沿用原提交身份。unified-meeting-store.ts、Station 持久 outbox 和 Hub 请求记录贯穿同一 requestId，Hub 消息记录其 submissionId；相同 ID 不可更换内容。结果未知显示待核对，恢复／补投原命令，模型未知不盲重跑。已确认立即释放发送，不等模型完成；明确再发同正文可用新 ID。未增加会议／账号发送锁 |
| F3 / Q104、Q106–Q107 | PlanMeetingModal.tsx 在原窗口保留审阅依据、当前编辑与提交版本。缓存仅在 Renderer 内存，按服务／账号／设备／会议隔离；关闭／切会保留，重启不恢复未批准编辑。关闭查看、放弃本机修改、服务器拒绝分开，无额外保存流程。相同快照、心跳、改名和进度不重置、不冲突；真正计划变更保留编辑，展示新版，由用户明确载入或核对后应用自己的字段变更，按稳定任务 ID 对齐，不套到其他任务。最新已分发字段只读，编辑期间派发则阻止旧编辑提交并提供还原；成功批准／拒绝回调只清理其对应的编辑版本，等待回应期间继续修改的内容仍保留。查看／编辑不暂停已有工作或改变自动批准开关 |
| 双向计划写入保护 | Hub planVersion 仅随计划内容／安排实际变化；相同内容／安排的 Host 再提案保留已有批准；planDecisionVersion 独立记录批准决定，阻止批准前已开始的迟到 Host 结果覆盖刚批准的安排。人工 review/decide 依据计划内容版本，不把通用 meeting.revision 当计划变更。Host 在输入开始前持久化原版本依据；正常回调及恢复均提交原依据，冲突保留回复并说明提案未应用。旧恢复轮次缺少依据不能补上最新版本。服务端继续核验已分发字段、原批准目标、准确基线和权限 |

其他生产文件：production-types.ts、connection.ts、unified-host.ts、CollaborationPanel.tsx、v2.schema.json、collaboration_store.py、collaboration_routes.py。旧面板计划入口也携带明确版本。新增正式回归为 tests/collaboration-stability.test.mjs、collaboration-stability-ui.test.mjs 和 services/remote/tests/test_collaboration_stability.py；保留原 R1–R4 断言，并将原集成夹具的计划写入更新到新版本契约。dev-unified-fixture.ts 仅供 Vite DEV 交互验证，生产包不含夹具入口。

没有新增草稿中心、会议全局锁、跨电脑／应用重启的未批准编辑恢复、隐藏计划预留或暂停／取消体系。未降低目录、名额、工具权限、原生退出和固定 SHA 规则。普通文字仍无需 GitHub。

## Hub、MySQL 与升级

需要匹配 .4 Hub，特性 unified-stability-v1。schema=2 的 station_hub **无需新增 DDL**；继续使用原 LONGTEXT 实体和请求／事件表。原账号、密钥、密码、设备、凭据、授权、会议、任务与历史保持，Station 不直连数据库。

旧实体版本缺省为 0。原 original-orchestrator 会议或已启用新保护的计划拒绝无版本写入（426）；旧幂等成功请求仍返回原收据。普通旧协议及原 Bridge／原生接口保留，未知执行留原设备核对。先备份数据库、非公开配置与设备原记录，再升级 Hub 和相关 Station；不清库、不轮换 HUB_SECRET、不要求全部重新注册。完整操作、旧输出处理和回退见随包 COLLABORATION_4_UPGRADE.md。MySQL 5.7 旧 schema=1 的已有升级材料仍随包提供，不应对 schema=2 误作新增迁移。

## 验证与真实范围

修改前五项正式正确行为回归在 .3 上全部失败，原日志 pre-fix-regression.log 保留；不是把复现错误算作通过。同条件新基线重新运行 1069 项：1030 通过、34 失败、5 跳过。

| 验证 | 结果／证据 |
| --- | --- |
| Renderer 和 Electron 两侧类型检查、生产构建 | 通过；typecheck-final.log、build-final.log。保留 Vite 大 chunk 提示 |
| 本轮 F1–F3 回归 | 26 项，含 13 项实际 React／隔离 Chrome 交互、13 项执行恢复／生产 HTTP/WSS 与持久 Station 场景；最终计入完整 Node 日志。附件、Enter、相同正文新发、未知提交、真实计划变更、关窗切会、已派发限制均断言可见行为 |
| 新 Hub / 原 Hub / 统一协议 | 新稳定性 13、原 R1–R4 12、统一协议 16 项通过；各套包含继承的旧协议测试，数量不视为互不重复的场景。真实回环 HTTP/WSS、独立 SQLite，非生产 |
| Guardian 与原生兼容 | Guardian 13、原生兼容 33、导出 4、契约路径 5、基础契约 4 项通过；原生实际进程、未知启动与原子封存、退出及 Windows 锁回归继续通过 |
| 实际 Codex | 原 Orchestrator Host→明确批准→固定目标 Worker→正文交付＋独立专家讨论通过；独立离线核验确认实际正文、收据 finalSummary 和两端成果逐字一致、textOnly 和独立线程。非双物理电脑／公网／真实 GitHub 验收 |
| MySQL 5.7 | MySQL 5.7.18 独立库通过：稳定性 13、原 R1–R4 12、统一协议 16、旧协议 8、Station 7；旧数据／凭据保留、SQL 幂等、未知版本不覆盖及仅 DML 运行账号通过 |
| 完整 Node 与失败比较 | 1095 项：1056 通过、34 既有失败、5 跳过；新增失败 0，失败名、错误码与规范化测试临时目录后的断言／错误原因均与基线一致；失败逐项及原因见 verification/REGRESSION_FAILURES.md、baseline-comparison.json 和原始日志，不称全量通过 |
| NSIS 与实际载荷 | 构建通过。实际解包 303 文件（7-Zip 一个 overlay 提示，退出 0），exe、asar、helper 与构建匹配；248 个编译文件逐字匹配。实际载荷两个隔离 Windows 进程完成启动、Renderer、OS 加密凭据及重启身份／WSS 恢复。安装器 NotSigned；没有覆盖用户安装 |
| Hub 部署 ZIP | 35 文件清单／Unix 模式、28 个固定依赖、Docker COPY 来源及导出生产 app 的 lifespan、health/ready 通过；未实际构建 Docker 镜像 |
| 来源与保留 | 604 个实现／测试／脚本文件冻结；首轮到第二轮只修两个测试夹具，随后补审修复计划回应期间的后续编辑保留并重新构建最终载荷。最终源码包包括未跟踪实现，清单核对、来源一致及 .3 保留证明随交付 |

首轮完整运行 1094 项：1053 通过、36 失败、5 跳过。两个新增失败未归作既有失败：原 R1–R4 集成夹具未携带计划版本，被 Hub 正确拒绝；首次 Vite 页面等待所有资源 load 超过 30 秒，尚未进入发送断言。夹具已增加“无依据写入必须拒绝”的断言，再以实际版本完成原准确基线链路；UI 改用专属端口并等待 DOM／真实 React 入口，不依赖全资源 load。行为断言保留，第二次完整复跑为 1094／1055 通过／34 既有失败／5 跳过。补审实际 React 又发现计划回应期间新编辑会被回调删除，已先用断言正确行为的单项回归暴露失败，再按提交版本清理修复并重建；再补一项真实 Hub 的相同提案回归：修复前内容版本相同却撤销批准；修复后保留已有批准，真实变化仍等待批准，人工明确拒绝仍有效。最终源码及包重新冻结，最终日志独立保留。

## 交付与现场验收

最终产物在 release/collaboration4-delivery-final/：Windows x64 安装器、源码 ZIP、Hub／WSS probe ZIP、MySQL 5.7 操作材料、SHA256、升级说明、S01–S18 索引和可公开证据。保留静态版本化测试夹具，排除真实配置、凭据、数据库、运行时测试 profile、旧 dist 及临时状态。完整源码与包内生产来源分别核对；签名、Docker 和现场条件如实报告。

现场仍需：第二台物理 Windows 电脑＋公网 Hub 的双端协作；用户指定测试仓库的真实 GitHub PR／冲突／成果；用户 Codex 桌面的原身份双向接续、精确停止和断联恢复；麦克风、屏幕、IDE、其他平台／Agent 的硬件验收；有 Docker 引擎的 Linux 镜像构建与云托管启动。具体步骤见 S01–S18 索引。现有云托管 Hub 可以使用，prod 只是环境标签；本任务按授权边界未发布生产或执行生产库迁移。
