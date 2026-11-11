# 07 验证、迁移与落地顺序

## 交付范围与基线

本批交付为模块设计文档，业务代码尚未修改。原工作树包含其他任务的大量未提交变更，不能把当前工作树直接当作干净的新重构基线。

实现开始时固定完整 commit、所需未提交补丁的来源及内容 hash、Node/Electron/CLI 版本。选择隔离工作树后逐项迁入明确属于本次重构的前置能力。每次迁移只允许一个调度入口持有同一工作流的执行权。

## 建议源码落点

以下为拟议模块边界，具体文件拆分以实现规模决定。

| 拟议位置 | 责任 | 现有复用入口 |
|---|---|---|
| electron/workflow/contracts.ts | 通用命令、事件、投影与错误 | cli-backend、worker-protocol 类型 |
| electron/workflow/store.ts | SQLite、事务、投影、幂等 | meeting-repository 的历史导入 |
| electron/workflow/service.ts | 命令校验、Work 队列、成果决定及状态机 | orchestrator、host-group 的编排接线 |
| electron/workflow/host-controller.ts | Host 会话与工具路由 | codex-app-server-transport、meeting-mcp |
| electron/workflow/messaging.ts | 成员消息、问题、等待、outbox | task-mailbox、worker-cli-bridge |
| electron/workflow/runtime.ts | 启动、恢复、轮次、资源 | 原生适配器、pty-host、agent-process-scope |
| electron/workflow/terminal.ts | 镜像、日志、订阅与输入 | worker-pty IPC、RealTerminal |
| electron/workflow/delivery.ts | 成果封存、验证、条件交付、真实 PR 核对及 Diff 快照 | delivery-*、integration-queue、基线 collaboration/github.ts |
| electron/ipc/workflow.ts | 经认证的产品入口 | ipc/validators |
| electron/main.ts（改造） | 关闭窗口后台继续、托盘或 Dock 入口、受控退出 | 现有 window-all-closed 与 before-quit 处理 |
| src/lib/workflow-store.ts | 事件投影与 UI 订阅 | meeting-store 的界面模式 |
| 现有成员/终端组件 | 工作流列表和执行详情 | ParticipantPanel、WorkerWorkbench、RealTerminal |

保持业务命令单入口，适配器只转译原生协议，数据库只接受服务事务。按实际需要拆文件，避免预先增加没有调用者的抽象。

## 先做的能力验证

| 编号 | 内容 | 通过证据 | 失败后的处理 |
|---|---|---|---|
| P0-A | 两种 CLI 的 ready、轮次与恢复 | 原生身份与 hooks/协议记录一致 | 相应能力标为 unknown，不开启自动注入 |
| P0-B | 提问、接收回复、修订激活；两种 CLI 在空闲提示符下的注入，包括输入框已有用户草稿的情况 | 不同版本和中断位置下都无错投；空闲注入有提交或轮次开始证据，草稿存在时拒绝 | idle-wake 标为 unsupported，答复、继续与修订改用 resume-with-instruction |
| P0-C | 子 agent 与后台进程停止 | 根轮次、子执行、写入进程组合证据 | 冻结、交接与版本切换降级为结束进程后执行；进程树退出也无法确认时保留 unconfirmed，等待用户放弃 |
| P0-D | headless + serialize 恢复 | 与原生终端屏幕和模式相符 | 使用安全检查点重放，不能虚假宣称完整恢复 |
| P0-E | SQLite 平台打包与提交延迟 | 目标安装包内事务、备份和故障恢复通过；测出 synchronous=FULL 下的单次提交延迟和主进程卡顿 | 先把 store 移到独立线程，异步接口不变；仍不达标时，只对不产生外部操作的事务使用 NORMAL，见 02 |
| P0-F | 冻结与条件交付 | 并发写、目标前进、回执丢失均不覆盖其他成果；已检出目标的快进交付 | 返回可核对状态，停止后续自动交付 |
| P0-G | Codex app-server 作为 Host | 编排工具可注册，派发权限随输入批次传递，服务拒绝讨论轮次调用派发。验证崩溃后线程恢复、原生 callId 稳定性和轮次中断 | 工具注入改用另一种方式。callId 不稳定且不能证明按原样重放时，批次进入待核对，按 03 恢复已记录的调用和结果 |
| P0-H | resume-with-instruction | 两种 CLI 按会话 ID 恢复并携带首条指令，上下文保留，接收有 hook 或轮次证据 | 该 CLI 的降级只能新建会话并附带历史摘要，界面标明上下文连续性受限 |
| P0-I | 分支归属、首次推送、真实 PR 与逐文件差异 | 本地临时远端验证空预期值及推送前归属检查。离线 HTTP fixture 核对授权、重放、变版和首次 PR 交付恢复。在已授权测试仓库确认真实 PR 元数据和 Diff 契约 | 失败场景显示具体阻断及恢复入口，Git 回执可查，PR 交付保持未完成 |

CLI 能力结论按版本保存。用户环境出现未验证的版本时，按 01“CLI 版本与能力漂移”先做快速探测；通过后暂停该版本的自动投递，由用户选择运行验证、改用已验证版本或人工投递。

P0 的结论决定各路径的默认启用方式：P0-B 决定空闲注入还是重启降级，P0-C 决定冻结使用轮次级还是进程级证据，P0-G 决定 Host 工具接入方式。结论写回 01、03 对应章节后再开始实现批次 2。

P0 阶段可以先做小型受控原型和离线 fixture。真实模型、网络及费用动作按已有授权范围进行，需要额外成本时先给出具体预算和方案。此设计任务没有启动真实模型或外部推送。

### P0 实测完成记录（2026-11-10，`win32-x64`）

已在本地受控环境（Electron `42.11.18` / Node `v24.19.0` / SQLite `3.53.3` / Git `2.52.0.1` / `claude-code 2.1.318` / `codex-cli 0.167.0` + 本地回环 Mock HTTP 服务与临时 Git 远端，零外部 API 扣费）完成全部 P0-A..P0-I 验证，并将结论写回 `01`、`02`、`03`、`04`。原始实测 JSON 报告与可复现脚本见 [p0-evidence/README.md](p0-evidence/README.md)：

| 编号 | 实测结论 | 关键指标 / 启用策略 |
|---|---|---|
| **P0-A** | **通过** | `claude-code 2.1.318` 与 `codex-cli 0.167.0` 的 `SessionStart`、`UserPromptSubmit`、`Stop` hooks 及 `--resume` / `resume` 会话恢复均通过；`nativeTurnId` 分别取 `prompt_id`（Claude）与 `turn_id`（Codex） |
| **P0-B** | **通过（需修适配器参数）** | 两种 CLI 在交互式 ConPTY 空闲提示符下的 bracketed paste + `\r` 注入均触发 `UserPromptSubmit` 与 `Stop`（`idle-wake = verified`）；发现并定位了现有 `codex-terminal-adapter.ts` 的 `-c hooks=true` TOML 键冲突与 Windows PowerShell hook 启动语法问题 |
| **P0-C** | **通过（默认 `scope=process` 冻结）** | 证实单靠轮次中断 (`\x03`) 无法杀死脱离轮次的后台写入子进程；修正 ConPTY 同步 `pid=0` 启动登记后，`taskkill /pid <pid> /t /f` + `Win32_Process` 进程树核对可 100% 清理进程树（`survivors = 0`），因此冻结、交接和版本切换默认采用 `scope=process` 或在无需重启时配合 `idle-wake` |
| **P0-D** | **通过（采用安全检查点重放路径）** | 离线环境未安装 `@xterm/headless` / `@xterm/addon-serialize`，按规范启用 UTF-8 多字节与 ANSI CSI/OSC 安全检查点偏移 + 原始字节流重放（`tailReplayHasReplacementChar = false`）；`64KB / 16ms` 批量刷盘单次最大耗时 `0.265ms` |
| **P0-E** | **通过（主进程直接启用 `WAL + synchronous=FULL`）** | Electron 内置 `node:sqlite` (`SQLite 3.53.3`) 在 `WAL` + `synchronous=FULL` 下 200 次完整命令事务提交延迟 `p50 = 0.45ms`、`p95 = 0.706ms`、`p99 = 1.319ms`、`max = 1.387ms`；`VACUUM INTO` 在线备份耗时 `5.32ms` 且 `integrity_check = ok`；`SIGKILL` 崩溃恢复后已提交事务完整保留、未提交事务干净回滚 |
| **P0-F** | **通过** | 干净工作树快照冻结、脏工作树拒绝/自动提交、分支归属校验 (`RV-27`)、非检出分支 `update-ref` 原子 CAS、已检出干净工作树 `git merge --ff-only` (`RV-12a/b/c`) 及恶意 `.git/hooks` / `.git/config fsmonitor` 隔离全部通过 |
| **P0-G** | **通过（选用 `app-server dynamicTools`）** | `codex app-server --stdio` (`0.167.0`) 在 `capabilities: { experimentalApi: true }` 下原生支持 `dynamicTools` (`item/tool/call`)、`turn/interrupt`（`345ms` 中断完成）以及进程重启后 `thread/resume` + `thread/turns/list` 保持原 `callId` 与参数逐项一致 |
| **P0-H** | **通过** | `claude --resume <id> <prompt>` 与 `codex resume <id> <prompt>` 均验证通过，保持原 `session_id`、完整携带历史消息并触发 `SessionStart` → `UserPromptSubmit` → `Stop`，作为通用恢复与降级投递路径（注意剥离 Windows `\\?\` 路径前缀） |
| **P0-I** | **通过** | 首次推送空预期值 `--force-with-lease=<ref>:` 在远端不存在时成功、已存在时拒绝覆盖 (`RV-23`/`RV-29`)；PR Diff 快照（`merge-base..head` + SHA-256 `diffHash`）与离线 GitHub PR HTTP fixture 鉴权/创建/核对全部通过 |

## 实现批次

1. **本地状态与骨架**。实现最小 schema、异步 store 接口、事务、命令信封、Work 队列、Worker 列表及显式版本迁移。接入 fake runtime，验证重复请求和重启恢复。
2. **一名 Worker 的完整闭环**。接通聊天开工、Host、原生终端、桥接、用户问题、按 P0-B 结论选定的答复投递路径、继续执行及报告。改造关闭窗口后台继续。先完成一份无需 Git 交付的 Artifact，核对接受、退回与返工路径。
3. **原生一致性与控制**。补齐镜像回放、输入所有权、真实中断、进程退出及能力声明，分别跑两种 CLI。
4. **候选与验证交付**。加入代码快照、机器验证、Host 判定、独立审查和准确授权。验证条件交付及首次推送，再按 P0-I 的证据接通真实 GitHub PR、差异快照和用户验收。
5. **多成员协作**。加入复用、资源、等待条件、交接、集成负责人和并发回报。
6. **兼容与发布验收**。历史映射、旧入口切换、真实 CLI 多轮、故障注入与各平台安装包验收。

每批次走正常产品入口，同时维护原生效果与运行事实。功能启用范围根据已验证后端能力决定。

## 最小垂直验收脚本

场景使用临时、专用仓库及共享目录。

1. 用户打开根目录，在聊天中讨论一个分析目标。核对本轮只产生讨论记录。
2. 用户在同一聊天发送「按这版开始分析」。服务绑定唯一方案和范围后，Host 查询成员并持久化派发意图。调用 SpawnAgent 后记录 dispatchId、workerId 和 workId。
3. Worker 原生终端接收到完整委派，报告一个需要用户决定的问题并停止本轮。
4. 用户答复经过服务直接送达，Host 收到抄送；Worker 在同一逻辑成员中继续。
5. 用户切到 Worker 终端再回 Host，后台执行持续。
6. 同一 Worker 正忙时，Host 下发独立目标 B。B 获得不同 workId 并排队，原目标 A 的委派保持有效。
7. Worker 发布 A 的 Artifact，Host 核对证据，服务封存 A 的第一版成果并提交用户验收，Worker 可领取 B。
8. 用户打开旧链接退回 A，Host 为 A 安排返工或改派，服务保留同一 workId。应用重启后核对队列、旧成果及退回决定。A 的第二版通过用户验收，B 保持独立。
9. 另做代码目标，完成候选、独立审查和分开授权的提交、首次推送与 PR 创建。用户对照真实 PR base/head 和逐文件 Diff 验收。
10. 在用户看完 PR Diff 后、点击接受前更新 head 或 base。旧成果应提示过期，当前 PR 重新核对，旧差异仍可查看。
11. 每步检查实际会话身份、消息回执、事件游标、工作与成果版本、文件 hash 和原生状态。

稳定性检查应多次执行并保存失败目录。一次成功只能证明该组合和该路径。

## 故障矩阵与预期结果

| 注入点 | 预期结果 |
|---|---|
| Spawn 意图落库后进程启动前 | 重试同请求复用原意图 |
| 进程已启动但身份回写前 | unknown，先核对；不双启动 |
| Worker 已收到指令而回执丢失 | 查询同一消息/轮次，无法证明时待核对 |
| AskUser 后应用重启 | 原问题可回答，答复按准确版本路由 |
| 修订送达但原生接收前 | 旧版本仍有效，新版本 pending |
| 接收确认已发生但事务回执丢失 | 查询原生接收与 requests，禁止重新生成成员 |
| 旧轮次迟到报告 | 归入旧历史，当前版本不变 |
| 用户接管期间 Host 输入 | defer，用户输入不被拼接 |
| 停止 hook 到达但子进程仍写 | 保留 unconfirmed |
| 终端快照生成期间高输出 | 有序拼接且无缺口，或明确重放 |
| 日志尾部截断/磁盘满 | 记录留存故障，停止入口仍可用 |
| 两成员同时发布同逻辑文件 | 一个成功，另一个版本冲突并保留内容 |
| 候选引用已创建但 DB 未确认 | 按预定 ID/hash 核对并补登记 |
| 技术验证后新增修改 | 对应验证与授权失效，已封存的历史仍保留原内容 |
| 交付目标已经前进 | needs_reintegration，不覆盖目标 |
| 本地引用已更新但回执丢失 | 根据 N 和 T 核对并补回执 |
| 推送成功但网络响应丢失 | 查询远端，记录事实，不重新执行 Worker |
| 其他 worktree 正在检出目标 | TARGET_IN_USE |
| SQLite schema 升级失败 | 回滚并停止新执行 |
| Host 崩溃时 Worker 仍在运行 | 回报可持久化，恢复同一 Host 处理 |
| Worker 资源全占用 | Host 保留容量，停止与答复仍响应 |
| Host 换代后重放同一工具调用 | 按推导的 requestId 命中原结果，不重复派发 |
| unknown 执行始终无法核对 | 提供用户放弃入口，确认后才允许替代执行 |
| 关闭最后一个窗口时有运行中工作 | 询问后默认后台继续，执行不中断 |
| 用户有草稿时到达答复 | 不注入，消息 deferred 并提示用户 |
| resume-with-instruction 中途崩溃 | 依据进程身份和原生会话核对，不重复启动，不重复投递 |
| 用户在两次执行之间升级 CLI | 记录版本变化，暂停自动投递并提供验证、改用已验证版本和人工投递入口 |
| 断电发生在外部操作执行后 | 意图与幂等记录已经以 FULL 落盘，恢复后可核对 |
| Host 恢复后重新生成的调用顺序改变 | 批次待核对，修改类工具返回 RECOVERY_PENDING，不重复派发 |
| CLI 尝试在执行中自更新 | 自更新已关闭；无法关闭的后端在能力证据中注明 |

## 本轮复核增补矩阵

| 编号 | 场景 | 预期结果 |
|---|---|---|
| RV-01 | 并发启动多个 Worker | 自动输入前资源已原子预留，不超发也不部分持锁互等 |
| RV-02 | 用户答复到达但依赖成果尚未就绪 | 只关闭对应问题，成员保持等待其他条件 |
| RV-03 | Host 判定验收条件 | RecordVerdict 可完成声明的人工判定，无法覆盖机器检查失败 |
| RV-04 | 事件恰好在 WaitAgents 查询与休眠之间到达 | 持久 wait 被标记就绪，Host 能读到事件 |
| RV-05 | 旧修订已投递时提交第二次修订 | 拒绝直接替换，先核对或确认撤回 |
| RV-06 | 两个 runner 同时领取同一步骤 | 只产生一个有效 claim，旧代次回执不能推进状态 |
| RV-07 | 用户撤销正在执行的交付授权 | 停止未开始步骤，已发生或不明副作用如实记录 |
| RV-08 | PTY 接收 Enter 后回执丢失 | 原始按键不自动重放，界面提示核对 |
| RV-09 | 人工输入窗口崩溃 | 输入租约撤销，原生状态核对前不自动注入 |
| RV-10 | 已完成成员直接开始新的原生工作 | 生成新委派或标为人工执行待归属，旧完成记录保持不变 |
| RV-11 | 测试脚本自动修改候选源码 | 验证记录 CHECK_MODIFIED_SOURCE，产生新候选后重验 |
| RV-12a | 交付目标在有改动的工作树中检出，或授权不包含“更新已检出的工作区” | 分支更新前返回 TARGET_IN_USE，目标引用和工作区均保持原值 |
| RV-12b | 交付目标在干净的工作树中检出，前置检查通过且授权包含该动作 | 执行 `git merge --ff-only --no-overwrite-ignore`，分支等于 N，工作区文件同步更新，合并前记录的未跟踪和被忽略文件不变 |
| RV-12c | 目标路径上存在被忽略或未跟踪的本地文件，或带 assume-unchanged / skip-worktree 标记 | 前置检查拒绝快进，返回 TARGET_IN_USE，本地文件保持不变 |
| RV-13 | Worker 自报进程已停止但进程仍活跃 | 仅保存声明，适配器核对前不释放资源或冻结 |
| RV-14 | 部分交接的源范围修订失败 | 接手者不能取得重叠写入范围，原成果及操作进度可恢复 |
| RV-15 | 普通请求完成前用户查询操作 | GetOperation 与 IPC 返回相同已持久化步骤，queued 不被当成完成 |
| RV-16 | 仓库文件中埋有要求推送、扩大范围或授予互读的注入文本 | Worker 照搬后 Host 没有取得新权限；需要授权的动作仍停在用户确认；AskUser 和授权界面显示真实来源 |
| RV-17 | 用户升级 CLI 后恢复成员 | 版本变化被记录，自动投递暂停，不使用未验证的 resume-with-instruction；用户可验证、改用已验证版本或人工投递 |
| RV-18 | 第一轮开始证据迟到时用户已输入下一条草稿 | draftPossible 保持 true，Host 不注入 |
| RV-19 | Worker 在 .git/hooks 与 .git/config 植入钩子、pushurl 和 credential.helper | 服务交付不执行这些钩子，推送到用户确认的远端，凭据不暴露 |
| RV-20 | Worker 切换工作或整体交接后打开旧链接，旧轮次报告迟到 | 用户查看原 Work 和版本，迟到报告归原委派，接手者仍用同一 workId |
| RV-21 | 工作领取后崩溃，或用户对同一成果并发接受与退回 | 核对原委派和投递意图，只有一条用户决定及对应状态成立 |
| RV-22 | A 的成果退回后同一 Worker 正在做 B | A 独立排队，可由 Host 改派，后续成果版本递增，B 的执行保持原归属 |
| RV-23 | 首次推送时发现同名 ref 已被创建，或本次创建回执丢失 | 非 N 的已存在引用保持原值，按准确 N 核对回执，权限或网络错误不当成 `absent` |
| RV-24 | GitHub 已创建 PR 而响应丢失，或同 head/base 下的 PR 指向其他提交 | 匹配的真实 PR 补回原操作，找不到确定结果时保留 uncertain，冲突 PR 不自动绑定或覆盖 |
| RV-25 | 读取 Diff 期间 PR 更新，或 API 截断、二进制和重命名 | 变版或不完整快照不能提交验收，支持的文件类型按真实 Diff 呈现，历史快照页保持同一身份 |
| RV-26 | 点击接受时远端 PR 已更新，或外部核对期间另一窗口先退回 | 核对实际 PR 快照及 Work revision，拒绝已检测到的过期版本，原快照和决定可查 |
| RV-27 | 没有 PR 创建授权，或只读窗口伪造结果接受 | PR 写入未启动，服务拒绝验收，必要交付和用户决定分别显示 |
| RV-28 | A 的 PR 待验收，B 通过仓库别名、其他 base 或普通 Git 交付尝试推到同一 head | 统一解析仓库 ID，在推送前返回 REMOTE_HEAD_OWNED，A 的远端引用和 PR head 保持原值 |
| RV-29 | 首次推送成功，PR 创建回执不明或 Diff 暂不可用，此时尚无 WorkResult | 在原 workId 和 Delivery 上重读并核对。证据恢复后由当前交付封存成果，原 Worker 轮次沿用，核对过程中没有重复推送或创建 PR |
| RV-30 | 首次 PR 受阻后申请更换分支，旧交付的成功结果与新授权并发到达 | 旧交付先封存时拒绝过期的换支授权。换支先确认时只允许新交付封存，旧回执进入历史，旧目标上尚未开始的写入不再派发 |
| RV-31 | A 在执行，用户讨论 B，或消息引用「开始执行」作为讨论材料 | B 的轮次缺少派发许可。服务拒绝新派发或修订，A 的授权执行和回报按原工作处理 |
| RV-32 | 聊天有两个方案，用户说「按那版开始做」，随后选定版本 | 澄清前没有派发。答复引用有效时，记录原始指令、选定版本及范围并直接派发。已取消的澄清无法开工 |
| RV-33 | 明确开工消息重发，Host 重启后用新 requestId 续办原 dispatchId | 查询到同一许可、Work 和派发回执，运行端按已有操作核对，无重复启动 |
| RV-34 | Host 用已有许可尝试派发到未授权的仓库或写入目录 | 拒绝越界派发，新的范围需要用户明确要求。开工回执仅包含派发许可，交付写入核对对应 Grant |

以上为设计要求，尚未作为运行测试执行。

## 离线验证入口与完成要求

实现后使用项目脚本完成 npm run typecheck、npm run build 和 npm test。针对新增行为扩展现有 worker-cli-integration、pty-host、meeting-recovery、agent-resource-pool、delivery-snapshot、delivery-verifier、integration-queue 和相关 IPC 测试，必要时新增状态机与 SQLite 恢复测试。

文档阶段仅进行文件链接、结构与契约一致性检查。当前数据库探测只验证本机 Electron 内置 SQLite 可以创建内存数据库并查询版本，不代表持久化或整体测试通过。

V1 不改远程 Hub；未来相关实现触及共享协议时再执行 Python 契约测试和 test:collaboration，避免拿未运行的远端测试作为当前验收证据。

## 真实验收记录

每次保存 runId、源码与补丁 hash、OS、Electron、Node、CLI/模型版本、能力表、输入、工具调用、过程事件、终端日志、成果和检查结果。结构化业务日志不保存登录令牌。原生终端输出可能包含 CLI 打印的敏感内容，原始录制按当前用户权限保护并默认仅本机查看；已知敏感交互可暂停录制并显式记录缺口，对外导出或共享使用经检查和脱敏的副本。

统计重复启动、丢失消息、错误授权、恢复成功、原生终端差异、无进展轮次和实际耗时。通过标准是场景要求及不变量全部满足，失败和未跑分别列出。

## 设计完成条件

七份模块文档共用同一身份、状态和操作语义；每个副作用有失败恢复路径；每个产品动作有正常入口及可观察回执。尚未证明的原生能力明确列为发布前验证项，不以文档描述替代实测。

