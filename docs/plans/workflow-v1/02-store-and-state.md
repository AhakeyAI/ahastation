# 02 存储与状态

## 存储方案与所有权

V1 使用一个 userData/workflows/state.sqlite 数据库，主进程内的 WorkflowStore 为唯一写入口。选择 Electron 内置 node:sqlite 的 DatabaseSync，WAL、foreign_keys=ON，短事务执行。日志和二进制正文放数据库外部。

WorkflowStore 对外接口从第一版起为异步（返回 Promise），事务以“传入纯函数、由 store 串行执行”的形式提供，事务函数内不允许 await 外部 I/O。内部实现暂用 DatabaseSync；以后移到 worker_threads 或 utilityProcess 时，调用方不需要改写。

synchronous 默认 FULL。WAL 下的 NORMAL 在应用崩溃时不丢已提交事务，但在操作系统崩溃或断电时可能丢失最近的提交。如果丢失的是 outbox 意图或幂等记录，而对应的外部操作已经执行，恢复后就没有依据核对。因此：

- 创建或推进 outbox 意图、启动或停止进程、授予或撤销 Grant、交付与冻结状态变化、工作排队与领取、委派版本切换、提交成果版本或写入 Decision 的事务，一律以 FULL 提交。outbox runner 只派发已在 FULL 事务中提交的意图。
- P0-E 实测不达标时，先把 store 移出主线程，异步接口不变。
- 移出主线程后仍不达标，才允许对不产生外部操作的事务（进度事件、合并摘要等）在同一连接上切换为 NORMAL。之后任何一次 FULL 提交都会把此前的 WAL 内容一并刷盘，顺序不会颠倒；断电时最多丢失最后一段进度事件，不影响副作用的核对依据。node:sqlite 在 Node 24 仍属实验性 API，随 Electron 版本锁定并在升级时回归。

本机 Electron 的内存查询已通过，打包、WAL 与磁盘恢复尚待验证。DatabaseSync 是同步 API，禁止在事务内执行模型、Git、进程启动或等待文件上传。查询分页；主进程卡顿实测不达标时将相同接口移到单写线程。[Node 24 SQLite](https://nodejs.org/docs/latest-v24.x/api/sqlite.html)

路径为数据库所在的本机数据目录，工作流根目录只作为项目挂载。共享目录可位于选定根目录下，由显式配置定位，不能让 Worker 直接写 state.sqlite。

## 表与约束

| 表 | 主键及重要约束 |
|---|---|
| schema_migrations | version 唯一、应用时间、校验和 |
| workflows | id；canonicalRootKey 唯一；hostEpoch、revision、nextEventSeq |
| repository_mounts | workflowId + repositoryId；真实路径及仓库身份 |
| workers | id；workflowId；currentVersion、pendingVersion、profileState、revision |
| work_items | workId；workflowId、repositoryId、指定 Worker、queueSeq、待领取 spec、当前委派引用、currentPrDeliveryId、latestResultVersion、state、revision |
| delegations | workerId + version；workId、specJson/specHash 不可变；state、waitReason 为可变投影 |
| work_results | workId + resultVersion；精确委派、Candidate/Artifact、Verification、Delivery 和 PR 快照引用；发布后不可变 |
| native_sessions | id；backend、nativeId、cwd、恢复证据 |
| executions | id；workerId；processIdentity、nativeSessionId、state、revision |
| turns | id；executionId、delegationVersion、nativeTurnId、state |
| bridge_credentials | tokenHash 唯一；executionId、version、effectiveScope、status |
| requests | workflowId + actorId + requestId；inputHash、resultJson。actorId 取逻辑身份：Host 为逻辑 Host ID（不含运行代次），Worker 为 workerId，用户为本机用户主体 |
| events | workflowId + seq；eventId 唯一；schemaVersion、类型、实体版本、actor、payload |
| operations | operationId 唯一；请求主体、关联成员、当前步骤、状态、结果与待核对原因 |
| outbox | effectId 唯一；operationId + stepKey 唯一；effectType、payload、state、claimEpoch、receipt |
| subscriptions | workflowId + consumerId；lastAckSeq。只持久化 Host 收件箱和 Worker 指令队列的游标；界面订阅只在内存中维护 |
| messages | id；recipientWorker、delegationVersion、messageSeq、state |
| decisions / grants | id；问题答复绑定 question/version；成果决定按 workId + resultVersion 唯一；Grant 绑定准确动作和成果；撤销时间 |
| artifacts / candidates | id；不可变正文身份与元数据；发布阶段 |
| verifications / deliveries | id；workId、准确委派和成果、授权、目标版本与外部结果。PR 交付记录阻断原因和替换关系 |
| remote_head_owners | GitHub 实例 + head 仓库 ID + 规范分支引用唯一归属 workId，关联首次预留及外部写入或绑定证据 |
| pull_requests / pull_request_bindings | PR 按 GitHub 实例、base 仓库 ID、PR 编号唯一归属 workId；每个 Delivery 至多绑定一个 PR |
| pull_request_snapshots | snapshotId；PR 身份、实际 base/head、状态、观察时间、Diff 哈希和不可变正文引用，见 05 |
| leases / wait_conditions | id；资源或等待条件；持有者、状态及引用版本；同一委派可有多个未解决阻断项 |

通过部分唯一索引限制每个 Worker 至多一个未退出的 Execution、每个 Execution 至多一个 active/interrupting/unconfirmed Turn。unknown Execution 仍视为占用；exited 和 abandoned 不占用。每个 Worker 的 pendingVersion 只允许指向一个 pending 记录。不同后端内部 subagent 不进入 workers 表。

workflowRoot 使用真实路径及平台目录身份去重，大小写按卷语义处理。根目录移动属于显式重新绑定，保留 Workflow ID。数据库 ID 不由路径哈希生成。

Delegation spec 不可变，状态字段可更新。Turn 是历史记录，Execution 退出后仍保留 Turn，并在同一处理流程中补充其停止结果或 unconfirmed 证据。

## 稳定工作身份与队列

Work 是 Host 派发的一个完整目标在服务里的记录。创建时生成 `workId`，固定工作流和仓库；独立新目标获得新 ID。修订、返工和整体交接沿用原 ID，各自保留准确的 `workerId + version`。从旧链接读取问题、授权、报告及原生历史时，按原记录及其 Work 查询。原生报文的 `workId` 由服务从绑定委派推导。

指定同一 Worker 的多个工作按 `queueSeq` 排队。创建工作与记录队列同事务提交。领取时在单写事务中检查 Worker 无开放委派、无在途投递且旧轮次已静止，再写唯一领取记录、`pending` 委派及启动意图。一个 Work 至多一个生效委派，可以有同一 Work 的一个待生效修订。独立排队项领取时才占用 `pendingVersion`。启动结果不明按原操作核对，队列保持原归属。

独立代码工作按 workId 使用各自的服务管理 worktree。领取后先核对基线和可写路径，再投递完整委派。需切换 cwd 时，按 01 停止原 Execution 后恢复或替换 NativeSession。原工作的冻结成果和写入目录保持独立，可供退回与交接引用。

当前委派交回成果后，服务在同一事务中封存 WorkResult、结束该委派，并将 Work 置为待用户验收。Worker 可领取下一项。用户退回时，决定和反馈留在原 Work，Host 用原 `workId` 安排返工，旧成果及其决定可查。返工或改派在该 Work 的证据和工作目录上展开；若 Worker 在执行其他工作，返工按独立队列等待。

## 单次命令事务

1. 根据连接确定 actor，校验 schema 和当前访问权。
2. BEGIN IMMEDIATE，读取 requests。相同身份与 requestId 内容相同返回原结果，内容不同返回 REQUEST_ID_CONFLICT。
3. 校验 expectedRevision、Host epoch、workId、委派或成果版本、Grant 及允许的状态迁移，按命令涉及的实体核对。
4. 写投影更新，分配事件序号，写 event、requests.result 和 outbox 意图。
5. COMMIT 后发送 UI 通知和启动 outbox runner。

事件、投影、幂等回执和意图要么全部存在，要么全部不存在。原回执返回不代表重新授权外部副作用；runner 在实际执行前重新核对未撤销且版本匹配的 Grant。

outbox runner 在单写事务中领取副作用步骤，保存 claimEpoch 和 processing 状态。同一 effectId 同时只有一个执行者；回执携带领取代次，旧代次不能覆盖新事实。多步骤操作保存相同 operationId，各步有稳定 stepKey，前一步结果持久化后才创建下一步意图。处理者失联或租约超时后，该步骤进入 uncertain 并先核对外部状态；仅在证明未执行或操作本身可安全幂等时重试。

Grant 的撤销与外部操作开始以事务中的 dispatching 记录为边界。撤销成功阻止尚未开始的操作；已进入 dispatching 的操作显示正在执行或结果待核对，继续尝试停止并保存实际结果。已经发生的提交和推送不能靠撤销记录回滚。

GitHub head 的归属和推送租约按规范化远端引用在本机所有工作流间共用。PR 交付在推送授权事务中预留 head，外部写入开始事务重新核对归属和当前交付。换分支确认时以 Work revision 校验并切换 `currentPrDeliveryId`，同步撤销旧交付尚未开始的写入步骤。后续回执按原 Delivery ID 保存，封存只读取当前交付。具体规则见 05。

进程、Git 和文件操作通过 operationId 执行。数据库与外部系统无法同事务，所有操作定义 reconcile。结果未知时置 uncertain，核对完成前停止重放该操作。

## 完整状态迁移规则

所有非表内状态迁移拒绝，包括本节后面的辅助对象表和 05 的 Delivery、冻结状态表。相同事件的幂等重放不生成第二次迁移。

| 对象 | 起点 → 终点 | 条件 |
|---|---|---|
| Worker | idle → engaged | 已领取一个 Work 并保存 pending 委派 |
| Worker | engaged → idle | 当前及 pending 委派均终结，当前轮次静止 |
| Worker | idle/engaged → archived | 开放委派和该成员的排队工作均已处理，全部 Execution 已退出，否则返回仍待处理项 |
| Work | （新建）→ queued | Host 派发完整目标及指定 Worker |
| Work | queued → queued | Host 显式改派，同一 workId 移入接手 Worker 的队尾，领取和改派按 Work revision 互斥 |
| Work | queued → in_progress | 领取成功，创建首个或返工委派 |
| Work | in_progress → in_progress | 当前 PR 交付受阻时可重新核对。用户确认替换目标的推送授权后，在事务中更新当前交付和 Work revision |
| Work | in_progress → awaiting_acceptance | 当前委派已验证，必要交付已核对，轮次及写入静止，无在途修订。PR 快照须来自当前 Delivery。事务封存新 WorkResult 并结束当前委派 |
| Work | awaiting_acceptance → awaiting_acceptance | 已绑定 PR 的 head 仍为原交付提交，服务核对新 PR 快照和受影响的验证，封存新成果版本并保留旧版 |
| Work | awaiting_acceptance → completed | 用户对当前成果版本选择接受，版本和必要交付核对通过 |
| Work | awaiting_acceptance → changes_requested | 用户针对当前成果版本选择退回并给出原因 |
| Work | changes_requested → queued | Host 指定 Worker 和返工 spec，同一 workId 写新排队顺序 |
| Work | queued/changes_requested/awaiting_acceptance → cancelled | 显式取消，移除排队资格，保留成果与交付事实 |
| Work | in_progress → cancelled | 当前工作和委派已安全取消，旧轮次静止，未开始的交付步骤已撤销，已发生或不明的副作用继续按原操作核对 |
| Delegation | pending → active | 原生接收确认及版本切换事务成功 |
| Delegation | pending → cancelled | Host 撤回未生效修订；或首个委派因启动失败迟迟未被接收，由 Host 或用户取消。启动失败本身只产生 failure 事件，不自动迁移 |
| Delegation | pending → superseded | 尚未投递的 pending 修订被新的修订按预期版本替换 |
| Delegation | active → waiting | 已登记问题或等待条件 |
| Delegation | active/waiting → candidate | 成果就绪、写入冻结且未决阻断已处理 |
| Delegation | candidate → verified | 所有必需 Verification 对相同成果版本有效 |
| Delegation | candidate → active | 验收失败、请求继续或新写入 |
| Delegation | verified → done | 封存 WorkResult 的事务完成，Worker 本次执行结束 |
| Delegation | verified → waiting | 缺少交付授权或资源 |
| Delegation | waiting → verified | 所有阻断项均解除，等待的仅是交付授权/资源，原验证仍有效 |
| Delegation | waiting → active | 所有阻断项均解除，需 Worker 继续执行，收到有效答复/继续处理回执 |
| Delegation | verified → active | 内容改变或目标前进需重新集成 |
| Delegation | active/waiting/candidate/verified → superseded | pending 新版本接收成功，旧轮次静止 |
| Delegation | active/waiting/candidate/verified → handed_off | 交接候选与接手委派已保存，旧写入确认停止 |
| Delegation | 开放状态 → cancelled | 取消意图保存、原执行静止；未知执行先保持取消中投影 |
| Execution | starting → running/unknown/exited | 启动证据、结果不明或确定失败 |
| Execution | running → stopping/unknown/exited | 显式结束、失联或已确认退出 |
| Execution | stopping → exited/unknown | 退出证据或失去确认 |
| Execution | unknown → running/exited | 原身份核对成功 |
| Execution | unknown/stopping → abandoned | 用户确认放弃无法核对的执行，见 01；记录剩余风险，释放唯一约束 |
| Turn | （新建）→ active | 原生输入接收证据或用户手动轮次的开始证据 |
| Turn | active → interrupting/stopped/unconfirmed | 中断请求、完成核对或证据不足 |
| Turn | interrupting → stopped/unconfirmed | 停止核对结果 |
| Turn | unconfirmed → stopped/active | 证明停止，或证明原轮次仍在执行并由 Host 继续 |
| Turn | active/interrupting/unconfirmed → stopped | 所属 Execution 确认退出（进程树退出证据） |
| Turn | active/interrupting/unconfirmed → abandoned | 所属 Execution 被用户放弃 |
| Message | persisted → deferred/delivered/rejected | 投递能力、回执或范围校验 |
| Message | deferred → delivered/rejected | 条件恢复或版本过期 |
| Message | delivered → consumed | 明确处理回执 |

辅助对象的迁移：

| 对象 | 起点 → 终点 | 条件 |
|---|---|---|
| Operation | pending → running | 首个步骤被领取 |
| Operation | running → completed/failed/uncertain | 全部步骤完成、确定失败或某步结果不明 |
| Operation | uncertain → completed/failed/running | 核对得出结果；证明未执行且可安全重试时回到 running |
| Operation | pending → cancelled | 尚未开始任何外部步骤时取消 |
| Outbox | pending → processing | runner 在事务中领取并写入 claimEpoch |
| Outbox | processing → done/failed/uncertain | 带当前 claimEpoch 的回执；租约超时进入 uncertain |
| Outbox | uncertain → done/failed/pending | 核对外部状态；证明未执行时回到 pending |
| Outbox | pending → revoked | 关联 Grant 撤销或操作取消，且尚未进入 dispatching |
| WaitCondition | open → satisfied | 引用的精确成果版本、答复或授权出现 |
| WaitCondition | open → invalidated | 引用的委派版本或成果被替代，由 Host 重新设置 |
| WaitCondition | open → cancelled | Host 撤销等待 |
| Question | open → answered | 用户或 Host 的答复已保存为 Decision |
| Question | open → expired | 绑定的委派版本已终结 |
| Question | open → withdrawn | 提问方或 Host 撤回 |
| Grant | active → consumed | 绑定的一次性动作已执行并有结果 |
| Grant | active → revoked/expired | 用户撤销，或绑定的 Candidate、目标提交、委派版本失效 |

收到停止指令但执行未确认时，在操作进度显示 stopping，业务取消尚未完成。归档不得掩盖开放委派。V1 的归档为持久终态，历史可查，重新激活需后续明确产品动作。

idle 表示无待完成工作；进程可以仍驻留。重启不把 unknown 自动改成失败或 idle。输入新代码可能使候选过期，检查当前内容后再发起验证。

waitReason 是全部未解决 wait_conditions 的界面摘要，不能作为唯一状态。问题回答、成果到达和授权分别解决绑定的条件，服务重新计算是否具备继续条件。候选验证和资料发布需保留具体版本，条件满足事件重放不会再次发送继续指令。

done、cancelled、handed_off 和 superseded 的委派历史保持终态。已交回成果的成员终端仍可查看和进行原生交互。新的实际工作需归属到新工作或当前已退回的工作，并建立新委派版本。运行门禁可验证时，在新模型轮次执行前完成版本建立；门禁不可验证且用户仍直接启动原生执行时，标记为人工执行待归属，独立记录 Turn，暂停自动编排。归属明确前，该执行的报告只作为人工历史保存。

## 文件与数据库一致性

Artifact 先写同卷临时文件、核对哈希、flush，再原子改名为内容寻址对象，最后事务保存可见元数据。崩溃留下的未引用对象由显式维护流程处理，仍在引用的证据不会删除。

Candidate 与 Delivery 保存 intent，创建 Git 对象和引用后再写完成事实。恢复按预定对象 ID 和哈希核对。PR 差异正文按 Artifact 的同卷写入及哈希核对规则保存，事务引用已落盘快照。事件不存凭据明文和无界终端日志。

## 启动恢复与迁移

先取得应用及数据库单写锁，检查 schemaVersion 和上次正常关闭标志，再恢复 projections、outbox、subscriptions、unknown executions。确认数据库可写后才启动任何模型。

旧 MeetingRepository 数据按来源 ID 建唯一 migration_map。迁移输出与旧记录分开，导入事务记录已导入事件游标；重复导入返回相同映射。不能确定成员身份或实际执行的记录转为待核对。切换某工作流到新服务时冻结旧调度入口，该工作流只允许一个调度者。

有明确旧任务 ID 的记录按来源工作流和旧任务 ID 映射到一个 `workId`，可核对的委派和成果沿用此映射。旧 `done` 或 Git 成功只保留为原事实。仅在存在对应成果版本和明确用户接受证据时导入为 `completed`，其余留作只读待核对历史。导入历史不自动入队或重放 GitHub 动作。

每次 schema 升级先做一致性备份，迁移版本化，失败回滚。普通复制正在使用的 SQLite 文件不足以产生一致备份。旧程序发现更新 schema 时停止写入。

## 验收

ST-01 事务任意点崩溃后事件/投影一致；ST-02 同 request 并发调用只产生一个 Worker；ST-03 request 内容冲突拒绝；ST-04 外部操作成功但回执前崩溃可核对；ST-05 重启后 unknown 不重复启动；ST-06 重放投影与当前状态一致；ST-07 pending 修订取消不改变当前版本；ST-08 验证后授权等待能继续交付且不重跑 Worker；ST-09 磁盘满时新执行停止，已有进程与停止入口仍可核对；ST-10 Host 运行代次变化后重放同一工具调用命中原结果；ST-11 abandoned 执行释放唯一约束且证据可查；ST-12 辅助对象的表外迁移被拒绝；ST-13 目标平台上提交延迟和主进程卡顿满足 P0-E 要求。

ST-14 队列领取与启动意图在重启后保持同一 workId，两个领取者不能重复分配；ST-15 封存成果、委派结束和待用户验收同事务恢复；ST-16 对同一成果并发接受与退回只写一个决定；ST-17 历史导入保留工作归属，无准确接受证据时保留待核对状态。
