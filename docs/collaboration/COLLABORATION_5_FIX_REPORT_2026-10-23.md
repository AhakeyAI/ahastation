# AhaStation collaboration.5 / Q108–Q112 交付报告

版本 **0.19.0-collaboration.5，Windows x64**。本轮在 `C:/Users/79142/.codex/worktrees/collaboration-baseline-upload/station-ctrl` 增量实施；分支 etrnal-dev，基底 b0cd16d1b7c4f9c91f9135ea163a7532ce1f2a1b。保留 Q1–Q107、原正确修改和 `electron/main.ts`。原目录、.3／.4 冻结交付不改；没有提交／推送 Git、创建真实远端 PR、生产部署／迁移或覆盖用户安装。

**代码、可执行隔离验证和新版打包已完成；物理双机、公网、真实 GitHub、用户 Desktop 与硬件仍待现场。完整 Node 最终为 1118 项：1079 通过、34 既有失败、5 跳过；新增失败 0，34 项失败名、错误码和原因逐项匹配。** 不将此结果表述为全仓测试全部通过，也不将本机双进程当作物理双机验收。

## 两处反例与共同链路

1. **停止异常和悬挂**：Station 公共 pump 不再等待逐项 stop／inspect／目录准备／交付。`background` 按服务／账号／设备和原输入、执行身份合并在途操作；观察超时只更新原因，不能删除在途职责或重开 helper。控制辅助调用最多 8 个，Git 发布辅助进程另限 4 个，互不挤占；实际任务仍遵守原名额、授权、目录和原生单写入者。逐项恢复检查、正式任务、Host／专家和原生历史／审批均按对象隔离，第一项拒绝或悬挂时后项继续。异常不假报退出；最近原因及历史落原状态，原卡和后台共用核对入口。
2. **accepted 被迟到错误改回 pending**：`deliver` 合并原 requestId 的投递；`acceptSubmission`、`reconcileSnapshotSubmissions` 和 `reconcileSubmission` 区分业务确认与传输结果。HTTP 成功或同 sourceDeviceId＋submissionId 的快照证据确认后，错误不能回退。原命令、正文、稳定 @、附件和关联保留；有意再发同文使用新 ID。旧 pending＋messageId＋空 outbox 可用原快照或只读 Hub 请求收据恢复；只有 messageId／digest 时不造正文或新身份，确实查不到保留原因和入口。

原复审脚本和 JSON 保留。四项正确行为回归先在 .4 失败，见 `pre-fix-hardening.log`，覆盖异常、未返回、并发投递与旧坏状态；修复后计入最终全量。首次预检曾因测试清理抢先发生遮住断言，已先修正清理等待，再取得四项断言失败证据。另补审发现失败的原生 Host 结果仍可能被主持层当作正常输出，先用 `pre-fix-native-host.log` 复现，再修复新／旧主持层；`host-outcome-fixed.log` 10/10 通过。

审计入口包括 pump/doPump、recoverReceipts、synchronizeReceipts、恢复定时器、专家交流、任务执行、原生接续／精确轮次停止、原生历史／工具决定、验证进程、Git 发布、撤权、账号／服务切换和退出清理。实现方法及 H01–H14、S01–S18 的具体证据见随包索引及原实施方案 9.10–9.11。

## 实际状态与资源规则

| 身份／负责方 | 事实、合法转换及恢复 |
| --- | --- |
| 会议 id，成员 deviceId＋agentId；Hub 原权限 | 原计划、批准和任务身份保持。F3 的 planVersion／planDecisionVersion、已分发字段保护继续有效 |
| 消息 requestId；原发送设备 | 原命令先落盘后调用；pending→accepted 需要原回执或准确快照证据；accepted 不因旧失败回退。当前权限或认证错误不能独自证明此前未收下 |
| 网络投递；原连接 epoch／服务／账号／设备 | 原 ID 在途合并，不加会议／账号发送锁。请求错误不会使已确认状态降级；旧连接事件、状态和落盘回调须再核对身份／代次。附件发布持有原账号职责，不能把迟到结果写进另一身份 |
| 执行 taskId＋attemptId，或输入 messageId；原执行设备 | starting 在调用前持久化；未知核对原执行，不重跑模型。turnOutcome 与 stopRequested 分开。只有可靠退出证据才释放模型名额，旧 attempt 不能改当前 receipt |
| 原生 threadId＋turnId；本机接续组件 | 同线程唯一写入保持；原生实际 completed／interrupted／failed 决定轮次结果，取消文件或中断请求不替代真实结果；journal 保留结果和真实退出码 |
| 停止意图；原输入／任务 | 已要求停止即禁止未开始补充、后续模型和新测试；明确继续才创建后续执行尝试。旧停止／进度不能覆盖正常结束或已交付事实 |
| 正常轮次原成果；taskId＋attemptId＋commit／branch／PR | 原授权和范围内继续整理、提交、推送、PR与回传；不重跑模型或补造测试通过。未运行命令报告 exitCode=null 和未运行原因；交付失败保留 delivery-pending |
| 真中断的部分成果 | 本机文件／工作区／原对话和已有提交保留；同步已有输出／引用，不自动新增提交、推送或 PR，不标完整交付，依赖继续等待 |
| 在途 Git；原尝试的 gitOperations[phase].id | 副作用前持久记录；独立 Job 约束进程及后代，原 journal 核对真实退出。模型名额可释放，Git 未确认时目录仍占用。明确继续的新 attempt 也须等待旧 Git，旧证据进入 gitHistory |
| 验证进程 executionId、物理 cwd | 检查退出未知保留真实名额与目录；逐项失败／慢不阻断独立恢复。停止先于调用时不启动命令；已发出的调用只核对原身份 |

正常结束与停止交错保留正常结果及完整交付；真正中断不被迟到正常包覆盖；未知不获得新发布许可。Git 先核对 HEAD、远端准确 SHA 与 PR，已完成步骤不重复。PR API 故障测试为明确夹具，真实文件、提交与 pack 传输使用专属本地仓库；没有把该夹具宣称为真实 GitHub PR。

## 测试、命令与退出码

Node 24.22.0：`C:/Program Files/nodejs/node.exe`；npm 同目录 npm.cmd。Python 3.13.5：`C:/aha/ahastation/pocket-vibe-agent/.venv/Scripts/python.exe`。设置 COLLABORATION_PYTHON、POCKET_VIBE_TEST_PYTHON、PYTHONUTF8；原生构建设置 AHASTATION_BUILD_PYTHON。测试均为独立 profile、专属进程、临时目录、回环服务和独立数据库。

| 实际运行 | 结果／日志（均在 runtime/collaboration5-2026-10-23） |
| --- | --- |
| 修改前 `npm run build`、完整 Node | build 0；Node 1：1095／1056 通过／34 失败／5 跳过，baseline-build.log、baseline-node.log |
| `npm run typecheck`（Renderer＋Electron）、`npm run build` | 均 0；acceptance-final/typecheck-identity-final.log、acceptance-final/build-identity-final.log。保留 Vite chunk 提示 |
| `npm run prebuild:native` | 0；native-release.log，frozen 自检成功，27 个 Python 来源清单核对 |
| 最终 `node --test --test-concurrency=1 --test-timeout=120000 --import <electron-stub register loader> tests/*.test.mjs` | 退出 1：**1118／1079／34／5**；identity-final/candidate-node-release.log。新增 23 项 Node／React 回归通过，含实际生产 HTTP/WSS、磁盘、真实 Git／helper 和实际 React |
| 基线比较＋完整断言头部核对 | 均 0；baseline-comparison.json、failure-reason-comparison.json：34/34 原因和码一致，仅规范化测试专属 Temp 目录名；REGRESSION_FAILURES.md 保留逐项原文 |
| Python unittest，各套 `discover -s services/remote/tests -p <pattern> -v` | hardening 15、stability 13、review-fixes 12、unified 16、Guardian 15、codex_shared 33、probe 4、contract_paths 5，逐套退出 0。继承用例有重复，不相加当作独立覆盖数 |
| 基础契约 | 在 services/remote 下 discover collaboration_contracts/tests：4/4、退出 0；contracts-correct-cwd.log。先前从仓库根错误执行导致 ModuleNotFoundError，错误日志保留，未算通过 |
| 真实 Codex 原 Host 编排→人工批准→固定 Worker→正文交付，独立专家讨论 | 退出 0；real-model-short-path.log；真实正常成果停止后手工核验追加通过，taskExecutionCalls=1、正文不变、补充不执行且自动推进被拒绝。独立离线核对 0，正文、finalSummary、双端快照逐字一致，textOnly 和不同原生线程有证据 |
| 真实 Git 与停止边界 | hardening-git-RESULT.json：原正常成果 PR 创建次数 1，首次回应丢失后复用；receive-pack 2 次为初始基线＋原成果。部分场景新增提交／推送／PR各 0，本机文件保留，新模型执行 0；验证命令未运行如实报告 |
| 独立 MySQL5.7 | 最终 mysql57-RESULT.json、mysql57-short-path.log 和各套 mysql57-python-*.log；旧数据、凭据、账号／设备保留，SQL 幂等、未知版本保护、DML-only 与禁止建表有记录。生产库未访问 |
| NSIS electron-builder --win --x64 --publish never，npmRebuild=false | 0；nsis-release.log。实际 NSIS 解包退出 0，303 文件，7-Zip 一个 overlay 提示；nsis-extraction-final.log |
| 实际载荷与启动／重启 | 0；248 个 dist／dist-electron 文件逐字匹配实际解包 asar，exe／helper／清单与构建相同。两个真实 Windows 进程、独立 profile、OS 加密凭据、Renderer 和 WSS／身份重启恢复通过；payload-smoke-final.log |
| Hub 导出与生产启动 | 0；36 文件、Unix 644、28 固定依赖、Docker COPY 上下文、生产路由、lifespan、health/ready 通过；hub-export-final.log、hub-check-final.log |

一次尚未完成的全量运行因补审发现 Host 失败结果缺口主动中止，不计作完整结果；原日志 candidate-node-final.log、INTERRUPTED-FULL-RUN.md 和中间包保留。只终止了该次专属测试树，随后核对相关 PID 已退出；未关闭用户 Station、Codex 或任务。修复后重建并从头完整运行，最终日志为 candidate-node-release.log。中间 `.5` 构建在 release/collaboration5-before-host-outcome，标记不可用。

34 个既有失败涉及旧 Observe/CLI/Desktop 的 ps／lsof 与进程关联夹具、Kimi 状态夹具，以及 Qoder 符号链接／fs.watch EPERM。5 项跳过的具体平台／权限原因逐项列在 REGRESSION_FAILURES.md。它们不是本轮自动豁免项：本轮比对断言并复核相关链路，新 Windows 停止／退出链走任务专属 Job、原生精确轮次及 durable journal，有 Guardian、原生接续、进程重启和载荷证据；没有用旧 POSIX 夹具的失败证明这条链可用。涉及旧 Observe、Kimi、Qoder 的原功能仍须在适合的环境完成验收，未宣称全部原功能已通过。

## Hub、数据、部署与回退

Hub 有变更：增加只读原消息收据查询、轮次结果与终态保护、明确继续规则及特性协商；同步 v2 JSON 契约和 Station。原 messageReceipt 接收命令契约与新 messageSubmissionReceipt 查询响应分开。旧幂等成功回执可读，旧记录缺字段不能默认正常退出或新发布许可。新字段进入快照后不匹配客户端收到 426，身份不被撤销。

**MySQL5.7、station_hub、schema=2 无新增 DDL**。继续原实体、事件、请求及原生历史表；不清库、不换 HUB_SECRET、不换密码、不重新注册全部设备、不让运行账号临时获得建表权限。SQL 与 .4 相同；旧 schema=1 的既有升级材料随包提供，不能误作本版新增迁移。

先备份原数据库、非公开配置／密钥和设备本机记录；保持原 HTTPS/WSS 与数据库配置，先在隔离环境验证，再由运维受控升级匹配 Hub／Station。本任务没有发布生产。回退前关闭新接收，在原设备核对原执行与在途 Git；新字段已生效时不能直接让旧客户端重放未知执行。无逆向 DDL，不自动回滚 Git。完整说明为随包 COLLABORATION_5_UPGRADE.md。

本机无可用 Docker CLI／标准安装路径／DOCKER_HOST，**未构建或启动 Docker 镜像**。Hub 源码导出与生产 app 隔离启动已过。安装器签名实测 **NotSigned**。

## 最终交付路径与验收边界

最终目录：`C:/Users/79142/.codex/worktrees/collaboration-baseline-upload/station-ctrl/release/collaboration5-delivery-final/`。

- `AhaStation Setup 0.19.0-collaboration.5.exe`：Windows x64 安装包。
- `deployment/ahastation-hub-source.zip`：匹配 Hub；另附 WSS probe ZIP。
- `source/ahastation-collaboration-source.zip`：包括必要未跟踪实现与静态夹具，不含真实凭据、数据库、运行 profile 或生产日志。
- `deployment/ahastation-mysql57-upgrade-materials.zip`、`COLLABORATION_5_UPGRADE.md`：既有 MySQL5.7 SQL 与备份／升级／回退说明。
- `H01-H14_S01-S18_EVIDENCE.md`、`verification/`、`SHA256SUMS.txt`、`CHECKSUMS.json`：逐项证据、完整日志、来源与保留核验。

绝对文件位置为上述最终目录加相应文件名；本报告同时存为目录内 DELIVERY_REPORT.md。完整源码、构建清单、原生 helper、Hub、实际安装器载荷和最终 SHA256 分别核验。保留 .3／.4 冻结交付、原未提交修改及本轮中间记录。

现场步骤见随包证据索引：准备第二台物理 Windows 与受控测试 HTTPS Hub，安装匹配版本、正常登录同一账号，确认旧历史和 WSS后执行断网／停止／恢复；在用户指定的测试 GitHub 仓库验证真实 PR与冲突／获取；在用户选定的 Codex Desktop 测试原对话、精确轮次与断联恢复；最后验证实际麦克风、屏幕、IDE及其他 Agent／平台。在有 Docker 引擎的隔离 Linux 环境构建 Hub镜像，启动 health/ready、登录、WSS和重启验证后再按运维流程发布。上述现场条件当前未具备，没有计为通过。

最终交付补核还发现：正常结束且已经回传的文字成果，被旧停止条件挡住了用户手工检查。先在生产HTTP上取得 pre-fix-normal-review.log 的409失败，再修正：仅有可靠正常结束证据的非代码成果，允许用户明确手工检查和最终验收；不启动Agent／新测试、不消除停止意图。已核验且正常完成的成果不因旧停止意图被误判未完成；依赖任务仍须原计划批准、原目标和核验，未知／中断／未核验仍等待。原任务未执行补充仍不能advance。新增Hub正确行为回归覆盖手工检查、准确原attempt、未批准拒绝、核验依赖及最终验收；Node依赖展示作相同正反校验。最终版本重新完整回归、打包和冻结，之前69文件包保留在 collaboration5-before-human-review，不作为最终包。

最终Station全量、Hub导出、NSIS和实际载荷证据位于 runtime/collaboration5-2026-10-23/identity-final/；本轮类型检查／构建、Hub Python回归和真实模型启动日志位于acceptance-final，MySQL与模型结果使用下述短路径。其他根目录同名日志为之前完整运行或中间记录，保留不覆盖。最终verification平铺收集有明确来源的日志；未修改的Guardian／原生兼容证据保留各自实际执行范围。源码和包内清单以最终来源核验为准。

补修后的MySQL与额外真实模型联测使用 runtime/c5-mysql-final、runtime/c5-model-final 短路径。较深的acceptance-final路径曾触发旧MySQL初始化失败与Windows原生cwd错误，原错误证据保留，未计通过；仅调整本次隔离测试输出位置，不修改系统／生产路径或降低断言。

最终 H07 补审：三个真实隔离 Hub、真实磁盘和 WSS 注册下，先挂起 B 账号目标档案加载，再让 C 完成注册，复现 B 迟到回调覆盖 C；pre-fix-identity.log 是修复前的断言失败。connect 现于归档、目标加载、串行落盘、探测、注册和凭据验证各边界核对连接代次与所选账号；旧探测不写新配置，设备重新接入的迟到凭据也不跨账号落盘。界面在所选账号与持久身份不一致时保留草稿并拒绝发送；消息入盘再次核对原身份。正式 collaboration-hardening-identity.test.mjs 验证 C 身份和设备不变、A 原消息在原归档完整保留、新账号没有旧提交；相关18项定向回归通过。首次修复后测试因启动时配置上报未结束使归档含额外设备更新而失败；补齐启动等待后保留严格完整原消息断言，没有删减行为断言。

最终 Station 全量与冻结来源使用 runtime/collaboration5-2026-10-23/identity-final/；acceptance-final 中的完整运行和安装器为补修前记录。此前并发打包期间一次 S11 页面启动超时（未进入行为断言），原35失败日志保留；安静环境 UI15/15及随后全量1117／1078／34／5通过基线范围，未降低超时或断言。新增身份修复后的完整结果以 identity-final/candidate-node-release.log 及同目录比较为准，最终公开 verification 使用该轮日志。
