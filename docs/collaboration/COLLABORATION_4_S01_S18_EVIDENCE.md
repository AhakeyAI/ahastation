# collaboration.4 / S01–S18 证据索引

最终交付目录 release/collaboration4-delivery-final/，证据在 verification/；完整未公开运行记录在 runtime/collaboration4-2026-10-23/。以下“通过”限定于写明的测试环境。实际模型、回环协议、React 夹具、MySQL 独立库和两台物理电脑分别记账。现场条件不足不转为通过。

| 项目 | 本轮实际证据与范围 | 结果／现场边界 |
| --- | --- | --- |
| S01 独立专家／Host／任务 | candidate-node-release.log 的 F1 和 S01/S13：同一交流上下文等待，Host、其他收到的任务、工具决定继续；实际 Codex 的独立专家线程与任务线程不同，real-model-RESULT.json / CONTENT-VALIDATION.json | 代码及隔离通过；双物理电脑待现场 |
| S02 准备失败与明确重试 | F1 adapter/directory/input/publication 失败均在原输入持久化原因、notStarted；test_collaboration_stability-final.log 核验专家与 Host 的重试唯一性、同一目标、附件及咨询身份 | 隔离通过，不改派 Host、不重建会议 |
| S03 已启动未知／停止／撤权／重启 | F1 launch/restart/preparation stop/revocation；Guardian 13；完整 Node 的 station-native-flow、station-process-recovery；Hub 撤权保留清理路径测试 | 隔离真实进程及状态注入通过；用户原生 Desktop／公网断联待现场 |
| S04 连点／连续 Enter | 实际 React rapid clicks、S04/S06 断言一次提交；Hub 并发相同 requestId 一条消息，明确再发同正文新 ID | 通过 |
| S05 发送中编辑／附件 | 实际 React S05/S08 与附件失败：异步准备期间改文字、添加新附件、设备改名；只发送原正文／目标／first.txt，保留新文字和 next.txt；失败不产生消息 | 通过；资料发布为明确 UI 夹具，真实 Git 传输另由原集成回归覆盖 |
| S06 已收下但模型未完成 | 实际 React S04/S06：Hub 返回后立即再发相同正文，ID 不同；F1 同上下文串行；模型回复不作为按钮解锁条件 | 通过 |
| S07 响应丢失／离线／重启 | F2 production HTTP/WSS：真实 Hub 提交后注入丢响应，Station 与 Hub 重启，读实际磁盘 outbox，原 requestId 补投回到原消息 ID，Host 处理一次；先本地保存再离线的提交也只一条；实际 React pending 核对保留新输入 | 通过；无盲重跑 |
| S08 稳定 @ 与附件 | 实际 React 中文候选、改名、离线及附件；原 R4 覆盖同名、编辑破坏、邮箱、原生准确身份及多目标拒绝；Hub 再核验成员／原生绑定 | 通过；原本机技能／键盘代码与相关完整回归保留 |
| S09 相同计划刷新 | 实际 React 在窗口打开时注入相同快照、名称、在线与进度，保留标题及精确 SHA 修订；Hub meeting.update 不改 planVersion，相同 Host 提案不撤销已有批准 | 通过，不增加批准或版本提示 |
| S10 真计划冲突／迟到输出 | 实际 React 新版保留编辑、禁旧批准、显式应用修改后提交正确版本；S10 两张截图；批准等待期间继续编辑，回调只清原版本并保留后续内容；Node Host 原依据／无依据恢复；Hub 双向版本检查和已分发不可变测试 | 通过，聊天与独立工作继续 |
| S11 关闭／切会／放弃 | 实际 React close/switch/return：第一、第二会议各自保留，放弃不发服务器拒绝；刷新 Renderer 不保留未提交编辑 | 通过；仅本次运行内存缓存，已提交业务仍持久化 |
| S12 自动批准／已派发边界 | 实际 React 开启后查看／编辑不改开关，派发期间变只读；Hub 关闭 autoApprovePlan 不撤销当前批准或已发任务；旧编辑提交仍被服务端拒绝 | 通过，没有编辑预留／隐式暂停 |
| S13 基线／单任务失败不阻断 | 原 R2 当前完整回归：真实临时 Git 的旧／新准确 SHA、未批准不派发、已派发字段保护；R1–R4 真实服务联测，S01/S13 工具决定与独立任务继续 | 通过 |
| S14 身份与 Guardian | 原 R3 业务 403、有效旧 token 服务端核验、失效／撤销拒绝；原 R1 Host 启动前失败；Guardian 封存未启动、迟到执行拒绝、未知不假报 | 通过；不清库或重建设备 |
| S15 原功能保护 | candidate-node-release.log 与基础对照；统一协议 16、原生兼容 33、Guardian 13、原 R1–R4 及原生双向停止／附件／Git 回归；实际 Codex 纯文字交付无 GitHub 要求 | 相关隔离回归通过；全量既有 34 失败和 5 跳过仍单列，硬件／其他平台待验收 |
| S16 MySQL 与旧数据 | mysql57-RESULT.json：5.7.18；稳定性 13、R1–R4 12、统一协议 16、旧协议 8、Station 7；旧记录／凭据、版本保护、SQL 重复执行、DML-only 账号通过 | 独立库通过；schema=2 无新增 DDL，生产未迁移 |
| S17 构建／打包／来源 | typecheck-final/build-final/native-candidate、package-verification、nsis-payload-source-verification、payload-RESULT、deployment-verification、preservation-and-freeze、源码 ZIP 内清单及 CHECKSUMS.json | 最终完整结果以 DELIVERY_REPORT.md 为准；NSIS NotSigned，Docker 镜像未构建 |
| S18 现场条件不足 | 下列操作步骤及 DELIVERY_REPORT.md 的现场边界；未把本机双进程、UI 夹具或 HTTP 回环算成公网／双机／Desktop 通过 | 如实列待验收 |

## 复跑入口

Node 24.22.0；两侧 tsc 通过 npm run typecheck。正式构建 npm run build；原生组件使用 AHASTATION_BUILD_PYTHON 指向包含 requirements-station-native 的 Python 3.13.5，再 npm run prebuild:native。

完整 Node 使用仓库 tests/electron-stub.mjs 的 register loader、--test-concurrency=1、--test-timeout=120000。COLLABORATION_PYTHON 与 POCKET_VIBE_TEST_PYTHON 指向同一隔离 Python；不能以未设置环境变量的跳过代替本轮结果。实际 React 测试用 Playwright 1.62.1 与隔离 headless Chrome；可以设置 STATION_PLAYWRIGHT_MODULE 为已安装模块路径、STATION_CHROME 为浏览器路径，缺少依赖应补齐后运行。测试自行选择独立本地端口，不接管已有 Vite 或用户浏览器。

Python：unittest discover -s services/remote/tests，分别运行 test_collaboration_stability.py、test_collaboration_review_fixes.py、test_unified_meeting.py、test_station_codex_guardian.py、test_codex_shared.py、test_probe_package.py、test_collaboration_contract_paths.py；基础契约在 services/remote 下运行 collaboration_contracts/tests。test:collaboration 已纳入本轮新测试。

MySQL 使用 scripts/rehearse-collaboration-mysql.py --mysql-base 指向本机独立 5.7 分发目录 --output 指向新的证据目录 --navicat-upgrade-checks。只能使用脚本创建的 owned-local-mysql / 127.0.0.1 / station_fixture_* 库；不要提供生产连接参数。private-test-connection.json 不在交付证据内。

## 待现场操作

1. 准备第二台物理 Windows，安装匹配 .4，正常登录同一 Station 账号。先按升级说明备份并受控升级现有 HTTPS 云 Hub；不要用新的账号或清库替代原身份。两端确认设备、历史、授权和 WSS，再在无用户项目写入的测试会议重走 S01–S14，包括断网、原设备恢复及接收关闭。
2. 使用用户指定的专用 GitHub 测试仓库／分支及各机已授权的不同本机目录，验证精确 SHA、PR、冲突、成果获取与依赖修订；不得拿正文模型或伪 PR 链接冒充真实远端交付。
3. 用户在自己的 Codex Desktop 选定测试对话，核对既有身份、桌面忙时等待、两端精确停止和断联恢复；保留原线程，不能通过归档／新建替代，不能停止其他桌面工作。
4. 在有 Docker 引擎的 Linux 环境从新 Hub ZIP 根构建镜像，使用独立配置启动，运行 health/ready、登录、WSS、重启和故障恢复后再按运维流程发布云端。当前仅包与导出生产 app 隔离启动已过。
5. 在实际麦克风、屏幕、IDE、其他 Agent／平台上执行原验收清单，记录未具备条件的项目。现有 34 个 Windows 测试失败也应按 REGRESSION_FAILURES.md 在对应环境处理，不能称全部原功能无条件通过。
