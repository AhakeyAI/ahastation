# 对照 Orca：AhaStation 多 CLI 任务执行能力

日期：2026-10-17。状态：源码分析与实施建议，尚未实现。

实施范围已收敛至 [多 CLI 实施规划](2026-10-17-multi-cli-implementation-plan.md)。本文件保留源码依据；下文的设计建议不作为逐项实现或测试要求。

对照基线：

- Orca：`<USER_HOME>/Desktop/orca`，`main` / `8e350554480ac5b77d3050a2040541fd334dad7c`。
- AhaStation：`<USER_HOME>/Desktop/ahastation-internal1`，`main` / `c134de2`。
- Orca 原有 `docs/site/public/docs/orca-design-mode.gif` 删除状态未改动；AhaStation 原有未跟踪 supervisor 设计文档保留。
- 本轮只读核查代码并编写文档，没有启动 Orca、安装依赖、调用真实模型或验证其测试通过。

## 结论

用户要的是：选择不同厂商的 Agent CLI，在各自可见、可接管的终端中并行接单，能提问、接收后续指令、报告结果，并由宿主统一管理任务、工作区和恢复。

AhaStation 已有 PTY、四个 terminal adapter、任务调度、邮箱、隔离工作区和交付框架。当前 terminal 路径仍主要是“宿主发提示词、用户确认完成”。Orca 则给终端内的 Agent 一套宿主 CLI 命令，让没有 SDK/MCP 的 Agent 也能进入结构化的任务通信和结果回收流程。

因此，supervisor 是重要的生命周期子项目，不能单独补齐用户要求的多 CLI 协作能力。优先补齐任务通信与完整代码交付，再推进可靠启动、后台存活及更多 Agent 适配；生命周期原型可以先独立验证。

## Orca 实际怎么做

以下路径以 `<USER_HOME>/Desktop/orca` 为根，均来自本地源码。

| 层次 | 源码锚点 | 对执行结果的作用 |
|---|---|---|
| Agent 目录 | `src/shared/tui-agent.ts:3`、`tui-agent-config.ts:27`、`tui-agent-config-types.ts:3` | 45 个启动类型，包括独立 CLI、变体和启动模式；集中声明检测命令、启动方式、信任准备、输入模式和 ready 信号，不能理解为 45 家能力完全一致 |
| 任务派发 | `src/main/runtime/rpc/methods/orchestration/worker/workers.ts:21`、`local-worker-start.ts:148` | 先记录 Task/Dispatch 和启动意图，再配置 Agent、选择工作区、启动终端并交付任务；协调者和执行者可不同 |
| 输入可靠性 | `src/main/runtime/launched-agent-composer-readiness.ts:1`、`src/shared/agent-prompt-injection.ts:1` | 判断前台是否确实为目标 Agent、是否卡在启动对话框；按 Agent/平台处理粘贴、分块、提交间隔和长文本 |
| 启动回执 | `src/main/runtime/rpc/methods/orchestration/worker/worker-start-readiness-settlement.ts:20` | 区分输入被接受、开始执行被观测、开始状态未知，未观测到不能一律标为 ready |
| 通用任务通信 | `src/main/runtime/orchestration/preamble.ts:70` | 在任务提示词中教所有 Worker 使用 `orchestration send / ask / check`，携带 taskId 和 dispatchId |
| 汇报接收 | `src/main/runtime/rpc/methods/orchestration/messaging/send-point-to-point.ts:58`、`src/main/runtime/orchestration/worker-report-admission.ts:29` | 校验当前 Dispatch 和实际进程归属；worker_done 的邮箱消息、结算与重放回执提交后再通知协调者 |
| 统一状态 | `src/main/agent-hooks/server.ts:1`、`src/shared/agent-hook-types.ts:6` | hook 标准化为宿主统一状态；hook 目标集合小于整个启动目录，不声称所有 Agent 都有相同遥测 |
| 存活与重连 | `src/main/daemon/client.ts:34`、`daemon-out-of-process-launcher.ts:88` | 独立 daemon、认证控制/输出连接、连接 generation、既有实例接管；Windows 还迁移运行镜像以应对更新 |

任务提示词中的关键不是一条“完成标记”，而是几种可由模型调用、宿主确认的操作：

```text
协调者 -> 创建 Task / Dispatch -> 启动指定 CLI -> 投递任务
Worker -> heartbeat / ask / check -> 宿主邮箱 -> 协调者
Worker -> worker_done(taskId, dispatchId, outcome, summary)
       -> 当前身份检查 -> 持久化与结算 -> 通知协调者
```

源码另有 structured chat 执行通道；Orca 并非所有工作都只能走 PTY。本次借鉴的是 CLI 通道如何与任务系统接起来。

## AhaStation 的实质差距

以下路径以 AhaStation 根目录为根。

| 能力 | 当前事实 | 必要改动 |
|---|---|---|
| 不同 CLI 混合执行 | `electron/backends/registry.ts:167` 注册四个 terminal backend；计划有 executorBackendId，调度支持独立执行后端 | 保留并验证实际路由；不能仅凭注册和 fake PTY 测试声称真实四家并行已经验收 |
| 默认执行者 | `electron/worker-backend-default.ts:9` 优先用户配置，否则选 Claude terminal | UI/计划明确记录每个任务实际执行后端及降级结果，避免用户以为已切换而仍走默认 |
| 通用扩展 | `terminal-cli-adapter.ts:85` 与 `src/lib/terminal-backends.ts:6` 各维护四家列表；CustomBackend 要求兼容 JSONL 和通用参数 | 建立统一 terminal profile 描述，去除跨层重复名单；不能把“填一个二进制名”当作任意 TUI 接入 |
| 接单可靠性 | `terminal-cli-adapter.ts:514` 的 fallback 会到点 markReady，随后粘贴并定时提交 | 增加有证据的 ready/blocked/unknown 与投递回执；保留人工接管，未知不自动重发 |
| Worker 通信 | `electron/meeting-mcp.ts:681` 已有 SDK Worker 的 ask/report；terminal 的 mcp/systemPrompt 等能力关闭 | 新增窄范围 Worker CLI 桥，让终端 Agent 调用同一领域接口 |
| 终端协调者 | 四个 terminal backend 都是 `coordinate:false`；Orca 的 CLI 调用者可在所属 Run 权限内派发任务 | 第一阶段保留现有 SDK Coordinator；完整对齐需另加协调者 CLI 入口，接入计划审批与现有会议命令，验证后才开放 terminal coordinate |
| 完成判断 | `terminal-cli-adapter.ts:61` 的标记仅提示用户；`electron/ipc/worker-pty.ts:157` 人工生成报告 | 允许 Agent 提交结构化 WorkReport，用户确认继续作为兜底及最终验收 |
| 代码交付 | 人工完成报告固定 `files:[] / tests:[]`；`delivery-harness.ts:606` 对 report-only 跳过 freeze 和 Coordinator diff review | 为代码任务收集真实文件清单、验证命令和未解决项，进入冻结、完整差异审查、集成流程；不得把代码改动作为纯报告接受 |
| 状态可信度 | 内部 Worker 使用 adapter 事件；`observe/` 是另一路外部会话观察，并排除本应用 Worker | 不把观察器状态当作内部任务的权威；内部状态从实际执行事件更新 |
| Windows 状态 | 外部观察器直接使用 `observe/process/darwin.ts` 的 ps/lsof | 不能用这条链证明 Windows 对所有 CLI 的精细状态；需要平台适配或明确不可观测 |
| 重启续接 | terminal `snapshot()` 返回 null，end() kill PTY 并清 hook；宿主退出结束会议 | 独立 supervisor，加 terminal/meeting/task/attempt 的持久绑定和 attach 路径 |

还需区分三个结论：PTY 进程活着、Agent 一轮结束、任务完成并通过验收。hook Stop、CPU 降低或终端安静都不能单独证明第三项。

## ADR-005：复用现有任务领域，新增通用 Worker CLI 入口

状态：Proposed。

保持现有 `CliBackend / BackendSession`、`WorkerScheduler`、`TaskMailbox`、`MeetingRepository`、`WorkReport` 和 DeliveryHarness。新增一个本机 Worker 命令入口和认证传输，直接接入这些接口，不复制 Orca 的整个数据库、UI 或远程运行时。

以下命令仅为拟议接口，并非已实现：

```text
aha-worker status
aha-worker progress --body-file progress.json
aha-worker ask --body-file question.json
aha-worker inbox --after <seq>
aha-worker ack --message <id>
aha-worker report --body-file report.json --operation-id <id>
```

任务 bootstrap 说明身份、工作区、边界、验收和这些命令；工具调用能力来自 CLI 自身运行 shell 命令的能力，不要求安装每家专属 MCP。命令随应用分发，Worker PATH 中提供启动入口；Windows 支持真实 argv 和中文/空格路径，不假定用户全局装好 aha-worker。

通过受限 env/凭证文件绑定 worker、meeting、attempt、terminal incarnation；服务端核对当前绑定。不能相信命令行自报的 workerId，也不能把全局应用管理员 token 交给 Worker。只授予报告、进度、问答和当前任务邮箱权限；发布、改审批档、创建无限子任务不在 Worker 凭证范围。

完整对齐时再提供协调者角色入口，例如拟议的 `aha-meeting plan / delegate / status`。它使用单独的会议协调者身份，接入现有 `Orchestrator.executeMeetingCommand` 及计划审批/预算/深度限制。Worker 的凭证不能调用协调者操作，未经批准的计划不能直接派发。终端 Coordinator 的 prompt 输入、命令回执、重连和能力声明也须单独验收，不能只把 `coordinate:false` 改成 true。

提交使用稳定 operationId 和 payload hash，同一 ID 相同内容返回原回执，内容不同则拒绝。现有 `submitWorkerReport()` 返回 void、后台触发后续处理；CLI 不能把它直接包装成“已持久化完成”。需要可等待的接收接口：校验 -> journal 中保存报告和去重身份 -> 返回 durable 接收回执 -> 驱动验证审查；恢复可重新驱动未完成阶段。

旧 attempt 的报告、重复完成、跨任务命令和迟到消息均拒绝或返回原结果，不能推进当前 attempt。inbox 的 delivered/ack 与模型是否真正执行指令分开。ask 先持久化问题、返回 messageId，等待超时可按 ID 查询，不能重复创建问题。

好处是四家 CLI 共用一次集成；代价是应用要提供稳定的本地协议、打包启动入口和恢复语义。仅解析 TUI 文本或完成字符串较省代码，但无法给模型提供可靠问答与结果提交接口，保留作显示/人工兜底。

## ADR-006：任务通信与终端存活分层建设

状态：Proposed。

首个可用切片可以在 main 存活时完成，不让完整 daemon 项目阻塞跨 CLI 协作验证。与此同时独立验证 Windows 进程存活原型，沿用 [supervisor 子方案](2026-10-17-pty-supervisor-design.md)。

CLI 桥通过“执行宿主服务”抽象访问领域接口，首期 main 承载。此阶段界面退出后不承诺自动汇报可达或自动流转；在 supervisor 阶段明确选择：CLI 将报告暂存至其受控持久收件通道，宿主重连后按原 operationId 接收，或者报告明确返回连接不可用并允许同 ID 重试。未拿到 durable 回执不能显示已提交。存活进程不代表完整任务服务仍在线。

首期不把 Coordinator、预算检查、审查集成一起搬进后台。断连时只能维持已有授权的运行，不能暗中启动新的任务、回复权限或发布。

## 实施顺序与验收

| 阶段 | 具体交付 | 验收条件 |
|---|---|---|
| P0 真实路由基线 | 明确现有四家安装/版本/认证和实际路径，离线 PTY 纵切夹具 | 一个计划的不同任务确实进入不同 backend 和独立 cwd；保留命令、版本和进程身份；先不调用付费模型 |
| P1 通用任务闭环 | Worker CLI 桥、bootstrap、durable 接收回执、邮箱问答、完整 WorkReport | 两种不同真实 CLI 并行接单；一方提问、协调者答复；两者回传报告，用户无需手抄终端输出；旧 attempt 和重复报告回归通过 |
| P2 完整代码交付与启动门控 | 检测实际变更并校验报告，固定候选、完整 diff review；输入 ready/blocked/unknown 和投递回执 | 有代码变更的任务不能走 report-only；启动卡登录/信任时不丢 prompt、不误报已执行；验收后依赖任务才放行 |
| P3 进程存活及重连 | supervisor、任务身份绑定、原终端 attach、报告通道断连策略、后台退出选项 | main 强杀后同一 CLI 进程存活；重连不重复发任务；断连期间的报告最终只接收一次；显式终止能清理自有进程树 |
| P4 扩展目录 | 统一 profile，再接 OpenCode terminal / Gemini / Pi 等所需 CLI | 每家分别记录版本、启动输入、阻塞识别、报告与恢复证据；不以目录行数代表稳定性 |

终端 Coordinator 属于完整对齐的另一项交付，可在 P2 后按需求顺序推进：由一个真实 CLI 创建获批计划并派发给另一种 CLI，问答与报告返回原会议，越权及旧身份操作被拒绝。P1 使用现有 SDK Coordinator 是首个切片，不代表这项能力已完成。

P1 的最小代码任务也必须校验实际变更并使用完整报告；P2 扩大异常覆盖和正式门控，不允许 P1 先用空 files 绕过审查。阶段之间不以文档、help 输出或 mock 通过替代真实 CLI 验收。

首个产品场景建议固定为：“一个 Coordinator 将接口实现和测试任务交给两个不同 CLI；它们在隔离工作区执行，途中问答和接收修订，提交完整报告，经过审查集成后由用户验收。”之后扩大到现有四家并发，再扩新 CLI。

本机只做了 PATH 静态检查：可解析 Codex、Kimi、Qoder、OpenCode 的启动命令，未找到 Claude 命令；没有运行版本/登录或模型请求，因此不据此断言运行可用。AhaStation 暂无 node_modules，实现前需要安装项目依赖。

## 建议验收用例

1. 两种 CLI 处理独立文件，均能报告真实变更与测试，用户最终验收后才完成任务。
2. 一个 Worker 提问、另一个继续工作；答复回到原任务，过期 attempt 不收错消息。
3. CLI 卡在登录/信任菜单，任务显示阻塞而非执行；人工处理后明确继续，输入不被注入 shell。
4. 报告重复提交、ACK 丢失、接收后 main 崩溃：去重身份与文件证据保留，不重复结算/发布。
5. 报告声称无文件但 worktree 有修改：拒绝作为 report-only 接受，并给出可修正的差异。
6. Worker 已结束一轮但尚未提交报告：显示待报告，不误放行依赖；人工兜底仍能使用。
7. supervisor 阶段验证重连前后同一进程/attempt/工作区，特别覆盖 Windows 打包版和自有后代退出。

实现后需双侧 typecheck、相关离线协议/任务/交付回归及项目全量测试；真实 CLI 验证单列版本、授权、费用与清理证据。当前分析未产生这些运行证据。
