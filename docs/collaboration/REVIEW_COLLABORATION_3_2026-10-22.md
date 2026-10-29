# collaboration.3 独立复审（2026-10-22）

结论：原 R1–R4 的主要复现路径已修复，但尚不足以满足完整交付要求。独立补查发现三个待修复点，涉及独立讨论与 Host 隔离、异步消息发送、计划修订草稿。此次只添加审查记录与隔离复现材料，没有修改产品代码、重新打包或部署。

审查工作树：`C:/Users/79142/.codex/worktrees/collaboration-baseline-upload/station-ctrl`，`etrnal-dev`，版本 `0.19.0-collaboration.3`。

## 待修复项

### F1 / P1：Host 互斥范围包含独立专家讨论

位置：`electron/collaboration/station-service.ts:288`；相关讨论状态与恢复位置为 479、493、561 行。

新的非终态检查只判断同会议，没有限制 `message.route === 'host'`。本机专家讨论也把状态存入 `hostMessages`，因而一个独立的专家对话会阻止 Host 处理其他输入；它们不是同一原生线程，不应共享此互斥。

独立内存快照调用生产 `doPump()`：本机专家为 starting 时，另一条 Host 输入启动次数为 0；专家改为 completed 后为 1。另核验 reconcile + 仍保留 hostScheduled 的状态，恢复检查次数为 0、Host 启动次数仍为 0。`discuss()` 的失败分支会保存 reconcile，但结束时没有删除对应调度标记；因此此前可不影响 Host 的专家异常会被新的检查扩大为会议阻塞。

建议将 Host 轮次串行限制在该会议真实 Host 执行流，独立专家讨论使用自己的串行与恢复规则。修正调度标记生命周期时仍须保留实际未知执行的核对约束，不能把未知执行当作空闲。

回归应覆盖本机专家正在执行及准备失败时 Host 仍可响应；同一 Host 的两个输入继续串行；确实共享一个原生对话的工作继续防止第二个写入者。

### F2 / P1：异步发送可重复提交，并清空发送期间的新草稿

位置：`src/components/SideDrawer.tsx:540–556`、577、930–939 行；`electron/collaboration/station-service.ts:160–169`。

发送处理现在等待 `onSend()` 成功再清空文本，改善了失败保留草稿，但没有发送中的同步防重入保护。发送按钮和 Enter 均可再次进入 submit。生产主进程为每次 message.send 分配新的 requestId，并刻意不按文本去重，因此两次调用是两条业务消息，可能触发两次 Host/Agent 执行。

使用实际 React SideDrawer 与明确 DEV 界面夹具，将 message.send 响应延迟 1.2 秒后连续点击两次，捕获 2 次发送，存下不同 ID 的 `message-1`、`message-2`。另在第一条消息等待期间输入新草稿，响应成功后的无条件 `setText('')` 将其擦除。

建议按一次提交捕获文本、@ 绑定、附件及明确发送身份；同步防重入，等待期间允许编辑时仅清除仍对应已提交版本的草稿。已保存但投递结果未知的重试应核对并复用原提交身份，不能靠全局相同文本去重。保留失败草稿和目标准确性。

回归应覆盖双击、连续 Enter、发送中编辑、失败及结果未知重试，并验证最终业务消息及执行次数。

### F3 / P2：相同状态刷新也会丢失尚未批准的基线修订

位置：`src/components/PlanMeetingModal.tsx:112–118`；`src/components/UnifiedMeetingFrame.tsx:22`、`src/lib/unified-meeting-store.ts:18–19`。

UnifiedMeetingFrame 按 meeting 对象引用生成 tasks；刷新会读取新的快照对象。PlanMeetingModal 的 effect 依赖 tasks/brief/backends 引用，每次又从服务器计划重建 draft，即使批准计划内容完全没变，也会覆盖用户正在审阅的修改。

实际 React 复现：选择“夹具：依赖基线”→打开原计划→将准确新提交加入修订→只调用 refreshShared() 获取相同快照。修订提示从“修订已加入草稿”退回“尚未改变获准基线”，本地修改丢失。真实 Hub 的设备心跳也会追加设备状态事件，因而这不是只有主动改名才出现的问题。

建议按稳定计划版本或内容管理审阅草稿。无关状态变化保留草稿；真正计划冲突明确告知用户并处理版本，不要静默覆盖。保留 expectedRevision 和已分发字段的服务端校验。

回归应覆盖相同快照、心跳、改名及其他任务状态变化，核验用户编辑不丢；真实计划变更应提示冲突，不能提交过期版本。

## 本次实际验证

- Renderer 与 Electron 类型检查通过。
- `collaboration-review-fixes.test.mjs` + `unified-meeting.test.mjs`：24 项通过，0 失败、0 跳过，启用了本机双 Station + 生产 Hub HTTP/WSS 的隔离联调用例。
- `test_collaboration_review_fixes.py`：12 项通过，独立 SQLite/HTTP/WSS。
- `test_station_codex_guardian.py`：13 项通过，隔离进程树与日志封存。
- 额外实际 React 界面复现确认 F2、F3；生产编译服务的内存快照复现确认 F1。它们是问题证据，不算产品功能通过。
- 最终包 CHECKSUMS 的 34 个文件全部匹配；冻结清单 593 个源码文件全部匹配。
- .3 源码 ZIP 内所审查的实现与当前源码一致；Hub 清单的 34 个文件通过，关键 Hub 源码与当前一致。
- 最终 .3 的 app.asar 哈希为 `36cbacd8f6fe796ecf97488dc4c8c03478683250296c6dbd8459352ed2d78e20`，与安装载荷记录一致；当前测试所用五个关键 Electron 编译模块与该 asar 内逐字节一致。
- 重新解包 Hub，检查清单、权限、固定依赖、路由、Docker COPY 来源，并用独立 SQLite 启动导出后的生产 app，health/ready 通过。未实际构建 Docker 镜像。

原四项判断：R1 已解决 Host 启动前失败的原路径，但 F1 是相关互斥回归；R2 的固定提交修订、服务端校验和独立调度已通过定向验证，但 F3 影响可用的审阅闭环；R3 的业务 403、原凭证恢复和真实失效分类通过；R4 的稳定身份、改名、离线和失效目标通过，但 F2 影响消息提交可靠性。

本轮未重新运行 1069 项全量测试、真实模型、MySQL 演练、安装器构建或用户安装。交付证据记录的 1069／1030 通过／34 失败／5 跳过不是本轮复跑结果，34 项失败仍不能算作通过。尚不能保证所有原功能完全不受影响。

## Hub、数据库与现场边界

本次审查没有发现四项修复必须新增 MySQL 表结构的证据；.3 的数据库结构相对 .2 没有新增 DDL。仍应使用现有 MySQL 5.7、station_hub 与原身份数据，部署匹配 .3 Hub，按升级说明先备份。F1–F3 主要在 Station，消息幂等若扩展契约需同步 Hub 并兼容原数据，不能用清库或放松授权解决。

真实双物理电脑／公网、实际 GitHub PR 与用户 Codex 桌面的接续／停止／断线，以及 Linux 容器构建仍需现场验证。此次未改动生产库、部署、密钥或用户应用。审查创建的临时浏览器与 Vite 均已退出。

## 可复现材料

- `runtime/review-collaboration3-2026-10-22/reproduce-ui.cjs`、`RESULT.json`、`plan-reset-on-identical-refresh.png`。
- `runtime/review-collaboration3-2026-10-22/reproduce-scheduling.mjs`、`SCHEDULING.json`。
- `runtime/review-collaboration3-node.log`、`runtime/review-collaboration3-hub.log`、`runtime/review-collaboration3-guardian.log`。
- `runtime/review-collaboration3-2026-10-22/hub-export/deployment-verification.json`。

UI 脚本自行创建并关闭隔离 Vite/Chrome：`node runtime/review-collaboration3-2026-10-22/reproduce-ui.cjs`。调度脚本按仓库 Node 测试方式加载 `tests/electron-stub.mjs` 后运行，不连接用户 Agent 或生产 Hub。
