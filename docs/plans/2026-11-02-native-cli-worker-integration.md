# 原生 CLI Worker 接线规划

日期：2026-11-02（Asia/Singapore）。当前工作区 `codex-native-production/ahastation-internal1`，代码基线 `02f647f92a9f6b1a3b0ae1506718a62739cc439d`。

实现状态更新：2026-11-03（Asia/Taipei）。本次已接通本机原生 CLI Worker 的派单、任务通信、候选交付及生命周期；离线夹具与真实 CLI/模型验收分开记录，详见[验收证据](../c0/b04-runtime/native-cli-scenarios.md#2026-11-03-离线接线证据)。

## 适用范围与优先级

本文件是**原生 CLI Worker 后续实施的唯一规划入口**。[规划索引](README.md)列明其他计划的适用范围。优先级为：本次用户明确决定 → 本文件 → 仍适用的接口与模块分工 → 带日期的历史方案/证据。它不改写 SDK 后端、跨端用户审批或其他产品模块的既有规则。

11-02 规划核对覆盖 `docs/plans/` 的 19 份既有 Markdown 规划、ADR 索引与运行底座相关决定、C0/AME 的规划入口、原生能力矩阵和 B04 说明，以及当时协调工作区中的两份未跟踪总规划。该次检查限于本地文档与代码。11-03 在本文件指定工作区继续实现与验证；远端 PR/最终 SHA 的 CI 以实际链接为准，历史日期和成员完成记录不能用作当前排期。

## 当前决定

用户明确要求：**子任务不需要发回 Host 审批。** 本规划替代 ADR 0019、原生 CLI Worker 变更说明及 2026-10-31 完成规划中要求工具请求转 Host 裁决的部分。跨成员契约与历史验收材料仍需同步修订，不能把本地规划更新写成其他成员已经确认。

复用现有链路：

`Host 讨论与派单 → worker-scheduler → terminal-cli-adapter → PTY/终端守护进程 → 本机原生 CLI → 当前任务成果回报 → Host 验收或返工`。

- Host（会议协调 Agent）负责目标、任务上下文、工作区、调度、追问与成果验收；不逐次批准工具调用。应用进程仍管理任务通信、会话归属与进程生命周期。
- Worker 的工具与命令由原生 CLI 执行，沿用用户选择的 CLI 权限和沙箱设置。需要用户确认时，在该 CLI 的原生终端中处理；宿主可显示等待状态。
- hooks 可用于状态观察和轮次结束通知；Host 的回复不作为工具执行许可。hooks 观察失败也不改成自动批准。
- 保留登录、原生工具、TUI 和现有 CLI 版本路线。撤销的 Codex 引擎补丁不再是实现依赖。
- 此决定没有授权关闭 CLI 原生审批、强制启用 bypass/full-access、修改个人全局配置或运行真实付费模型。
- 阶段计划确认、任务是否开跑、成果接受/返工以及发布授权各自保留；它们不属于被取消的逐工具 Host 审批。原生 CLI 能力不足时明确标为限制，不增加修改第三方引擎的隐含路线。

## 当前代码与文档事实

| 核对项 | 本次实现事实 | 边界 |
| --- | --- | --- |
| `electron/backends/codex-terminal-adapter.ts`、`claude-terminal-adapter.ts` | 已有原生 CLI 适配；经 `terminal-cli-adapter.ts` / `pty-host.ts` 启动，工具审批由 TUI 处理 | 复用；无需新建执行器、替换登录方式或编译 Codex |
| `electron/global-hooks/protocol.ts`、`terminal-cli-adapter.ts` | Claude/Codex 终端 Worker 接受绑定当前任务/attempt 的 `native-cli-self-approval` 模式；拒绝混入旧 Host permit、controlled 提示或强制 bypass | 只开放这两个本机原生入口；hooks 状态不等于任务完成或工具授权 |
| `electron/ipc/worker-pty.ts` | 接好待发任务、接管/交还及实际文件差异的人工报告兜底 | 人工完成仍需明确操作，主报告通道为 `aha-worker report` |
| `electron/worker-protocol.ts`、`worker-scheduler.ts`、`delivery-harness.ts` | 已有报告 schema、任务调度和成果验证流程 | 复用这些领域接口，补原生终端的报告生产端 |
| `electron/worker-cli-bridge.ts`、`electron/worker-cli.ts`、`electron/worker-report-files.ts` | 新增回环 HTTP 薄桥和 `aha-worker report/ask/inbox`；校验令牌、任务、attempt 和实际 diff；候选及日志落盘后返回回执 | 相同报告幂等，冲突/旧 attempt/错误任务/无凭据拒绝；ask 仅为任务问答，不授予工具许可 |
| `worker-scheduler.ts`、`pty-host.ts`、`task-recovery.ts` | 同会话追问、接管输入暂停、先读 diff 再交还、停止证据及重启显式恢复已接线 | 未证明的恢复不自动重复派工，不静默转 SDK；停止失败或只有根进程退出时不冒充整树确认 |
| `electron/native-worker/` 的 permit/broker、离线 AppContainer/ConPTY | 是前一方案的执行核心或离线边界候选，尚未接通真实产品任务链 | 保留历史实现与证据，不把其审批/定制隔离要求自动带入当前路线 |

## 保留与取消

| 项目 | 本轮处理 |
| --- | --- |
| 原有 `codex-terminal-adapter.ts` / Claude 终端适配器 | 复用原生 CLI 启动和 PTY 路径 |
| report、ask、inbox 的薄 CLI 入口 | 已补接现有 scheduler、邮箱和 delivery harness；ask 用于任务问题或阻塞说明，不承载工具许可 |
| 当前 task/attempt、会话归属、幂等报告和成果验证 | 保留，避免串任务、重复报告或提前宣称成功 |
| 用户接管、交还、停止和进程树清理 | 保留；接管期间停止自动输入，停止确认依据实际进程证据 |
| 工具请求转 Host、Host 审批队列和逐次 permit 消费 | 从这条原生 Worker 路线取消；历史候选代码暂保留，不接入新路径 |
| 自建 Codex 引擎、额外工具 broker、定制沙箱或模型/工具流量分离体系 | 不作为本轮接线的前置条件；复用 CLI 既有能力并记录实际限制 |
| SDK 等其他后端已有权限机制 | 本决定只针对这条原生 CLI Worker 路线，不批量改动其他后端 |
| 跨设备 Station/Hub、远端查看、广泛会话扫描、扩展界面 | 保留原模块归属，排在本机最小闭环之后；不作为启动本机原生任务的新增前置 |

任务身份、报告凭据和进程归属仍用于验证任务通信；它们不再被解释为每个工具动作都要向 Host 申请的许可。

## 执行顺序

1. **复用入口并明确模式。** Leo 在现有 session factory / terminal profile 接缝定义“原生 CLI 自身审批”模式，声明实际支持的 CLI、平台和权限配置。新路径不调用旧 Host 工具审批端口或 controlled deny-only relay；hooks 的状态观察可独立使用。不为此升级依赖、改个人配置或新增通用安全框架。
2. **补齐报告生产端和本机身份。** Leo 定位旧薄 CLI 桥的可复用来源，适配现有 `worker-protocol`、scheduler、邮箱与 delivery harness；将任务、attempt 与本机终端/原生会话绑定，报告凭据仅用于当前任务通信。状态 hooks 不授予报告身份，也不生成成功报告。Station 统一归属/迁移单列为后续工作，不伪造 Station owner 来跑本机验收。
3. **跑通一个本机最小任务。** 经实际产品入口派单，复用现有工作区和任务输入；CLI 执行编辑/测试并回交带实际 diff/test 证据的候选报告，由 Host 接受或返工。报告落盘并取得回执后再释放会话，避免先结束进程导致回执丢失；重复报告幂等，旧 attempt 拒绝。无需 Host 批准任何工具调用。
4. **补齐生命周期和恢复。** 验证同会话追问、原生审批、接管/交还、停止与自有后代清理、断线/重启的明确状态。当前不能证明恢复的组合标为“未知/需用户继续”，不默认保活、重复派工或静默改为另一种执行模式。
5. **按新契约复审和验收。** 按[原生 CLI 验收清单](../c0/b04-runtime/native-cli-scenarios.md)取证。先隐藏 fixture 和必要定向测试，再做已授权的真实 CLI/模型验证；以最终 SHA 的 CI、指定平台结果和模块负责人复核决定发布。旧 B04 的 SDK/Host 审批结果仅为历史证据。

步骤 1–3 是当前关键路径。步骤 4 补齐本机日常行为；随后再扩展跨设备、更多平台/CLI 和界面。接口责任沿用现有分工；本规划不替其他成员承诺日期，也不擅自关闭或重开 Issue。

## 复核发现与修正

| 发现 | 修正 |
| --- | --- |
| 旧总规划将强制工具守卫、逐次 permit、模型/工具网络分离串为真实任务前置，并包含“必要上游补丁” | 按最新用户决定取消本轮前置；原生权限继承 CLI 配置，已撤回的引擎实验不再续做 |
| 11-02 核对发现当前基线没有旧 CLI 桥 | 当时改为待补接项；11-03 已新增薄桥并接通现有领域接口，保留显式人工报告兜底 |
| ADR、冲刺表、能力矩阵和 C0/AME 入口的适用顺序不一致 | 统一指向本文件；旧方案保留为带日期的历史，SDK 与跨端用户审批的范围单独说明 |
| 旧 B04 的 S3/S4/S5/S11 仍按 Host grant/permit 判定，易被重新当作改引擎理由 | 新增独立原生 CLI 清单；保留拒绝、停止与成果真实性检查，未修改历史场景 JSON 或已有结果 |
| 旧计划把全局 hooks、Station owner、受控网络出口或扩展 UI 变为同一条巨大依赖链 | 本机报告闭环优先；全局 hooks 以观察/状态消费为范围，跨设备与扩展能力按所属模块后续实施 |

历史中对脚本/网络隔离的证据和限制仍成立。取消 Host 审批不产生新的隔离保证；CLI 配置无法表达某项限制时，如实标明不支持，不把应用 grant 宣称为 CLI 的实际约束。

## 完成标准与当前状态

完成标准是一条现有产品入口的真实派工链：原生 CLI 完成工作、可由用户处理其原生审批、Host 收到当前 attempt 的成果并接受或返工，期间无需 Host 逐次批准工具。报告、接管和停止必须有实际运行证据。

本次已改动运行逻辑：Claude/Codex 本机终端 Worker 可经任务绑定进入调度；专家子任务映射到对应原生入口，显式原生默认项也可生效。未明确选择原生默认项时，常规默认解析仍保留 SDK 路径；已选原生任务的恢复不静默切换后端。

当前完成的是代码接线与隐藏离线验证。N1–N8 使用注入 PTY/CLI 夹具、自有临时 Git 仓库和真实回环通信；N3 的确认程序是 Node 夹具，不是 Claude/Codex 引擎，N6 是 Windows 自有根进程及后代的实际停止与 30 秒观察。`typecheck`、`build` 和 CI 只证明相应源码检查、测试与构建结果。

真实 Claude/Codex 登录与信任界面、原生审批策略、模型工具回合、真实 CLI 到 WorkReport 的闭环、指定 Mac/N5095 平台及生产发布验收仍待执行。真实账号和付费模型需用户另行授权。本轮不合并、不发布安装包、不关闭 Issue、不向成员发送通知；原有 B04 结论不转作新契约验收。
