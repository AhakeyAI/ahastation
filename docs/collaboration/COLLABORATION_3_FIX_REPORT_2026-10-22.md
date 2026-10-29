# AhaStation collaboration.3 定向修复交付报告

版本：**0.19.0-collaboration.3 / Windows x64**。本轮在指定候选工作树 `C:/Users/79142/.codex/worktrees/collaboration-baseline-upload/station-ctrl`、`etrnal-dev` 分支增量修复，基底提交仍为 `b0cd16d1b7c4f9c91f9135ea163a7532ce1f2a1b`。没有提交、推送、生产部署或生产数据库迁移。原工作目录和 `.2` 冻结交付保留；本轮核对 `electron/main.ts` 与 `.2` 冻结源码逐字节一致。

交付范围为独立审查 R1–R4 的代码、正式回归、构建及匹配部署材料；不重新设计会议，不扩展设备权限或自动批准工具。现场边界在下方单列。

## 四项修复

| 问题 | 修复后的行为 | 主要文件 |
| --- | --- | --- |
| R1 启动前失败挡住后续输入 | Host 先持久化 preparing，完成准备后才写启动意图并交执行器。确认未启动的错误为 failed，保留原输入、可读原因及 notStarted，释放后续调度；不能冒充成功。修正后通过原界面明确重试，新消息引用 retryOf，Hub 按原输入去重。已启动但未知的执行仍 reconcile，不自动重放。恢复旧缺少执行记录的轮次时先用原子封存阻止迟到启动，再确认未启动；不能只靠“没找到文件”猜测。准备期间停止也阻止迟到启动 | electron/collaboration/unified-host.ts、station-service.ts、production-types.ts、coordinator.ts；services/remote/device/station_codex.py、task_journal.py、collaboration_store.py；UnifiedMeetingFrame.tsx；v2.schema.json |
| R2 依赖基线变化打断整个 pump | 保留批准计划的固定 SHA。依赖全部核验后，尚未分发且旧 SHA 过期的任务显示“等待基线修订批准”。原计划审阅显示旧、新 SHA、原因及受影响任务，用户先把准确新提交加入草稿，再按原计划批准入口提交；未加入时不能批准该修订。已分发任务只读，Hub 拒绝篡改设备、Agent、基线、依赖、原生身份和其他批准字段；旧计划留在原追加事件中。单个准备／等待／权限错误不再跳过其他任务、审批、停止和结果处理。等待由持久快照派生，重复 pump／重启不反复创建提案 | 新增 electron/collaboration/plan-revision.ts；station-service.ts；services/remote/device/collaboration_store.py；PlanMeetingModal.tsx、UnifiedMeetingFrame.tsx、UserTasksPanel.tsx、unified-meeting-store.ts |
| R3 业务 403 误撤销凭证 | Hub 业务拒绝返回 FORBIDDEN，认证拒绝返回 AUTH_INVALID；HTTP 及 WSS 按原因处理，暂不可用不作撤销。旧字符串 403 通过同 token 的快照验证分类。B 的协调设备专属成果核验入口禁用并解释原因，主进程也先检查。旧 credentialInvalid 使用原 token 核验服务端 identity 和完整快照，成功才恢复；离线、过期、真实撤销或设备不符不清除。不删除原 token、不重建设备 | connection.ts、station-service.ts、TaskInspector.tsx；services/remote/device/collaboration_routes.py、collaboration_store.py；公共错误及升级说明 |
| R4 中文／改名后 @ 误发 Host | 编辑器将选择保存为文本范围＋稳定 memberId/deviceId/Agent/确切 nativeSessionId；显示标签只展示。改名后仍向原身份发送。编辑破坏范围会清除绑定，残留未解析 @ 明确拒绝；删除整段后普通文字仍交 Host。离线、离会、无效会话在发送前提示并保留草稿，Hub 再核验账号、会议、设备和原生身份。附件异步发送保留相同绑定，单条多个不同目标仍拒绝，邮件地址不被当作点名 | 新增 src/lib/shared-mentions.ts；SideDrawer.tsx、UnifiedMeetingFrame.tsx、unified-meeting-store.ts；services/remote/device/collaboration_store.py |

普通群聊仍由原 Host 统筹；原参与者、Chat、任务与成果入口保留。批准计划、执行端目录／Agent 授权、模型工具审批继续分开。未新增发送对象下拉框，未静默更换设备，未给同一原生对话增加第二个写入者。

## Hub 与 MySQL 5.7

**需要更新匹配 Hub，不需要在 schema=2 的 station_hub 执行新增 DDL。** 新失败状态、retryOf、approvedPlanRevision 存在原实体 LONGTEXT，计划旧版本存在原追加事件；账号、凭据、设备、任务、授权及历史标识全部保留。

新特性为 unified-review-fixes-v1；新 Station 声明并要求匹配 Hub。旧状态继续兼容；出现新失败恢复消息时，不支持这些状态的旧客户端收到 426，防止错误恢复。旧 Bridge／原生接口保留。当前库若仍为 schema=1，则使用随包之前已存在的 MySQL 5.7 升级材料，不能将其误称为 .3 新增迁移。

禁止换 HUB_SECRET 或生产密码、删除或重建数据库、清表或要求全部重新配对。Station 仍只连接 Hub 的 HTTPS/WSS。升级前保留服务版本、非公开配置与完整数据库备份；推荐先 Hub、再相关 Station、最后四项验收及恢复接收。完整顺序、错误兼容、维护与回退见 [COLLABORATION_3_UPGRADE.md](../../services/remote/docs/COLLABORATION_3_UPGRADE.md)。

## 本轮验证

独立审查的四个复现已先转成断言正确行为的正式测试；修复前 4 项全部失败，原始日志 `pre-fix-regression.log` 保留。不是把“成功复现错误”算作功能通过。

以下为冻结来源的最终运行结果；原始记录统一在 `runtime/collaboration3-2026-10-22/`，交付时复制可公开证据到 `release/collaboration3-delivery-final/verification/`。历史 .2 的 1054 项仅作参考；本轮已重新运行同条件基线，实际仍为 1054／1015 通过／34 失败／5 跳过。

| 检查 | 本轮结果 |
| --- | --- |
| Renderer＋Electron 类型检查 | 最终两侧通过，typecheck-verified.log |
| 正式生产构建、原生接收组件 | 通过，build-verified.log、native-build-verified.log；保留 Vite 大 chunk 提示 |
| R1–R4 定向 Node | 15 项通过；另有原 Station 7 项定向测试，合计 22 项通过；含双 Station 服务＋生产 Hub HTTP/WSS、原凭证重连、实际输入准备及稳定载荷；模型传输／前序成果为明确确定性夹具，不冒充真实模型或 GitHub |
| 新 Hub 回归 | 12 项通过：4 项新链路＋8 项继承旧协议，SQLite／真实 HTTP/WSS；包含终态、重试、准确基线、批准历史、授权、过期／撤销及原生目标拒绝 |
| 原生 Guardian | 13 项通过，包含 Windows 临时读／替换锁有界重试、封存未启动、拒绝迟到执行、未知启动不误报、进程链清理及原兼容 |
| 真实 Codex 原统一链 | 通过；Host→明确批准→固定执行端→独立讨论；另独立核验确认最终正文与收据及两端成果逐字一致、textOnly 生效、线程分开。无用户项目写入或 GitHub 操作 |
| 完整 Node 与同条件失败比较 | 1069 项：1030 通过、34 失败、5 跳过；本轮基线 1054／1015／34／5。新增失败 0；34 项失败名称相同，忽略独立临时目录名后错误原因与代码相同。原始差异、原因对照及全部日志保留 |
| 原生会话、导出与公共契约 | 原生接续 33／33、导出 4／4、契约路径 5／5、基础契约 4／4；本轮日志分别保留 |
| MySQL 5.7 及升级保留演练 | MySQL 5.7.18 独立库通过：新增协议 12、统一协议 16、旧协议 8、Station 集成 7；身份／凭据／旧数据保留、SQL 可重复执行、版本保护和仅 DML 运行账号全部通过 |
| Windows NSIS、包内来源、实际安装载荷启动／重启 | 构建通过；实际 NSIS 解包，exe／asar／原生 helper 与构建一致，248 个编译文件逐一匹配；包内来源、自检和 Codex 版本核验通过。两个真实 Windows 安装载荷进程使用独立 profile、系统加密凭据，启动／重启身份恢复／WSS 重连通过。没有覆盖用户安装。安装器 NotSigned，无发布者签名 |
| Hub 包解包、入口、依赖、Docker 上下文、隔离启动 | 34 文件清单／Unix 权限通过；固定依赖匹配；根 Docker COPY 来源齐全；导出后生产 app 以独立 SQLite 完成 lifespan、/health、/ready。机器无 Docker 引擎，未实际构建容器镜像 |

UI 使用实际 React 原组件配合明确 DEV 夹具，已经核验：中文 @ 选中后改名仍提交相同稳定目标；发送前离线保留草稿且不发 Host；B 核验按钮禁用；计划准确 SHA 草稿修订及批准前禁用，已分发字段只读。截图带“界面交互夹具／无模型／无公网验收”，不代替实机。

## 四项简短人工验收

1. **R1**：发送未绑定资料给 Host → 看见未启动失败与原消息 → 发送合法纯文字应继续 → 修正后点明确重试，双击／重连只产生一次重试。实际执行未知时应继续核对。
2. **R2**：同初始 SHA 批准 A→B → A 经真实检查推进 verifiedCommit → B 等待可见修订，其他工作继续 → 原计划审阅核对准确新 SHA、加入草稿并批准 → B 从新 SHA 执行一次，A 历史字段不变。
3. **R3**：B 的核验入口禁用；隔离直接越权请求 403 后仍在线。同 token 查询与重连成功。给旧误标状态正常连接，应经服务端验证恢复；真实过期／撤销或不可达不得伪装成功。
4. **R4**：选择中文／空格／同名成员后改名再发，仍同设备；离线／移除／编辑破坏应拒绝并保留草稿。删除全部 @ 后普通文字归 Host；邮件不受影响；指定原生身份不被标题替换。

## 剩余现场与环境边界

- 用户目前只有这一台电脑；本机双进程、确定性适配器、SQLite/MySQL 测试及 UI 夹具不等于双物理 Windows 公网协作。
- 本任务明确不部署生产。现有微信云托管 Hub 可以继续使用；prod 是环境标签，不表示不能用。需要操作者按匹配包受控升级；本轮没有发布、重启、故障试验或修改生产数据库。
- 真实 GitHub 测试仓库的 PR、冲突、成果获取及用户 Codex 桌面的双向接续／停止／断联恢复，仍需指定账号／项目和现场条件；麦克风、屏幕、IDE、其他平台与其他 Agent 的全面硬件验收也未用夹具替代。
- 当前环境没有 Docker 引擎；Docker 构建上下文和导出启动已检查，Linux 容器构建／云托管启动仍需有引擎环境验证。

## 产物与来源一致性

本轮产物位于 `release/collaboration3-delivery-final/`，不覆盖 `release/unified-meeting-delivery/`：新版本 Windows x64 NSIS、匹配 Hub ZIP、源码 ZIP、SHA256、修复／升级说明及证据。源码包包括必要未跟踪实现、测试与文档，排除 node_modules、真实配置、凭证、数据库和临时运行文件。最终报告、源码导出和 SHA256 清单随本目录冻结。

## 中间运行与既有失败

首轮完整运行 candidate-node-final.log 为 1068 项、1027 通过、36 失败、5 跳过；两项新增问题没有计作既有失败：Windows 日志短暂共享锁已补有界读取／原子替换重试与真实锁回归；原测试“过期凭证点击连接自动换新”改为验证真实过期拒绝、原 token 保留，以及单独明确本机重新授权后身份／历史保留。这是 R3 要求的行为修订，不删除该测试。随后新增准确 Git 基线执行回归，重新构建原生组件、正式构建及安装器，完整复跑得到上表 1069 项结果。首轮日志和旧 .3 中间构建保留，release/collaboration3-delivery/ 标记不可作为最终交付。

34 项既有失败涉及当前 Windows 环境下的 ps／lsof、Kimi／Qoder 终端和转录、符号链接、fs.watch 等用例。逐项名称、原始错误及两轮原因对照见 verification/REGRESSION_FAILURES.md、baseline-comparison.json、failure-reason-comparison.json；未将它们泛化成全部同一原因，也未扩展重构这些无关模块。5 项跳过保留其外部条件，不计作通过。

原 .2 的 CHECKSUMS 中 27 个文件全部重新核对未变；本轮 593 个实现／测试／脚本文件在最终验证后重新核对冻结哈希一致。完整来源一致性见 verification/preservation-and-freeze-verification.json。
