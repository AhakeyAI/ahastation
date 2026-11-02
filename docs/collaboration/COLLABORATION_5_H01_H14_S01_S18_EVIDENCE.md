# collaboration.5 / H01–H14、S01–S18 证据索引

最终目录 `release/collaboration5-delivery-final/`；可公开证据在 verification/，原始私有测试 profile、独立数据库和运行资料留 runtime/collaboration5-2026-10-23，不进入交付。下表的通过均限于列明的隔离环境，不能推导为物理双机、公网或用户 Desktop 已验收。

## H01–H14

| 编号 | 正确行为及禁止行为 | 实际代码／测试／证据 |
| --- | --- | --- |
| H01 | 活跃专家 stop 拒绝、恢复首项 helper 拒绝时，原对象保留未知与真实占用；独立 Host、任务、审批继续 | station-service background／stopMessage／recoverReceipt／recoverInput；collaboration-hardening.test 的 H01、H01/H03 reject；原复审反例先转成正确行为断言失败再修。最终全量日志包含成功断言；错误就地保留，不发布虚假的 exitConfirmed |
| H02 | stop／核对未 resolve 时独立工作已经推进；同一在途控制不重复；观察超时不清职责 | deterministic gate 单项＋collaboration-hardening-scheduling.test：生产 HTTP/WSS、真实 FileTestExecution 和磁盘；停止 gate 未释放时，另一会议先交付、工具审批允许后首项交付，停止调用仍 1 次。控制 helper 8 个上限的悬挂／释放测试通过；Git 执行另有 4 个上限 |
| H03 | 第一项失败／慢不阻断后续检查、任务、专家、原生历史及有效工具决定 | recoverReceipts 按执行调度；check/task/input 三者后项均在 gate 未释放时持久恢复。syncNativeSession 按原生对话隔离，首个 history 悬挂时后个 history checkpoint 和 approval.observed 已完成。原生兼容 33、实际 frozen helper Native flow 保持通过 |
| H04 | 同提交 flush／人工核对合并；已有两次在途传输的成败两序及双成功乱序都只有一条 Hub 消息，accepted 不回退 | collaboration-hardening-http.test 使用生产 Hub、独立 SQLite 和实际 station-v2.json；直接覆盖旧版已存在的两次在途传输，另外单项验证公开投递入口合并。Hub 同原 requestId 仅 1 条；错误不撤销 accepted，独立提交不受发送锁阻挡 |
| H05 | Hub 收下丢 HTTP 响应、WSS 先确认／重复、断线及重启仍核对原身份，不重跑未知模型 | hardening HTTP 的 WSS-before-HTTP-loss；既有 F2 production HTTP/WSS lost response＋Station／Hub restart；Hub generation_snapshot_boundary、R3 reconnect。事件 seq／revision、连接 epoch 和身份在落盘时再核验；正常响应与同步消息可交叉确认 |
| H06 | 旧 pending＋messageId＋空 outbox 恢复；无证据不捏造成功或正文；主动同文新 ID 可发 | hardening HTTP：重新加载实际磁盘，仅查只读原收据，POST=0；假 requestId 即使有真实 messageId 也保持 pending＋原因。Hub Hardening 旧收据去掉 submissionId 后仍可读、只读 cursor 不变、他设备不可读、带斜线等合法旧 ID 查询通过；同文明确新提交得到不同消息 |
| H07 | 落盘失败不能假确认；旧连接／账号／服务回调不能写入新身份 | 原确认更新 fsync/rename 故障断言，重新加载仍有原命令；DurableState 实际 Windows 文件锁／原子落盘；station-process-recovery 的真实 Receiver 进程崩溃与同设备恢复；hardening 成功／失败旧 HTTP 回调均不改新 owner、service、outbox、收据。发送前、回调及串行落盘回调再核验身份；文件发布持有原账号职责 |
| H08 | 同目录、原生同线程、容量占满保持等待；独立上下文与有真实名额者继续；模型退出不释放在途 Git 目录 | hardening 的真实目录正反比较；生产 scheduling：容量1时第二任务已接收但不启动，改容量2后真正完成，第一任务仍待审批。Git 目录与名额分开；新 attempt 等旧 Git 退出后才接收，旧 Git 证据归档且不继承 stopRequested。Native flow／33 原生回归验证原线程单写入，不删除锁 |
| H09 | 原卡原因／重新核对准确；成功收起旧错误；编辑、@、附件不被旧回调擦除 | 实际 React／隔离 Chrome 15 项：新增原消息 stop 未确认原因、原 messageId 核对、恢复清提示、新正文／next.txt 保留；新增任务卡正常轮次、停止意图、交付待处理和明确继续入口。继承发送、稳定 @、附件、计划和旧回调编辑保护断言全部保留。核对不发送新模型输入 |
| H10 | 停止与正常结束两序、回包反序按真实结果；失败结果不能派计划 | Guardian 真实独立进程：interrupt 已请求但原生返回 completed，结果 ok=true、cancelled=false、turnOutcome=completed，重复 stop 原回执相同。原真实中断／后代清理测试保持；Hub 正常结束前后 stop 与迟到 stop-unconfirmed／stopped 均不回退；新／旧 Host failed 结果正式回归先失败后通过，未提交计划／正常完成事件 |
| H11 | 正常轮次原交付允许；新 Agent／补充／测试禁止，Git 幂等；失败只交付待处理 | hardening-git.test 经实际 frozen helper／Windows Job，专属本地 Git 提交、推送和准确 SHA；PR API 创建成功丢回应后再核对只创建 1 次，不重复 push／commit。task.stopRequested 保留，验收 exitCode=null／未运行，新 Agent=0。Guardian 停止先于验证调用则 marker 文件完全不产生；已运行验证真实退出码保留。Git 过程按阶段 durable，未知占目录，退出不占模型名额 |
| H12 | 真中断只保留本机部分成果和既有事实，不新增发布、不标完整交付、依赖等候 | 实际本地 partial.txt 保留，HEAD 与远端 refs 前后相同，部分场景新增 commit／push／PR=0；未发送 delivered。中断结果为受控 fixture，退出与进程链另由真实 Guardian／Native flow 验证。Hub 拒绝 interrupted→completed／delivered 及部分成果 review，原依赖规则保留。没有把本地提交称为远端可获取 |
| H13 | 未知、撤权、重复停止、重启不盲重跑、不复活旧 attempt、不假释放 | unknown journal 保持 reconcile 和占用；控制合并与 sealUnstarted 防迟到启动；真实进程崩溃保留 deviceId／attempt／thread，只明确继续后新执行。旧 attempt 回调有 guard；撤权保留退出清理，Git 在途只核对／精准停止，已发生事实保留。独立 scheduling 正向交付和真实原生停止证明一并保留 |
| H14 | R1–R4、F3、原统一会议与相关 Git／原生／DB 行为保持 | 最终 Node 1118／1079／34既有失败／5跳过，23新增用例通过；两侧 tsc、build、全部相关 Python、独立 MySQL5.7、真实 Codex、Hub 包与实际 NSIS 载荷通过。失败名／码／原断言34/34匹配；623源码冻结；原 main.ts、.3／.4冻结及SQL保留核验见 preservation-and-freeze-verification.json |

这些是对关键业务结论与故障影响范围的有界覆盖；没有声称逐一枚举了所有 OS 崩溃时刻或所有网络组合。测试 fixture 注入组件故障、结果和 PR API 的位置均在源码中明确；实际磁盘／Hub、Git 传输、原生独立进程、模型和 React 分别有对应证据。

## S01–S18 保留核验

| 原项 | .5 实际证据与范围 |
| --- | --- |
| S01 独立上下文 | 原 F1、H01–H03、真实 scheduling 与 Codex 不同线程；.4 异常遗漏已由新增 gate／拒绝回归关闭 |
| S02 准备失败与明确重试 | F1 五边界、原 R1、Hub stability 的原目标／附件／consultation 重试唯一性 |
| S03 未知／停止／撤权／重启 | H01–H03/H08/H10/H13，Guardian15、Native flow、Receiver 真进程崩溃；未把“停止请求”当退出 |
| S04 连点／Enter | 实际 React 发送用例，Hub 原 requestId 唯一；明确再发同文新 ID |
| S05 编辑／附件 | 实际 React 异步准备期间新正文、稳定目标及 next.txt 保护，失败不生成消息 |
| S06 Hub 确认可发下一条 | 原实际 Enter／同文用例，等待模型不作为发送锁；accepted 单调确认 |
| S07 丢回应／离线／重启 | H04–H07 和原 F2；.4 并发回退遗漏已补三序真实 HTTP 与旧坏状态恢复 |
| S08 稳定 @ | 原 R4＋实际中文候选／改名／离线／附件；失效明确提示且不转 Host |
| S09 相同计划刷新 | F3 实际 React 相同 snapshot／rename／online／progress 保留编辑，Hub identical Host proposal 保留批准 |
| S10 真冲突／迟到方案 | F3 双向版本、Host 原依据、显式 rebase、已分发不可变、批准回包只清对应编辑版本 |
| S11 关闭／切会／放弃 | 实际 React 原审阅窗口本次运行缓存；关闭不拒绝，放弃不向 Hub 发拒绝，重载不跨重启保留未批准编辑 |
| S12 自动批准／已分发 | 原实际 React 与 Hub：查看编辑不改策略，不撤销已有工作或增加编辑锁 |
| S13 单项失败不阻断 | R2 实际 Git 准确基线／原批准、H01–H03／生产 scheduling／原审批决定 |
| S14 身份／Guardian | 原 R3 403与有效身份、凭据核验、H05–H07、原子封存与精确原执行恢复 |
| S15 原功能 | 全量基线比较、Unified16、原生33、Guardian15、Git、Host／Worker；34失败与5跳过仍是对应原功能的待验收，不称全部原功能通过 |
| S16 MySQL | MySQL5.7.18最终独立演练；Hardening15＋原稳定性／R1–R4／统一／旧协议＋Station，旧记录／凭据、幂等SQL、DML-only与禁止建表 |
| S17 构建／来源 | 两侧typecheck、build、native自检、NSIS实载荷303文件、编译248文件、两个Windows进程与重启、Hub36文件、源码／SHA清单；NotSigned，Docker未构建 |
| S18 现场条件 | 下列步骤；物理双机／公网／真实GitHub PR／用户Desktop／硬件均未运行 |

## 证据文件与复跑

最终 Node 原日志 candidate-node-release.log 与同环境 baseline-node.log；baseline-comparison.json、failure-reason-comparison.json 和 REGRESSION_FAILURES.md 逐项核对。使用 `tests/electron-stub.mjs` 的 register loader，不能直接将 resolver 模块当作 import 执行。

Python 各套原日志以 test_*.log 命名；基础契约从 services/remote 运行。MySQL 使用 scripts/rehearse-collaboration-mysql.py，显式指定 mysql-5.7.18-winx64 分发和新的 output，--navicat-upgrade-checks；只能连接该脚本创建的 owned-local-mysql／127.0.0.1／station_fixture_*。不向命令传生产连接，不发布私有连接 JSON、数据库或 profile。

实际模型 RESULT.json、CONTENT-VALIDATION.json，实际载荷 payload-RESULT.json、package-verification.json、nsis-payload-source-verification.json，Git hardening-git-RESULT.json、Hub deployment-verification.json，以及源码、原生和保留核验均在 verification。最终文件及每个公开证据 SHA256 以 CHECKSUMS.json 为准。

## 待现场步骤

1. 第二台物理 Windows 安装同版 .5。备份后受控升级已有 HTTPS Hub，正常登录同一 Station 账号，确认原设备、历史、授权、WSS和身份。用专属测试会议重走 H01–H14／S01–S14，加入 A/B 两端真实断网、恢复和重启。现有云托管 Hub 可以按运维流程使用；本任务未操作生产部署或数据库。
2. 用户指定的专用 GitHub 测试仓库／分支和两机各自授权目录：准确 SHA、PR、冲突、文件获取、依赖与停止三类成果规则。明确区分本地提交和已推送可获取文件，不把本地传输／API夹具算真实 GitHub。
3. 用户在 Codex Desktop 选定测试对话，核对原 threadId、精确 turnId、桌面忙时等待、双向停止、断联与原设备恢复；不归档／重建替代原对话，不停止其他桌面工作。
4. 有 Docker 引擎的隔离 Linux 环境从新 Hub ZIP 根构建镜像，保持测试配置，验证 health/ready、登录、WSS和重启，再走生产发布流程。本机未运行镜像构建。
5. 实际麦克风、屏幕、IDE、其他 Agent／平台执行原验收表；按 REGRESSION_FAILURES.md 处理相关平台夹具和未通过原功能，记录真实结果。

最终交付补核还发现：正常结束且已经回传的文字成果，被旧停止条件挡住了用户手工检查。先在生产HTTP上取得 pre-fix-normal-review.log 的409失败，再修正：仅有可靠正常结束证据的非代码成果，允许用户明确手工检查和最终验收；不启动Agent／新测试、不消除停止意图。已核验且正常完成的成果不因旧停止意图被误判未完成；依赖任务仍须原计划批准、原目标和核验，未知／中断／未核验仍等待。原任务未执行补充仍不能advance。新增Hub正确行为回归覆盖手工检查、准确原attempt、未批准拒绝、核验依赖及最终验收；Node依赖展示作相同正反校验。最终版本重新完整回归、打包和冻结，之前69文件包保留在 collaboration5-before-human-review，不作为最终包。

最终构建、全量、MySQL、Hub和实际载荷的新一轮证据位于 runtime/collaboration5-2026-10-23/acceptance-final/；根目录同名日志为之前完整运行／中间记录，保留不覆盖。最终verification平铺收集本轮日志；未修改的Guardian／原生兼容／模型证据保留各自实际执行范围。源码和包内清单以最终来源核验为准。

补修后的MySQL与额外真实模型联测使用 runtime/c5-mysql-final、runtime/c5-model-final 短路径。较深的acceptance-final路径曾触发旧MySQL初始化失败与Windows原生cwd错误，原错误证据保留，未计通过；仅调整本次隔离测试输出位置，不修改系统／生产路径或降低断言。

最终 H07 补审：三个真实隔离 Hub、真实磁盘和 WSS 注册下，先挂起 B 账号目标档案加载，再让 C 完成注册，复现 B 迟到回调覆盖 C；pre-fix-identity.log 是修复前的断言失败。connect 现于归档、目标加载、串行落盘、探测、注册和凭据验证各边界核对连接代次与所选账号；旧探测不写新配置，设备重新接入的迟到凭据也不跨账号落盘。界面在所选账号与持久身份不一致时保留草稿并拒绝发送；消息入盘再次核对原身份。正式 collaboration-hardening-identity.test.mjs 验证 C 身份和设备不变、A 原消息在原归档完整保留、新账号没有旧提交；相关18项定向回归通过。首次修复后测试因启动时配置上报未结束使归档含额外设备更新而失败；补齐启动等待后保留严格完整原消息断言，没有删减行为断言。

最终 Station 全量与冻结来源使用 runtime/collaboration5-2026-10-23/identity-final/；acceptance-final 中的完整运行和安装器为补修前记录。此前并发打包期间一次 S11 页面启动超时（未进入行为断言），原35失败日志保留；安静环境 UI15/15及随后全量1117／1078／34／5通过基线范围，未降低超时或断言。新增身份修复后的完整结果以 identity-final/candidate-node-release.log 及同目录比较为准，最终公开 verification 使用该轮日志。
